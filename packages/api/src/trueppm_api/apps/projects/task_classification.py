"""Subtree classification cascade for ``PATCH /projects/{pk}/tasks/classification/``.

ADR-0790, #2735. Applies the two orthogonal hybrid axes — ``governance_class`` and
``delivery_mode`` — across a task subtree in one call.

The two axes are **not** one choice, and the difference is load-bearing rather than
cosmetic. ``governance_class`` selects which overlay governs the subtree and carries an
inherit bit (``parent_governance_inherited``); ``delivery_mode`` selects how work is
executed, estimated and rolled up, and carries none. ``scrum`` and ``kanban`` are not
interchangeable either — the rollup engine reads point burndown for one and item
throughput for the other, and the agile-aware Monte Carlo samples the team velocity
distribution only for ``scrum``. Collapsing the axes into a single toggle mis-tags every
Kanban team.

Three invariants this module exists to hold:

- **Milestones survive a cascade.** ``is_milestone ⟺ delivery_mode='milestone' ⟺
  duration=0`` is normalized on every write path (``TaskSerializer.
  _reconcile_milestone_signals``). Writing an agile delivery mode across a phase would
  silently dissolve every gate inside it, taking the rollup SQL — which keys on
  ``delivery_mode`` — with it. That is never done, under any request flag; see
  :func:`_classify_row`.
- **Explicit governance survives a cascade.** ``preserve_governance_overrides``
  defaults true. That default is what makes cascading safe to try: a planner who has
  hand-tuned one compliance branch inside an otherwise agile phase can re-declare the
  phase without losing the branch.
- **The write reaches offline clients.** Every touched row goes through
  ``Task.save()``, never ``QuerySet.update()`` — ``server_version`` and ``sync_seq``
  advance only inside ``VersionedModel.save()`` (ADR-0686), and a bulk update would
  leave the classification permanently invisible to the delta pull (the #2491 class).

This is a service function rather than view code so an MCP, management-command, or
agent caller reaches identical semantics without going through DRF — the "human and
agent principals are governed identically" claim holds on this path by construction.
"""

from __future__ import annotations

import dataclasses
import re
import uuid
from typing import TYPE_CHECKING, Any

from django.db.models import Q

from trueppm_api.apps.access.permissions import can_user_edit_task
from trueppm_api.apps.projects.refusal_codes import BulkRefusalCode

if TYPE_CHECKING:
    from rest_framework.request import Request

    from trueppm_api.apps.projects.models import Project, Task

#: A milestone row was left unclassified on at least one axis. Reported as a *skip*,
#: never a rejection: a classification crossing a gate is a documented no-op, so one
#: milestone inside a phase cannot fail the rows around it.
#:
#: Bound to the shared enum rather than mirroring ``task_bulk``'s constant by hand
#: (#3037). The two batch write paths are meant to speak one vocabulary, and the old
#: comment said so — but a second string literal asserting sameness is exactly what
#: drifts, and nothing would have failed if it had.
CODE_MILESTONE_GATE = BulkRefusalCode.MILESTONE_GATE.value

#: Maximum rows one cascade may resolve.
#:
#: Deliberately **not** shared with ``task_bulk.TASK_BULK_MAX_OPERATIONS`` (500): that
#: cap bounds rows a human typed into a grid, this one bounds rows the server resolved
#: from a single click, and 500 sits below a realistic top-level phase. A cap is still
#: required because §7 of ADR-0790 forces one ``save()`` per changed row, so an
#: uncapped subtree is an unbounded write inside one transaction. Exceeding it is a 400
#: naming the count — never a silent truncation, which would report a subtree as
#: classified when its tail is not.
TASK_CLASSIFY_MAX_SUBTREE = 2000


class SubtreeTooLarge(Exception):
    """The resolved subtree exceeds :data:`TASK_CLASSIFY_MAX_SUBTREE`.

    Carries the counts so the view can render an actionable 400 rather than a bare cap
    violation the caller cannot act on.
    """

    def __init__(self, matched: int, cap: int) -> None:
        self.matched = matched
        self.cap = cap
        super().__init__(f"Subtree resolves {matched} tasks, above the {cap}-task cap.")


class SubtreeNotAuthorable(Exception):
    """The caller may not edit every row in the resolved subtree.

    Permission on this endpoint is all-or-nothing, which diverges deliberately from
    ``tasks/bulk/``'s per-row rejection. There, the caller typed 38 things and one bad
    row must not discard the other 37. Here they declared *one* thing about a subtree,
    and applying it to the 60% of rows they happen to be assigned leaves the plan
    asserting a split that is not true — worse than refusing (ADR-0790 §6).

    Carries the count only. No ids: the count is what makes the 403 explainable, and
    enumerating rows adds nothing the caller can act on.
    """

    def __init__(self, forbidden: int, matched: int, *, detail: str | None = None) -> None:
        self.forbidden = forbidden
        self.matched = matched
        #: ``detail`` exists for the root-only pre-check (#3305), which refuses before
        #: the subtree is resolved and therefore cannot honestly say "n of m tasks" —
        #: it does not know m, and inventing one would re-open the count disclosure
        #: this ordering was changed to close.
        super().__init__(
            detail or f"Your role cannot author {forbidden} of the {matched} tasks in this subtree."
        )


@dataclasses.dataclass(frozen=True)
class ClassificationSpec:
    """One validated cascade request. Built by ``TaskClassificationSerializer``."""

    subtree_id: uuid.UUID
    cascade: bool
    governance_class: str | None
    delivery_mode: str | None
    preserve_governance_overrides: bool
    skip_milestones: bool


@dataclasses.dataclass
class _AxisTally:
    """Per-axis counters. ``overrides_kept`` stays ``None`` on an axis without an
    inherit bit — see :func:`_axis_report`."""

    applied: int = 0
    unchanged: int = 0
    overrides_kept: int = 0


def resolve_subtree(project: Project, spec: ClassificationSpec) -> list[Task]:
    """Lock and return the subtree root plus, when cascading, its descendants.

    Raises:
        Task.DoesNotExist: The root is not a live task in this project. The view maps
            this to a 404 rather than leaking whether the id exists elsewhere.
        SubtreeTooLarge: More rows resolved than :data:`TASK_CLASSIFY_MAX_SUBTREE`.

    Rows are locked with ``select_for_update()`` in ``wbs_path`` order, which is both
    deterministic (so two cascades on overlapping subtrees serialize rather than
    deadlock) and the order the change detection in :func:`cascade_task_classification`
    wants anyway — the root sorts before its own descendants.

    The root is locked first, in its own statement, before its ``wbs_path`` is read.
    A concurrent reparent moves the path, so reading it unlocked would resolve a
    descendant set for a tree shape that no longer exists by the time the write lands.
    """
    from trueppm_api.apps.projects.models import Task

    root = Task.objects.select_for_update().get(
        pk=spec.subtree_id, project=project, is_deleted=False
    )
    if not spec.cascade:
        return [root]

    scope = Q(pk=root.pk)
    if root.wbs_path:
        # A descendant is any live task one or more levels deeper, i.e. whose path
        # starts with "<root path>.". ``__regex`` is the lookup the rest of the
        # codebase uses for ltree paths (see ``serializers.py`` summary detection), so
        # this needs no extra lookup registration. Segments are digits; the escape is
        # a safety net, not a load-bearing guard.
        scope |= Q(wbs_path__regex=rf"^{re.escape(str(root.wbs_path))}\.")

    matched = Task.objects.filter(scope, project=project, is_deleted=False).count()
    if matched > TASK_CLASSIFY_MAX_SUBTREE:
        raise SubtreeTooLarge(matched, TASK_CLASSIFY_MAX_SUBTREE)

    return list(
        Task.objects.select_for_update()
        .filter(scope, project=project, is_deleted=False)
        .order_by("wbs_path", "pk")
    )


def assert_graph_feasible(project_id: Any) -> None:
    """Run the ADR-0259 graph guard over the project's edges before recalculation.

    This endpoint writes no dependency edges, so the guard cannot reject anything the
    cascade itself did. It runs because the cascade calls ``enqueue_recalculate``, and
    ADR-0259's rule is that the guard runs before a bulk write and before
    recalculation.

    That rule is non-vacuous today rather than defensive ceremony: the seed importer
    still bypasses the guard (**#2589, open**) and project templates seed dependency
    edges through it, so a cyclic graph can genuinely exist in a project — and a
    cascade is very often the first authoring act after a template applies. Catching it
    here surfaces an actionable 400 instead of a CPM worker crash nobody sees.

    Project-scoped, not subtree-scoped: a cycle can leave the subtree and re-enter it,
    and ``enqueue_recalculate``'s own unit is the project.

    Raises:
        InfeasibleGraphError: Self-referential or cyclic edges, re-worded to name the
            offending tasks (see :func:`_offending_task_labels`).
        InvalidScheduleInput: The graph is malformed rather than cyclic.
    """
    from trueppm_api.apps.projects.models import Dependency
    from trueppm_api.apps.projects.serializers import _load_project_tasks_and_children_map
    from trueppm_api.apps.scheduling.graph_guard import (
        InfeasibleGraphError,
        validate_task_graph,
    )

    task_ids, children_map = _load_project_tasks_and_children_map(project_id)
    edges = [
        (str(p), str(s))
        for p, s in Dependency.objects.filter(
            is_deleted=False, predecessor_id__in=[uuid.UUID(t) for t in task_ids]
        ).values_list("predecessor_id", "successor_id")
    ]
    try:
        validate_task_graph(edges, children_map=children_map)
    except InfeasibleGraphError as exc:
        # The guard reasons in opaque node ids; this is the layer that knows they are
        # task pks. Relabelling here rather than passing labels *in* keeps the cost on
        # the refusal path only — the guard blames a handful of ids, and the feasible
        # cascade (every request that is not refused) reads no extra row.
        raise exc.with_labels(_offending_task_labels(project_id, exc.offending)) from exc


def _offending_task_labels(project_id: Any, offending: list[str]) -> dict[str, str]:
    """Resolve blamed task ids to the ``"<WBS> — <name>"`` form the plan shows.

    That form is not invented here: it is the reference the Schedule already uses
    wherever it names a task outside its own row — the dependency picker, the
    dependencies tab, the task drawer title — so the tasks a refusal names are
    findable by searching for exactly the string it printed.

    Private on purpose. ``validate_task_graph`` explicitly invites callers to run
    the guard in their own *external*-id space (Jira keys, MS Project uids), and
    relabelling one of those refusals through here would hand a non-UUID to a
    ``UUIDField`` lookup — a Django ``ValidationError`` DRF does not convert, i.e.
    a 500 on what should be a 400. This is only correct for the pk-space guard run
    directly above it.

    Not a disclosure — verified against the gate, not assumed. The guard is
    project-scoped, and this endpoint requires ``IsProjectMemberWrite`` +
    ``IsProjectPlanAuthor`` on the project, a strict subset of the ``IsProjectMember``
    that already grants ``list``/``retrieve`` on every task in it. So a caller who can
    trip this guard could already have read every name and WBS code it can print; only
    the wording changes. That holds **while** ``Task`` has no row-level visibility gate
    — the dormant ``Visibility`` enum lives on ``Project``/``Program`` only. If per-task
    visibility ever lands, this function becomes a cross-boundary read and must be
    re-scoped; nothing in the pipeline would catch that on its own.

    Ids that no longer resolve (a row deleted between the refusal and this read) are
    simply absent; the message falls back to the raw id for those alone.

    Scoped to live rows in *this* project rather than resolving a bare pk. A blamed
    node is always both today — the guard reads only in-project live tasks — but that
    is an invariant of the edge query two functions away, and this lookup is what
    would print the answer if it ever stopped holding.
    """
    from trueppm_api.apps.projects.models import Task
    from trueppm_api.apps.scheduling.graph_guard import nodes_to_label

    # Only the ids the sentence will actually print. A 5000-task cycle names four of
    # its members, so resolving all 5000 would materialize 4996 rows to discard them.
    rows = Task.objects.filter(
        project_id=project_id, is_deleted=False, pk__in=set(nodes_to_label(offending))
    ).values("id", "name", "wbs_path")
    labels: dict[str, str] = {}
    for row in rows:
        name = (row["name"] or "").strip()
        wbs = str(row["wbs_path"] or "").strip()
        if name and wbs:
            labels[str(row["id"])] = f"{wbs} — {name}"
        elif name:
            labels[str(row["id"])] = name
        elif wbs:
            # A row with no name is still findable by its WBS code, which is the
            # handle the message exists to give — so say so rather than print a
            # dangling separator.
            labels[str(row["id"])] = f"{wbs} — (unnamed task)"
    return labels


def assert_authorable(request: Request, rows: list[Task]) -> None:
    """All-or-nothing per-row edit check (ADR-0790 §6).

    ``IsProjectPlanAuthor`` decides whether the caller may enter Author mode at all;
    ``can_user_edit_task`` remains authoritative for *which rows* they may touch
    (ADR-0773 §3). Both apply — the project-level gate does not subsume the row-level
    one, which is why a plain Member (who may edit only their assigned tasks) cannot
    re-classify a phase they do not own.

    Raises:
        SubtreeNotAuthorable: One or more rows fail the per-row bar.
    """
    forbidden = sum(1 for task in rows if not can_user_edit_task(request, task, method="PATCH"))
    if forbidden:
        raise SubtreeNotAuthorable(forbidden, len(rows))


def _apply_governance(
    task: Task,
    *,
    is_root: bool,
    spec: ClassificationSpec,
    tally: _AxisTally,
) -> tuple[list[str], list[str]]:
    """Resolve the ``governance_class`` axis for one row.

    Returns ``(changed, withheld)`` and mutates ``task`` in memory only — saving is the
    caller's decision, exactly as in :func:`_classify_row`.
    """
    changed: list[str] = []
    withheld: list[str] = []

    if spec.governance_class is not None:
        if task.is_milestone and spec.skip_milestones:
            withheld.append("governance_class")
        elif (
            not is_root
            and spec.preserve_governance_overrides
            and (not task.parent_governance_inherited)
        ):
            # An explicit override: this node declared its own governance rather than
            # taking its parent's. Preserving it is the default, and it is counted so
            # the caller can see what the cascade deliberately did not touch.
            tally.overrides_kept += 1
        else:
            # The root is the declaration point — declaring a subtree's governance IS
            # breaking inheritance from whatever sits above it. Cascaded descendants
            # inherit from the root. A descendant overwritten because the caller sent
            # preserve_governance_overrides=false is no longer an override, so its bit
            # resets to True with everything else.
            target_bit = not is_root
            if (
                task.governance_class != spec.governance_class
                or task.parent_governance_inherited != target_bit
            ):
                task.governance_class = spec.governance_class
                task.parent_governance_inherited = target_bit
                changed += ["governance_class", "parent_governance_inherited"]
                tally.applied += 1
            else:
                tally.unchanged += 1

    return changed, withheld


def _apply_delivery(
    task: Task,
    *,
    spec: ClassificationSpec,
    tally: _AxisTally,
) -> tuple[list[str], list[str]]:
    """Resolve the ``delivery_mode`` axis for one row.

    Returns ``(changed, withheld)`` and mutates ``task`` in memory only — saving is the
    caller's decision, exactly as in :func:`_classify_row`.
    """
    changed: list[str] = []
    withheld: list[str] = []

    if spec.delivery_mode is not None:
        if task.is_milestone:
            # Unconditional, and not a flag the caller can waive. is_milestone,
            # delivery_mode='milestone' and duration=0 are three encodings of one
            # fact; writing a non-milestone mode here produces a row the rollup SQL
            # and the CPM engine disagree about. skip_milestones governs the OTHER
            # axis (governance on a gate is invariant-safe — that is what an overlay
            # is); it has no say over this one.
            withheld.append("delivery_mode")
        elif task.delivery_mode != spec.delivery_mode:
            task.delivery_mode = spec.delivery_mode
            changed.append("delivery_mode")
            tally.applied += 1
        else:
            tally.unchanged += 1

    return changed, withheld


def _classify_row(
    task: Task,
    *,
    is_root: bool,
    spec: ClassificationSpec,
    governance: _AxisTally,
    delivery: _AxisTally,
    skipped: list[dict[str, Any]],
) -> list[str]:
    """Compute one row's new classification; return the model fields it changed.

    Mutates ``task`` in memory only — the caller decides whether to save, so a row
    already at the requested value costs no write, no version bump, and no history row.

    The two axes are resolved independently and their results concatenated, which is
    what keeps ``changed`` and the skip report's ``axes`` in governance-then-delivery
    order.
    """
    governance_changed, governance_withheld = _apply_governance(
        task, is_root=is_root, spec=spec, tally=governance
    )
    delivery_changed, delivery_withheld = _apply_delivery(task, spec=spec, tally=delivery)

    changed = governance_changed + delivery_changed
    withheld = governance_withheld + delivery_withheld

    if withheld:
        skipped.append(
            {
                "id": str(task.pk),
                "code": CODE_MILESTONE_GATE,
                "axes": withheld,
                "message": (
                    "Milestone left unclassified on "
                    + " and ".join(withheld)
                    + " — a classification does not re-type a gate."
                ),
            }
        )

    return changed


def _axis_report(
    requested: str | None, tally: _AxisTally, *, has_inherit_bit: bool
) -> dict[str, Any] | None:
    """One axis's block in the response, or ``None`` if the request omitted the axis.

    ``overrides_kept`` is ``null`` on an axis with no inherit bit — **not** ``0``.
    Zero reads as "there were none", which is a claim about the data; ``null`` states
    that the count is not computable on this axis, which is a claim about the model,
    and it is the true one. Only ``governance_class`` carries the bit, so only
    governance can report the count (issue #2735 §3).
    """
    if requested is None:
        return None
    return {
        "requested": requested,
        "applied": tally.applied,
        "unchanged": tally.unchanged,
        "overrides_kept": tally.overrides_kept if has_inherit_bit else None,
        "has_inherit_bit": has_inherit_bit,
    }


#: Fields _classify_row can change — also consulted by task_batch_services.py's
#: undo (the two modules deliberately don't import from each other; see that
#: module's own copy of this tuple for why).
CLASSIFICATION_FIELDS = ("governance_class", "parent_governance_inherited", "delivery_mode")


def cascade_task_classification(
    project: Project, request: Request, spec: ClassificationSpec
) -> tuple[dict[str, Any], list[uuid.UUID], dict[str, dict[str, Any]]]:
    """Apply one classification cascade.

    Returns ``(report, written_task_ids, before_after)``. ``before_after`` maps
    ``str(task_id) -> {"before": {...}, "after": {...}}`` for exactly the rows
    written — the ADR-0810 undo ledger's input, built here because this is the
    only point that sees both a row's pre-cascade values and its post-cascade
    ``changed`` fields in the same place.

    Must be called inside ``transaction.atomic()`` — ``resolve_subtree`` takes row
    locks, and the caller registers the recalculation and broadcast with
    ``transaction.on_commit``.

    Raises:
        Task.DoesNotExist: the root is not a live task in this project — raised by the
            unlocked root read below, or by :func:`resolve_subtree`.
        SubtreeTooLarge: from :func:`resolve_subtree`.
        SubtreeNotAuthorable: from the root pre-check below, or :func:`assert_authorable`.
        InfeasibleGraphError / InvalidScheduleInput: from :func:`assert_graph_feasible`.
    """
    from trueppm_api.apps.projects.models import Task

    # Authorization first, so an unauthorized caller never pays for — or learns
    # anything from — the work below. Permission here is all-or-nothing and the root
    # is in every resolved subtree, so authoring the root is a *necessary* condition:
    # refusing on it alone is sound, and it is the only check that can run before the
    # subtree is resolved. Deliberately unlocked and ahead of resolve_subtree, because
    # that call locks the root, resolves descendants and evaluates the size cap — so
    # running it first made a caller with no authorship on the subtree pay for up to
    # 2000 row locks and receive a 400 disclosing the subtree's task count instead of
    # a 403 (#3305).
    #
    # Residual, and narrower by construction: a caller who *can* author the root but
    # not every descendant is still resolved under lock before assert_authorable
    # refuses them below. Closing that too would mean authorizing the descendant set
    # before locking it, which reintroduces a TOCTOU — a row inserted between the
    # unlocked authorization and the locked write would be written unauthorized.
    root_only = Task.objects.get(pk=spec.subtree_id, project=project, is_deleted=False)
    if not can_user_edit_task(request, root_only, method="PATCH"):
        raise SubtreeNotAuthorable(1, 1, detail="Your role cannot author the root of this subtree.")

    rows = resolve_subtree(project, spec)
    assert_authorable(request, rows)

    governance = _AxisTally()
    delivery = _AxisTally()
    skipped: list[dict[str, Any]] = []
    written: list[uuid.UUID] = []
    before_after: dict[str, dict[str, Any]] = {}

    # Two passes. The first mutates instances in memory only and collects what would
    # be written; nothing touches the database. That is what lets the graph guard be
    # skipped entirely when the cascade turns out to be a no-op — its cost scales with
    # PROJECT size (every task row plus every edge), not subtree size, so a repeated
    # identical cascade would otherwise pay a full project scan to write nothing.
    #
    # The "before" snapshot is taken here, ahead of _classify_row, because that
    # function mutates `task` in memory before the caller decides to save — by the
    # time a row reaches `pending` below, its pre-cascade values are already gone
    # from the instance itself.
    pending: list[tuple[Task, list[str]]] = []
    for task in rows:
        before = {field: getattr(task, field) for field in CLASSIFICATION_FIELDS}
        changed = _classify_row(
            task,
            is_root=task.pk == spec.subtree_id,
            spec=spec,
            governance=governance,
            delivery=delivery,
            skipped=skipped,
        )
        if changed:
            pending.append((task, changed))
            before_after[str(task.pk)] = {"before": before}

    if pending:
        assert_graph_feasible(project.pk)
        for task, changed in pending:
            # known_exists=True: the rows were just SELECTed under a lock, so the
            # INSERT/UPDATE disambiguation probe VersionedModel.save() otherwise runs
            # per row is a guaranteed-True query — 2000 of them for a large phase.
            task.save(update_fields=changed, known_exists=True)
            written.append(task.pk)
            before_after[str(task.pk)]["after"] = {
                field: getattr(task, field) for field in CLASSIFICATION_FIELDS
            }

    report: dict[str, Any] = {
        "subtree": str(spec.subtree_id),
        "matched": len(rows),
        # Rows actually saved (#3306). Not derivable from the per-axis tallies and
        # not the same number: ``applied`` increments once per row PER AXIS, so a
        # both-axes cascade counts the same row twice, and a milestone withheld on
        # one axis but written on the other is one row appearing in one total only.
        # The governance branch also writes two model columns per increment, so the
        # sum is neither rows nor fields. This is the one count the caller can hold
        # against what they selected and check against the grid.
        "rows_written": len(written),
        "skipped": skipped,
    }
    governance_block = _axis_report(spec.governance_class, governance, has_inherit_bit=True)
    if governance_block is not None:
        report["governance"] = governance_block
    delivery_block = _axis_report(spec.delivery_mode, delivery, has_inherit_bit=False)
    if delivery_block is not None:
        report["delivery_mode"] = delivery_block
    return report, written, before_after
