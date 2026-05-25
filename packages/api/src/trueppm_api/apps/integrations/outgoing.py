"""OSS ``OUTGOING_CHANNEL_PROVIDERS`` registrations (ADR-0049 §2, ADR-0083).

Two providers ship in OSS:

- ``generic`` — returns the event payload unchanged. This is the historical
  behavior (the internal envelope POSTed as the raw body), so every existing
  webhook row — which defaults to ``format="generic"`` — is byte-for-byte
  unaffected by the format extension.
- ``slack`` — renders a Slack incoming-webhook message (``text`` + a single
  attachment). Discord and Mattermost incoming webhooks accept the Slack
  attachment shape de-facto, so this one renderer covers all three.

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

# Human-readable title + bar color for each of the 11 OSS event types. Kept as
# data (not branches) so the slack renderer stays a pure lookup; an unmapped
# event still renders with a sensible fallback title rather than raising.
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
}


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
    Discord, and Mattermost incoming webhooks all accept. The attachment lists
    the task fields present in the payload as Slack ``fields`` so the message is
    skimmable without opening TruePPM.
    """

    key: ClassVar[str] = "slack"
    label: ClassVar[str] = "Slack"

    def render(self, event: OutgoingChannelEvent) -> dict[str, Any]:
        payload = event.payload
        title, color = _SLACK_EVENT_META.get(
            event.event_type, (event.event_type, _SLACK_COLOR_NEUTRAL)
        )
        task_name = payload.get("name") or payload.get("id") or "task"

        # Only surface fields that are present — task.deleted carries just id +
        # project, so we must not emit empty "Status"/"Assignee" rows for it.
        field_specs: list[tuple[str, Any]] = [
            ("Status", payload.get("status")),
            ("Assignee", payload.get("assignee")),
            ("Planned start", payload.get("planned_start")),
        ]
        fields = [
            {"title": label, "value": str(value), "short": True}
            for label, value in field_specs
            if value
        ]

        return {
            "text": f"*{title}* — {task_name}",
            "attachments": [
                {
                    "color": color,
                    "title": task_name,
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
