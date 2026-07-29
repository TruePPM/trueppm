"""Data-backfill helper for the sync delta cursor (ADR-0686, #2491).

Extracted from the migration file so tests can import it without coupling to a
migration file *name*, which a squash deletes (CLAUDE.md migration rule 3).

Seeds every existing synced row's ``sync_seq`` from its project's sequence. Every
row in a project gets the **same** value — one step of the sequence for the whole
pre-existing dataset. That is correct, not a shortcut: the delta is ``> since``
and the checkpoint is the maximum, so rows sharing a value are either all before
or all after any client checkpoint. It is the same property that lets a batched
upload share one value (ADR-0686).

Because the value is the project's old watermark **plus one**, every ``since`` an
existing client holds is strictly below it. The first pull after upgrade
redelivers the project once under WatermelonDB upsert semantics — which also
repairs whatever the old scheme had already dropped — and every pull after that
is a normal delta. No client change, and no forced re-pull from zero.

Soft-deleted rows are renumbered too: they are tombstones the delta must still
deliver, selected by the same ``sync_seq__gt=since`` filter and split on
``is_deleted``.
"""

from __future__ import annotations

from typing import Any

# (label, join clause reaching the project row, predicate binding the target).
# The target table is aliased ``x`` and the project row ``p`` in every statement.
_INDIRECT_SOURCES: list[tuple[str, str, str]] = [
    ("projects.Task", "{project} p", "x.project_id = p.id"),
    ("access.ProjectMembership", "{project} p", "x.project_id = p.id"),
    ("projects.Risk", "{project} p", "x.project_id = p.id"),
    ("projects.Sprint", "{project} p", "x.project_id = p.id"),
    ("projects.Label", "{project} p", "x.project_id = p.id"),
    (
        "projects.SprintRetro",
        "{sprint} s JOIN {project} p ON s.project_id = p.id",
        "x.sprint_id = s.id",
    ),
    (
        "projects.RetroActionItem",
        "{sprintretro} r JOIN {sprint} s ON r.sprint_id = s.id "
        "JOIN {project} p ON s.project_id = p.id",
        "x.retro_id = r.id",
    ),
    (
        "projects.TaskSuggestedAssignee",
        "{task} t JOIN {project} p ON t.project_id = p.id",
        "x.task_id = t.id",
    ),
    (
        "projects.TaskRecurrenceRule",
        "{task} t JOIN {project} p ON t.project_id = p.id",
        "x.task_id = t.id",
    ),
    (
        "integrations.TaskLink",
        "{task} t JOIN {project} p ON t.project_id = p.id",
        "x.task_id = t.id",
    ),
    (
        "timetracking.TimeEntry",
        "{task} t JOIN {project} p ON t.project_id = p.id",
        "x.task_id = t.id",
    ),
    # Graph edges reach the project through the endpoint the delta scopes and
    # orders by. Both are delivered as their own collection filtered on their own
    # `sync_seq`, so an unseeded edge would stay at 0 and never be delivered.
    (
        "projects.Dependency",
        "{task} t JOIN {project} p ON t.project_id = p.id",
        "x.predecessor_id = t.id",
    ),
    (
        "projects.TaskRelation",
        "{task} t JOIN {project} p ON t.project_id = p.id",
        "x.source_id = t.id",
    ),
]


def seed_sync_seq(apps: Any, schema_editor: Any) -> None:
    """Give every existing synced row a cursor drawn from its project's sequence.

    Every collection the delta serves is seeded, graph edges included: each is
    filtered on its *own* ``sync_seq``, so a row left at 0 would never be
    delivered again — not even by a cold-start ``since=0`` pull.
    """
    get = apps.get_model
    tables = {
        "project": get("projects", "Project")._meta.db_table,
        "task": get("projects", "Task")._meta.db_table,
        "sprint": get("projects", "Sprint")._meta.db_table,
        "sprintretro": get("projects", "SprintRetro")._meta.db_table,
        "calendar": get("projects", "Calendar")._meta.db_table,
    }

    with schema_editor.connection.cursor() as cursor:
        # The project row is itself a synced source. Do it first, while
        # last_sync_version still holds the pre-migration watermark.
        #
        # Every identifier interpolated into the statements below is a db_table
        # read from model _meta; no user input reaches them, and there is no
        # value to bind as a parameter.
        # nosemgrep: formatted-sql-query, sqlalchemy-execute-raw-query
        cursor.execute(
            f"UPDATE {tables['project']} SET sync_seq = last_sync_version + 1"  # nosec B608
        )

        for label, join, predicate in _INDIRECT_SOURCES:
            app_label, model_name = label.split(".")
            table = get(app_label, model_name)._meta.db_table
            cursor.execute(
                f"UPDATE {table} x SET sync_seq = p.last_sync_version + 1 "  # nosec B608
                f"FROM {join.format(**tables)} WHERE {predicate}"
            )

        # A calendar can be shared, and one row carries one cursor, so it takes
        # the maximum over its owners. The final statement then raises every
        # owning project's watermark to at least that value — without it a shared
        # calendar would sit permanently above one owner's checkpoint and be
        # redelivered on every pull.
        cursor.execute(
            f"UPDATE {tables['calendar']} c SET sync_seq = sub.v FROM ("  # nosec B608
            f"  SELECT calendar_id, MAX(last_sync_version) + 1 AS v"
            f"    FROM {tables['project']} WHERE calendar_id IS NOT NULL"
            f"   GROUP BY calendar_id"
            f") sub WHERE c.id = sub.calendar_id"
        )

        cursor.execute(
            f"UPDATE {tables['project']} p SET last_sync_version = GREATEST("  # nosec B608
            f"  p.last_sync_version + 1,"
            f"  COALESCE((SELECT c.sync_seq FROM {tables['calendar']} c"
            f"             WHERE c.id = p.calendar_id), 0))"
        )


def unseed_sync_seq(apps: Any, schema_editor: Any) -> None:
    """Reverse: leave the column at its default.

    ``last_sync_version`` is deliberately *not* wound back. It is monotonic by
    contract, and a watermark that is too high only costs a client a pull that
    returns nothing; one that moves backwards would redeliver rows forever.
    """
    get = apps.get_model
    labels = ["projects.Project", "projects.Calendar", *[s[0] for s in _INDIRECT_SOURCES]]
    with schema_editor.connection.cursor() as cursor:
        for label in labels:
            app_label, model_name = label.split(".")
            table = get(app_label, model_name)._meta.db_table
            # nosemgrep: formatted-sql-query, sqlalchemy-execute-raw-query
            cursor.execute(f"UPDATE {table} SET sync_seq = 0")  # nosec B608
