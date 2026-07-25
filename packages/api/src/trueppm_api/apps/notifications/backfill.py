"""Data-backfill helpers for the notifications app migrations.

These functions are extracted from migration files so tests can import them
without coupling to migration file names, which break on squash (CLAUDE.md rule 3).

The valid key sets are inlined rather than imported from the model enums so the
helpers stay correct even if those enums later change — a data migration must
reproduce the state at the time it runs.
"""

from __future__ import annotations

from typing import Any

_VALID_EVENT_TYPES = {
    "task_assigned",
    "task_overdue",
    "comment_mention",
    "status_change",
    "budget_alert",
    "risk_created",
    "milestone_reached",
    "sprint_start",
    "sprint_end",
}
_VALID_CHANNELS = {"in_app", "email", "slack", "mobile_push"}


def _clean_channel_row(channels: dict[Any, Any]) -> tuple[dict[str, bool], bool]:
    """Keep only valid ``(channel → bool)`` cells; report whether anything was dropped."""
    row: dict[str, bool] = {}
    changed = False
    for channel, enabled in channels.items():
        if channel not in _VALID_CHANNELS or not isinstance(enabled, bool):
            changed = True
            continue
        row[channel] = enabled
    return row, changed


def _clean_matrix_payload(matrix: dict[Any, Any]) -> tuple[dict[str, dict[str, bool]], bool]:
    """Strip unknown event-type keys and clean each channel row; report any drop.

    Split from :func:`_clean_matrix` so the outer per-row iteration keeps the driver
    loop (which persists) readable and each nesting level stays shallow.
    """
    cleaned: dict[str, dict[str, bool]] = {}
    changed = False
    for event_type, channels in matrix.items():
        if event_type not in _VALID_EVENT_TYPES or not isinstance(channels, dict):
            changed = True
            continue
        row, row_changed = _clean_channel_row(channels)
        changed = changed or row_changed
        cleaned[event_type] = row
    return cleaned, changed


def _clean_matrix(apps: Any, schema_editor: Any) -> None:
    """Strip unknown event-type / channel keys from persisted notification matrices (#675).

    The serializer rejects unknown keys on write, but rows created before that
    validation shipped (#522 / #589) may carry garbage keys that leak into the
    GET response and mislead the #674 dispatcher. Drops any event-type or channel
    key not in the current enums, and any non-boolean leaf, leaving only valid cells.
    """
    Model = apps.get_model("notifications", "ProjectNotificationPreference")
    for pref in Model.objects.all().iterator():
        matrix = pref.matrix
        if not isinstance(matrix, dict):
            # Corrupt non-dict payload — reset to an empty matrix; reads fall
            # through to the default overlay.
            pref.matrix = {}
            pref.save(update_fields=["matrix"])
            continue
        cleaned, changed = _clean_matrix_payload(matrix)
        if changed:
            pref.matrix = cleaned
            pref.save(update_fields=["matrix"])
