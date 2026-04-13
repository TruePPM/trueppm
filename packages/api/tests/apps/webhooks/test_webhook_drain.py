"""Tests for the webhook delivery drain task (_do_drain_webhooks / drain_webhook_queue).

Covers:
  - Stranded PENDING deliveries (attempt_count==0, old enough) are re-dispatched
  - Recent PENDING deliveries are left alone (within the orphan window)
  - Deliveries with attempt_count > 0 are not touched (Celery retry chain is live)
  - Inactive webhook deliveries are marked FAILED without dispatching
  - Broker unavailability leaves the delivery PENDING
  - SUCCESS and FAILED deliveries are never touched
  - drain_webhook_queue task has correct idempotent_task configuration
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.utils import timezone

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def project(db: object) -> object:
    from trueppm_api.apps.projects.models import Project

    return Project.objects.create(name="Webhook Test Project", start_date="2026-01-01")


@pytest.fixture()
def webhook(project: object) -> object:
    from trueppm_api.apps.webhooks.models import Webhook

    return Webhook.objects.create(
        project=project,
        url="https://example.com/hook",
        secret="s3cr3t",
        events=["task.created"],
        is_active=True,
    )


def _make_delivery(
    webhook: object,
    *,
    status: str = "pending",
    attempt_count: int = 0,
    age_minutes: int = 10,
) -> object:
    from trueppm_api.apps.webhooks.models import WebhookDelivery

    delivery = WebhookDelivery.objects.create(
        webhook=webhook,
        event_type="task.created",
        payload={"task_id": str(uuid.uuid4())},
        status=status,
        attempt_count=attempt_count,
    )
    # Back-date created_at to simulate age
    WebhookDelivery.objects.filter(pk=delivery.pk).update(
        created_at=timezone.now() - timedelta(minutes=age_minutes),
    )
    delivery.refresh_from_db()
    return delivery


def _drain() -> None:
    from trueppm_api.apps.webhooks.tasks import _do_drain_webhooks

    _do_drain_webhooks()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDoDrainWebhooks:
    def test_dispatches_stranded_pending_delivery(self, webhook: object) -> None:
        """A PENDING delivery older than 5 min with attempt_count==0 is re-dispatched."""
        delivery = _make_delivery(webhook, age_minutes=10)
        with patch("trueppm_api.apps.webhooks.tasks.deliver_webhook.delay") as mock_delay:
            _drain()

        mock_delay.assert_called_once_with(str(delivery.pk))

    def test_ignores_recent_pending_delivery(self, webhook: object) -> None:
        """Deliveries created within the orphan window are not touched."""
        _make_delivery(webhook, age_minutes=2)
        with patch("trueppm_api.apps.webhooks.tasks.deliver_webhook.delay") as mock_delay:
            _drain()

        mock_delay.assert_not_called()

    def test_ignores_retrying_delivery(self, webhook: object) -> None:
        """attempt_count > 0 means Celery retry chain is active — do not re-dispatch."""
        _make_delivery(webhook, attempt_count=2, age_minutes=10)
        with patch("trueppm_api.apps.webhooks.tasks.deliver_webhook.delay") as mock_delay:
            _drain()

        mock_delay.assert_not_called()

    def test_marks_inactive_webhook_delivery_failed(self, webhook: object) -> None:
        """Stranded delivery for an inactive webhook is marked FAILED, not dispatched."""
        from trueppm_api.apps.webhooks.models import DeliveryStatus

        webhook.is_active = False
        webhook.save(update_fields=["is_active"])
        delivery = _make_delivery(webhook, age_minutes=10)

        with patch("trueppm_api.apps.webhooks.tasks.deliver_webhook.delay") as mock_delay:
            _drain()

        mock_delay.assert_not_called()
        delivery.refresh_from_db()
        assert delivery.status == DeliveryStatus.FAILED
        assert delivery.completed_at is not None

    def test_broker_down_leaves_delivery_pending(self, webhook: object) -> None:
        """If .delay() raises, delivery stays PENDING for the next drain tick."""
        from trueppm_api.apps.webhooks.models import DeliveryStatus

        delivery = _make_delivery(webhook, age_minutes=10)
        with patch(
            "trueppm_api.apps.webhooks.tasks.deliver_webhook.delay",
            side_effect=ConnectionError("broker down"),
        ):
            _drain()  # must not raise

        delivery.refresh_from_db()
        assert delivery.status == DeliveryStatus.PENDING

    def test_does_not_touch_success_deliveries(self, webhook: object) -> None:
        """SUCCESS deliveries are never re-dispatched."""
        _make_delivery(webhook, status="success", age_minutes=10)
        with patch("trueppm_api.apps.webhooks.tasks.deliver_webhook.delay") as mock_delay:
            _drain()

        mock_delay.assert_not_called()

    def test_does_not_touch_failed_deliveries(self, webhook: object) -> None:
        """FAILED deliveries are never re-dispatched."""
        _make_delivery(webhook, status="failed", age_minutes=10)
        with patch("trueppm_api.apps.webhooks.tasks.deliver_webhook.delay") as mock_delay:
            _drain()

        mock_delay.assert_not_called()

    def test_no_pending_deliveries_does_nothing(self, db: object) -> None:
        with patch("trueppm_api.apps.webhooks.tasks.deliver_webhook.delay") as mock_delay:
            _drain()

        mock_delay.assert_not_called()


@pytest.mark.django_db
class TestDrainWebhookQueueTask:
    def test_task_has_skip_contention(self) -> None:
        from trueppm_api.apps.webhooks.tasks import drain_webhook_queue

        assert drain_webhook_queue._idempotent_config["on_contention"] == "skip"  # type: ignore[attr-defined]

    def test_task_has_correct_time_limits(self) -> None:
        from trueppm_api.apps.webhooks.tasks import drain_webhook_queue

        assert drain_webhook_queue.soft_time_limit == 25
        assert drain_webhook_queue.time_limit == 30

    def test_task_acks_late(self) -> None:
        from trueppm_api.apps.webhooks.tasks import drain_webhook_queue

        assert drain_webhook_queue.acks_late is True
