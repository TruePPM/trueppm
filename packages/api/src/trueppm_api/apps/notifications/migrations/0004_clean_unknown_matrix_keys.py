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

from django.db import migrations

from trueppm_api.apps.notifications.backfill import _clean_matrix


class Migration(migrations.Migration):
    dependencies = [
        ("notifications", "0003_projectnotificationpreference_paused"),
    ]

    operations = [
        # Reverse is a no-op: dropped garbage keys carried no meaning, so there
        # is nothing to restore.
        migrations.RunPython(_clean_matrix, migrations.RunPython.noop, elidable=True),
    ]
