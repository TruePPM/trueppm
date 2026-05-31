"""Tests for the #638 webhook format extension (ADR-0083).

Covers the OUTGOING_CHANNEL_PROVIDERS registry registration, the generic and
slack renderers, per-webhook rendering in dispatch, the serializer format
validation, and the 11-event hard cap.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.integrations.outgoing import (
    GenericOutgoingChannelProvider,
    SlackOutgoingChannelProvider,
)
from trueppm_api.apps.integrations.registry import (
    OUTGOING_CHANNEL_PROVIDERS,
    OutgoingChannelEvent,
)
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.webhooks.models import (
    ALL_WEBHOOK_EVENTS,
    OSS_WEBHOOK_EVENT_CAP,
    Webhook,
    WebhookDelivery,
    WebhookEventType,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="fmt_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="FmtProject", start_date=date(2026, 3, 1), calendar=calendar)


@pytest.fixture
def admin_client(user: object, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# ---------------------------------------------------------------------------
# Event-type hard cap (ADR-0083)
# ---------------------------------------------------------------------------


def test_event_type_cap() -> None:
    """The OSS webhook event set is capped at 11 — a 12th requires its own ADR.

    If this fails because someone added a new WebhookEventType, do not just bump
    the number: the cap is the gate against per-customer event proliferation
    (the Enterprise upsell). Adding an event is a deliberate ADR-0083 decision.
    """
    assert len(ALL_WEBHOOK_EVENTS) == OSS_WEBHOOK_EVENT_CAP == 11
    assert set(ALL_WEBHOOK_EVENTS) == {
        "task.created",
        "task.updated",
        "task.deleted",
        "dependency.created",
        "dependency.deleted",
        "schedule.recalculated",
        "project.created",
        "task.assigned",
        "task.assignee_changed",
        "task.mentioned",
        "task.due_date_changed",
    }


# ---------------------------------------------------------------------------
# Provider registry + renderers
# ---------------------------------------------------------------------------


def test_oss_providers_registered() -> None:
    """generic + slack are registered at AppConfig.ready()."""
    assert "generic" in OUTGOING_CHANNEL_PROVIDERS
    assert "slack" in OUTGOING_CHANNEL_PROVIDERS
    assert OUTGOING_CHANNEL_PROVIDERS.get("generic") is GenericOutgoingChannelProvider
    assert OUTGOING_CHANNEL_PROVIDERS.get("slack") is SlackOutgoingChannelProvider


def test_generic_render_is_passthrough() -> None:
    """The generic provider returns the payload unchanged (historical behavior)."""
    payload = {"id": "t1", "name": "Pour", "status": "in_progress"}
    event = OutgoingChannelEvent(event_type="task.updated", project_id="p1", payload=payload)
    assert GenericOutgoingChannelProvider().render(event) == payload


def test_slack_render_shape() -> None:
    """The slack provider builds a text + single-attachment message."""
    payload = {
        "id": "t1",
        "name": "Foundation pour",
        "status": "in_progress",
        "assignee": "u9",
        "planned_start": "2026-08-12",
    }
    event = OutgoingChannelEvent(event_type="task.assigned", project_id="p1", payload=payload)
    rendered = SlackOutgoingChannelProvider().render(event)

    assert "Task assigned" in rendered["text"]
    assert "Foundation pour" in rendered["text"]
    assert len(rendered["attachments"]) == 1
    attachment = rendered["attachments"][0]
    assert attachment["title"] == "Foundation pour"
    assert attachment["footer"] == "TruePPM"
    field_titles = {f["title"] for f in attachment["fields"]}
    assert {"Status", "Assignee", "Planned start"} <= field_titles


def test_slack_render_omits_absent_fields() -> None:
    """task.deleted carries only id+project — no empty Status/Assignee rows."""
    payload = {"id": "t1", "project": "p1"}
    event = OutgoingChannelEvent(event_type="task.deleted", project_id="p1", payload=payload)
    rendered = SlackOutgoingChannelProvider().render(event)
    assert rendered["attachments"][0]["fields"] == []


# ---------------------------------------------------------------------------
# Per-webhook rendering in dispatch
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_dispatch_renders_per_webhook_format(project: Project, user: object) -> None:
    """Each subscription renders with its own format; deliver_webhook unchanged.

    A slack webhook and a generic webhook on the same event get differently
    rendered delivery payloads — the rendered dict is frozen onto each row.
    """
    slack_hook = Webhook.objects.create(
        project=project,
        url="https://hooks.slack.com/services/x",
        secret="s",
        events=["task.created"],
        format="slack",
        created_by=user,
    )
    generic_hook = Webhook.objects.create(
        project=project,
        url="https://example.com/hook",
        secret="s",
        events=["task.created"],
        format="generic",
        created_by=user,
    )

    payload = {"id": "t1", "name": "Pour", "status": "not_started"}
    import trueppm_api.apps.webhooks.tasks as wh_tasks

    with patch.object(wh_tasks, "deliver_webhook") as mock_task:
        mock_task.delay = MagicMock()
        from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

        dispatch_webhooks(str(project.pk), "task.created", payload)

    slack_delivery = WebhookDelivery.objects.get(webhook=slack_hook)
    generic_delivery = WebhookDelivery.objects.get(webhook=generic_hook)

    assert "attachments" in slack_delivery.payload
    assert slack_delivery.payload["text"].startswith("*Task created*")
    # dispatch injects the per-subscription sequence under a reserved _meta key
    # (#715, ADR-0089); the rendered domain content is otherwise unchanged.
    assert {k: v for k, v in generic_delivery.payload.items() if k != "_meta"} == payload
    assert generic_delivery.payload["_meta"]["sequence"] == generic_delivery.sequence_number
    assert slack_delivery.payload["_meta"]["sequence"] == slack_delivery.sequence_number


@pytest.mark.django_db
def test_dispatch_unknown_format_degrades_to_raw(project: Project, user: object) -> None:
    """An un-registered format degrades to the raw payload rather than 500ing."""
    hook = Webhook.objects.create(
        project=project,
        url="https://example.com/hook",
        secret="s",
        events=["task.created"],
        format="teams",  # not registered in OSS
        created_by=user,
    )
    payload = {"id": "t1"}
    import trueppm_api.apps.webhooks.tasks as wh_tasks

    with patch.object(wh_tasks, "deliver_webhook") as mock_task:
        mock_task.delay = MagicMock()
        from trueppm_api.apps.webhooks.dispatch import dispatch_webhooks

        dispatch_webhooks(str(project.pk), "task.created", payload)

    # Degrades to the raw payload (no 500), with the additive _meta key (#715).
    delivery = WebhookDelivery.objects.get(webhook=hook)
    assert {k: v for k, v in delivery.payload.items() if k != "_meta"} == payload
    assert delivery.payload["_meta"]["sequence"] == delivery.sequence_number


# ---------------------------------------------------------------------------
# Serializer format validation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_webhook_with_slack_format(admin_client: APIClient, project: Project) -> None:
    resp = admin_client.post(
        f"/api/v1/projects/{project.pk}/webhooks/",
        {
            "url": "https://hooks.slack.com/services/x",
            "secret": "s" * 32,  # >= 32-char minimum (#893)
            "events": ["task.assigned"],
            "format": "slack",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["format"] == "slack"


@pytest.mark.django_db
def test_create_webhook_defaults_to_generic(admin_client: APIClient, project: Project) -> None:
    resp = admin_client.post(
        f"/api/v1/projects/{project.pk}/webhooks/",
        {"url": "https://example.com/hook", "secret": "s" * 32, "events": ["task.created"]},
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["format"] == "generic"


@pytest.mark.django_db
def test_create_webhook_rejects_unknown_format(admin_client: APIClient, project: Project) -> None:
    resp = admin_client.post(
        f"/api/v1/projects/{project.pk}/webhooks/",
        {
            "url": "https://example.com/hook",
            "secret": "s",
            "events": ["task.created"],
            "format": "carrier-pigeon",
        },
        format="json",
    )
    assert resp.status_code == 400
    assert "format" in resp.data


@pytest.mark.django_db
def test_create_webhook_accepts_new_event_types(admin_client: APIClient, project: Project) -> None:
    """The four new #638 events are subscribable."""
    resp = admin_client.post(
        f"/api/v1/projects/{project.pk}/webhooks/",
        {
            "url": "https://example.com/hook",
            "secret": "s" * 32,  # >= 32-char minimum (#893)
            "events": [
                WebhookEventType.TASK_ASSIGNED,
                WebhookEventType.TASK_ASSIGNEE_CHANGED,
                WebhookEventType.TASK_MENTIONED,
                WebhookEventType.TASK_DUE_DATE_CHANGED,
            ],
            "format": "generic",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert set(resp.data["events"]) == {
        "task.assigned",
        "task.assignee_changed",
        "task.mentioned",
        "task.due_date_changed",
    }
