"""Tests for the webhook delivery retention purge (_do_webhook_purge / purge_old_deliveries).

Covers (ADR-0081, issue #661):
  - Terminal (SUCCESS/FAILED) deliveries older than the window are deleted
  - PENDING deliveries are never purged regardless of age (the drain may re-dispatch)
  - Recent terminal deliveries are preserved
  - A custom TRUEPPM_WEBHOOK_RETENTION_DAYS window is respected
  - TRUEPPM_WEBHOOK_RETENTION_DAYS=None disables the purge entirely
  - purge_old_deliveries has the expected idempotent_task configuration
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.utils import timezone


@pytest.fixture()
def project(db: object) -> object:
    from trueppm_api.apps.projects.models import Project

    return Project.objects.create(name="Webhook Purge Project", start_date="2026-01-01")


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


def _make_delivery(webhook: object, *, status: str, age_days: float) -> object:
    from trueppm_api.apps.webhooks.models import WebhookDelivery

    delivery = WebhookDelivery.objects.create(
        webhook=webhook,
        event_type="task.created",
        payload={"task_id": str(uuid.uuid4())},
        status=status,
    )
    # auto_now_add bypasses kwargs; back-date created_at via an update.
    WebhookDelivery.objects.filter(pk=delivery.pk).update(
        created_at=timezone.now() - timedelta(days=age_days),
    )
    return delivery


def _purge() -> None:
    from trueppm_api.apps.webhooks.tasks import _do_webhook_purge

    _do_webhook_purge()


@pytest.mark.django_db
class TestWebhookPurge:
    def test_deletes_old_success_rows(self, webhook: object) -> None:
        from trueppm_api.apps.webhooks.models import DeliveryStatus, WebhookDelivery

        d = _make_delivery(webhook, status=DeliveryStatus.SUCCESS, age_days=8)
        _purge()
        assert not WebhookDelivery.objects.filter(pk=d.pk).exists()

    def test_deletes_old_failed_rows(self, webhook: object) -> None:
        from trueppm_api.apps.webhooks.models import DeliveryStatus, WebhookDelivery

        d = _make_delivery(webhook, status=DeliveryStatus.FAILED, age_days=8)
        _purge()
        assert not WebhookDelivery.objects.filter(pk=d.pk).exists()

    def test_preserves_pending_rows_regardless_of_age(self, webhook: object) -> None:
        from trueppm_api.apps.webhooks.models import DeliveryStatus, WebhookDelivery

        # PENDING is non-terminal — the drain may still re-dispatch it, so even an
        # ancient PENDING row must survive the purge.
        d = _make_delivery(webhook, status=DeliveryStatus.PENDING, age_days=365)
        _purge()
        assert WebhookDelivery.objects.filter(pk=d.pk).exists()

    def test_preserves_recent_terminal_rows(self, webhook: object) -> None:
        from trueppm_api.apps.webhooks.models import DeliveryStatus, WebhookDelivery

        d = _make_delivery(webhook, status=DeliveryStatus.SUCCESS, age_days=1)
        _purge()
        assert WebhookDelivery.objects.filter(pk=d.pk).exists()

    def test_respects_custom_retention_window(self, webhook: object) -> None:
        from trueppm_api.apps.webhooks.models import DeliveryStatus, WebhookDelivery

        # 10 days old: purged under the default 7-day window, kept under 30 days.
        kept = _make_delivery(webhook, status=DeliveryStatus.SUCCESS, age_days=10)
        # 40 days old: beyond the 30-day window.
        purged = _make_delivery(webhook, status=DeliveryStatus.FAILED, age_days=40)
        with patch("django.conf.settings.TRUEPPM_WEBHOOK_RETENTION_DAYS", 30):
            _purge()
        assert WebhookDelivery.objects.filter(pk=kept.pk).exists()
        assert not WebhookDelivery.objects.filter(pk=purged.pk).exists()

    def test_disabled_when_retention_none(self, webhook: object) -> None:
        from trueppm_api.apps.webhooks.models import DeliveryStatus, WebhookDelivery

        d = _make_delivery(webhook, status=DeliveryStatus.SUCCESS, age_days=999)
        with patch("django.conf.settings.TRUEPPM_WEBHOOK_RETENTION_DAYS", None):
            _purge()
        assert WebhookDelivery.objects.filter(pk=d.pk).exists()

    def test_task_idempotent_config(self) -> None:
        from trueppm_api.apps.webhooks.tasks import purge_old_deliveries

        assert purge_old_deliveries.name == "webhooks.purge_old_deliveries"
        assert getattr(purge_old_deliveries, "reject_on_worker_lost", False) is True
