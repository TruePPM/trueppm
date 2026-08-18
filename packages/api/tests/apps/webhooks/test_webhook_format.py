"""Tests for the #638 webhook format extension (ADR-0083).

Covers the OUTGOING_CHANNEL_PROVIDERS registry registration, the generic and
slack renderers, per-webhook rendering in dispatch, the serializer format
validation, and the 19-event hard cap.

Also holds the two **catalog-parity gates** added in #2883. Both the Slack
renderer's title/color table and the web event picker had drifted to 11 of the 19
backend events, and nothing compared any of the three: the Python gate
(``test_event_type_cap``) and the TS build each passed in isolation while
`risk.opened` rendered to Slack as a bare uuid and the picker silently deleted
eight real subscriptions on save.
"""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path
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
    """The OSS webhook event set is capped at 19 — a 20th requires its own ADR.

    If this fails because someone added a new WebhookEventType, do not just bump
    the number: the cap is the gate against per-customer event proliferation
    (the Enterprise upsell). Adding an event is a deliberate ADR-0083 decision.
    The agile trio (sprint.*) was added under ADR-0147, raising the cap 11→14; the
    risk/baseline/comment domain events were added under ADR-0206, raising it 14→19.
    """
    assert len(ALL_WEBHOOK_EVENTS) == OSS_WEBHOOK_EVENT_CAP == 19
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
        "sprint.activated",
        "sprint.closed",
        "sprint.scope_changed",
        "risk.opened",
        "risk.escalated",
        "risk.closed",
        "baseline.captured",
        "comment.created",
    }


# ---------------------------------------------------------------------------
# Catalog parity gates (#2883)
# ---------------------------------------------------------------------------

# packages/api/tests/apps/webhooks/<this file> → repo root is five levels up.
_REPO_ROOT = Path(__file__).resolve().parents[5]
_WEB_EVENT_CATALOG = (
    _REPO_ROOT / "packages/web/src/features/settings/components/integrations/events.ts"
)
# Matches `id: 'task.created'` entries in the TS catalog. A bare `^\s*id: ` count
# undercounts the file (prettier keeps short group entries on one line), so match
# the quoted value rather than the line.
_TS_EVENT_ID_RE = re.compile(r"id: '([a-z_]+\.[a-z_]+)'")


def test_slack_meta_covers_every_event() -> None:
    """Every backend event has a Slack title + color (#2883).

    Without this, an unmapped event fell through to the
    ``(event.event_type, neutral)`` fallback and posted to Slack as
    ``*risk.opened* — <uuid>`` with an empty ``fields`` array. The fallback stays
    (it must never raise), but it is no longer reachable for a real OSS event.
    """
    from trueppm_api.apps.integrations.outgoing import _SLACK_EVENT_META

    missing = set(ALL_WEBHOOK_EVENTS) - set(_SLACK_EVENT_META)
    assert missing == set(), f"Slack renderer has no title/color for: {sorted(missing)}"


def test_slack_field_specs_exist_for_every_event_family() -> None:
    """Every event family surfaces at least one field its payload actually carries.

    The field extractor read only task keys (name/status/assignee/planned_start),
    none of which appear in a sprint, risk, or baseline payload — so those events
    rendered with an empty ``fields`` array even once they had a title.
    """
    from trueppm_api.apps.integrations.outgoing import (
        _SLACK_DEFAULT_FIELDS,
        _slack_field_specs,
    )

    families = {event.split(".", 1)[0] for event in ALL_WEBHOOK_EVENTS}
    non_task_families = families - {"task", "dependency", "schedule", "project"}
    for event in ALL_WEBHOOK_EVENTS:
        specs = _slack_field_specs(event)
        assert specs, f"no field specs for {event}"
        if event.split(".", 1)[0] in non_task_families:
            # A family that fell back to the task defaults is the exact bug: the
            # keys do not exist in its payload.
            assert specs != _SLACK_DEFAULT_FIELDS, (
                f"{event} still falls back to the task field specs"
            )


def test_web_event_catalog_covers_every_backend_event() -> None:
    """The Settings event picker must offer every event the backend can fire (#2883).

    This is the gate that was missing. The web catalog is hand-maintained TypeScript
    with no generator, so the only thing that can bind it to ``WebhookEventType`` is
    a test that reads the file. If this fails, add the event to
    ``packages/web/src/features/settings/components/integrations/events.ts`` (with a
    group and a label) — do not relax the assertion. Note that the *data-loss* half
    of #2883 is fixed independently in the modal: a save preserves ids the picker
    did not render, so a future gap here degrades to "not selectable", never to
    "silently deleted".
    """
    assert _WEB_EVENT_CATALOG.is_file(), f"web event catalog not found at {_WEB_EVENT_CATALOG}"
    ts_ids = set(_TS_EVENT_ID_RE.findall(_WEB_EVENT_CATALOG.read_text(encoding="utf-8")))

    missing = set(ALL_WEBHOOK_EVENTS) - ts_ids
    assert missing == set(), f"web event picker is missing: {sorted(missing)}"
    # The reverse direction matters too: an id the backend cannot emit would be an
    # unfireable subscription offered to an admin.
    extra = ts_ids - set(ALL_WEBHOOK_EVENTS)
    assert extra == set(), f"web event picker offers unfireable events: {sorted(extra)}"


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


def test_slack_render_sprint_event() -> None:
    """A sprint payload renders its own fields, not the (absent) task keys (#2883)."""
    payload = {
        "id": "s1",
        "name": "Sprint 14",
        "state": "active",
        "goal": "Ship the intake form",
        "committed_points": 21,
        "start_date": "2026-08-17",
        "finish_date": "2026-08-31",
    }
    event = OutgoingChannelEvent(event_type="sprint.activated", project_id="p1", payload=payload)
    rendered = SlackOutgoingChannelProvider().render(event)

    assert rendered["text"] == "*Sprint started* — Sprint 14"
    field_titles = {f["title"] for f in rendered["attachments"][0]["fields"]}
    assert {"State", "Goal", "Committed points", "Start", "Finish"} == field_titles


def test_slack_render_risk_event_uses_title_as_the_subject() -> None:
    """A risk payload has no ``name`` — the subject comes from ``title``."""
    payload = {
        "id": "r1",
        "short_id": "R-4",
        "title": "Permit delay",
        "status": "open",
        "probability": 4,
        "impact": 5,
        "severity": 20,
        "category": "external",
    }
    event = OutgoingChannelEvent(event_type="risk.escalated", project_id="p1", payload=payload)
    rendered = SlackOutgoingChannelProvider().render(event)

    assert rendered["text"] == "*Risk escalated* — Permit delay"
    fields = {f["title"]: f["value"] for f in rendered["attachments"][0]["fields"]}
    assert fields["Severity"] == "20"
    assert fields["Status"] == "open"


def test_slack_render_scope_change_uses_item_name() -> None:
    """sprint.scope_changed is about the injected item, not the sprint's plan."""
    payload = {
        "id": "sc1",
        "sprint": "s1",
        "item_name": "Hotfix the export",
        "status": "accepted",
        "goal_impact": "at_risk",
    }
    event = OutgoingChannelEvent(
        event_type="sprint.scope_changed", project_id="p1", payload=payload
    )
    rendered = SlackOutgoingChannelProvider().render(event)

    assert rendered["text"] == "*Sprint scope changed* — Hotfix the export"
    fields = {f["title"]: f["value"] for f in rendered["attachments"][0]["fields"]}
    assert fields == {
        "Item": "Hotfix the export",
        "Decision": "accepted",
        "Goal impact": "at_risk",
    }


def test_slack_render_baseline_surfaces_zero_and_false() -> None:
    """A genuine 0/False must render, not vanish behind a truthiness check (#2883)."""
    payload = {"id": "b1", "name": "Rebaseline Q3", "task_count": 0, "has_cpm_dates": False}
    event = OutgoingChannelEvent(event_type="baseline.captured", project_id="p1", payload=payload)
    rendered = SlackOutgoingChannelProvider().render(event)

    fields = {f["title"]: f["value"] for f in rendered["attachments"][0]["fields"]}
    assert fields == {"Tasks captured": "0", "Has CPM dates": "False"}


def test_slack_render_comment_event() -> None:
    """comment.created spreads the task payload and adds the author (never the body)."""
    payload = {
        "id": "t1",
        "name": "Foundation pour",
        "status": "in_progress",
        "comment_id": "c1",
        "author_display": "Jordan Mehta",
    }
    event = OutgoingChannelEvent(event_type="comment.created", project_id="p1", payload=payload)
    rendered = SlackOutgoingChannelProvider().render(event)

    assert rendered["text"] == "*New comment* — Foundation pour"
    fields = {f["title"]: f["value"] for f in rendered["attachments"][0]["fields"]}
    assert fields["Author"] == "Jordan Mehta"


def test_slack_render_ping_has_a_readable_title() -> None:
    """The test ping now renders through this provider, so it needs a real title."""
    from trueppm_api.apps.webhooks.models import PING_EVENT_TYPE

    payload = {"event": PING_EVENT_TYPE, "webhook_id": "w1"}
    event = OutgoingChannelEvent(event_type=PING_EVENT_TYPE, project_id="p1", payload=payload)
    rendered = SlackOutgoingChannelProvider().render(event)

    assert "Test ping" in rendered["text"]
    # Slack rejects a body with no text/blocks/attachments (400 invalid_payload).
    assert rendered["text"]
    assert len(rendered["attachments"]) == 1


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
