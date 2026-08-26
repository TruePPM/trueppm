"""Data-backfill helpers for the projects app migrations.

These functions are extracted from migration files so tests can import them
without coupling to migration file names, which break on squash (CLAUDE.md rule 3).
"""

from __future__ import annotations

import logging
from typing import Any, NamedTuple

from django.db.models import Count, F

logger = logging.getLogger(__name__)


def backfill_risk_short_ids(apps: Any, schema_editor: Any) -> None:
    """Renumber existing risks to a contiguous decimal sequence per project (#929).

    Existing risks carry 8-char hex short_ids allocated from the shared
    ``object_sequence`` — the bug behind every register row collapsing to
    ``R-0000``. For each project, order *all* risks (including soft-deleted ones)
    by ``created_at`` and assign ``1, 2, 3 …`` as the new decimal ``short_id``,
    then set ``project.risk_sequence`` to the high-water mark so new risks never
    reuse a number.

    Soft-deleted risks are included in the ordering on purpose: the VoC panel
    required immutability with *no reuse after deletion* (deletion leaves a gap —
    "where is R-8?" is an expected audit finding, not a bug). Numbering only the
    live rows would silently re-pack the sequence and reuse a dead risk's number.

    ``server_version`` is bumped on every renumbered risk so offline/mobile
    clients re-pull the corrected identifier on their next sync delta. The writes
    use bulk ``.update()`` / ``bulk_update()`` — a one-time data correction, not
    an audited user edit, so they intentionally leave no HistoricalRisk rows
    (matching the 0071 backfill precedent).
    """
    Project = apps.get_model("projects", "Project")
    Risk = apps.get_model("projects", "Risk")

    for project_id in Project.objects.values_list("pk", flat=True):
        risks = list(Risk.objects.filter(project_id=project_id).order_by("created_at", "pk"))
        if not risks:
            continue

        # Two-pass renumber. ``unique_risk_short_id_per_project`` is a plain
        # (non-deferrable) UniqueConstraint, so Postgres checks it per-row inside
        # the bulk UPDATE. Writing the final decimals in one pass is only safe
        # because legacy hex short_ids can't equal a bare decimal — but a
        # mixed-version deploy window (new app code minting decimal short_ids
        # before this migration runs) could break that assumption and abort the
        # migration with an IntegrityError. Routing through a sentinel namespace
        # that is disjoint from BOTH legacy hex (uppercase ``[0-9A-F]``) and the
        # final decimals (the lowercase ``x`` prefix guarantees this) makes the
        # renumber collision-proof regardless of the starting values.
        for seq, risk in enumerate(risks, start=1):
            risk.short_id = f"x{seq:07d}"
        Risk.objects.bulk_update(risks, ["short_id"], batch_size=2000)
        for seq, risk in enumerate(risks, start=1):
            risk.short_id = str(seq)
        Risk.objects.bulk_update(risks, ["short_id"], batch_size=2000)

        # Bump server_version so sync clients see the changed short_id. Done as a
        # single bulk UPDATE per project rather than per-row save().
        Risk.objects.filter(project_id=project_id).update(server_version=F("server_version") + 1)
        Project.objects.filter(pk=project_id).update(risk_sequence=len(risks))


def _backfill_wbs_paths(apps: Any, schema_editor: object) -> None:
    """Assign sequential root-level wbs_path values to tasks that have none (#138).

    Tasks with null wbs_path have no hierarchy information (parent_id is derived
    from wbs_path, not stored separately), so they are assigned sequential
    root-level paths within their project, ordered by short_id (project-scoped
    insertion order).
    """
    Task = apps.get_model("projects", "Task")

    # Order by short_id, not pk: Task.id is a UUID (random), so pk ordering is
    # non-deterministic. short_id is allocated from Project.object_sequence on
    # INSERT and zero-padded to 8 hex digits, so its lexicographic order matches
    # creation order within a project. Backfill from migration 0015 ensures
    # every pre-existing Task has a short_id assigned.
    null_tasks = (
        Task.objects.filter(wbs_path__isnull=True, is_deleted=False)
        .order_by("project_id", "short_id")
        .values_list("id", "project_id")
    )

    project_root_counts: dict[Any, int] = {}
    updates = []
    for task_id, project_id in null_tasks:
        # Count existing root-level tasks (wbs_path matches ^\d+$) for this project.
        # Computed once per project and cached; the update list preserves order so
        # each new task sees the correct next position.
        if project_id not in project_root_counts:
            project_root_counts[project_id] = Task.objects.filter(
                project_id=project_id,
                is_deleted=False,
                wbs_path__isnull=False,
                wbs_path__regex=r"^\d+$",
            ).count()
        project_root_counts[project_id] += 1
        updates.append((task_id, str(project_root_counts[project_id])))

    for task_id, new_path in updates:
        Task.objects.filter(id=task_id).update(wbs_path=new_path)


class RepairedWbsPath(NamedTuple):
    """One row moved off a duplicated ``wbs_path`` by :func:`repair_duplicate_wbs_paths`."""

    project_id: str
    task_id: str
    old_path: str
    new_path: str
    kept_task_id: str
    #: Live rows under ``old_path`` that stayed with the kept task. See the
    #: function docstring — they are ambiguous by construction, not merely unmoved.
    stranded_descendants: int


def _free_sibling_path(taken: set[str], prefix: str, start: int) -> tuple[str, int]:
    """The next unused path under ``prefix``, and the ordinal to resume searching from.

    ``taken`` is every live path already claimed in the project, including the ones
    this repair has just handed out — so two duplicates in the same group cannot
    collide with each other.
    """
    ordinal = start
    while True:
        candidate = f"{prefix}{ordinal}" if prefix else str(ordinal)
        if candidate not in taken:
            return candidate, ordinal + 1
        ordinal += 1


def repair_duplicate_wbs_paths(task_model: Any) -> list[RepairedWbsPath]:
    """Re-path duplicate live ``(project, wbs_path)`` rows and report every move (#3068).

    Migration ``0148`` adds ``unique_task_wbs_path_per_project_live`` as an
    ``ExclusionConstraint``. ``AddConstraint`` builds and **validates** the GiST index
    against every existing row, so on a database that already holds two live tasks
    sharing a path, ``migrate`` aborts. Migrations run on container start, which makes
    that an upgrade crash-loop rather than an error an operator can step around — and
    the state is not hypothetical. It is exactly the corruption #3048 was filed to stop,
    which any database running the pre-#3048 code could have accumulated (#3061 and the
    three importer paths in #3069 are the known producers).

    Repairing rather than refusing is deliberate: refusing leaves the operator with a
    crash loop and no tooling to get out of it. But rows are being moved out from under
    them, so **every move is logged at WARNING here**, not by the caller. A silent
    reshuffle of someone's WBS would be worse than failing loudly, and the migration
    output is the only record the operator will have — so the log is part of this
    function's contract and is testable with it, rather than living in the migration
    wrapper where CLAUDE.md rule 3 forbids a test from reaching it.

    **Which row keeps the path.** #3068 proposed "oldest ``created_at``, tie-break on
    ``pk``". ``Task`` has no ``created_at`` — it carries ``blocked_since``,
    ``status_changed_at``, ``deleted_at``, ``seeded_at`` and ``edited_at``, none of
    which is a creation stamp and each of which is null on most rows. The rule used is
    **lowest ``sync_seq``, then lowest ``id``**: ``sync_seq`` is the owning project's
    monotonic write cursor (ADR-0686), so the row that reached the project's sequence
    first keeps the path — the closest thing to "created first" this table records.
    Both terms are stable, so repairing the same database twice, or two replicas of it,
    produces identical output.

    **Descendant count deliberately does not enter the rule, and that is the crux.** The
    instinct is "keep whichever row owns the subtree" — but descendants are addressed BY
    PATH, and every row in a duplicate group shares the path. A row at ``4.2.1`` is a
    child of "the ``4.2`` in this project"; when there are two of those, nothing in the
    data says which. The count is identical for every candidate and cannot rank them.
    Using it would look principled while sorting on a constant.

    So the subtree stays with the kept row, and the moved row becomes childless at its
    new path. That is a real consequence for the operator, which is why the count rides
    back on :attr:`RepairedWbsPath.stranded_descendants` instead of being dropped.

    A moved row is re-pathed among its **own siblings** — ``4.2`` becomes ``4.9``, not a
    new root — so it stays inside the phase a planner put it in. A root-level duplicate
    shifts to a free root ordinal past the project's current max, the same rule
    ``_root_ordinal_offset()`` applies to template adoption, so repaired and seeded rows
    agree about what "the next free root" means.

    Takes the model class rather than reaching for ``Task`` directly so the migration can
    pass its historical model and a test can pass the real one (CLAUDE.md rule 3: never
    import a migration module in a test).

    On the overwhelmingly common clean database this is one aggregate query and a return.
    """
    dupes = (
        task_model.objects.filter(is_deleted=False, wbs_path__isnull=False)
        .values("project_id", "wbs_path")
        .annotate(n=Count("id"))
        .filter(n__gt=1)
    )
    affected = {(g["project_id"], str(g["wbs_path"])) for g in dupes}
    if not affected:
        return []

    repaired: list[RepairedWbsPath] = []

    for project_id in sorted({pid for pid, _ in affected}, key=str):
        rows = list(
            task_model.objects.filter(
                project_id=project_id, is_deleted=False, wbs_path__isnull=False
            ).values("id", "wbs_path", "sync_seq")
        )
        taken = {str(r["wbs_path"]) for r in rows}

        by_path: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            by_path.setdefault(str(row["wbs_path"]), []).append(row)

        # Live descendants per path — for the operator-facing report ONLY, never for
        # the keep rule (see the docstring). A path's descendants are the rows whose
        # path starts with it plus a separator; the string test is exact because an
        # ltree label cannot contain a dot.
        descendants = {
            path: sum(len(v) for p, v in by_path.items() if p.startswith(path + "."))
            for path in by_path
        }

        # Resume the ordinal search per prefix so a group of three duplicates does not
        # rescan from 1 for each move.
        next_ordinal: dict[str, int] = {}

        for path in sorted(p for pid, p in affected if pid == project_id):
            group = by_path.get(path, [])
            if len(group) < 2:
                continue
            # Earliest position in the project's write sequence keeps the path; the pk
            # breaks a tie. Both are stable, so this is reproducible.
            group.sort(key=lambda r: (r["sync_seq"], str(r["id"])))
            keeper, movers = group[0], group[1:]

            head, _, _ = path.rpartition(".")
            prefix = f"{head}." if head else ""
            start = next_ordinal.get(prefix, 1)

            for mover in movers:
                new_path, start = _free_sibling_path(taken, prefix, start)
                taken.add(new_path)
                task_model.objects.filter(pk=mover["id"]).update(wbs_path=new_path)
                repaired.append(
                    RepairedWbsPath(
                        project_id=str(project_id),
                        task_id=str(mover["id"]),
                        old_path=path,
                        new_path=new_path,
                        kept_task_id=str(keeper["id"]),
                        stranded_descendants=descendants.get(path, 0),
                    )
                )
            next_ordinal[prefix] = start

    _log_repairs(repaired)
    return repaired


def _log_repairs(repaired: list[RepairedWbsPath]) -> None:
    """Report every moved row at WARNING. See :func:`repair_duplicate_wbs_paths`."""
    if not repaired:
        return
    logger.warning(
        "wbs_path repair (#3068): %d row(s) across %d project(s) shared a live WBS path "
        "with another row and have been moved so the uniqueness constraint can be "
        "applied. Review the moves below.",
        len(repaired),
        len({r.project_id for r in repaired}),
    )
    for row in repaired:
        logger.warning(
            "wbs_path repair (#3068): project=%s task=%s moved %s -> %s (kept task=%s)%s",
            row.project_id,
            row.task_id,
            row.old_path,
            row.new_path,
            row.kept_task_id,
            (
                f"; {row.stranded_descendants} live row(s) under {row.old_path} stayed "
                f"with task {row.kept_task_id} - a duplicated path makes their parent "
                "ambiguous and nothing in the data distinguishes them"
                if row.stranded_descendants
                else ""
            ),
        )
