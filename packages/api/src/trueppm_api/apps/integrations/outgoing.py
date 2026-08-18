"""OSS ``OUTGOING_CHANNEL_PROVIDERS`` registrations (ADR-0049 §2, ADR-0083).

Two providers ship in OSS:

- ``generic`` — returns the event payload unchanged. This is the historical
  behavior (the internal envelope POSTed as the raw body), so every existing
  webhook row — which defaults to ``format="generic"`` — is byte-for-byte
  unaffected by the format extension.
- ``slack`` — renders a Slack incoming-webhook message (``text`` + a single
  legacy ``attachments`` entry — not Block Kit). Discord and Mattermost incoming
  webhooks accept the Slack attachment shape de-facto, so this one renderer covers
  all three; ``blocks`` would only work on Slack.

Enterprise registers richer providers (``slack_app`` OAuth, ``teams``, …)
against the same registry from its own ``AppConfig.ready()`` — no OSS change.
The provider only *renders*; ``apps/webhooks/tasks.py::deliver_webhook`` owns
transport, HMAC signing, retries, and the sequence header (ADR-0083).
"""

from __future__ import annotations

from typing import Any, ClassVar

from .registry import OutgoingChannelEvent, OutgoingChannelProvider

# Slack attachment bar color per event family. Red for destructive/blocking
# transitions, green for creation/assignment, neutral grey for the rest —
# matches the design-system semantic palette so the Slack card reads at a glance.
_SLACK_COLOR = "#1C6B3A"  # brand-primary (green)
_SLACK_COLOR_CRITICAL = "#B91C1C"  # semantic-critical (red)
_SLACK_COLOR_NEUTRAL = "#6B6965"  # text-secondary (grey)

# Human-readable title + bar color for every OSS event type, plus the reserved
# ``ping``. Kept as data (not branches) so the slack renderer stays a pure lookup;
# an unmapped event still renders with a sensible fallback title rather than
# raising. ``test_slack_meta_covers_every_event`` fails if a new WebhookEventType
# lands without an entry — the gap this table had for eight real OSS events, which
# made `risk.opened` post to Slack as `*risk.opened* — <uuid>` with no fields
# (#2883).
_SLACK_EVENT_META: dict[str, tuple[str, str]] = {
    "task.created": ("Task created", _SLACK_COLOR),
    "task.updated": ("Task updated", _SLACK_COLOR_NEUTRAL),
    "task.deleted": ("Task deleted", _SLACK_COLOR_CRITICAL),
    "task.assigned": ("Task assigned", _SLACK_COLOR),
    "task.assignee_changed": ("Task reassigned", _SLACK_COLOR_NEUTRAL),
    "task.mentioned": ("You were mentioned", _SLACK_COLOR),
    "task.due_date_changed": ("Task date changed", _SLACK_COLOR_NEUTRAL),
    "dependency.created": ("Dependency added", _SLACK_COLOR_NEUTRAL),
    "dependency.deleted": ("Dependency removed", _SLACK_COLOR_NEUTRAL),
    "schedule.recalculated": ("Schedule recalculated", _SLACK_COLOR_NEUTRAL),
    "project.created": ("Project created", _SLACK_COLOR),
    "sprint.activated": ("Sprint started", _SLACK_COLOR),
    "sprint.closed": ("Sprint closed", _SLACK_COLOR_NEUTRAL),
    "sprint.scope_changed": ("Sprint scope changed", _SLACK_COLOR_CRITICAL),
    "risk.opened": ("Risk opened", _SLACK_COLOR_CRITICAL),
    "risk.escalated": ("Risk escalated", _SLACK_COLOR_CRITICAL),
    "risk.closed": ("Risk closed", _SLACK_COLOR),
    "baseline.captured": ("Baseline captured", _SLACK_COLOR),
    "comment.created": ("New comment", _SLACK_COLOR_NEUTRAL),
    # Reserved, non-domain: the "Send test" ping now renders through this provider
    # like any other delivery (#2884), so it needs a title an admin recognizes in
    # the channel rather than a bare "ping".
    "ping": ("Test ping", _SLACK_COLOR_NEUTRAL),
}

# The payload key each event family carries its human-readable name under. Task,
# sprint, and baseline payloads use ``name``; a risk uses ``title``; a sprint
# scope change is about the injected item, so ``item_name``. ``id`` is the last
# resort (task.deleted carries only id + project).
_SLACK_NAME_KEYS: tuple[str, ...] = ("name", "title", "item_name", "id")

# Slack attachment field rows per event family — (label, payload key). The
# extractor read only task keys (name/status/assignee/planned_start) before
# #2883, which are absent from every sprint, risk, and baseline payload, so those
# events rendered with an empty ``fields`` array.
_SLACK_DEFAULT_FIELDS: tuple[tuple[str, str], ...] = (
    ("Status", "status"),
    ("Assignee", "assignee"),
    ("Planned start", "planned_start"),
)

_SLACK_FIELDS_BY_FAMILY: dict[str, tuple[tuple[str, str], ...]] = {
    "sprint": (
        ("State", "state"),
        ("Goal", "goal"),
        ("Committed points", "committed_points"),
        ("Start", "start_date"),
        ("Finish", "finish_date"),
    ),
    "risk": (
        ("Status", "status"),
        ("Severity", "severity"),
        ("Probability", "probability"),
        ("Impact", "impact"),
        ("Category", "category"),
    ),
    "baseline": (
        ("Tasks captured", "task_count"),
        ("Has CPM dates", "has_cpm_dates"),
    ),
    "comment": (
        ("Author", "author_display"),
        ("Status", "status"),
        ("Assignee", "assignee"),
    ),
}

# Event-level override, checked before the family table. sprint.scope_changed is
# in the "sprint" family but its payload is about the injected item, not the
# sprint's own plan fields.
_SLACK_FIELDS_BY_EVENT: dict[str, tuple[tuple[str, str], ...]] = {
    "sprint.scope_changed": (
        ("Item", "item_name"),
        ("Decision", "status"),
        ("Goal impact", "goal_impact"),
    ),
}


def _slack_field_specs(event_type: str) -> tuple[tuple[str, str], ...]:
    """Return the (label, payload key) rows to surface for ``event_type``."""
    if event_type in _SLACK_FIELDS_BY_EVENT:
        return _SLACK_FIELDS_BY_EVENT[event_type]
    family = event_type.split(".", 1)[0]
    return _SLACK_FIELDS_BY_FAMILY.get(family, _SLACK_DEFAULT_FIELDS)


class GenericOutgoingChannelProvider(OutgoingChannelProvider):
    """Pass-through provider — the raw TruePPM event envelope, unchanged.

    This preserves the pre-#638 behavior exactly: the payload built by the
    dispatching view is what gets POSTed. Existing webhooks (``format="generic"``
    by default) see no change.
    """

    key: ClassVar[str] = "generic"
    label: ClassVar[str] = "Generic (JSON)"

    def render(self, event: OutgoingChannelEvent) -> dict[str, Any]:
        return event.payload


class SlackOutgoingChannelProvider(OutgoingChannelProvider):
    """Render a TruePPM event as a Slack incoming-webhook message.

    Produces ``{"text": ..., "attachments": [{...}]}`` — the shape Slack,
    Discord, and Mattermost incoming webhooks all accept. The attachment lists the
    fields present in the payload as Slack ``fields`` so the message is skimmable
    without opening TruePPM. Which fields those are is per event family
    (:func:`_slack_field_specs`), because a sprint, a risk, and a baseline share
    almost no keys with a task.

    This is the legacy ``attachments`` shape, **not** Block Kit — deliberately, and
    the reason one renderer covers Slack, Discord, and Mattermost (only Slack
    understands ``blocks``). Migrating to Block Kit would drop the other two.
    """

    key: ClassVar[str] = "slack"
    label: ClassVar[str] = "Slack"

    def render(self, event: OutgoingChannelEvent) -> dict[str, Any]:
        payload = event.payload
        title, color = _SLACK_EVENT_META.get(
            event.event_type, (event.event_type, _SLACK_COLOR_NEUTRAL)
        )
        subject = next(
            (str(payload[key]) for key in _SLACK_NAME_KEYS if payload.get(key)),
            "event",
        )

        # Only surface fields that are present — task.deleted carries just id +
        # project, so we must not emit empty "Status"/"Assignee" rows for it. The
        # check is against None/"" rather than truthiness so a genuine ``0``
        # (committed_points on an empty sprint) or ``False`` (has_cpm_dates) still
        # renders instead of vanishing.
        fields = [
            {"title": label, "value": str(payload[key]), "short": True}
            for label, key in _slack_field_specs(event.event_type)
            if payload.get(key) not in (None, "")
        ]

        return {
            "text": f"*{title}* — {subject}",
            "attachments": [
                {
                    "color": color,
                    "title": subject,
                    "fields": fields,
                    "footer": "TruePPM",
                    "mrkdwn_in": ["text"],
                }
            ],
        }


# Ordered tuple — apps.py iterates these in declaration order so OSS
# registration order is deterministic for tests and the format-picker menu.
OSS_OUTGOING_CHANNEL_PROVIDERS: tuple[type[OutgoingChannelProvider], ...] = (
    GenericOutgoingChannelProvider,
    SlackOutgoingChannelProvider,
)
