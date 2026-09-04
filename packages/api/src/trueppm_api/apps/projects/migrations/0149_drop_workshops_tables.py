"""Drop the workshops tables left behind by removing the workshops app (#3301).

The ``workshops`` app is deleted, so its own migrations can no longer run — an app
that is not in ``INSTALLED_APPS`` has no migration state and Django will never
apply a ``DeleteModel`` for it. Without this the two tables would survive forever
on every existing database as orphans that nothing owns and nothing can drop.

Raw SQL rather than ``DeleteModel`` for the same reason: the models no longer
exist to reference. This is one of the narrow cases the migration-discipline rule
in CLAUDE.md carves out for ``RunSQL`` — the ORM genuinely cannot express it.

The ``django_migrations`` cleanup matters as much as the ``DROP``: leaving the
rows behind would make a later app with the same label inherit a phantom applied
history and silently skip its own ``0001_initial``.

Irreversible by design. Reversing would have to recreate two tables whose model
definitions are gone from the tree; a database that needs them back should
restore from a backup or check out a pre-removal ref.
"""

from __future__ import annotations

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0148_task_unique_task_wbs_path_per_project_live"),
    ]

    operations = [
        migrations.RunSQL(
            # Participant carries the FK, so it goes first. IF EXISTS keeps this a
            # no-op on a database created after the app was removed.
            sql=[
                "DROP TABLE IF EXISTS workshops_participant;",
                "DROP TABLE IF EXISTS workshops_session;",
                "DELETE FROM django_migrations WHERE app = 'workshops';",
            ],
            reverse_sql=migrations.RunSQL.noop,
        ),
    ]
