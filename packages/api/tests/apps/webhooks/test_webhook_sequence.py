"""Tests for per-subscription outgoing webhook sequence numbers (#664).

Sequence numbers are a delivery-ordering *hint* for consumers: monotonic and
contiguous per subscription, stable across retries, and never reused even after
the retention purge deletes delivery rows.
"""

from __future__ import annotations

import urllib.request
from datetime import date
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model

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

    with patch.object(urllib.request, "urlopen", return_value=mock_resp):
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

    def capture_urlopen(req: urllib.request.Request, **kwargs: object) -> MagicMock:
        captured.append(req)
        resp = MagicMock()
        resp.status = 200
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    from trueppm_api.apps.webhooks import tasks as wh_tasks

    with patch.object(urllib.request, "urlopen", side_effect=capture_urlopen):
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    assert len(captured) == 1
    # urllib normalizes header names to Title-case-first only.
    assert captured[0].get_header("X-trueppm-webhook-sequence") == "2"


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
