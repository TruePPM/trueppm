"""Celery tasks for the sync app.

``purge_sync_batches`` reaps :class:`~trueppm_api.apps.sync.models.SyncBatch`
rows past the dedup window so the idempotency table stays bounded — the
ADR-0081 purge convention applied to the upload envelope (ADR-0082 §Durable
Execution #6).

``reap_domain_tombstones`` hard-deletes per-row soft-deleted tombstones
(``is_deleted=True``) from live projects. VersionedModel rows are soft-deleted
so the mobile sync endpoint can return their IDs as tombstones to offline
clients; once the retention window has passed there is no further value in
keeping the row and it can be hard-deleted. Only rows belonging to live
(non-deleted, non-archived) projects are touched — tombstones in deleted or
archived projects are skipped because those projects may still be restoring.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from trueppm_api.core.idempotent import idempotent_task

logger = logging.getLogger(__name__)


@idempotent_task(
    lock_key_template="purge_sync_batches",
    lock_ttl=300,
    on_contention="skip",
    name="sync.purge_sync_batches",
)
def purge_sync_batches(self: object) -> None:
    """Delete SyncBatch rows older than the retention window.

    Runs nightly via Celery Beat. Rows are only dedup-relevant within
    ``TRUEPPM_SYNC_BATCH_RETENTION_HOURS`` (default 24h); past that, the same
    ``client_batch_id`` is allowed to re-run, so the row carries no value.
    Idempotent and contention-skipping — a second concurrent run is a no-op.
    """
    _do_purge()


def _do_purge(*, dry_run: bool = False, override_value: int | None = None) -> int:
    """Business logic for purge_sync_batches — extracted for testability.

    The window (in hours) comes from ``resolve_retention`` (operator override →
    the TRUEPPM_SYNC_BATCH_RETENTION_HOURS default, ADR-0173). This window is
    non-nullable, so it is never disabled. Returns rows deleted, or the eligible
    count when ``dry_run``; ``override_value`` forces a hypothetical window.
    """
    from django.utils import timezone

    from trueppm_api.apps.observability.retention import resolve_retention
    from trueppm_api.apps.sync.models import SyncBatch

    ttl_hours = (
        override_value
        if override_value is not None
        else resolve_retention("TRUEPPM_SYNC_BATCH_RETENTION_HOURS")
    )
    if ttl_hours is None:
        return 0
    cutoff = timezone.now() - timedelta(hours=ttl_hours)
    qs = SyncBatch.objects.filter(created_at__lt=cutoff)
    if dry_run:
        return qs.count()
    deleted, _ = qs.delete()
    if deleted:
        logger.info("purge_sync_batches: deleted %d expired batch row(s)", deleted)
    return deleted


@idempotent_task(
    lock_key_template="purge_board_events",
    lock_ttl=300,
    on_contention="skip",
    name="sync.purge_board_events",
)
def purge_board_events(self: object) -> None:
    """Delete BoardEvent replay-buffer rows older than the retention window.

    Runs nightly via Celery Beat (ADR-0236, #321). A reconnecting client whose
    ``?since=`` predates the retained window gets a ``resync_required`` frame and
    refetches, so aged-out rows carry no value. Idempotent and contention-skipping
    — a concurrent run is a no-op.
    """
    _do_purge_board_events()


def _do_purge_board_events(*, dry_run: bool = False, override_value: int | None = None) -> int:
    """Business logic for purge_board_events — extracted for testability.

    Reads the window directly from ``settings.TRUEPPM_BOARD_EVENT_RETENTION_HOURS``
    (mirrors ``reap_domain_tombstones``), not the ADR-0173 operator resolver — the
    replay buffer is internal transport plumbing, not an operator-tunable table.
    Returns rows deleted, or the eligible count when ``dry_run``; ``override_value``
    forces a hypothetical window (hours).
    """
    from django.conf import settings
    from django.utils import timezone

    from trueppm_api.apps.sync.models import BoardEvent

    ttl_hours: int = (
        override_value
        if override_value is not None
        else getattr(settings, "TRUEPPM_BOARD_EVENT_RETENTION_HOURS", 24)
    )
    cutoff = timezone.now() - timedelta(hours=ttl_hours)
    qs = BoardEvent.objects.filter(created_at__lt=cutoff)
    if dry_run:
        return qs.count()
    deleted, _ = qs.delete()
    if deleted:
        logger.info("purge_board_events: deleted %d expired replay-buffer row(s)", deleted)
    return deleted


# ---------------------------------------------------------------------------
# reap_domain_tombstones — hard-delete stale per-row soft-delete tombstones
# ---------------------------------------------------------------------------

# Registry of (Model, project_filter_kwargs, age_field_or_None).
#
# ``age_field`` is the DateTimeField used to enforce the retention window. Two
# flavors are in use: an ``updated_at`` (auto_now=True) column that reflects the
# most recent save (Risk, Sprint), or a ``deleted_at`` column stamped only by
# ``soft_delete()`` (mirrors Attachment.deleted_at) — used by Task and
# Dependency so a tombstone reliably survives TRUEPPM_TOMBSTONE_RETENTION_DAYS
# regardless of when the row last happened to be saved for an unrelated reason.
# ``age_field=None`` remains a valid registry entry for a model that
# deliberately opts out of a grace window, but every model below enforces one —
# an offline mobile client must have a window to reconnect and receive a
# tombstone before it is hard-deleted, or the deleted row becomes a permanent
# phantom on that device.
#
# Extend this list when new VersionedModel subclasses are added that carry
# ``is_deleted`` tombstones in the projects domain.


def _build_registry() -> list[tuple[Any, dict[str, Any], str | None]]:
    """Build the tombstone model registry with deferred model imports.

    Deferred so the function can be called safely after Django app setup
    completes, avoiding circular imports at module load time.
    """
    from trueppm_api.apps.projects.models import (
        Dependency,
        Label,
        Risk,
        Sprint,
        SprintRetro,
        Task,
        TaskRelation,
    )
    from trueppm_api.apps.timetracking.models import TimeEntry

    return [
        # Task: deleted_at is stamped in Task.soft_delete() (mirrors Attachment) —
        # enforce the retention window so a tombstone survives long enough for an
        # offline client to reconnect and receive it.
        (
            Task,
            {"project__is_deleted": False, "project__is_archived": False},
            "deleted_at",
        ),
        # Risk: has updated_at — enforce the retention window.
        (
            Risk,
            {"project__is_deleted": False, "project__is_archived": False},
            "updated_at",
        ),
        # Sprint: has updated_at — enforce the retention window.
        (
            Sprint,
            {"project__is_deleted": False, "project__is_archived": False},
            "updated_at",
        ),
        # Dependency: no direct project FK — reap via predecessor. deleted_at is
        # stamped in Dependency.soft_delete() (mirrors Task) — enforce the same
        # retention window. Same-project and cross-project edges are both
        # handled: once the predecessor's project is live and the edge is past
        # the retention window, there is no further sync value in the row.
        (
            Dependency,
            {
                "predecessor__project__is_deleted": False,
                "predecessor__project__is_archived": False,
            },
            "deleted_at",
        ),
        # TaskRelation (ADR-0455): no direct project FK — reap via the source task,
        # mirroring Dependency. deleted_at is stamped in TaskRelation.soft_delete(),
        # so the same retention grace window keeps a tombstone available long enough
        # for an offline client to reconnect and receive it.
        (
            TaskRelation,
            {
                "source__project__is_deleted": False,
                "source__project__is_archived": False,
            },
            "deleted_at",
        ),
        # Label (#2342): direct project FK; no deleted_at, but soft_delete() saves the
        # row so auto_now ``updated_at`` is the deletion time. Highest-churn catalog.
        (
            Label,
            {"project__is_deleted": False, "project__is_archived": False},
            "updated_at",
        ),
        # SprintRetro (#2342): reaped via its sprint's project; ``updated_at`` as above.
        # Cascades to RetroActionItem, which _delete_tracking_sync_seq folds into the floor.
        (
            SprintRetro,
            {"sprint__project__is_deleted": False, "sprint__project__is_archived": False},
            "updated_at",
        ),
        # TimeEntry (#2342): reaped via its task's project. ``deleted_at`` is stamped by
        # TimeEntry.soft_delete(); a row soft-deleted before that column existed has a
        # NULL and is never reaped (same as Task), which errs toward keeping a tombstone.
        (
            TimeEntry,
            {"task__project__is_deleted": False, "task__project__is_archived": False},
            "deleted_at",
        ),
        # NOT yet covered, because no column records WHEN they were deleted and a
        # created_at/absent age would reap inside the grace window: ProjectMembership,
        # RetroActionItem, TaskSuggestedAssignee, TaskLink, TaskRecurrenceRule (need a
        # deleted_at column + migration). Calendar is shared across projects, so it has
        # no single owner to floor against.
    ]


@idempotent_task(
    lock_key_template="reap_domain_tombstones",
    lock_ttl=600,
    on_contention="skip",
    name="sync.reap_domain_tombstones",
)
def reap_domain_tombstones(self: object) -> dict[str, int]:
    """Hard-delete per-row soft-deleted tombstones from live projects.

    Runs nightly via Celery Beat. For each model in ``_build_registry()``:
    - Filters ``is_deleted=True`` rows in live (non-deleted, non-archived) projects.
    - For models with an ``age_field`` (``updated_at`` or ``deleted_at``), further
      restricts to rows older than the ``TRUEPPM_TOMBSTONE_RETENTION_DAYS`` cutoff
      (default 90 days).
    - Hard-deletes the eligible rows.

    Returns a dict mapping ``{app_label.model_name: rows_deleted}`` for each
    model — useful for monitoring and log-based alerting.

    Idempotent and contention-skipping — a concurrent run is a no-op.
    """
    return _do_reap()


def _do_reap(*, override_days: int | None = None) -> dict[str, int]:
    """Business logic for reap_domain_tombstones — extracted for testability.

    Args:
        override_days: Force a specific retention window (days) instead of
            reading ``TRUEPPM_TOMBSTONE_RETENTION_DAYS`` from settings. Useful
            in tests to avoid manipulating global settings.

    Returns:
        Dict mapping ``{app_label.model_name: rows_deleted}`` for every
        model in the registry, including zeros.
    """
    from django.conf import settings
    from django.utils import timezone

    retention_days: int = (
        override_days
        if override_days is not None
        else getattr(settings, "TRUEPPM_TOMBSTONE_RETENTION_DAYS", 90)
    )
    cutoff = timezone.now() - timedelta(days=retention_days)

    registry = _build_registry()
    eligible: list[tuple[Any, str, Any]] = []
    candidates: set[Any] = set()
    counts: dict[str, int] = {}
    for Model, project_filters, age_field in registry:
        label: str = Model._meta.label_lower
        counts[label] = 0
        qs = Model.objects.filter(is_deleted=True, **project_filters)
        if age_field is not None:
            qs = qs.filter(**{f"{age_field}__lt": cutoff})
        owner = _owner_path(project_filters)
        eligible.append((Model, owner, qs))
        # ``order_by()`` first: a model's ``Meta.ordering`` would otherwise be
        # added to the SELECT list and silently defeat the DISTINCT.
        candidates.update(qs.order_by().values_list(owner, flat=True).distinct())

    # One short transaction per project rather than one for the whole run, so a
    # nightly reap never holds every project's row lock at once.
    # A failure in one project (a deadlock with a concurrent writer, a lock
    # timeout) rolls back only that project's transaction — its tombstones and
    # its floor together, so nothing leaks — and the next night retries it. It
    # must not abort every remaining project's reap.
    from django.db import OperationalError

    for project_id in sorted(candidates, key=str):
        try:
            _reap_project(project_id, eligible, counts)
        except OperationalError:
            logger.exception(
                "reap_domain_tombstones: reap of project %s failed and was rolled back; "
                "it will be retried on the next run",
                project_id,
            )

    for label, deleted in counts.items():
        if deleted:
            logger.info(
                "reap_domain_tombstones: hard-deleted %d %s tombstone(s)",
                deleted,
                label,
            )
    return counts


def _owner_path(project_filters: dict[str, Any]) -> str:
    """Return the lookup path to a registry entry's owning project id.

    Derived from the registry's own project-liveness filter
    (``project__is_deleted`` → ``project``; ``predecessor__project__is_deleted``
    → ``predecessor__project``) so the registry tuple shape stays unchanged. That
    owner is the project whose sequence the row drew its ``sync_seq`` from
    (``apps/sync/sequence.py`` resolvers), which is what makes the row's
    ``sync_seq`` comparable with that project's pull cursor.
    """
    for key in project_filters:
        if key.endswith("__is_deleted"):
            return key.removesuffix("__is_deleted")
    raise ValueError(f"registry entry has no project liveness filter: {project_filters!r}")


def _delta_lookups(model: Any, project_id: Any) -> dict[str, Any] | None:
    """Return the filter selecting ``model`` rows that ``project_id``'s pull delivers.

    Mirrors the scoping of ``ProjectSyncView``'s delta: a row counts toward a
    project's floor only if that project's single-project pull would have
    delivered it. Graph edges are delivered only when **both** ends sit in the
    project, so a cross-project ``Dependency`` / ``TaskRelation`` is never part of
    either project's delta — and its ``sync_seq`` was drawn from the
    predecessor's / source's sequence, which is a different number line from this
    project's whenever the reaped task is the successor / target. Counting it
    would inflate the floor above every cursor this project's clients hold and
    force spurious re-syncs.

    Returns ``None`` for a model outside the project sync union (it carries
    ``sync_seq = 0`` and no pull delivers it) and for one this helper cannot
    attribute to a single project (``Calendar``, which a task reap never
    cascades to).
    """
    from trueppm_api.apps.projects.models import (
        Dependency,
        RetroActionItem,
        SprintRetro,
        TaskRelation,
    )
    from trueppm_api.apps.sync.sequence import OWNER_RESOLVERS

    if model not in OWNER_RESOLVERS:
        return None
    if model is Dependency:
        return {"predecessor__project_id": project_id, "successor__project_id": project_id}
    if model is TaskRelation:
        return {"source__project_id": project_id, "target__project_id": project_id}
    if model is SprintRetro:
        return {"sprint__project_id": project_id}
    if model is RetroActionItem:
        return {"retro__sprint__project_id": project_id}
    names = {f.name for f in model._meta.concrete_fields}
    if "project" in names:
        return {"project_id": project_id}
    if "task" in names:
        return {"task__project_id": project_id}
    return None


def _delete_tracking_sync_seq(qs: Any, project_id: Any) -> tuple[int, int, bool]:
    """Delete ``qs`` like ``QuerySet.delete()``; return ``(rows, max_sync_seq, live)``.

    The maximum covers every row the delete removes that ``project_id``'s pull
    would have delivered, **cascades included**. A reaped ``Task`` cascades to
    rows that are not themselves eligible — a ``Dependency`` tombstone still
    inside its retention window, or a live ``TaskLink`` — and each of those
    vanishes without a deliverable tombstone just as surely as the task does. A
    floor computed from the eligible rows alone would let a client whose
    ``since`` sits between the task's cursor and the cascaded row's keep the
    cascaded row forever.

    The maximum alone covers only cascaded **tombstones**. ``live`` is ``True``
    when the delete removes an in-scope row that is not itself a tombstone
    (``is_deleted=False``, or a model with no ``is_deleted``). Every client whose
    ``since`` is at or above that row's ``sync_seq`` was handed the live row and
    is not below a floor equal to it (the comparison is strict), so it would keep
    the row forever. The caller then draws a fresh value of the project sequence
    and raises the floor to it, the same reasoning as
    :func:`~.sequence.raise_program_tombstone_floor`: every client of the project
    re-syncs once.

    A cascaded row this project's pull never delivers — a cross-project edge, or
    a row outside the sync union — is left out (:func:`_delta_lookups`): no
    client of this project holds it, and its ``sync_seq`` may belong to another
    project's sequence. The values are read from the database before the delete
    so every row is filtered by the same lookups whether the collector loaded it
    or queued it as a fast delete.

    Soft-deleting a parent while its children stay live is a separate gap
    (#4948): those children are not tombstones and the reap never sees them.
    """
    from django.db.models import Count, Max, Q
    from django.db.models.deletion import Collector

    del_query = qs._chain()
    del_query._for_write = True
    del_query.query.select_for_update = False
    del_query.query.select_related = False
    del_query.query.clear_ordering(force=True)
    collector = Collector(using=del_query.db, origin=qs)
    collector.collect(del_query)

    def _top(rows: Any, model: Any) -> tuple[int, bool]:
        lookups = _delta_lookups(model, project_id)
        if lookups is None or not _has_sync_seq(model):
            return 0, False
        scoped = rows.filter(**lookups)
        has_flag = any(f.attname == "is_deleted" for f in model._meta.concrete_fields)
        agg = scoped.aggregate(
            top=Max("sync_seq"),
            live=Count("pk", filter=Q(is_deleted=False)) if has_flag else Count("pk"),
        )
        value = agg["top"]
        return (int(value) if value is not None else 0), bool(agg["live"])

    top = 0
    live = False
    for model, instances in collector.data.items():
        pks = [i.pk for i in instances]
        if pks:
            t, lv = _top(model._base_manager.filter(pk__in=pks), model)
            top, live = max(top, t), live or lv
    for fast in collector.fast_deletes:
        t, lv = _top(fast, fast.model)
        top, live = max(top, t), live or lv
    deleted, _ = collector.delete()
    return int(deleted), top, live


def _has_sync_seq(model: Any) -> bool:
    return any(f.attname == "sync_seq" for f in model._meta.concrete_fields)


def _reap_project(
    project_id: Any, eligible: list[tuple[Any, str, Any]], counts: dict[str, int]
) -> None:
    """Reap one project's eligible tombstones and raise its tombstone floor (#2474).

    The floor and the delete commit together, which is the whole guarantee: a
    delta pull can only miss a reaped tombstone if the reap committed before the
    pull's tombstone query, and then the pull's post-query re-read of the floor
    (``ProjectSyncView``) sees the raised value and answers ``resync_required``.

    **Atomicity, not lock order, keeps the floor sound.** The project row is
    locked first, and every ``sync_seq`` draw ``UPDATE``s that row
    (``apps/sync/sequence.py``), so no tombstone of this project can be re-saved
    to a higher ``sync_seq`` between the reads below and the delete. That lock
    order is *not* shared by every writer: many lock a ``Task`` row first and
    then allocate (``projects/services.py``, ``Task.save()``), so the reap can
    deadlock with one of them. PostgreSQL then aborts one side; if it is the
    reap, the whole transaction — deletes and floor together — rolls back, no
    tombstone is lost without its floor, and ``_do_reap`` moves on to the next
    project and retries this one on the next run.
    """
    from django.db import transaction
    from django.db.models import F, Value
    from django.db.models.functions import Greatest

    from trueppm_api.apps.projects.models import Project

    with transaction.atomic():
        head = (
            Project.objects.select_for_update()
            .filter(pk=project_id, is_deleted=False, is_archived=False)
            .values_list("last_sync_version", flat=True)
            .first()
        )
        if head is None:
            # Archived or deleted since the candidate scan: the registry's own
            # filters would exclude it, so reap nothing.
            return
        floor = 0
        live_cascade = False
        for Model, owner, qs in eligible:
            scoped = qs.filter(**{owner: project_id})
            deleted, top, live = _delete_tracking_sync_seq(scoped, project_id)
            counts[Model._meta.label_lower] += deleted
            floor = max(floor, top)
            live_cascade = live_cascade or live
        if live_cascade:
            # A live row was hard-deleted: every client that holds it — including
            # one whose ``since`` is the current head — must re-sync. The floor
            # comparison is strict, so a floor equal to the head would spare that
            # client; draw a fresh value instead, as raise_program_tombstone_floor
            # does. The new head equals the floor, so a full re-sync's timestamp
            # is never below it and recovery terminates.
            from trueppm_api.apps.sync.sequence import _next_seq

            head = _next_seq(project_id) or head
            floor = int(head)
        # Clamp to the project's own head (defense in depth: every row counted
        # above drew from this project's sequence, so it should already hold). A
        # floor above ``last_sync_version`` would make the full re-sync's own
        # ``timestamp`` fall below it — a resync_required loop. ``floor <= head``
        # is the invariant that makes a full re-sync always terminate.
        floor = min(floor, int(head))
        if floor:
            Project.objects.filter(pk=project_id).update(
                tombstone_floor=Greatest(F("tombstone_floor"), Value(floor))
            )
