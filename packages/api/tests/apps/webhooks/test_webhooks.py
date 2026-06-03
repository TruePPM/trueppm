"""Tests for outbound webhook subscription management and delivery."""

from __future__ import annotations

import hashlib
import hmac
import urllib.error
import urllib.request
from datetime import date
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.webhooks.models import (
    DeliveryStatus,
    Webhook,
    WebhookDelivery,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="wh_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="WHProject", start_date=date(2026, 3, 1), calendar=calendar)


@pytest.fixture
def admin_client(user: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def viewer_client(project: Project) -> APIClient:
    viewer = User.objects.create_user(username="wh_viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=viewer)
    return c


@pytest.fixture
def member_client(project: Project) -> APIClient:
    member = User.objects.create_user(username="wh_member", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    c = APIClient()
    c.force_authenticate(user=member)
    return c


@pytest.fixture
def webhook(project: Project, user: object) -> Webhook:
    return Webhook.objects.create(
        project=project,
        url="https://example.com/hook",
        secret="test-secret-123",
        events=["task.created", "task.updated"],
        created_by=user,
    )


# ---------------------------------------------------------------------------
# Model tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_webhook_create(project: Project, user: object) -> None:
    wh = Webhook.objects.create(
        project=project,
        url="https://example.com/hook",
        secret="s3cret",
        events=["task.created"],
        created_by=user,
    )
    assert wh.is_active is True
    assert wh.events == ["task.created"]


@pytest.mark.django_db
def test_delivery_create(webhook: Webhook) -> None:
    delivery = WebhookDelivery.objects.create(
        webhook=webhook,
        event_type="task.created",
        payload={"id": "abc"},
    )
    assert delivery.status == DeliveryStatus.PENDING
    assert delivery.attempt_count == 0


# ---------------------------------------------------------------------------
# API tests — CRUD
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_webhook_requires_admin(member_client: APIClient, project: Project) -> None:
    resp = member_client.post(
        f"/api/v1/projects/{project.pk}/webhooks/",
        {"url": "https://example.com/hook", "secret": "s", "events": ["task.created"]},
        format="json",
    )
    assert resp.status_code == 403


@pytest.mark.django_db
def test_create_webhook_as_admin(admin_client: APIClient, project: Project) -> None:
    resp = admin_client.post(
        f"/api/v1/projects/{project.pk}/webhooks/",
        {
            "url": "https://example.com/hook",
            "secret": "a" * 40,  # >= 32-char minimum (#893)
            "events": ["task.created"],
        },
        format="json",
    )
    assert resp.status_code == 201
    assert resp.data["url"] == "https://example.com/hook"
    # Secret is echoed exactly once on create so the caller can record it (#893).
    assert resp.data["secret"] == "a" * 40


@pytest.mark.django_db
def test_list_webhooks_as_viewer(
    viewer_client: APIClient, project: Project, webhook: Webhook
) -> None:
    resp = viewer_client.get(f"/api/v1/projects/{project.pk}/webhooks/")
    assert resp.status_code == 200
    assert len(resp.data["results"]) == 1
    # Secret is not exposed.
    assert "secret" not in resp.data["results"][0]


@pytest.mark.django_db
def test_delete_webhook_requires_admin(
    viewer_client: APIClient, project: Project, webhook: Webhook
) -> None:
    resp = viewer_client.delete(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_delete_webhook_as_admin(
    admin_client: APIClient, project: Project, webhook: Webhook
) -> None:
    resp = admin_client.delete(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/")
    assert resp.status_code == 204
    assert not Webhook.objects.filter(pk=webhook.pk).exists()


# ---------------------------------------------------------------------------
# deliveries audit log — payload is Admin-only (#903)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_deliveries_payload_denied_to_member(
    member_client: APIClient, project: Project, webhook: Webhook
) -> None:
    """A plain project Member must not read the delivery audit log: its payloads
    carry task notes / comment snippets / assignee emails (#903)."""
    WebhookDelivery.objects.create(
        webhook=webhook,
        event_type="task.updated",
        payload={"task": {"notes": "secret internal note", "assignee_email": "a@b.example"}},
    )
    resp = member_client.get(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/deliveries/")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_deliveries_payload_readable_by_admin(
    admin_client: APIClient, project: Project, webhook: Webhook
) -> None:
    """An Admin can read the deliveries (and their payloads)."""
    WebhookDelivery.objects.create(
        webhook=webhook,
        event_type="task.updated",
        payload={"task": {"notes": "secret internal note"}},
    )
    resp = admin_client.get(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/deliveries/")
    assert resp.status_code == 200
    assert len(resp.json()) == 1
    assert resp.json()[0]["payload"]["task"]["notes"] == "secret internal note"


# ---------------------------------------------------------------------------
# Secret validation + one-time echo (#893)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestWebhookSecret:
    """The signing secret must meet a minimum length/entropy floor and is only
    ever echoed once, in the create response."""

    def _create(self, client: APIClient, project: Project, **overrides: object) -> object:
        body: dict[str, object] = {
            "url": "https://example.com/hook",
            "events": ["task.created"],
        }
        body.update(overrides)
        return client.post(f"/api/v1/projects/{project.pk}/webhooks/", body, format="json")

    def test_short_secret_rejected(self, admin_client: APIClient, project: Project) -> None:
        resp = self._create(admin_client, project, secret="short")
        assert resp.status_code == 400
        assert "secret" in resp.data

    def test_whitespace_only_secret_rejected(
        self, admin_client: APIClient, project: Project
    ) -> None:
        resp = self._create(admin_client, project, secret=" " * 40)
        assert resp.status_code == 400
        assert "secret" in resp.data

    def test_omitted_secret_is_autogenerated(
        self, admin_client: APIClient, project: Project
    ) -> None:
        """A blank/omitted secret triggers a strong auto-generated value."""
        resp = self._create(admin_client, project)
        assert resp.status_code == 201, resp.data
        # Echoed once and long enough to be a real secret.
        generated = resp.data["secret"]
        assert isinstance(generated, str)
        assert len(generated) >= 32
        wh = Webhook.objects.get(pk=resp.data["id"])
        assert wh.secret == generated

    def test_empty_string_secret_is_autogenerated(
        self, admin_client: APIClient, project: Project
    ) -> None:
        resp = self._create(admin_client, project, secret="")
        assert resp.status_code == 201, resp.data
        assert len(resp.data["secret"]) >= 32

    def test_valid_secret_accepted(self, admin_client: APIClient, project: Project) -> None:
        resp = self._create(admin_client, project, secret="x" * 32)
        assert resp.status_code == 201, resp.data
        assert resp.data["secret"] == "x" * 32

    def test_secret_never_echoed_on_read(
        self, admin_client: APIClient, project: Project, webhook: Webhook
    ) -> None:
        """Retrieve/list never expose the secret — only the create response does."""
        detail = admin_client.get(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/")
        assert detail.status_code == 200
        assert "secret" not in detail.data
        listing = admin_client.get(f"/api/v1/projects/{project.pk}/webhooks/")
        assert listing.status_code == 200
        assert "secret" not in listing.data["results"][0]

    def test_patch_blank_secret_rejected(
        self, admin_client: APIClient, project: Project, webhook: Webhook
    ) -> None:
        """A PATCH with an empty secret must not silently disable HMAC (#893).

        On CREATE a blank secret auto-generates; on UPDATE it must be rejected so
        an existing webhook can never be left with an empty (verification-off)
        secret.
        """
        original = webhook.secret
        resp = admin_client.patch(
            f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/",
            {"secret": ""},
            format="json",
        )
        assert resp.status_code == 400
        assert "secret" in resp.data
        webhook.refresh_from_db()
        assert webhook.secret == original

    def test_patch_whitespace_secret_rejected(
        self, admin_client: APIClient, project: Project, webhook: Webhook
    ) -> None:
        original = webhook.secret
        resp = admin_client.patch(
            f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/",
            {"secret": " " * 40},
            format="json",
        )
        assert resp.status_code == 400
        assert "secret" in resp.data
        webhook.refresh_from_db()
        assert webhook.secret == original

    def test_patch_omitting_secret_leaves_it_unchanged(
        self, admin_client: APIClient, project: Project, webhook: Webhook
    ) -> None:
        """Omitting `secret` on a PATCH must not overwrite the existing one."""
        original = webhook.secret
        resp = admin_client.patch(
            f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/",
            {"events": ["task.created"]},
            format="json",
        )
        assert resp.status_code == 200, resp.data
        # Secret is write-only — never echoed on a non-create response.
        assert "secret" not in resp.data
        webhook.refresh_from_db()
        assert webhook.secret == original

    def test_patch_valid_secret_rotates(
        self, admin_client: APIClient, project: Project, webhook: Webhook
    ) -> None:
        """A PATCH with a valid ≥32-char secret rotates it (write-only, not echoed)."""
        new_secret = "z" * 40
        resp = admin_client.patch(
            f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/",
            {"secret": new_secret},
            format="json",
        )
        assert resp.status_code == 200, resp.data
        # Rotation is a write — the new secret is never echoed back.
        assert "secret" not in resp.data
        webhook.refresh_from_db()
        assert webhook.secret == new_secret


# ---------------------------------------------------------------------------
# Dispatch tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_dispatch_creates_delivery_and_enqueues(project: Project, webhook: Webhook) -> None:
    """dispatch_webhooks creates a WebhookDelivery and enqueues deliver_webhook."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with patch.object(wh_tasks, "deliver_webhook") as mock_task:
        mock_task.delay = MagicMock()
        from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

        dispatch_webhooks(str(project.pk), "task.created", {"id": "t1"})

        assert WebhookDelivery.objects.count() == 1
        delivery = WebhookDelivery.objects.first()
        assert delivery.event_type == "task.created"
        mock_task.delay.assert_called_once_with(str(delivery.pk))


@pytest.mark.django_db
def test_dispatch_skips_inactive_webhook(project: Project, webhook: Webhook) -> None:
    webhook.is_active = False
    webhook.save()
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with patch.object(wh_tasks, "deliver_webhook") as mock_task:
        mock_task.delay = MagicMock()
        from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

        dispatch_webhooks(str(project.pk), "task.created", {"id": "t1"})

        assert WebhookDelivery.objects.count() == 0
        mock_task.delay.assert_not_called()


@pytest.mark.django_db
def test_dispatch_skips_unsubscribed_event(project: Project, webhook: Webhook) -> None:
    """Webhook subscribes to task.created/updated but not dependency.created."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with patch.object(wh_tasks, "deliver_webhook") as mock_task:
        mock_task.delay = MagicMock()
        from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

        dispatch_webhooks(str(project.pk), "dependency.created", {"id": "d1"})

        assert WebhookDelivery.objects.count() == 0
        mock_task.delay.assert_not_called()


# ---------------------------------------------------------------------------
# Delivery task tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_deliver_webhook_success(webhook: Webhook) -> None:
    """Successful delivery marks status=success and records response_status."""
    delivery = WebhookDelivery.objects.create(
        webhook=webhook,
        event_type="task.created",
        payload={"id": "t1"},
    )

    mock_resp = MagicMock()
    mock_resp.status = 200
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)

    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with (
        patch.object(wh_tasks, "assert_url_allowed"),  # see test_webhook_ssrf.py
        # Delivery uses the redirect-disabled opener (#808), not bare urlopen —
        # patch that or the test hits the real example.com URL.
        patch.object(wh_tasks._no_redirect_opener, "open", return_value=mock_resp),
    ):
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    delivery.refresh_from_db()
    assert delivery.status == DeliveryStatus.SUCCESS
    assert delivery.response_status == 200
    assert delivery.attempt_count == 1
    assert delivery.completed_at is not None


@pytest.mark.django_db
def test_deliver_webhook_hmac_signature(webhook: Webhook) -> None:
    """The delivery includes a valid HMAC-SHA256 signature header."""
    delivery = WebhookDelivery.objects.create(
        webhook=webhook,
        event_type="task.created",
        payload={"id": "t1"},
    )

    captured_req: list[urllib.request.Request] = []

    def capture_open(req: urllib.request.Request, **kwargs: object) -> MagicMock:
        captured_req.append(req)
        resp = MagicMock()
        resp.status = 200
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with (
        patch.object(wh_tasks, "assert_url_allowed"),  # see test_webhook_ssrf.py
        # Delivery uses the redirect-disabled opener (#808), not bare urlopen.
        patch.object(wh_tasks._no_redirect_opener, "open", side_effect=capture_open),
    ):
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    assert len(captured_req) == 1
    req = captured_req[0]
    body = req.data
    expected_sig = hmac.new(
        webhook.secret.encode("utf-8"),
        body,
        hashlib.sha256,
    ).hexdigest()
    assert req.get_header("X-trueppm-signature") == f"sha256={expected_sig}"
    assert req.get_header("X-trueppm-event") == "task.created"


@pytest.mark.django_db
def test_deliver_webhook_non_2xx_retries(webhook: Webhook) -> None:
    """Non-2xx response triggers retry (via self.retry)."""
    delivery = WebhookDelivery.objects.create(
        webhook=webhook,
        event_type="task.created",
        payload={"id": "t1"},
    )

    # Simulate HTTP 500 via HTTPError.
    error = urllib.error.HTTPError(
        url="https://example.com/hook",
        code=500,
        msg="Internal Server Error",
        hdrs=MagicMock(),
        fp=None,
    )

    from trueppm_api.apps.webhooks import tasks as wh_tasks

    retry_exc = Exception("Retry!")
    with (
        patch.object(wh_tasks, "assert_url_allowed"),  # see test_webhook_ssrf.py
        # Delivery uses the redirect-disabled opener (#808), not bare urlopen —
        # patch that or the test hits the real example.com URL.
        patch.object(wh_tasks._no_redirect_opener, "open", side_effect=error),
        patch.object(wh_tasks.deliver_webhook, "retry", side_effect=retry_exc) as mock_retry,
        pytest.raises(Exception, match="Retry"),
    ):
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    delivery.refresh_from_db()
    assert delivery.attempt_count == 1
    assert delivery.status == DeliveryStatus.PENDING  # Not yet failed — retry pending
    mock_retry.assert_called_once()


# ---------------------------------------------------------------------------
# Test ping
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_test_ping(admin_client: APIClient, project: Project, webhook: Webhook) -> None:
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with patch.object(wh_tasks, "deliver_webhook") as mock_task:
        mock_task.delay = MagicMock()
        resp = admin_client.post(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/test/")
    assert resp.status_code == 202
    assert "delivery_id" in resp.data


@pytest.mark.django_db
def test_test_ping_deferred_via_on_commit(
    admin_client: APIClient,
    project: Project,
    webhook: Webhook,
    django_capture_on_commit_callbacks: object,
) -> None:
    """deliver_webhook.delay is called inside transaction.on_commit, not immediately."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    calls: list[str] = []

    def record_delay(delivery_id: str) -> None:
        calls.append(delivery_id)

    with (
        patch.object(wh_tasks.deliver_webhook, "delay", side_effect=record_delay),
        django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
    ):
        resp = admin_client.post(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/test/")

    assert resp.status_code == 202
    delivery_id = resp.data["delivery_id"]
    assert len(calls) == 1
    assert calls[0] == delivery_id
    delivery = WebhookDelivery.objects.get(pk=delivery_id)
    assert delivery.event_type == "ping"


@pytest.mark.django_db
def test_test_ping_broker_unavailable_delivery_stays_pending(
    admin_client: APIClient,
    project: Project,
    webhook: Webhook,
    django_capture_on_commit_callbacks: object,
) -> None:
    """Broker down: delivery row committed but not enqueued; drain can recover it."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with (
        patch.object(
            wh_tasks.deliver_webhook,
            "delay",
            side_effect=ConnectionError("broker down"),
        ),
        django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
    ):
        resp = admin_client.post(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/test/")

    assert resp.status_code == 202
    delivery_id = resp.data["delivery_id"]
    delivery = WebhookDelivery.objects.get(pk=delivery_id)
    # Row was committed; attempt_count stays 0 so drain can re-enqueue it.
    assert delivery.attempt_count == 0


# ---------------------------------------------------------------------------
# dispatch_webhooks — broker failure coverage
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_dispatch_webhooks_broker_unavailable_swallowed(project: Project, webhook: Webhook) -> None:
    """Broker failure in dispatch_webhooks is swallowed; delivery row stays PENDING."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks
    from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

    with patch.object(
        wh_tasks.deliver_webhook, "delay", side_effect=ConnectionError("broker down")
    ):
        dispatch_webhooks(str(project.pk), "task.created", {"id": "t1"})  # must not raise

    assert WebhookDelivery.objects.count() == 1
    delivery = WebhookDelivery.objects.first()
    # attempt_count 0 means the drain can pick it up.
    assert delivery.attempt_count == 0
    assert delivery.status == DeliveryStatus.PENDING


# ---------------------------------------------------------------------------
# deliver_webhook task attributes
# ---------------------------------------------------------------------------


def test_deliver_webhook_reject_on_worker_lost() -> None:
    """deliver_webhook must have reject_on_worker_lost=True for at-least-once delivery."""
    from trueppm_api.apps.webhooks.tasks import deliver_webhook

    assert getattr(deliver_webhook, "reject_on_worker_lost", False) is True
