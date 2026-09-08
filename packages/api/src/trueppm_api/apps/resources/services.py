"""Service-layer helpers for the resources app."""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING, Any, NamedTuple

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


def ensure_project_resources(project_id: Any, resource_ids: list[Any]) -> None:
    """Batched :func:`ensure_project_resource` — two statements for any number of ids.

    Same contract as the single-row helper: a resource already on the roster is left
    exactly as it is (live *or* soft-deleted — reactivation belongs to the explicit
    roster UI, never to the side effect of a task assignment), and only a resource with
    no row at all gets one.

    Two details are load-bearing and easy to lose when converting a ``get_or_create``
    loop to ``bulk_create``:

    * ``ProjectResource`` is a ``VersionedModel``, and ``bulk_create`` does **not** call
      ``Model.save()`` — so the INSERT-path ``server_version = 1`` that
      :meth:`VersionedModel.save` would set has to be written here explicitly. A row
      left at the field default of 0 would publish a bogus optimistic-lock token.
      ``sync_seq`` is correctly left at 0: ``ProjectResource`` is outside the sync union
      (it has no ``OWNER_RESOLVERS`` entry), so ``save()`` would not have allocated one
      either.
    * ``ignore_conflicts=True`` makes the INSERT an ``ON CONFLICT DO NOTHING`` against
      ``uniq_project_resource_project_resource``, so a concurrent writer rostering the
      same resource cannot turn this into an ``IntegrityError``. That is the same
      last-writer-wins outcome the previous ``get_or_create`` produced, without the
      per-row savepoint.

    No signal receiver is wired to ``ProjectResource`` (``post_save`` senders in this
    codebase are ``Task``, ``Program``, ``ProjectMembership``, ``Historical*`` and the
    user model), so skipping ``save()`` skips nothing else.
    """
    if not resource_ids:
        return
    wanted = list(dict.fromkeys(resource_ids))
    existing = set(
        ProjectResource.objects.filter(project_id=project_id, resource_id__in=wanted).values_list(
            "resource_id", flat=True
        )
    )
    missing = [rid for rid in wanted if rid not in existing]
    if not missing:
        return
    ProjectResource.objects.bulk_create(
        [
            ProjectResource(project_id=project_id, resource_id=rid, server_version=1)
            for rid in missing
        ],
        ignore_conflicts=True,
    )


def rostered_resource_ids(project: Project) -> set[str]:
    """The resource ids on ``project``'s live roster, as strings.

    The membership index every inline-authoring surface resolves an owner against
    (ADR-0774 §3). Scoped deliberately: ``Resource`` is a workspace-**global** library
    with no project FK, so resolving against it would let a value authored on one
    project bind to a person who is a member of none of the caller's — the
    reach-across-projects hole ``data-interchange.spec.md`` §5.3 exists to close.

    ``.active()`` (#3572) so a deactivated person cannot be bound as an owner by an
    ``@mention`` or an import column: they are off the roster, and an authoring
    surface that still resolved them would re-create the very membership the
    deactivation removed.
    """
    return {
        str(rid)
        for rid in ProjectResource.objects.active()
        .filter(project=project)
        .values_list("resource_id", flat=True)
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
    build_assignment_event(
        task_id=task_id,
        event_type=event_type,
        resource=resource,
        actor=actor,
        units_from=units_from,
        units_to=units_to,
    ).save()


def build_assignment_event(
    *,
    task_id: Any,
    event_type: str,
    resource: Resource,
    actor: Any,
    units_from: Decimal | None = None,
    units_to: Decimal | None = None,
) -> TaskActivityEvent:
    """Build — but do not save — the audit row :func:`record_assignment_event` writes.

    The batched counterpart of that helper: :func:`apply_task_owners` accumulates the
    rows a whole inline-``owners`` payload earns and writes them with one
    ``bulk_create`` instead of one INSERT per owner. Both paths build the ``detail``
    payload here so the two spellings of the same audit row cannot drift.

    ``TaskActivityEvent`` is a plain ``models.Model`` with no signal receivers and no
    ``server_version``, so ``bulk_create`` loses nothing ``save()`` provided.
    ``created_at`` is ``auto_now_add``, which ``bulk_create`` still honors — the insert
    compiler calls ``Field.pre_save`` per object, in list order, exactly as the
    per-row loop did.
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
    return TaskActivityEvent(task_id=task_id, actor=actor, event_type=event_type, detail=detail)


class _OwnerWritePlan(NamedTuple):
    """Everything one inline-``owners`` payload resolves to, before anything is written.

    ``written`` is the return value of :func:`apply_task_owners` (rows in input order);
    ``upserts`` is the de-duplicated set of rows the INSERT actually has to carry;
    ``audit`` and ``events`` are the audit rows and board events the payload earns.
    """

    written: list[TaskResource]
    upserts: list[TaskResource]
    audit: list[TaskActivityEvent]
    events: list[tuple[str, str]]


def _plan_owner_writes(task: Task, owners: list[dict[str, object]], actor: Any) -> _OwnerWritePlan:
    """Resolve ``owners`` against a single read of the task's existing assignment rows.

    Replaces the per-owner ``filter(...).first()`` probe *and* the SELECT inside
    ``update_or_create`` with one ``resource_id__in`` read, then replays the payload
    entry by entry against an in-memory view of that row set. The replay is not
    decoration: a payload naming the same resource twice has to keep producing the
    audit trail the per-row loop produced (an add, then a units delta), not collapse
    into one add at the final allocation.

    A row is queued only when the write actually changes something. Re-committing an
    owner at the same units is not an ownership change and must not read as one, so it
    earns no audit row and no broadcast.
    """
    resources: list[Resource] = []
    for owner in owners:
        resource = owner["resource"]
        assert isinstance(resource, Resource)
        resources.append(resource)

    state: dict[Any, TaskResource] = {
        row.resource_id: row
        for row in TaskResource.objects.filter(task=task, resource_id__in={r.pk for r in resources})
    }
    written: list[TaskResource] = []
    upserts: dict[Any, TaskResource] = {}
    audit: list[TaskActivityEvent] = []
    events: list[tuple[str, str]] = []

    for owner, resource in zip(owners, resources, strict=True):
        units = owner.get("units")
        # Quantize to the column's 2dp before writing. Without this the audit row
        # stringifies the caller's literal ("1.0") while the drawer path records the
        # DB-normalized value ("1.00") — two spellings of the same allocation in one
        # activity feed, and a spurious units-changed delta on the next write.
        new_units = (units if isinstance(units, Decimal) else Decimal("1.0")).quantize(
            Decimal("0.01")
        )
        prior = state.get(resource.pk)

        if prior is None:
            # The pk comes from the field's ``uuid4`` default at construction, not from
            # the database, so the board event below can name the row before it exists.
            row = TaskResource(task=task, resource=resource, units=new_units)
            state[resource.pk] = row
            upserts[resource.pk] = row
            written.append(row)
            events.append(("assignment_created", str(row.pk)))
            if actor is not None:
                audit.append(
                    build_assignment_event(
                        task_id=task.pk,
                        event_type=TaskActivityEventType.ASSIGNEE_ADDED,
                        resource=resource,
                        actor=actor,
                        units_to=new_units,
                    )
                )
            continue

        written.append(prior)
        if prior.units == new_units:
            continue
        units_from = prior.units
        prior.units = new_units
        upserts[resource.pk] = prior
        events.append(("assignment_updated", str(prior.pk)))
        if actor is not None:
            audit.append(
                build_assignment_event(
                    task_id=task.pk,
                    event_type=TaskActivityEventType.ASSIGNEE_UNITS_CHANGED,
                    resource=resource,
                    actor=actor,
                    units_from=units_from,
                    units_to=new_units,
                )
            )

    return _OwnerWritePlan(
        written=written, upserts=list(upserts.values()), audit=audit, events=events
    )


def apply_task_owners(
    task: Task, owners: list[dict[str, object]], *, actor: Any = None, broadcast: bool = True
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

    **In-transaction cost is constant in the number of owners, not linear (#3575).** At
    most five statements for any payload size: one read of the task's existing
    assignment rows, one upsert of the rows that changed, one read of the roster, one
    insert of the missing roster rows, one insert of the audit rows. The previous
    per-owner loop cost roughly six statements *each* (a redundant ``.first()`` probe
    whose only job was to read ``prior.units``, ``update_or_create``'s savepoint +
    ``SELECT … FOR UPDATE`` + write, a ``get_or_create`` roster probe, and an audit
    INSERT), so a 50-row bulk paste with two owners apiece opened ~750 statements inside
    one atomic block.

    Read that claim narrowly: it is about the statements *inside the transaction*, which
    is where the cost mattered. Two things downstream stay linear in the payload and are
    unchanged by this — the audit rows (N rows, but in one INSERT) and the post-commit
    fanout, which is still one ``broadcast_board_event`` per changed row. Batching that
    fanout would need a new frozen event type and a client handler, so it is separate
    work, not a claim this function makes.

    **Why an upsert rather than the row lock it replaces.** ``update_or_create`` took a
    ``SELECT … FOR UPDATE`` on the assignment row; ``bulk_create(update_conflicts=True)``
    takes none, and instead issues ``INSERT … ON CONFLICT (task_id, resource_id) DO
    UPDATE SET units``, resolved against ``uniq_task_resource_task_resource``. That is
    the same last-writer-wins outcome the lock produced — two concurrent requests
    naming the same owner serialize on the unique index inside the database and both
    commit, rather than one raising ``IntegrityError`` — but it survives being batched,
    which a per-row lock does not.

    Two behavioral differences follow, both confined to the losing side of a genuine
    concurrent add of the *same* owner to the *same* task, and both accepted:

    * The loser's in-memory row keeps the pk it generated rather than the winner's, so
      its ``assignment_created`` event names an id the database discarded. Inert — every
      ``assignment_*`` event funnels to the same ``scheduleInvalidate`` on the client,
      which refetches rather than reading the id, and all three callers discard this
      function's return value.
    * The loser records a second ``assignee_added`` audit row. Under the old lock its
      ``get_or_create`` caught the ``IntegrityError``, re-read the row and returned
      ``created=False``, and because ``prior`` was still ``None`` from the probe *before*
      it, the loser recorded nothing at all. Both writers now read ``prior is None`` and
      both write an add, so the activity feed can show one person added twice. Reading
      that back off the database to suppress it would cost the query the batching exists
      to remove, for a duplicate line in an append-only feed; a lost audit row would have
      been the worse trade.

    Args:
        task: The task being authored. Must already be saved.
        owners: Validated ``[{"resource": Resource, "units": Decimal}, ...]``. The
            caller (``TaskSerializer._resolve_owners``) is responsible for having
            scoped every resource to ``task.project``'s roster.
        actor: The acting user, for the audit row. ``None`` skips it — correct for a
            system path such as an import, which records its own provenance.
        broadcast: Emit the ``assignment_*`` board events. Pass ``False`` only when the
            caller already emits a coarser event covering the same rows — the recurring
            occurrence sweep (#2902) writes many tasks per project per run and
            deliberately emits one bulk ``tasks_bulk_mutated`` per project instead of one
            event per row, and both event families funnel to the same
            ``scheduleInvalidate('tasks')`` on the client, so the per-assignment events
            would be pure duplicate load. Never pass ``False`` from a user-facing write.

    Returns:
        The ``TaskResource`` rows written, in input order.
    """
    from django.db import transaction

    if not owners:
        return []

    plan = _plan_owner_writes(task, owners, actor)

    if plan.upserts:
        # One statement for new rows and re-allocations alike. ``TaskResource`` is a
        # plain ``models.Model`` — no ``server_version``, no ``HistoricalRecords``, and
        # no signal receiver anywhere in the codebase — so bypassing ``save()`` here
        # bypasses nothing that ``save()`` was doing.
        TaskResource.objects.bulk_create(
            plan.upserts,
            update_conflicts=True,
            update_fields=["units"],
            unique_fields=["task", "resource"],
        )

    # Rostered from ``written``, not ``upserts``: a re-write at unchanged units still
    # has to guarantee the roster row, exactly as the per-owner ``get_or_create`` did.
    # ``task.project_id`` rather than ``task.project`` so the count stays constant even
    # when the caller's Task has no Project in its FK cache.
    ensure_project_resources(task.project_id, [row.resource_id for row in plan.written])

    if plan.audit:
        TaskActivityEvent.objects.bulk_create(plan.audit)

    written = plan.written
    events = plan.events

    if events and broadcast:
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
