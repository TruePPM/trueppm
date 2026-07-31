"""Per-project monotonic sequence backing the sync delta cursor (ADR-0686, #2491).

``Project.last_sync_version`` is the allocator for a project's ``sync_seq``
sequence. Every synced write draws the next value in one statement::

    UPDATE projects_project SET last_sync_version = last_sync_version + 1
     WHERE id = %s RETURNING last_sync_version

and stamps it on the row's ``sync_seq``. Because every synced row in a project is
drawn from the same counter, the values are totally ordered within the project,
``MAX`` is a meaningful checkpoint, and the delta filter ``sync_seq__gt=since`` is
correct.

This replaces the ADR-0142 watermark *receivers*, which cached
``MAX(server_version)`` on the same column. That cache was faithful; the thing it
cached was not a valid ordering — ``server_version`` counts a single row's saves,
so comparing it against a project-wide maximum let a frequently-edited row raise
the checkpoint above every other row's counter and drop those rows from the delta
permanently (#2491). ``server_version`` keeps its per-row meaning (optimistic
lock, and the 1:1 history-row correspondence the ADR-0217 field-level merge
counts on); ``sync_seq`` is the replication cursor.

**The project row lock is load-bearing.** Allocation ``UPDATE``s the project row
and holds its write lock until commit, so concurrent synced writes to one project
serialize on allocation and commit order equals allocation order. Without that a
transaction could allocate 100, a later one allocate 101 and commit first, and a
pull between the two commits would report 101 and permanently skip 100 — this
same bug, reintroduced as a race. Under ``READ COMMITTED`` readers neither block
nor observe an uncommitted allocation, so a pull always reports a checkpoint whose
rows are all committed.

For a single write this adds no contention ADR-0142 did not already have: its
receivers issued ``UPDATE projects_project SET last_sync_version = Greatest(…)``
on every synced save, taking the same lock. For a *batch* the lock is held
longer. The old ``coalesce_watermark_bumps`` deferred its one UPDATE to context
exit, so the project row was locked only for the tail of the transaction; the
allocator cannot defer, because it must return a value to stamp on the first row.
Two concurrent uploads to the same project therefore serialize across the whole
apply rather than just its tail. That is the price of an ordered cursor — the
ordering is exactly what the lock buys — but it is a real change, not a wash.

``Dependency`` and ``TaskRelation`` carry no project FK, but they *are* delivered
as their own collections, so they allocate through their edge's owning task
(``predecessor`` / ``source``) exactly like any other synced row. They must: the
delta filters each collection on its own ``sync_seq``, so a row that never
allocates stays at 0 and ``sync_seq__gt=since`` never returns it — not even on a
cold start with ``since=0``.

Deliberately *not* allocated: every ``VersionedModel`` outside the sync union
(``PulseResponse``, ``RetroBoardItem``, ``BacklogItem``, ``ApiToken``, resources,
teams, …). They keep ``sync_seq = 0``; nothing reads it for them.

CPM output writes use ``bulk_update`` (ADR-0091) — no ``save()``, no allocation —
so recompute leaves the cursor untouched, matching the delta.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from typing import Any

from django.db import models
from django.db.models import F, Value
from django.db.models.functions import Greatest

#: A resolver maps a synced instance to the project ids whose sequence it draws
#: from. Direct FKs read the id off the instance (no query). Indirect ones return
#: a queryset that ``allocate`` materializes, costing one extra SELECT per save:
#: ``_next_seq`` needs a concrete id for its ``UPDATE … WHERE id = %s``, so unlike
#: the ADR-0142 receivers it replaces, the queryset cannot stay an IN-subquery.
Resolver = Callable[[Any], Iterable[Any]]

# Per-thread allocation cache for the coalesced-batch context (see
# ``coalesce_sync_seq``). ``None`` outside a batch, so a non-batch save allocates
# its own value exactly as before.
_batch_state = threading.local()


def _batch_cache() -> dict[Any, int] | None:
    return getattr(_batch_state, "active", None)


def _next_seq(project_id: Any) -> int:
    """Draw the next value of ``project_id``'s sequence, or 0 if the row is gone.

    Returns 0 when the ``UPDATE`` matches no row — the project was hard-deleted
    concurrently, or (for a ``Project`` being INSERTed) does not exist yet. The
    caller decides what that means; a 0 cursor is simply never delivered.

    The statement lives in :func:`trueppm_api.core.db.increment_returning`, shared
    with the ``server_version`` bump so the API has one raw-SQL site.
    """
    from trueppm_api.apps.projects.models import Project
    from trueppm_api.core.db import increment_returning

    seq = increment_returning(Project, "last_sync_version", project_id)
    return seq if seq is not None else 0


def allocate_program_seq() -> int:
    """Draw the next value of the installation-wide program sequence (ADR-0747).

    The program slice of the sync protocol has no owning row to sequence from the
    way a task has its project: the accessible set is the per-user union of the
    caller's programs, and those programs are independent. A scalar cursor over
    per-program sequences would reintroduce the same defect one level up — a hot
    program's sequence outrunning a cold one's and dropping the cold program's rows
    from the delta permanently (#2498). One counter for every program-scoped write
    is what makes the scalar cursor sound again.

    Returns 0 if the singleton row is missing (a database predating the backfill
    migration). A row left at ``sync_seq = 0`` is simply never delivered, so this
    fails closed toward "not yet replicated" rather than toward a false checkpoint.
    """
    from trueppm_api.apps.sync.models import ProgramSyncSequence
    from trueppm_api.core.db import increment_returning

    seq = increment_returning(ProgramSyncSequence, "value", ProgramSyncSequence.SINGLETON_PK)
    return seq if seq is not None else 0


def _raise_to(project_ids: Iterable[Any], seq: int) -> None:
    """Raise every project's allocator to at least ``seq`` (monotonic)."""
    from trueppm_api.apps.projects.models import Project

    Project.objects.filter(pk__in=project_ids).update(
        last_sync_version=Greatest(F("last_sync_version"), Value(seq))
    )


def allocate_for_projects(project_ids: list[Any]) -> int:
    """Return a cursor value valid for every project in ``project_ids``.

    The single-owner case — every synced model except ``Calendar`` — is one
    ``UPDATE … RETURNING``.

    A row owned by several projects (a ``Calendar`` shared by more than one) can
    carry only one ``sync_seq``, so it draws from *every* owner and keeps the
    maximum. The follow-up ``_raise_to`` is what preserves the invariant
    ``sync_seq <= last_sync_version`` for the owners whose draw came in lower —
    without it the shared row would sit permanently above one project's
    checkpoint and be redelivered on every single pull.
    """
    if not project_ids:
        return 0
    # Sort before taking any lock. A multi-owner row locks several project rows in
    # sequence, and the resolver's queryset has no ORDER BY — two concurrent saves
    # of the same shared calendar could otherwise grab the same two rows in
    # opposite orders and deadlock. A total order on the ids removes the cycle.
    project_ids = sorted(project_ids, key=str)
    batch = _batch_cache()
    if batch is None:
        seq = max(_next_seq(pid) for pid in project_ids)
    else:
        for pid in project_ids:
            if pid not in batch:
                batch[pid] = _next_seq(pid)
        seq = max(batch[pid] for pid in project_ids)
    if len(project_ids) > 1 and seq:
        _raise_to(project_ids, seq)
        if batch is not None:
            # Keep the cache consistent with the watermarks just raised. A later
            # row in the same batch owned only by a lower-drawing project would
            # otherwise reuse a value now *below* that project's watermark — and
            # a row at or below the checkpoint is never delivered.
            for pid in project_ids:
                batch[pid] = seq
    return seq


def allocate(instance: Any) -> None:
    """Stamp ``instance.sync_seq`` with a fresh cursor value from its owner(s).

    A no-op for models outside the sync union and for a synced row whose owning
    project cannot be resolved yet (a ``Calendar`` no project points at). Such a
    row keeps ``sync_seq = 0`` and is not delivered until an owner appears — see
    :func:`register_sequence_receivers`, which allocates a calendar the moment a
    project links to it.
    """
    # Program-scoped rows draw from the installation-wide sequence instead of a
    # project's (ADR-0747) — they have no owning project, and the per-user
    # accessible set makes a per-program sequence unusable under a scalar cursor.
    if type(instance) in PROGRAM_SEQUENCE_MODELS:
        seq = allocate_program_seq()
        if seq:
            instance.sync_seq = seq
        return

    resolver = OWNER_RESOLVERS.get(type(instance))
    if resolver is None:
        return
    project_ids = list(resolver(instance))
    if not project_ids:
        return
    seq = allocate_for_projects(project_ids)
    if not seq:
        return
    instance.sync_seq = seq
    if hasattr(instance, "last_sync_version") and instance.pk in project_ids:
        # A project drawing from its own sequence: keep the in-memory allocator in
        # step with the row the UPDATE just wrote. `last_sync_version` is excluded
        # from save()'s update_fields, so the DB value is already correct — this
        # only stops a caller reading a stale watermark off the saved instance.
        instance.last_sync_version = seq


def seed_project_sequence(project: Any) -> None:
    """Start a not-yet-INSERTed project's sequence at 1, in memory.

    ``Project`` is itself a synced row, but on the INSERT path there is no row to
    ``UPDATE`` — the allocator column and the cursor are written by the INSERT
    itself. Called from ``VersionedModel.save()``.
    """
    project.last_sync_version = 1
    project.sync_seq = 1


@contextmanager
def coalesce_sync_seq() -> Iterator[None]:
    """Draw one cursor value per project for the whole block.

    Rows written together may share a ``sync_seq``: the delta is ``> since`` and
    the checkpoint is the maximum, so a batch is either wholly before or wholly
    after any client checkpoint. Sharing keeps the #1527 optimization that stopped
    a 500-row sync upload from issuing 500 ``UPDATE projects_project`` statements
    — it now issues one per project instead of one per row.

    The allocations run *inside* the caller's transaction, so a rollback discards
    them along with the rows. Re-entrancy is a no-op: a nested call shares the
    outermost cache.
    """
    if _batch_cache() is not None:
        yield
        return
    _batch_state.active = {}
    try:
        yield
    finally:
        _batch_state.active = None


def _resolvers() -> dict[type[models.Model], Resolver]:
    """Build the model → owning-project-ids map (imports are deferred to app-ready)."""
    from trueppm_api.apps.access.models import ProjectMembership
    from trueppm_api.apps.integrations.models import TaskLink
    from trueppm_api.apps.projects.models import (
        Calendar,
        Dependency,
        Label,
        Project,
        RetroActionItem,
        Risk,
        Sprint,
        SprintRetro,
        Task,
        TaskRecurrenceRule,
        TaskRelation,
        TaskSuggestedAssignee,
    )
    from trueppm_api.apps.timetracking.models import TimeEntry

    return {
        Project: lambda i: [i.pk],
        Task: lambda i: [i.project_id],
        ProjectMembership: lambda i: [i.project_id],
        Risk: lambda i: [i.project_id],
        Sprint: lambda i: [i.project_id],
        # Label catalog (ADR-0400) — direct project FK. The TaskLabel through-row
        # is deliberately absent: it has no cursor of its own, and attach/detach
        # saves the Task, which allocates there instead.
        Label: lambda i: [i.project_id],
        # A calendar may be shared by several projects — draw from all of them.
        Calendar: lambda i: list(
            Project.objects.filter(calendar_id=i.pk).values_list("pk", flat=True)
        ),
        SprintRetro: lambda i: Sprint.objects.filter(pk=i.sprint_id).values_list(
            "project_id", flat=True
        ),
        RetroActionItem: lambda i: SprintRetro.objects.filter(pk=i.retro_id).values_list(
            "sprint__project_id", flat=True
        ),
        TaskSuggestedAssignee: lambda i: Task.objects.filter(pk=i.task_id).values_list(
            "project_id", flat=True
        ),
        TaskLink: lambda i: Task.objects.filter(pk=i.task_id).values_list("project_id", flat=True),
        # Graph edges have no project FK of their own. Both are delivered as their
        # own sync collection filtered on their own `sync_seq`, so both must
        # allocate — otherwise they sit at 0 and are never delivered at all. The
        # owner is read off the endpoint the delta already scopes and orders by
        # (`predecessor` / `source`), matching their composite indexes.
        Dependency: lambda i: Task.objects.filter(pk=i.predecessor_id).values_list(
            "project_id", flat=True
        ),
        TaskRelation: lambda i: Task.objects.filter(pk=i.source_id).values_list(
            "project_id", flat=True
        ),
        TaskRecurrenceRule: lambda i: Task.objects.filter(pk=i.task_id).values_list(
            "project_id", flat=True
        ),
        # A time entry's owning project is reached through its task (ADR-0185 §6).
        # Any user's entry advances the project cursor; the per-user sync filter
        # lives in the delta query, not here — a cursor value the caller cannot
        # see only costs a pull that returns nothing for that row.
        TimeEntry: lambda i: Task.objects.filter(pk=i.task_id).values_list("project_id", flat=True),
    }


#: Populated by :func:`register_sequence_receivers` at app-ready. Empty before
#: then, which makes ``allocate`` a no-op — correct during app loading.
OWNER_RESOLVERS: dict[type[models.Model], Resolver] = {}

#: Models whose ``sync_seq`` is drawn from the installation-wide program sequence
#: rather than an owning project's (ADR-0747, #2498). Populated at app-ready
#: alongside ``OWNER_RESOLVERS`` — empty before then, so ``allocate`` is a no-op
#: during app loading, exactly as for the project path.
PROGRAM_SEQUENCE_MODELS: set[type[models.Model]] = set()


def register_sequence_receivers() -> None:
    """Populate the resolver map and connect the calendar-link receiver.

    Called from ``SyncConfig.ready``.
    """
    from django.db.models.signals import post_save

    from trueppm_api.apps.access.models import ProgramMembership
    from trueppm_api.apps.projects.models import Calendar, Program, Project

    OWNER_RESOLVERS.clear()
    OWNER_RESOLVERS.update(_resolvers())

    # ADR-0747: the two program-scoped synced models. Deliberately NOT in
    # OWNER_RESOLVERS — they resolve to no project, and adding them there would
    # make them silently unallocated rather than program-allocated.
    PROGRAM_SEQUENCE_MODELS.clear()
    PROGRAM_SEQUENCE_MODELS.update({Program, ProgramMembership})

    def _on_project_saved(sender: type, instance: Any, created: bool, **kwargs: Any) -> None:
        """Allocate the calendar when a project starts pointing at it.

        A ``Calendar`` created before any project references it resolves to no
        owner, so it keeps ``sync_seq = 0`` and would never be delivered. The
        moment a project links to it — at creation, or when the FK is repointed —
        it gains an owner and must be allocated, exactly once.

        ``raw`` saves (loaddata) bypass app logic; the DB may be mid-fixture-load,
        so skip — the backfill migration or a later real save establishes it.
        """
        if kwargs.get("raw") or instance.calendar_id is None:
            return
        previous = getattr(instance, "_sync_loaded_calendar_id", None)
        if not created and previous == instance.calendar_id:
            return
        instance._sync_loaded_calendar_id = instance.calendar_id
        calendar = Calendar.objects.filter(pk=instance.calendar_id).first()
        if calendar is None:
            return
        allocate(calendar)
        if calendar.sync_seq:
            # A plain .update(): the calendar's own content did not change, so
            # this must not bump server_version or write a history row.
            Calendar.objects.filter(pk=calendar.pk).update(sync_seq=calendar.sync_seq)

    post_save.connect(
        _on_project_saved,
        sender=Project,
        dispatch_uid="sync_sequence_project_calendar_link",
        weak=False,
    )
