"""Service-layer helpers for the resources app."""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING, Any

from trueppm_api.apps.projects.models import Project, TaskActivityEvent, TaskActivityEventType
from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Task

#: Allocation bounds shared with ``TaskResourceSerializer.validate_units``. 1% is the
#: smallest meaningful assignment; 200% catches a data-entry slip while still allowing
#: deliberate overtime.
MIN_ASSIGNMENT_UNITS = Decimal("0.01")
MAX_ASSIGNMENT_UNITS = Decimal("2.0")


def ensure_project_resource(project: Project, resource: Resource) -> ProjectResource:
    """Idempotently add a resource to a project's roster.

    Centralises the auto-roster pattern: any code path that creates a
    task–resource assignment (TaskResource) must call this so the resource
    appears in Team → Roster, Allocation, and Heatmap views (#241).

    Returns the existing ``ProjectResource`` row when one is already present
    (whether live or soft-deleted), otherwise creates a new live row. Soft-
    deleted rows are intentionally left alone — the soft-delete is a deliberate
    PM action and reactivation belongs to the explicit roster UI, not to the
    side-effect of a task assignment.
    """
    obj, _ = ProjectResource.objects.get_or_create(
        project=project,
        resource=resource,
    )
    return obj


def rostered_resource_ids(project: Project) -> set[str]:
    """The resource ids on ``project``'s live roster, as strings.

    The membership index every inline-authoring surface resolves an owner against
    (ADR-0774 §3). Scoped deliberately: ``Resource`` is a workspace-**global** library
    with no project FK, so resolving against it would let a value authored on one
    project bind to a person who is a member of none of the caller's — the
    reach-across-projects hole ``data-interchange.spec.md`` §5.3 exists to close.
    """
    return {
        str(rid)
        for rid in ProjectResource.objects.filter(project=project, is_deleted=False).values_list(
            "resource_id", flat=True
        )
    }


def task_is_summary(task: Task) -> bool:
    """True when ``task`` has at least one live structural descendant.

    A summary task rolls up from its children, so a direct resource assignment on it
    creates ambiguous scheduling semantics (ADR-0024). Shared by every assignment write
    path so the rule is enforced identically wherever an assignment is authored.

    Tests descendancy with the ltree ``<path>.*{1}`` lquery against the GiST index on
    ``projects_task.wbs_path`` rather than loading children — the question is only
    "does one exist", and this stays O(index seek) on a deep WBS.
    """
    from django.db import connection

    if not task.wbs_path:
        return False
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT EXISTS("
            "  SELECT 1 FROM projects_task c"
            "  WHERE c.project_id = %s"
            "    AND c.is_deleted = false"
            "    AND c.id != %s"
            "    AND c.wbs_path IS NOT NULL"
            "    AND c.wbs_path ~ (%s || '.*{1}')::lquery"
            ")",
            [task.project_id, task.pk, str(task.wbs_path)],
        )
        return bool(cursor.fetchone()[0])


def record_assignment_event(
    *,
    task_id: Any,
    event_type: str,
    resource: Resource,
    actor: Any,
    units_from: Decimal | None = None,
    units_to: Decimal | None = None,
) -> None:
    """Write one task-activity audit row for a resource-assignment change (ADR-0394).

    ``TaskResource`` is a through-table with no ``HistoricalRecords`` (like ``RiskTask``),
    so assignment add/remove/re-allocation is recorded in ``TaskActivityEvent`` following
    the ADR-0207 precedent. Written synchronously inside the request transaction so the
    audit row commits or rolls back with the assignment mutation itself — it is a DB row,
    not an external side effect, so (unlike the board broadcast) it is not deferred to
    ``transaction.on_commit``. ``actor`` is the acting member; callers on a request path
    always have one, and a system path (an import) records its own provenance instead of
    calling this with a null actor.

    ``units`` carries the allocation: a single value for add/remove, or a
    ``{"from", "to"}`` delta for ``assignee_units_changed`` (mirroring the
    ``cpm_recalculated`` date-delta shape). Decimals are stringified so the JSON detail
    is exact and stable.
    """
    detail: dict[str, object] = {
        "resource_id": str(resource.pk),
        "resource_name": resource.name,
    }
    if event_type == TaskActivityEventType.ASSIGNEE_UNITS_CHANGED:
        detail["units"] = {
            "from": str(units_from) if units_from is not None else None,
            "to": str(units_to) if units_to is not None else None,
        }
    else:
        detail["units"] = str(units_to) if units_to is not None else None
    TaskActivityEvent.objects.create(
        task_id=task_id, actor=actor, event_type=event_type, detail=detail
    )


def _write_one_owner(
    task: Task, owner: dict[str, object], actor: Any
) -> tuple[TaskResource, tuple[str, str] | None]:
    """Upsert one inline owner; return the row and the board event it earns.

    The event is ``None`` for a re-write at the same units. Committing the same row
    twice is not an ownership change and must not read as one — so it earns no audit
    row and no broadcast.
    """
    resource = owner["resource"]
    assert isinstance(resource, Resource)
    units = owner.get("units")
    # Quantize to the column's 2dp before writing. Without this the audit row
    # stringifies the caller's literal ("1.0") while the drawer path records the
    # DB-normalized value ("1.00") — two spellings of the same allocation in one
    # activity feed, and a spurious units-changed delta on the next write.
    new_units = (units if isinstance(units, Decimal) else Decimal("1.0")).quantize(Decimal("0.01"))
    prior = TaskResource.objects.filter(task=task, resource=resource).first()
    assignment, created = TaskResource.objects.update_or_create(
        task=task, resource=resource, defaults={"units": new_units}
    )
    ensure_project_resource(task.project, resource)

    units_changed = prior is not None and prior.units != new_units
    if actor is not None:
        if created:
            record_assignment_event(
                task_id=task.pk,
                event_type=TaskActivityEventType.ASSIGNEE_ADDED,
                resource=resource,
                actor=actor,
                units_to=new_units,
            )
        elif prior is not None and units_changed:
            record_assignment_event(
                task_id=task.pk,
                event_type=TaskActivityEventType.ASSIGNEE_UNITS_CHANGED,
                resource=resource,
                actor=actor,
                units_from=prior.units,
                units_to=new_units,
            )

    if created:
        return assignment, ("assignment_created", str(assignment.pk))
    if units_changed:
        return assignment, ("assignment_updated", str(assignment.pk))
    return assignment, None


def apply_task_owners(
    task: Task, owners: list[dict[str, object]], *, actor: Any = None
) -> list[TaskResource]:
    """Write inline ``owners`` authored on a task write into ``TaskResource`` rows.

    The single primitive behind every Project Designer authoring surface that says
    "this person owns this row" — the ``@ana`` token, the import Owner column, the
    seeded-landing owner action (ADR-0774, #2718). It exists because the obvious
    implementation, ``Task.assignee``, is silently wrong: every capacity, utilization,
    heat-map and sprint-capacity computation sums ``TaskResource.units`` and never reads
    ``assignee``, so a bare-assignee task contributes zero load forever with no warning.

    **Upsert, never replace-set.** Applied through the ``(task, resource)`` unique
    constraint: a resource already assigned has its ``units`` updated, a new one is
    added, and anyone *not* named is left alone. ``@ana`` means "Ana owns this", not
    "Ana is now the only person here" — a replace-set would let one token edit silently
    delete a co-assignee written by somebody else. Removal stays on
    ``DELETE /task-resources/{id}/``.

    Each assigned resource is auto-rostered (#241) so an owner can never be assigned
    work yet be invisible in Team → Roster, Allocation, and Heatmap.

    **Parity with ``TaskResourceViewSet`` is the point of doing all of this here.** An
    assignment authored inline must be indistinguishable, downstream, from one made in
    the task drawer — so this also writes the ADR-0394 audit row and fires the
    ``assignment_*`` board event. Both matter for concrete reasons:

    - Without the audit row, an owner set by token is missing from the task activity
      feed while the same assignment made in the drawer appears — a plan whose ownership
      history depends on which affordance was used.
    - Without the broadcast, `task_updated` alone would reach other clients. That
      invalidates task queries but **not** the allocation timeline or the heat map,
      which `useProjectWebSocket` refreshes on `assignment_*` only — so a colleague
      watching capacity would keep seeing a stale zero, which is this issue's original
      complaint reappearing over the wire.

    The broadcast is deferred with ``transaction.on_commit`` (it is an external side
    effect that must not fire for a rolled-back write); the audit row is not (it is a DB
    row that must commit or roll back with the assignment).

    Args:
        task: The task being authored. Must already be saved.
        owners: Validated ``[{"resource": Resource, "units": Decimal}, ...]``. The
            caller (``TaskSerializer._resolve_owners``) is responsible for having
            scoped every resource to ``task.project``'s roster.
        actor: The acting user, for the audit row. ``None`` skips it — correct for a
            system path such as an import, which records its own provenance.

    Returns:
        The ``TaskResource`` rows written, in input order.
    """
    from django.db import transaction

    written: list[TaskResource] = []
    events: list[tuple[str, str]] = []
    for owner in owners:
        assignment, event = _write_one_owner(task, owner, actor)
        written.append(assignment)
        if event is not None:
            events.append(event)

    if events:
        project_id = str(task.project_id)
        task_id = str(task.pk)

        def _broadcast() -> None:
            from trueppm_api.apps.sync.broadcast import broadcast_board_event

            for event_type, assignment_id in events:
                broadcast_board_event(
                    project_id, event_type, {"id": assignment_id, "task_id": task_id}
                )

        transaction.on_commit(_broadcast)

    return written
