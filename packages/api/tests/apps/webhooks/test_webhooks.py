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
        {"url": "https://example.com/hook", "secret": "s3cret", "events": ["task.created"]},
        format="json",
    )
    assert resp.status_code == 201
    assert resp.data["url"] == "https://example.com/hook"
    # Secret is write-only — not returned.
    assert "secret" not in resp.data


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

    with patch.object(urllib.request, "urlopen", return_value=mock_resp):
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

    def capture_urlopen(req: urllib.request.Request, **kwargs: object) -> MagicMock:
        captured_req.append(req)
        resp = MagicMock()
        resp.status = 200
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with patch.object(urllib.request, "urlopen", side_effect=capture_urlopen):
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
        patch.object(urllib.request, "urlopen", side_effect=error),
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
