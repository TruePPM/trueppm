"""SSRF guard tests for webhook registration and delivery (#768).

Webhook.url is configured by a project admin (an RBAC role, not an infra
operator), so outbound delivery is untrusted egress. The serializer rejects
obviously unsafe targets at registration and ``deliver_webhook`` re-checks at
delivery time as the authoritative guard. Both route through the shared
integrations egress chokepoint (``assert_url_allowed``, ADR-0049 §3).
"""

from __future__ import annotations

import contextlib
import json
from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.webhooks.models import DeliveryStatus, Webhook, WebhookDelivery

User = get_user_model()


@pytest.fixture
def project(db: object) -> Project:
    calendar = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="SSRFProj", start_date=date(2026, 3, 1), calendar=calendar)


@pytest.fixture
def admin_client(project: Project) -> APIClient:
    user = User.objects.create_user(username="ssrf_admin", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.mark.django_db
@pytest.mark.parametrize(
    "blocked_url",
    [
        "http://169.254.169.254/latest/meta-data/",  # cloud metadata
        "http://127.0.0.1/internal",  # loopback
        "http://10.0.0.5/admin",  # RFC1918 private
        "ftp://example.com/payload",  # disallowed scheme
    ],
)
def test_create_webhook_rejects_ssrf_url(
    admin_client: APIClient, project: Project, blocked_url: str
) -> None:
    """Registration rejects private/loopback/link-local/bad-scheme URLs with a 400."""
    resp = admin_client.post(
        f"/api/v1/projects/{project.pk}/webhooks/",
        {"url": blocked_url, "secret": "s3cret", "events": ["task.created"]},
        format="json",
    )
    assert resp.status_code == 400
    assert "url" in resp.data
    assert not Webhook.objects.filter(project=project).exists()


@pytest.mark.django_db
def test_create_webhook_egress_error_does_not_echo_internal_ip(
    admin_client: APIClient, project: Project
) -> None:
    """The egress rejection must not leak the DNS-resolved internal address.

    ``EgressBlocked`` embeds the resolved address (e.g. "resolves to non-public
    address 10.0.0.5"). Surfacing ``str(exc)`` to the client would turn this
    field into an SSRF oracle for internal network topology (CodeQL
    py/stack-trace-exposure). The serializer must return a curated message and
    log the real detail server-side only — mirrors the notifications
    bounce-webhook fix in #2082. Regression guard for #2083.
    """
    from trueppm_api.apps.integrations.http import EgressBlocked

    leak = "host 'internal.example.com' resolves to non-public address 10.0.0.5"
    with patch(
        "trueppm_api.apps.integrations.http.assert_url_allowed",
        side_effect=EgressBlocked(leak),
    ):
        resp = admin_client.post(
            f"/api/v1/projects/{project.pk}/webhooks/",
            {
                "url": "https://internal.example.com/x",
                "secret": "s" * 32,
                "events": ["task.created"],
            },
            format="json",
        )

    assert resp.status_code == 400
    body = json.dumps(resp.data)
    assert "10.0.0.5" not in body
    assert "resolves to non-public address" not in body
    assert "not allowed" in body.lower()
    assert not Webhook.objects.filter(project=project).exists()


@pytest.mark.django_db
def test_create_webhook_allows_public_url(admin_client: APIClient, project: Project) -> None:
    """A public (or not-yet-resolvable) URL passes registration validation."""
    resp = admin_client.post(
        f"/api/v1/projects/{project.pk}/webhooks/",
        {
            "url": "https://hooks.example.com/x",
            "secret": "s" * 32,  # >= 32-char minimum (#893)
            "events": ["task.created"],
        },
        format="json",
    )
    assert resp.status_code == 201


@pytest.mark.django_db
def test_deliver_webhook_blocked_url_fails_without_request(project: Project) -> None:
    """Delivery to a private/loopback URL is blocked before any socket opens.

    A webhook can reach a blocked URL even when registration validation is
    bypassed (e.g. a row created directly, or DNS rebinding after registration),
    so the delivery-time guard is the authoritative SSRF defense.

    The invariant is that ``assert_url_allowed`` rejects the URL *before* the
    delivery opener is ever touched. We mock ``_no_redirect_opener.open`` (the
    opener ``deliver_webhook`` actually POSTs through since #808) and assert it is
    never called — mocking ``urllib.request.urlopen`` would prove nothing because
    the code path does not call it, and it would leave the test one leaked guard
    away from a real 10s socket connect to 169.254.169.254 (#1652).
    """
    user = User.objects.create_user(username="ssrf_owner", password="pw")
    webhook = Webhook.objects.create(
        project=project,
        url="http://169.254.169.254/latest/meta-data/",
        secret="s3cret",
        events=["task.created"],
        created_by=user,
    )
    delivery = WebhookDelivery.objects.create(
        webhook=webhook, event_type="task.created", payload={"id": "t1"}
    )

    from trueppm_api.apps.integrations.http import assert_url_allowed
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    # Pin the REAL guard for this test. Sibling webhook tests mock
    # ``wh_tasks.assert_url_allowed`` away for their own purposes; if one of those
    # module-level patches fails to unwind (e.g. a worker interrupted mid-test
    # under xdist), the mock bleeds into this worker and the guard silently no-ops
    # here — which is exactly how this test reached a real socket on CI (#1652).
    # Binding the real function makes the test exercise the guard regardless of
    # ambient state. The opener is stubbed as a fail-loud safety net: a genuine
    # bypass makes open() get called and assert_not_called fail deterministically,
    # instead of hanging 10s on a live connection to the metadata endpoint.
    with (
        patch.object(wh_tasks, "assert_url_allowed", assert_url_allowed),
        patch.object(wh_tasks._no_redirect_opener, "open") as mock_open,
    ):
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    mock_open.assert_not_called()
    delivery.refresh_from_db()
    assert delivery.status == DeliveryStatus.FAILED
    assert delivery.attempt_count == 1
    assert delivery.completed_at is not None


@pytest.mark.django_db
def test_deliver_webhook_does_not_follow_redirects(project: Project) -> None:
    """Closes #808: delivery uses a redirect-disabled opener.

    A malicious webhook receiver returning a 302/307 with ``Location:`` pointing
    at ``169.254.169.254`` (cloud metadata) or an RFC1918 host would, with the
    default urllib opener, be re-fetched without re-running the SSRF guard. On a
    307/308 the original POST body — already signed — would be replayed against
    the internal target. This test pins the no-redirect opener as the
    delivery-time defense.
    """
    user = User.objects.create_user(username="redirect_owner", password="pw")
    webhook = Webhook.objects.create(
        project=project,
        url="https://hooks.example.com/recv",
        secret="s3cret",
        events=["task.created"],
        created_by=user,
    )
    delivery = WebhookDelivery.objects.create(
        webhook=webhook, event_type="task.created", payload={"id": "t1"}
    )

    from trueppm_api.apps.webhooks import tasks as wh_tasks

    # Simulate the receiver returning 302 -> internal target. With the default
    # opener urllib would follow and hit the internal host; with NoRedirectHandler
    # the 302 surfaces directly to our code path and is counted as a non-2xx
    # status that retries via the normal backoff, never landing on the redirect
    # target.
    redirect_call_count = {"n": 0}

    def fake_open(*args: object, **kwargs: object) -> object:  # pragma: no cover - simple stub
        redirect_call_count["n"] += 1

        class Resp:
            status = 302

            def __enter__(self) -> Resp:
                return self

            def __exit__(self, *exc_info: object) -> None:
                return None

        return Resp()

    # SSRF pre-check passes for the public URL; we want to assert that the
    # opener used for the actual POST is the no-redirect one and the redirect
    # is NOT followed to the internal target.
    with (
        patch.object(wh_tasks, "assert_url_allowed", return_value=None),
        patch.object(wh_tasks._no_redirect_opener, "open", side_effect=fake_open) as mock_open,
        # Celery retry may raise in unit context; we only care about call shape.
        contextlib.suppress(Exception),
    ):
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    # The custom opener was used (not bare urllib.request.urlopen) and was
    # called exactly once: redirects were not followed.
    assert mock_open.call_count == 1
    delivery.refresh_from_db()
    # 302 is non-2xx → retries / fails per normal backoff; the key invariant
    # is that no second open() happened to follow the redirect.
    assert delivery.response_status == 302


# --- https-only receivers (#2936) -------------------------------------------


@pytest.mark.django_db
def test_create_webhook_rejects_public_http_url(admin_client: APIClient, project: Project) -> None:
    """A plaintext receiver is refused even when the host is public."""
    resp = admin_client.post(
        f"/api/v1/projects/{project.pk}/webhooks/",
        {"url": "http://hooks.example.com/x", "secret": "s" * 32, "events": ["task.created"]},
        format="json",
    )
    assert resp.status_code == 400
    assert "https://" in json.dumps(resp.data["url"])
    assert not Webhook.objects.filter(project=project).exists()


@pytest.mark.django_db
def test_legacy_http_webhook_stays_editable_when_url_unchanged(
    admin_client: APIClient, project: Project
) -> None:
    """An existing http:// row can still be renamed/re-evented; delivery is untouched."""
    hook = Webhook.objects.create(
        project=project, url="http://legacy.example.com/x", secret="s" * 32, events=["task.created"]
    )
    url = f"/api/v1/projects/{project.pk}/webhooks/{hook.pk}/"
    ok = admin_client.patch(url, {"events": ["task.updated"]}, format="json")
    assert ok.status_code == 200, ok.data
    same = admin_client.patch(
        url, {"url": "http://legacy.example.com/x", "events": ["task.created"]}, format="json"
    )
    assert same.status_code == 200, same.data


@pytest.mark.django_db
def test_legacy_http_webhook_cannot_be_repointed_to_http(
    admin_client: APIClient, project: Project
) -> None:
    hook = Webhook.objects.create(
        project=project, url="http://legacy.example.com/x", secret="s" * 32, events=["task.created"]
    )
    resp = admin_client.patch(
        f"/api/v1/projects/{project.pk}/webhooks/{hook.pk}/",
        {"url": "http://other.example.com/x"},
        format="json",
    )
    assert resp.status_code == 400
    hook.refresh_from_db()
    assert hook.url == "http://legacy.example.com/x"


@pytest.mark.django_db
def test_test_ping_is_throttled(admin_client: APIClient, project: Project) -> None:
    """The 11th ping inside a minute is 429 (scope ``webhook_test``, 10/min) (#2936)."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    hook = Webhook.objects.create(
        project=project, url="https://hooks.example.com/x", secret="s" * 32, events=["task.created"]
    )
    url = f"/api/v1/projects/{project.pk}/webhooks/{hook.pk}/test/"
    with patch.object(wh_tasks.deliver_webhook, "delay"):
        codes = [admin_client.post(url).status_code for _ in range(11)]
    assert codes[:10] == [202] * 10
    assert codes[10] == 429


@pytest.mark.django_db
def test_create_webhook_rejects_http_on_egress_allowlisted_host(
    admin_client: APIClient, project: Project, settings: object
) -> None:
    """https is mandatory even for an operator-allowlisted host (#2936).

    ``assert_url_allowed`` exempts allowlisted hosts from the private-address
    deny-list, so before the https rule an operator could register ``http://``
    on an in-cluster host. The scheme check is independent of that exemption.
    """
    settings.EGRESS_ALLOWLISTED_HOSTS_WEBHOOKS = ("hooks.internal",)  # type: ignore[attr-defined]
    resp = admin_client.post(
        f"/api/v1/projects/{project.pk}/webhooks/",
        {"url": "http://hooks.internal/x", "secret": "s" * 32, "events": ["task.created"]},
        format="json",
    )
    assert resp.status_code == 400
    assert "url" in resp.data
    assert not Webhook.objects.filter(project=project).exists()


def _resolves_private(*args: object, **kwargs: object) -> list[tuple[object, ...]]:
    import socket

    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", 443))]


@pytest.mark.django_db
@pytest.mark.parametrize("setting", ["EGRESS_ALLOWLISTED_HOSTS", "EGRESS_ALLOWLISTED_HOSTS_SSO"])
def test_create_webhook_rejects_an_sso_allowlisted_internal_host(
    admin_client: APIClient, project: Project, settings: object, setting: str
) -> None:
    """#2851 / #3561: allow-listing an in-cluster IdP for SSO does not open it to webhooks.

    The failure scenario: an operator sets ``TRUEPPM_EGRESS_ALLOWLISTED_HOSTS=keycloak``
    for in-cluster OIDC (the documented use), and a project Admin then registers a
    webhook at ``https://keycloak/admin/...`` to read an internal service.
    """
    setattr(settings, setting, ["keycloak"])
    with patch("socket.getaddrinfo", _resolves_private):
        resp = admin_client.post(
            f"/api/v1/projects/{project.pk}/webhooks/",
            {
                "url": "https://keycloak/admin/realms/x",
                "secret": "s" * 32,
                "events": ["task.created"],
            },
            format="json",
        )
    assert resp.status_code == 400
    assert "url" in resp.data
    assert not Webhook.objects.filter(project=project).exists()


@pytest.mark.django_db
def test_create_webhook_admits_a_webhook_allowlisted_internal_host(
    admin_client: APIClient, project: Project, settings: object
) -> None:
    """An operator CAN still trust an in-cluster receiver — on the webhook list only."""
    settings.EGRESS_ALLOWLISTED_HOSTS_WEBHOOKS = ["hooks.internal"]  # type: ignore[attr-defined]
    with patch("socket.getaddrinfo", _resolves_private):
        resp = admin_client.post(
            f"/api/v1/projects/{project.pk}/webhooks/",
            {"url": "https://hooks.internal/x", "secret": "s" * 32, "events": ["task.created"]},
            format="json",
        )
    assert resp.status_code == 201


@pytest.mark.django_db
def test_deliver_webhook_refuses_an_sso_allowlisted_internal_host(
    project: Project, settings: object
) -> None:
    """The delivery path diverges from SSO too: an SSO-trusted host is refused (#2851).

    Covers a row that predates the split (or was written past the serializer):
    delivery re-validates under the WEBHOOKS purpose, so the SSO exemption the
    operator configured for the IdP does not reach this socket.
    """
    from trueppm_api.apps.integrations import http as egress
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    settings.EGRESS_ALLOWLISTED_HOSTS = ["keycloak"]  # type: ignore[attr-defined]
    settings.EGRESS_ALLOWLISTED_HOSTS_SSO = ["keycloak"]  # type: ignore[attr-defined]
    user = User.objects.create_user(username="ssrf_owner_sso", password="pw")
    webhook = Webhook.objects.create(
        project=project,
        url="https://keycloak/admin/realms/x",
        secret="s3cret",
        events=["task.created"],
        created_by=user,
    )
    delivery = WebhookDelivery.objects.create(
        webhook=webhook, event_type="task.created", payload={"id": "t1"}
    )
    # The SSO purpose still reaches it — the two callers now diverge.
    with patch("socket.getaddrinfo", _resolves_private):
        egress.assert_url_allowed(webhook.url, purpose=egress.EgressPurpose.SSO)
        with (
            patch.object(wh_tasks, "assert_url_allowed", egress.assert_url_allowed),
            patch.object(wh_tasks._no_redirect_opener, "open") as mock_open,
        ):
            wh_tasks.deliver_webhook.run(str(delivery.pk))

    mock_open.assert_not_called()
    delivery.refresh_from_db()
    assert delivery.status == DeliveryStatus.FAILED
