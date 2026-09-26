"""Data-backfill helpers for the projects app migrations.

These functions are extracted from migration files so tests can import them
without coupling to migration file names, which break on squash (CLAUDE.md rule 3).
"""

from __future__ import annotations

import logging
from collections.abc import Callable
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
    ``root_ordinal_offset()`` applies to template adoption, so repaired and seeded rows
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


class RewrittenKey(NamedTuple):
    """One code the ADR-1237 repair changed, for the upgrade log and for tests."""

    kind: str
    object_id: Any
    old_code: str
    new_code: str


def _creation_order(model: Any, historical_model: Any | None) -> dict[Any, Any]:
    """Map each row's pk to a sortable "when was it created" value.

    ``Program`` carries ``created_at``. ``Project`` does not, so its earliest
    history row stands in — the closest thing to a creation timestamp the table
    has. A row with neither sorts last, by pk, which is deterministic if not
    meaningful.
    """
    from django.db.models import Min

    if any(f.name == "created_at" for f in model._meta.get_fields()):
        return dict(model.objects.values_list("pk", "created_at"))
    if historical_model is None:
        return {}
    return dict(
        historical_model.objects.values("id")
        .annotate(first=Min("history_date"))
        .values_list("id", "first")
    )


def repair_object_keys(
    project_model: Any,
    program_model: Any,
    object_key_model: Any,
    *,
    historical_project_model: Any | None = None,
) -> list[RewrittenKey]:
    """Give every project and program a unique key and an ``ObjectKey`` row (ADR-1237 §4).

    Runs before ``AddConstraint(Upper("code"))`` so the constraint can validate
    (migration rule 7). For each kind, in creation order:

    * a non-blank code that no older row already holds (case-insensitively) is
      **kept** as-is — including a grandfathered hyphenated project code — and
      recorded with ``source="user"``;
    * a duplicate is **suffixed** (``PLAT`` → ``PLAT2``), so the oldest holder
      keeps the key its links already use;
    * a blank code is **derived** from the name.

    Both rewrites are recorded with ``source="backfill"`` and logged at WARNING,
    and the upgrade notes tell operators to list them with
    ``ObjectKey.objects.filter(source="backfill")``.

    Idempotent: an object that already has a current ``ObjectKey`` row is left
    alone, and every existing ``ObjectKey`` key is treated as taken, so a re-run
    neither duplicates rows nor reissues a retired key.

    Model classes are parameters so the migration can pass historical models and
    a test can pass the real ones (migration rule 3).
    """
    from trueppm_api.apps.projects.keys import (
        KIND_PROGRAM,
        KIND_PROJECT,
        PROJECT_KEY_RE,
        base_key_for,
        next_free_key,
    )

    def taken_in(taken: set[str]) -> Callable[[str], bool]:
        return lambda candidate: candidate.upper() in taken

    rewritten: list[RewrittenKey] = []
    for kind, model, fk, historical in (
        (KIND_PROJECT, project_model, "project", historical_project_model),
        (KIND_PROGRAM, program_model, "program", None),
    ):
        taken = {
            k.upper()
            for k in object_key_model.objects.filter(kind=kind).values_list("key", flat=True)
        }
        keyed = set(
            object_key_model.objects.filter(
                kind=kind, is_current=True, **{f"{fk}__isnull": False}
            ).values_list(f"{fk}_id", flat=True)
        )
        order = _creation_order(model, historical)
        rows = [r for r in model.objects.all().only("pk", "name", "code") if r.pk not in keyed]
        # Rows that already carry a key keep claiming it; they are not re-ordered.
        for code in model.objects.filter(pk__in=keyed).values_list("code", flat=True):
            if code:
                taken.add(code.upper())
        rows.sort(key=lambda r: (order.get(r.pk) is None, order.get(r.pk) or 0, str(r.pk)))

        new_rows: list[Any] = []
        changed: list[Any] = []
        pending: list[Any] = []
        for row in rows:
            code = (row.code or "").strip()
            if code and code.upper() not in taken:
                taken.add(code.upper())
                new_rows.append(
                    object_key_model(
                        kind=kind, key=code, is_current=True, source="user", **{fk: row}
                    )
                )
            else:
                pending.append(row)

        # Rewrites run after every keeper has claimed its code, so a blank or
        # duplicate row can never be handed a code an older, kept row holds.
        for row in pending:
            old = (row.code or "").strip()
            if old and kind == KIND_PROJECT and PROJECT_KEY_RE.fullmatch(old.upper()):
                base = old.upper()
            elif old and kind == KIND_PROGRAM:
                base = base_key_for(old, kind)
            else:
                base = base_key_for(row.name, kind)
            new = next_free_key(base, kind, taken_in(taken))
            taken.add(new.upper())
            row.code = new
            changed.append(row)
            new_rows.append(
                object_key_model(
                    kind=kind, key=new, is_current=True, source="backfill", **{fk: row}
                )
            )
            rewritten.append(RewrittenKey(kind, row.pk, old, new))

        if changed:
            model.objects.bulk_update(changed, ["code"], batch_size=1000)
        if new_rows:
            object_key_model.objects.bulk_create(new_rows, batch_size=1000)

    _log_key_rewrites(rewritten)
    return rewritten


def _log_key_rewrites(rewritten: list[RewrittenKey]) -> None:
    """Report every rewritten code at WARNING. See :func:`repair_object_keys`."""
    if not rewritten:
        return
    logger.warning(
        "key repair (ADR-1237): %d project/program code(s) were blank or duplicated and "
        "have been rewritten so keys can be unique. List them later with "
        "ObjectKey.objects.filter(source='backfill').",
        len(rewritten),
    )
    for row in rewritten:
        logger.warning(
            "key repair (ADR-1237): %s=%s code %r -> %r",
            row.kind,
            row.object_id,
            row.old_code,
            row.new_code,
        )
