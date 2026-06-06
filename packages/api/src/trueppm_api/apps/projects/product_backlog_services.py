"""Service + pure-compute layer for the Product-Owner backlog (ADR-0105).

Separated from the viewset so the logic is unit-testable and has one source of truth:

1. **Scoring** — ``compute_score`` derives a WSJF / RICE / value-effort score from a task's
   distinct per-model input columns for the project's active model. Computed, never stored.
2. **Definition of Ready** — ``dor_blockers`` enumerates why a story may not be marked READY;
   ``ac_counts`` powers the acceptance-criteria meter (from the AcceptanceCriterion child rows).
   The READY transition is gated on an empty blocker list but is advisory (it does not block
   the team from pulling a story into a sprint via the planning/scope path).
3. **Auto-rank** — ``auto_rank`` is a one-shot sort of the project backlog by the active model's
   score, writing the result into ``priority_rank`` (manual rank as tiebreaker). There is no
   persistent lock — a later manual drag always wins. Iterated via ``save()`` so each row bumps
   ``server_version`` and writes ``HistoricalTask`` (audit).
4. **Dual ordering** — ``seed_sprint_rank`` seeds the within-sprint execution order from
   ``priority_rank`` at sprint commit; in-sprint reorders write ``sprint_rank`` only (ADR-0105 §5).
"""

from __future__ import annotations

from typing import Any

from django.db import transaction

from trueppm_api.apps.projects.models import (
    DorState,
    PrioritizationModel,
    Project,
    Task,
    TaskStatus,
    TaskType,
)
from trueppm_api.apps.sync.broadcast import broadcast_board_event

# ── Scoring ─────────────────────────────────────────────────────────────────


def compute_score(task: Task, model: str) -> float | None:
    """Return the prioritization score for ``task`` under ``model``, or None.

    WSJF = (business_value+time_criticality+risk_reduction)/job_size,
    RICE = (reach*impact*confidence)/effort, value_effort = value/effort_estimate.
    Returns None when any required input is missing or the denominator is zero/absent —
    an unscored story sorts last and renders as "—" rather than a misleading 0.
    """
    if model == PrioritizationModel.WSJF:
        bv, tc, rr = task.business_value, task.time_criticality, task.risk_reduction
        size = task.job_size
        if bv is None or tc is None or rr is None or not size:
            return None
        return (bv + tc + rr) / size
    if model == PrioritizationModel.RICE:
        reach, impact, confidence, effort = task.reach, task.impact, task.confidence, task.effort
        if reach is None or impact is None or confidence is None or not effort:
            return None
        return (reach * impact * confidence) / effort
    if model == PrioritizationModel.VALUE_EFFORT:
        if task.value is None or not task.effort_estimate:
            return None
        return task.value / task.effort_estimate
    return None  # NONE or unknown


# ── Acceptance criteria + Definition of Ready ────────────────────────────────


def ac_counts(task: Task) -> tuple[int, int]:
    """Return (met, total) acceptance criteria for the AC meter (DA-10/DA-14).

    Uses the prefetched ``acceptance_criteria`` related rows when available (the grooming
    endpoint prefetches them) so this stays O(1) queries per task.
    """
    criteria = list(task.acceptance_criteria.all())
    return (sum(1 for c in criteria if c.met), len(criteria))


def dor_blockers(task: Task) -> list[str]:
    """Reasons ``task`` cannot be marked READY (empty list ⇒ it may go Ready).

    The Mark-ready gate (#731): estimated AND at least one acceptance criterion AND every
    criterion met. Machine-stable codes the web maps to the drawer's DoR checklist copy.
    """
    blockers: list[str] = []
    if task.story_points is None:
        blockers.append("unestimated")
    met, total = ac_counts(task)
    if total == 0:
        blockers.append("no_acceptance_criteria")
    elif met < total:
        blockers.append("acceptance_criteria_unmet")
    return blockers


class DorTransitionError(Exception):
    """Raised when a READY transition is attempted with unresolved DoR blockers."""

    def __init__(self, blockers: list[str]) -> None:
        self.blockers = blockers
        super().__init__(f"Cannot mark ready: {', '.join(blockers)}")


def mark_ready(task: Task, actor: Any) -> Task:
    """Transition a story to READY, enforcing the (advisory) DoR gate. Idempotent."""
    blockers = dor_blockers(task)
    if blockers:
        raise DorTransitionError(blockers)
    if task.dor != DorState.READY:
        task.dor = DorState.READY
        task.save(update_fields=["dor", "server_version"])
        _broadcast_task(task)
    return task


def send_to_refine(task: Task, actor: Any) -> Task:
    """Move a story back to REFINE (no gate — refining is always allowed)."""
    if task.dor != DorState.REFINE:
        task.dor = DorState.REFINE
        task.save(update_fields=["dor", "server_version"])
        _broadcast_task(task)
    return task


def _broadcast_task(task: Task) -> None:
    pid, tid = str(task.project_id), str(task.id)
    transaction.on_commit(lambda: broadcast_board_event(pid, "task_updated", {"id": tid}))


# ── Auto-rank ────────────────────────────────────────────────────────────────


def _backlog_stories(project: Project) -> list[Task]:
    """Project-backlog stories eligible for auto-rank.

    Scoped to ``status=BACKLOG`` and ``sprint__isnull=True`` so re-ranking never touches a
    task's sprint membership or its ADR-0102 ``sprint_pending`` flag. Epics excluded.
    """
    return list(
        Task.objects.filter(
            project=project,
            is_deleted=False,
            status=TaskStatus.BACKLOG,
            sprint__isnull=True,
        )
        .exclude(type=TaskType.EPIC)
        .order_by("priority_rank", "short_id")
    )


def auto_rank(project: Project, actor: Any) -> int:
    """One-shot recompute of ``priority_rank`` from the active scoring model.

    Scored stories sort by score descending; ties (and unscored stories) keep their existing
    manual order (``priority_rank`` asc, then ``short_id``). Returns the count of rows whose
    rank changed. Idempotent. Not a persistent lock — a later manual drag rewrites
    ``priority_rank`` and wins.
    """
    model = project.prioritization_model
    stories = _backlog_stories(project)

    def sort_key(item: tuple[int, Task]) -> tuple[int, float, int]:
        manual_index, task = item
        score = compute_score(task, model)
        if score is None:
            return (1, 0.0, manual_index)
        return (0, -score, manual_index)

    ordered = [t for _, t in sorted(enumerate(stories), key=sort_key)]

    changed = 0
    with transaction.atomic():
        for new_rank, task in enumerate(ordered, start=1):
            if task.priority_rank != new_rank:
                task.priority_rank = new_rank
                # iterate save() (never bulk_update) so server_version bumps + history writes.
                task.save(update_fields=["priority_rank", "server_version"])
                changed += 1

    if changed:
        pid = str(project.id)
        transaction.on_commit(
            lambda: broadcast_board_event(pid, "backlog_reranked", {"project_id": pid})
        )
    return changed


# ── Manual reorder (ADR-0110, #494) ───────────────────────────────────────────


class BacklogReorderConflict(Exception):
    """Raised when the client's backlog snapshot is stale (ADR-0110 §3).

    Covers every "the backlog moved under you" case — a story added or removed
    concurrently (the supplied set no longer matches the live backlog) or a row whose
    ``server_version`` advanced since the client loaded it. The view maps this to 409 and
    the client refetches + replays the drag. ``ids`` lists the offending task ids.
    """

    def __init__(self, ids: list[str]) -> None:
        self.ids = ids
        super().__init__(f"Stale backlog snapshot for tasks: {', '.join(ids)}")


def reorder_backlog(project: Project, ordered: list[tuple[str, int]], actor: Any) -> int:
    """Apply a manual drag reorder of the project backlog (ADR-0110, #494).

    ``ordered`` is the *complete* current backlog as ``[(task_id, server_version), ...]`` in
    the new priority order. Renumbers ``priority_rank`` densely 1..N (matching ``auto_rank``'s
    output shape) so a later auto-rank diff stays clean; sparse keys buy nothing under a
    full-list rewrite. Optimistic-locked on ``server_version`` and on set-completeness: if the
    supplied set differs from the live backlog (concurrent add/remove) or any row's version is
    stale, raises :class:`BacklogReorderConflict` (409) and writes nothing.

    Writes only changed rows, each via ``save()`` (never ``bulk_update``) so ``server_version``
    bumps and ``HistoricalTask`` is written. Returns the count of rows whose rank changed.
    Idempotent: re-applying the same order writes nothing. Rank-only — never touches
    ``sprint_rank`` or ``parent_epic`` (ADR-0110 §5).
    """
    changed = 0
    with transaction.atomic():
        # Lock the live backlog rows first to serialise concurrent reorders, scoped exactly
        # like _backlog_stories (BACKLOG, sprint-less, non-epic).
        live = (
            Task.objects.select_for_update()
            .filter(
                project=project,
                is_deleted=False,
                status=TaskStatus.BACKLOG,
                sprint__isnull=True,
            )
            .exclude(type=TaskType.EPIC)
        )
        by_id = {str(t.pk): t for t in live}
        supplied = {tid for tid, _ in ordered}

        # Completeness + membership: the client must hold exactly the current backlog. Any
        # drift (story added/removed since load, or an id that isn't a current backlog story)
        # is a stale snapshot → 409, not a partial write.
        drift = sorted((supplied - by_id.keys()) | (by_id.keys() - supplied))
        if drift:
            raise BacklogReorderConflict(drift)

        # Per-row optimistic lock.
        stale = [tid for tid, sv in ordered if by_id[tid].server_version != sv]
        if stale:
            raise BacklogReorderConflict(stale)

        for new_rank, (tid, _) in enumerate(ordered, start=1):
            task = by_id[tid]
            if task.priority_rank != new_rank:
                task.priority_rank = new_rank
                task.save(update_fields=["priority_rank", "server_version"])
                changed += 1

        # Registered inside the atomic block so it defers to commit (and fires only within a
        # transaction). pid is a non-mutating local, so the plain closure capture is safe —
        # matching the auto_rank pattern.
        if changed:
            pid = str(project.id)
            transaction.on_commit(
                lambda: broadcast_board_event(pid, "backlog_reranked", {"project_id": pid})
            )
    return changed


# ── Dual ordering (#365) ──────────────────────────────────────────────────────


def seed_sprint_rank(sprint: Any) -> None:
    """Seed within-sprint execution order from product-backlog priority at commit.

    Called when a sprint activates (PLANNED→ACTIVE). Orders the sprint's tasks by
    ``priority_rank`` and writes ``sprint_rank`` 1..N. In-sprint reorders thereafter write
    ``sprint_rank`` only and never touch ``priority_rank`` (ADR-0105 §5).
    """
    tasks = list(
        Task.objects.filter(sprint=sprint, is_deleted=False)
        .exclude(type=TaskType.EPIC)
        .order_by("priority_rank", "short_id")
    )
    with transaction.atomic():
        for rank, task in enumerate(tasks, start=1):
            if task.sprint_rank != rank:
                task.sprint_rank = rank
                task.save(update_fields=["sprint_rank", "server_version"])


# ── Split story ──────────────────────────────────────────────────────────────


def split_story(parent: Task, actor: Any, *, name: str | None = None) -> Task:
    """Create a sibling story under the same epic, carrying over unmet criteria.

    The child inherits the parent's ``parent_epic`` so the split stays grouped; only *unmet*
    acceptance criteria are copied (the remaining work); points are NOT auto-divided (the PO
    re-estimates both halves, so velocity is never double-counted).
    """
    from trueppm_api.apps.projects.models import AcceptanceCriterion

    unmet = [c for c in parent.acceptance_criteria.all() if not c.met]
    with transaction.atomic():
        child = Task.objects.create(
            project=parent.project,
            name=name or f"{parent.name} (split)",
            type=parent.type,
            parent_epic=parent.parent_epic,
            status=TaskStatus.BACKLOG,
            sprint=None,
            dor=DorState.IDEA,
            notes=f"Split from {parent.short_id or parent.id}.",
        )
        for pos, c in enumerate(unmet):
            AcceptanceCriterion.objects.create(
                task=child,
                text=c.text,
                given=c.given,
                when=c.when,
                then=c.then,
                position=pos,
            )
    pid, cid = str(parent.project_id), str(child.id)
    transaction.on_commit(lambda: broadcast_board_event(pid, "task_created", {"id": cid}))
    return child
