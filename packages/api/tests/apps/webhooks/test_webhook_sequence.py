"""Tests for per-subscription outgoing webhook sequence numbers (#664).

Sequence numbers are a delivery-ordering *hint* for consumers: monotonic and
contiguous per subscription, stable across retries, and never reused even after
the retention purge deletes delivery rows.
"""

from __future__ import annotations

import importlib
import json
import urllib.request
from datetime import date, timedelta
from types import ModuleType
from unittest.mock import MagicMock, patch

import pytest
from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.utils import timezone

from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.webhooks.models import Webhook, WebhookDelivery

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="seq_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="SeqProject", start_date=date(2026, 3, 1), calendar=calendar)


@pytest.fixture
def webhook(project: Project, user: object) -> Webhook:
    return Webhook.objects.create(
        project=project,
        url="https://example.com/hook",
        secret="test-secret-123",
        events=["task.created", "task.updated"],
        created_by=user,
    )


def _make_delivery(webhook: Webhook, event_type: str = "task.created") -> WebhookDelivery:
    return WebhookDelivery.objects.create(
        webhook=webhook,
        event_type=event_type,
        payload={"id": "t1"},
    )


# ---------------------------------------------------------------------------
# Allocation: monotonic and contiguous per subscription
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sequence_starts_at_one(webhook: Webhook) -> None:
    delivery = _make_delivery(webhook)
    assert delivery.sequence_number == 1


@pytest.mark.django_db
def test_sequence_is_monotonic_per_subscription(webhook: Webhook) -> None:
    """Successive deliveries to the same subscription get contiguous numbers."""
    numbers = [_make_delivery(webhook).sequence_number for _ in range(5)]
    assert numbers == [1, 2, 3, 4, 5]
    webhook.refresh_from_db()
    assert webhook.delivery_sequence == 5


@pytest.mark.django_db
def test_sequence_is_independent_per_subscription(project: Project, user: object) -> None:
    """Each subscription has its own counter; they do not interleave."""
    hook_a = Webhook.objects.create(
        project=project, url="https://a.example/h", secret="s", events=["task.created"]
    )
    hook_b = Webhook.objects.create(
        project=project, url="https://b.example/h", secret="s", events=["task.created"]
    )

    assert _make_delivery(hook_a).sequence_number == 1
    assert _make_delivery(hook_b).sequence_number == 1
    assert _make_delivery(hook_a).sequence_number == 2
    assert _make_delivery(hook_a).sequence_number == 3
    assert _make_delivery(hook_b).sequence_number == 2


# ---------------------------------------------------------------------------
# Stability across retries
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sequence_stable_across_retries(webhook: Webhook) -> None:
    """The same delivery row keeps its sequence number when re-saved on retry."""
    delivery = _make_delivery(webhook)
    original = delivery.sequence_number

    # Simulate the retry path: deliver_webhook mutates and re-saves the row.
    delivery.attempt_count += 1
    delivery.save(update_fields=["attempt_count"])
    delivery.refresh_from_db()
    assert delivery.sequence_number == original

    # A full save() (not just update_fields) must also not re-number it.
    delivery.save()
    delivery.refresh_from_db()
    assert delivery.sequence_number == original

    # The subscription counter did not advance from the re-saves.
    webhook.refresh_from_db()
    assert webhook.delivery_sequence == original


@pytest.mark.django_db
def test_deliver_webhook_does_not_renumber(webhook: Webhook) -> None:
    """Running the delivery task does not change the allocated sequence."""
    delivery = _make_delivery(webhook)
    original = delivery.sequence_number

    mock_resp = MagicMock()
    mock_resp.status = 200
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)

    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with (
        patch.object(wh_tasks, "assert_url_allowed"),  # see test_webhook_ssrf.py
        # Delivery uses the redirect-disabled opener (#808), not bare urlopen.
        patch.object(wh_tasks._no_redirect_opener, "open", return_value=mock_resp),
    ):
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    delivery.refresh_from_db()
    assert delivery.sequence_number == original


# ---------------------------------------------------------------------------
# No reuse after purge (ADR-0081 interaction)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_sequence_not_reused_after_delivery_purge(webhook: Webhook) -> None:
    """The counter lives on the subscription, so purging deliveries never reuses
    a number — a gap at the consumer stays a genuine gap.
    """
    first = _make_delivery(webhook)
    second = _make_delivery(webhook)
    assert [first.sequence_number, second.sequence_number] == [1, 2]

    # Simulate the retention purge deleting terminal delivery rows.
    WebhookDelivery.objects.all().delete()

    third = _make_delivery(webhook)
    assert third.sequence_number == 3  # not 1 — counter survived the purge


# ---------------------------------------------------------------------------
# Delivery transport: header
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_deliver_webhook_sends_sequence_header(webhook: Webhook) -> None:
    """deliver_webhook sends X-TruePPM-Webhook-Sequence matching the row."""
    _make_delivery(webhook)  # seq 1
    delivery = _make_delivery(webhook)  # seq 2

    captured: list[urllib.request.Request] = []

    def capture_open(req: urllib.request.Request, **kwargs: object) -> MagicMock:
        captured.append(req)
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

    assert len(captured) == 1
    # urllib normalizes header names to Title-case-first only.
    assert captured[0].get_header("X-trueppm-webhook-sequence") == "2"


# ---------------------------------------------------------------------------
# Delivery transport: body carries the sequence under _meta (#715, ADR-0089)
# ---------------------------------------------------------------------------

# A realistic generic body is the flat task dict from _task_webhook_payload —
# domain fields at the top level. The sequence must live under a reserved _meta
# namespace so it cannot collide with a domain field of the same name.
_FLAT_TASK_PAYLOAD = {"id": "t1", "project": "p1", "name": "Design review", "status": "todo"}


@pytest.mark.django_db
def test_dispatch_injects_sequence_into_generic_body(project: Project, webhook: Webhook) -> None:
    """The stored/delivered generic body carries ``_meta.sequence``, monotonic per
    subscription, leaving the flat domain fields untouched."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks
    from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

    with patch.object(wh_tasks.deliver_webhook, "delay", MagicMock()):
        dispatch_webhooks(str(project.pk), "task.created", dict(_FLAT_TASK_PAYLOAD))
        dispatch_webhooks(str(project.pk), "task.updated", dict(_FLAT_TASK_PAYLOAD))

    deliveries = list(WebhookDelivery.objects.order_by("sequence_number"))
    assert [d.payload["_meta"]["sequence"] for d in deliveries] == [1, 2]
    # The flat domain fields are preserved untouched alongside the _meta key.
    assert deliveries[0].payload["id"] == "t1"
    assert deliveries[0].payload["status"] == "todo"
    # _meta.sequence mirrors the column exactly (same value in body and header).
    assert deliveries[0].payload["_meta"]["sequence"] == deliveries[0].sequence_number


@pytest.mark.django_db
def test_dispatch_injects_sequence_into_slack_body(project: Project, user: object) -> None:
    """The slack renderer's ``{text, attachments}`` body also carries ``_meta`` as
    an additive top-level key (Slack ignores unknown fields)."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks
    from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

    slack_hook = Webhook.objects.create(
        project=project,
        url="https://hooks.slack.com/services/T/B/x",
        secret="s",
        events=["task.created"],
        format="slack",
        created_by=user,
    )

    with patch.object(wh_tasks.deliver_webhook, "delay", MagicMock()):
        dispatch_webhooks(str(project.pk), "task.created", dict(_FLAT_TASK_PAYLOAD))

    delivery = WebhookDelivery.objects.get(webhook=slack_hook)
    assert delivery.payload["_meta"]["sequence"] == 1
    assert "text" in delivery.payload  # slack shape intact
    assert "attachments" in delivery.payload


@pytest.mark.django_db
def test_body_sequence_does_not_leak_across_subscriptions(project: Project, user: object) -> None:
    """A single fan-out renders the shared event payload per subscription; the
    generic provider returns that dict by reference, so each row must still get
    its own number without one subscription's sequence bleeding into another."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks
    from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

    hook_a = Webhook.objects.create(
        project=project, url="https://a.example/h", secret="s", events=["task.created"]
    )
    hook_b = Webhook.objects.create(
        project=project, url="https://b.example/h", secret="s", events=["task.created"]
    )

    with patch.object(wh_tasks.deliver_webhook, "delay", MagicMock()):
        dispatch_webhooks(str(project.pk), "task.created", dict(_FLAT_TASK_PAYLOAD))

    # First delivery to each independent subscription is 1 — no cross-contamination.
    assert WebhookDelivery.objects.get(webhook=hook_a).payload["_meta"]["sequence"] == 1
    assert WebhookDelivery.objects.get(webhook=hook_b).payload["_meta"]["sequence"] == 1


@pytest.mark.django_db
def test_delivered_body_carries_sequence_stable_across_retries(webhook: Webhook) -> None:
    """The POSTed body carries ``_meta.sequence`` matching the header, and re-running
    the same delivery (a retry) posts the same number — the frozen body is never
    renumbered."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks
    from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

    with patch.object(wh_tasks.deliver_webhook, "delay", MagicMock()):
        dispatch_webhooks(str(webhook.project_id), "task.created", dict(_FLAT_TASK_PAYLOAD))
    delivery = WebhookDelivery.objects.get()

    captured: list[bytes] = []

    def capture_open(req: urllib.request.Request, **kwargs: object) -> MagicMock:
        captured.append(req.data)
        resp = MagicMock()
        resp.status = 200
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    with (
        patch.object(wh_tasks, "assert_url_allowed"),  # see test_webhook_ssrf.py
        # Delivery uses the redirect-disabled opener (#808), not bare urlopen.
        patch.object(wh_tasks._no_redirect_opener, "open", side_effect=capture_open),
    ):
        wh_tasks.deliver_webhook.run(str(delivery.pk))  # first attempt
        wh_tasks.deliver_webhook.run(str(delivery.pk))  # simulated retry

    bodies = [json.loads(b) for b in captured]
    assert [b["_meta"]["sequence"] for b in bodies] == [1, 1]
    assert bodies[0]["_meta"]["sequence"] == delivery.sequence_number


# ---------------------------------------------------------------------------
# Dispatch and inspection endpoint
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_dispatch_assigns_sequence(project: Project, webhook: Webhook) -> None:
    """dispatch_webhooks-created deliveries carry a sequence number."""
    from trueppm_api.apps.webhooks import tasks as wh_tasks
    from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

    with patch.object(wh_tasks.deliver_webhook, "delay", MagicMock()):
        dispatch_webhooks(str(project.pk), "task.created", {"id": "t1"})
        dispatch_webhooks(str(project.pk), "task.updated", {"id": "t1"})

    seqs = sorted(WebhookDelivery.objects.values_list("sequence_number", flat=True))
    assert seqs == [1, 2]


@pytest.mark.django_db
def test_deliveries_endpoint_exposes_sequence(
    webhook: Webhook, project: Project, user: object
) -> None:
    """The delivery inspection endpoint returns sequence_number for consumers."""
    from rest_framework.test import APIClient

    from trueppm_api.apps.access.models import ProjectMembership, Role

    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    _make_delivery(webhook)
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.get(f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/deliveries/")
    assert resp.status_code == 200
    assert resp.data[0]["sequence_number"] == 1


# ---------------------------------------------------------------------------
# Migration 0005 backfill (#664)
# ---------------------------------------------------------------------------


def _set_created_at(delivery: WebhookDelivery, when: object) -> None:
    """Stamp ``created_at`` directly (it is ``auto_now_add``, so the model never
    lets us set it through ``save()``) to make backfill ordering deterministic."""
    WebhookDelivery.objects.filter(pk=delivery.pk).update(created_at=when)


def _reset_to_pre_migration_state(*webhooks: Webhook) -> None:
    """Simulate the rows as they looked before migration 0005 ran: every
    sequence field at its ``default=0``, as if the columns were just added."""
    WebhookDelivery.objects.all().update(sequence_number=0)
    for hook in webhooks:
        Webhook.objects.filter(pk=hook.pk).update(delivery_sequence=0)


@pytest.mark.django_db
class TestBackfillSequenceNumbers:
    """The 0005 RunPython helpers number historical deliveries per subscription.

    The forward helper is invoked directly with the live app registry (the same
    pattern as the WBS backfill test) because Django applies migrations before
    any rows exist, so the loop body is never exercised by ordinary test setup.
    """

    def _migration(self) -> ModuleType:
        return importlib.import_module(
            "trueppm_api.apps.webhooks.migrations.0005_webhook_delivery_sequence_numbers"
        )

    def test_backfill_numbers_by_created_at_not_insertion_order(self, webhook: Webhook) -> None:
        # Insert in one order, then rewrite created_at into a different order so
        # the assertion proves the backfill keys off created_at, not PK/insertion.
        first_inserted = _make_delivery(webhook)
        second_inserted = _make_delivery(webhook)
        third_inserted = _make_delivery(webhook)

        base = timezone.now()
        _set_created_at(third_inserted, base)  # earliest
        _set_created_at(first_inserted, base + timedelta(minutes=1))
        _set_created_at(second_inserted, base + timedelta(minutes=2))  # latest

        _reset_to_pre_migration_state(webhook)
        self._migration().backfill_sequence_numbers(django_apps, None)

        third_inserted.refresh_from_db()
        first_inserted.refresh_from_db()
        second_inserted.refresh_from_db()
        assert third_inserted.sequence_number == 1
        assert first_inserted.sequence_number == 2
        assert second_inserted.sequence_number == 3

        # The subscription counter continues from the highest backfilled value,
        # so the next live delivery does not collide with a historical one.
        webhook.refresh_from_db()
        assert webhook.delivery_sequence == 3
        assert _make_delivery(webhook).sequence_number == 4

    def test_backfill_is_independent_per_subscription(self, project: Project, user: object) -> None:
        hook_a = Webhook.objects.create(
            project=project, url="https://a.example/h", secret="s", events=["task.created"]
        )
        hook_b = Webhook.objects.create(
            project=project, url="https://b.example/h", secret="s", events=["task.created"]
        )
        _make_delivery(hook_a)
        _make_delivery(hook_a)
        _make_delivery(hook_b)

        _reset_to_pre_migration_state(hook_a, hook_b)
        self._migration().backfill_sequence_numbers(django_apps, None)

        hook_a.refresh_from_db()
        hook_b.refresh_from_db()
        assert hook_a.delivery_sequence == 2
        assert hook_b.delivery_sequence == 1
        a_seqs = sorted(
            WebhookDelivery.objects.filter(webhook=hook_a).values_list("sequence_number", flat=True)
        )
        b_seqs = sorted(
            WebhookDelivery.objects.filter(webhook=hook_b).values_list("sequence_number", flat=True)
        )
        assert a_seqs == [1, 2]
        assert b_seqs == [1]

    def test_backfill_leaves_counter_at_zero_for_subscription_with_no_deliveries(
        self, webhook: Webhook
    ) -> None:
        _reset_to_pre_migration_state(webhook)
        self._migration().backfill_sequence_numbers(django_apps, None)

        webhook.refresh_from_db()
        assert webhook.delivery_sequence == 0  # `if seq > 0` guard skips the update

    def test_reverse_backfill_zeroes_all_sequences(self, webhook: Webhook) -> None:
        _make_delivery(webhook)
        _make_delivery(webhook)

        self._migration().reverse_backfill(django_apps, None)

        webhook.refresh_from_db()
        assert webhook.delivery_sequence == 0
        assert list(WebhookDelivery.objects.values_list("sequence_number", flat=True)) == [0, 0]
