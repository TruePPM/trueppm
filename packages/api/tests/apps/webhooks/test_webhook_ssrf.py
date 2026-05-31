"""SSRF guard tests for webhook registration and delivery (#768).

Webhook.url is configured by a project admin (an RBAC role, not an infra
operator), so outbound delivery is untrusted egress. The serializer rejects
obviously unsafe targets at registration and ``deliver_webhook`` re-checks at
delivery time as the authoritative guard. Both route through the shared
integrations egress chokepoint (``assert_url_allowed``, ADR-0049 §3).
"""

from __future__ import annotations

import contextlib
import urllib.request
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

    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with patch.object(urllib.request, "urlopen") as mock_urlopen:
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    mock_urlopen.assert_not_called()
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
