"""Strip unknown event-type / channel keys from persisted matrices (#675).

The serializer rejects unknown keys on write, but rows created before that
validation shipped (#522 / #589) may carry garbage like `{"haha": {"foo": true}}`
that leaks into the GET response and would mislead the #674 dispatcher. This
one-shot data migration drops any event-type or channel key not in the current
enums, and any non-boolean leaf, leaving only valid cells.

The valid key sets are inlined rather than imported from the model enums so the
migration stays correct even if those enums later change — a data migration must
reproduce the state at the time it runs.
"""

from __future__ import annotations

from typing import Any

from django.db import migrations

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


def _clean_matrix(apps: Any, schema_editor: Any) -> None:
    Model = apps.get_model("notifications", "ProjectNotificationPreference")
    for pref in Model.objects.all().iterator():
        matrix = pref.matrix
        if not isinstance(matrix, dict):
            # Corrupt non-dict payload — reset to an empty matrix; reads fall
            # through to the default overlay.
            pref.matrix = {}
            pref.save(update_fields=["matrix"])
            continue
        cleaned: dict[str, dict[str, bool]] = {}
        changed = False
        for event_type, channels in matrix.items():
            if event_type not in _VALID_EVENT_TYPES or not isinstance(channels, dict):
                changed = True
                continue
            row: dict[str, bool] = {}
            for channel, enabled in channels.items():
                if channel not in _VALID_CHANNELS or not isinstance(enabled, bool):
                    changed = True
                    continue
                row[channel] = enabled
            cleaned[event_type] = row
        if changed:
            pref.matrix = cleaned
            pref.save(update_fields=["matrix"])


class Migration(migrations.Migration):
    dependencies = [
        ("notifications", "0003_projectnotificationpreference_paused"),
    ]

    operations = [
        # Reverse is a no-op: dropped garbage keys carried no meaning, so there
        # is nothing to restore.
        migrations.RunPython(_clean_matrix, migrations.RunPython.noop, elidable=True),
    ]
