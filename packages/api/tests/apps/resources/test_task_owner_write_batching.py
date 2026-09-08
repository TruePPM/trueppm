"""The inline-``owners`` WRITE phase is constant in the number of owners (#3575).

``test_perf_n_plus_one.py::test_bulk_response_serialization_is_constant_in_n`` pins the
bulk endpoint's *response* phase (#998) and nothing pinned the write phase, so
``apply_task_owners`` was free to spend ~6 statements per owner — a redundant
``.first()`` probe, ``update_or_create``'s savepoint + ``SELECT … FOR UPDATE`` + write,
a ``get_or_create`` roster probe, and an audit INSERT. A 50-row paste with two owners
apiece opened ~750 statements inside one atomic block.

The guard here is the first class of test; the rest are the correctness invariants that
``bulk_create`` silently drops if you are not explicit about them — ``server_version``
on a ``VersionedModel`` (no ``save()``, no bump, and delta sync breaks with no test
failing anywhere), the roster's leave-soft-deleted-rows-alone rule, and the audit trail
a duplicated owner earns.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Task,
    TaskActivityEvent,
    TaskActivityEventType,
)
from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource
from trueppm_api.apps.resources.services import apply_task_owners, ensure_project_resources

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def cal(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard", working_days=31, hours_per_day=8.0)


@pytest.fixture
def project(cal: Calendar) -> Project:
    return Project.objects.create(name="Designer", start_date=date(2026, 4, 27), calendar=cal)


@pytest.fixture
def owner_user(project: Project) -> Any:
    u = User.objects.create_user(username="pm_owner", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.OWNER)
    return u


@pytest.fixture
def client(owner_user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner_user)
    return c


def _rostered(project: Project, n: int, *, prefix: str = "R") -> list[Resource]:
    """``n`` resources, each on ``project``'s live roster."""
    out = []
    for i in range(n):
        r = Resource.objects.create(name=f"{prefix}{i}", max_units=Decimal("1.0"))
        ProjectResource.objects.create(project=project, resource=r)
        out.append(r)
    return out


def _unrostered(n: int, *, prefix: str = "U") -> list[Resource]:
    """``n`` resources deliberately NOT on any roster, so the roster INSERT fires.

    ``_resolve_owners`` rejects these on the API path, but the recurring-occurrence
    sweep and any future service caller reach ``apply_task_owners`` directly, and the
    auto-roster (#241) exists precisely for them.
    """
    return [
        Resource.objects.create(name=f"{prefix}{i}", max_units=Decimal("1.0")) for i in range(n)
    ]


def _owners(resources: list[Resource], units: str = "1.0") -> list[dict[str, object]]:
    """The validated shape ``TaskSerializer._resolve_owners`` hands the service."""
    return [{"resource": r, "units": Decimal(units)} for r in resources]


# ---------------------------------------------------------------------------
# The query-count guard — the point of the issue
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_apply_task_owners_query_count_is_constant_in_owner_count(
    project: Project, owner_user: Any
) -> None:
    """Writing 8 owners costs the same number of statements as writing 1.

    The two arms genuinely differ in owner count (1 vs 8) on tasks that are otherwise
    identical, so a per-owner statement cannot hide behind a shared fixed cost. On the
    pre-#3575 per-row loop this fails with roughly ``6 × 7 = 42`` extra statements.
    """
    one = _rostered(project, 1, prefix="A")
    many = _rostered(project, 8, prefix="B")

    def write_count(task_name: str, resources: list[Resource]) -> int:
        task = Task.objects.create(project=project, name=task_name, duration=1)
        with CaptureQueriesContext(connection) as ctx:
            apply_task_owners(task, _owners(resources), actor=owner_user, broadcast=False)
        return len(ctx.captured_queries)

    # Warm any one-time connection/content-type caches so the first measured call is
    # not charged for them.
    write_count("warmup", _rostered(project, 1, prefix="W"))

    assert write_count("small", one) == write_count("big", many)


@pytest.mark.django_db
def test_apply_task_owners_costs_at_most_five_statements(project: Project, owner_user: Any) -> None:
    """An absolute ceiling, so the equality guard above cannot pass by regressing both arms.

    One read of the task's assignment rows, one upsert, one roster read, one audit
    insert. The roster insert is the fifth and does not fire here because every owner is
    already rostered — hence ``<= 5`` rather than an exact count. The unrostered arm
    below is the one that proves the fifth statement.
    """
    resources = _rostered(project, 6, prefix="C")
    task = Task.objects.create(project=project, name="T", duration=1)
    # Warm caches on a throwaway task first.
    apply_task_owners(
        Task.objects.create(project=project, name="warm", duration=1),
        _owners(_rostered(project, 1, prefix="D")),
        actor=owner_user,
        broadcast=False,
    )

    with CaptureQueriesContext(connection) as ctx:
        apply_task_owners(task, _owners(resources), actor=owner_user, broadcast=False)

    assert len(ctx.captured_queries) <= 5, [q["sql"] for q in ctx.captured_queries]


@pytest.mark.django_db
def test_query_count_is_constant_when_the_owners_still_need_rostering(
    project: Project, owner_user: Any
) -> None:
    """The roster INSERT branch is inside the guard too, not just the roster read.

    Every other cost guard here hands ``apply_task_owners`` already-rostered resources,
    so ``ensure_project_resources`` finds nothing missing and its ``bulk_create`` never
    runs — which would leave half the fix unmeasured. The old per-owner
    ``get_or_create`` roster probe was one of the ~6 statements this issue exists to
    remove, so reverting *that* half alone has to fail something.
    """

    def write_count(task_name: str, resources: list[Resource]) -> int:
        task = Task.objects.create(project=project, name=task_name, duration=1)
        with CaptureQueriesContext(connection) as ctx:
            apply_task_owners(task, _owners(resources), actor=owner_user, broadcast=False)
        return len(ctx.captured_queries)

    write_count("warmup", _unrostered(1, prefix="V"))
    assert write_count("small", _unrostered(1, prefix="X")) == write_count(
        "big", _unrostered(8, prefix="Y")
    )


@pytest.mark.django_db
def test_rostering_eight_new_owners_costs_exactly_five_statements(
    project: Project, owner_user: Any
) -> None:
    """The full five: assignment read, upsert, roster read, roster insert, audit insert.

    An exact count rather than a ceiling, because this is the one arrangement in which
    every one of the five fires. Also pins ``server_version`` across a multi-row roster
    insert — the single-row case elsewhere cannot see a list comprehension that sets it
    on only the first element.
    """
    task = Task.objects.create(project=project, name="T", duration=1)
    apply_task_owners(
        Task.objects.create(project=project, name="warm", duration=1),
        _owners(_unrostered(1, prefix="Z")),
        actor=owner_user,
        broadcast=False,
    )
    newcomers = _unrostered(8, prefix="N")

    with CaptureQueriesContext(connection) as ctx:
        apply_task_owners(task, _owners(newcomers), actor=owner_user, broadcast=False)

    assert len(ctx.captured_queries) == 5, [q["sql"] for q in ctx.captured_queries]
    rows = ProjectResource.objects.filter(
        project=project, resource_id__in=[r.pk for r in newcomers]
    )
    assert rows.count() == 8
    assert set(rows.values_list("server_version", flat=True)) == {1}


@pytest.mark.django_db
def test_ceiling_holds_when_the_task_has_no_project_in_its_fk_cache(
    project: Project, owner_user: Any
) -> None:
    """Rostering reads ``task.project_id``, never ``task.project``.

    Every other test here builds its task with ``Task.objects.create(project=project)``,
    which populates the FK cache — so a revert to ``task.project`` would cost nothing in
    those and one SELECT per occurrence inside the recurring-occurrence sweep, which is
    exactly where it would hurt. Re-fetching the task leaves the cache cold, which is
    the only arrangement that can see the difference.
    """
    created = Task.objects.create(project=project, name="Cold", duration=1)
    apply_task_owners(
        Task.objects.create(project=project, name="warm", duration=1),
        _owners(_unrostered(1, prefix="P")),
        actor=owner_user,
        broadcast=False,
    )
    task = Task.objects.get(pk=created.pk)
    assert "project" not in task._state.fields_cache
    # Built outside the context: ``_unrostered`` writes a row per resource, and those
    # INSERTs are not the statements under measurement.
    newcomers = _unrostered(4, prefix="Q")

    with CaptureQueriesContext(connection) as ctx:
        apply_task_owners(task, _owners(newcomers), actor=owner_user, broadcast=False)

    assert len(ctx.captured_queries) == 5, [q["sql"] for q in ctx.captured_queries]


@pytest.mark.django_db
def test_a_mixed_payload_rosters_only_the_newcomers(project: Project, owner_user: Any) -> None:
    """``missing`` as a proper subset of ``wanted`` — the case a single-row test cannot see.

    A resource already on the roster must be left byte-for-byte alone (no reinsert, no
    ``server_version`` bump), while the newcomers beside it are created at 1.
    """
    settled = _rostered(project, 3, prefix="S")
    newcomers = _unrostered(3, prefix="T")
    task = Task.objects.create(project=project, name="T", duration=1)

    apply_task_owners(task, _owners(settled + newcomers), actor=owner_user, broadcast=False)

    assert set(
        ProjectResource.objects.filter(
            project=project, resource_id__in=[r.pk for r in newcomers]
        ).values_list("server_version", flat=True)
    ) == {1}
    # The pre-existing rows were created by ProjectResource.objects.create() in the
    # fixture, i.e. through save(), so they are already at 1 — the assertion that
    # matters is that there is still exactly one row each and no second insert.
    assert (
        ProjectResource.objects.filter(
            project=project, resource_id__in=[r.pk for r in settled]
        ).count()
        == 3
    )


@pytest.mark.django_db
def test_ensure_project_resources_is_a_no_op_for_an_empty_id_list(project: Project) -> None:
    """The public helper's own empty guard, which its only caller can never reach.

    ``apply_task_owners`` returns early on empty ``owners``, so nothing in the service
    exercises this branch; it is a guard for the helper's own callers.
    """
    with CaptureQueriesContext(connection) as ctx:
        ensure_project_resources(project.pk, [])
    assert ctx.captured_queries == []
    assert ProjectResource.objects.filter(project=project).count() == 0


@pytest.mark.django_db
def test_bulk_endpoint_write_phase_is_constant_in_owners_per_task(
    client: APIClient, project: Project
) -> None:
    """``POST /tasks/bulk/`` with 2 owners per row costs the same as with 6.

    Task count is held equal between the arms so the response phase (#998, already
    pinned) and the per-task serializer cost cancel out and only the per-owner write
    cost can differ.
    """
    few = _rostered(project, 2, prefix="E")
    lots = _rostered(project, 6, prefix="F")

    def bulk_count(tag: str, resources: list[Resource]) -> int:
        payload = {
            "operations": [
                {
                    "op": "create",
                    "data": {
                        "name": f"{tag}{i}",
                        "owners": [{"resource": str(r.pk), "units": "1.0"} for r in resources],
                    },
                }
                for i in range(3)
            ]
        }
        with CaptureQueriesContext(connection) as ctx:
            res = client.post(f"/api/v1/projects/{project.pk}/tasks/bulk/", payload, format="json")
        assert res.status_code == 207, res.data
        assert res.data["rejected"] == [], res.data["rejected"]
        return len(ctx.captured_queries)

    bulk_count("warm", few)
    assert bulk_count("few", few) == bulk_count("lots", lots)


# ---------------------------------------------------------------------------
# What bulk_create silently drops if you are not explicit
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_auto_rostered_row_carries_server_version_one(project: Project, owner_user: Any) -> None:
    """``ProjectResource`` is a ``VersionedModel`` and ``bulk_create`` skips ``save()``.

    ``server_version`` is the optimistic-lock token clients echo back as
    ``X-Base-Version`` and the counter ADR-0217's field-level merge does arithmetic on.
    A roster row inserted at the field default of 0 instead of the INSERT-path value of
    1 is a silent protocol lie that no behavioral test would catch.
    """
    off_roster = Resource.objects.create(name="Unrostered", max_units=Decimal("1.0"))
    task = Task.objects.create(project=project, name="T", duration=1)

    apply_task_owners(task, _owners([off_roster]), actor=owner_user, broadcast=False)

    row = ProjectResource.objects.get(project=project, resource=off_roster)
    assert row.server_version == 1
    assert row.is_deleted is False
    # ProjectResource is outside the sync union (no OWNER_RESOLVERS entry), so save()
    # would not have allocated a cursor either — 0 is the correct value, not a miss.
    assert row.sync_seq == 0


@pytest.mark.django_db
def test_soft_deleted_roster_row_is_not_reactivated_or_duplicated(
    project: Project, owner_user: Any
) -> None:
    """The soft-delete is a deliberate PM action; assignment must not undo it.

    ``get_or_create`` matched soft-deleted rows too, so the batched read has to as well
    — filtering ``is_deleted=False`` would insert a duplicate and trip the unique
    constraint (or, with ``ignore_conflicts``, silently no-op and lose the roster row).
    """
    res = Resource.objects.create(name="Retired", max_units=Decimal("1.0"))
    pr = ProjectResource.objects.create(project=project, resource=res)
    pr.soft_delete()
    task = Task.objects.create(project=project, name="T", duration=1)

    apply_task_owners(task, _owners([res]), actor=owner_user, broadcast=False)

    rows = ProjectResource.objects.filter(project=project, resource=res)
    assert rows.count() == 1
    assert rows.get().is_deleted is True


@pytest.mark.django_db
def test_roster_row_is_ensured_even_when_the_assignment_is_unchanged(
    project: Project, owner_user: Any
) -> None:
    """A no-op re-write still guarantees the roster row, as the per-owner loop did.

    The upsert only carries rows whose units changed, so rostering must key off the
    owners *named*, not the rows written — otherwise a repaired roster gap would depend
    on the allocation happening to differ.
    """
    res = Resource.objects.create(name="Gap", max_units=Decimal("1.0"))
    task = Task.objects.create(project=project, name="T", duration=1)
    TaskResource.objects.create(task=task, resource=res, units=Decimal("1.00"))
    assert not ProjectResource.objects.filter(project=project, resource=res).exists()

    apply_task_owners(task, _owners([res], units="1.0"), actor=owner_user, broadcast=False)

    assert ProjectResource.objects.filter(project=project, resource=res).exists()


# ---------------------------------------------------------------------------
# Behavior the batching must preserve
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_every_named_owner_is_written_with_its_own_units(project: Project, owner_user: Any) -> None:
    """A mixed payload of adds and re-allocations lands in one upsert, row for row."""
    a, b, c = _rostered(project, 3, prefix="G")
    task = Task.objects.create(project=project, name="T", duration=1)
    TaskResource.objects.create(task=task, resource=a, units=Decimal("1.00"))

    written = apply_task_owners(
        task,
        [
            {"resource": a, "units": Decimal("0.25")},
            {"resource": b, "units": Decimal("0.50")},
            {"resource": c, "units": Decimal("1.0")},
        ],
        actor=owner_user,
        broadcast=False,
    )

    assert [r.resource_id for r in written] == [a.pk, b.pk, c.pk]
    assert dict(TaskResource.objects.filter(task=task).values_list("resource_id", "units")) == {
        a.pk: Decimal("0.25"),
        b.pk: Decimal("0.50"),
        c.pk: Decimal("1.00"),
    }


@pytest.mark.django_db
def test_audit_rows_are_written_for_every_add_and_delta(project: Project, owner_user: Any) -> None:
    """One bulk_create must produce exactly the rows the per-owner INSERTs produced."""
    a, b = _rostered(project, 2, prefix="H")
    task = Task.objects.create(project=project, name="T", duration=1)
    TaskResource.objects.create(task=task, resource=a, units=Decimal("1.00"))

    apply_task_owners(
        task,
        [{"resource": a, "units": Decimal("0.50")}, {"resource": b, "units": Decimal("1.0")}],
        actor=owner_user,
        broadcast=False,
    )

    delta = TaskActivityEvent.objects.get(
        task=task, event_type=TaskActivityEventType.ASSIGNEE_UNITS_CHANGED
    )
    assert delta.detail == {
        "resource_id": str(a.pk),
        "resource_name": a.name,
        "units": {"from": "1.00", "to": "0.50"},
    }
    added = TaskActivityEvent.objects.get(
        task=task, event_type=TaskActivityEventType.ASSIGNEE_ADDED
    )
    assert added.detail == {
        "resource_id": str(b.pk),
        "resource_name": b.name,
        "units": "1.00",
    }
    assert added.actor_id == owner_user.pk
    assert added.created_at is not None


@pytest.mark.django_db
def test_a_null_actor_writes_no_audit_rows(project: Project) -> None:
    """The recurring-occurrence sweep runs with ``actor=None`` and records its own
    provenance — it must not start emitting per-assignment audit rows."""
    res = _rostered(project, 1, prefix="I")
    task = Task.objects.create(project=project, name="T", duration=1)

    apply_task_owners(task, _owners(res), actor=None, broadcast=False)

    assert TaskActivityEvent.objects.filter(task=task).count() == 0
    assert TaskResource.objects.filter(task=task).count() == 1


@pytest.mark.django_db
def test_rewrite_at_the_same_units_writes_and_broadcasts_nothing(
    project: Project, owner_user: Any
) -> None:
    """Committing an unchanged row is not an ownership change and must not read as one."""
    res = _rostered(project, 1, prefix="J")
    task = Task.objects.create(project=project, name="T", duration=1)
    apply_task_owners(task, _owners(res), actor=owner_user, broadcast=False)
    before = TaskActivityEvent.objects.filter(task=task).count()

    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast:
        apply_task_owners(task, _owners(res), actor=owner_user, broadcast=True)

    assert TaskActivityEvent.objects.filter(task=task).count() == before
    assert bcast.call_args_list == []


@pytest.mark.django_db
def test_the_same_owner_named_twice_replays_the_add_then_the_delta(
    project: Project, owner_user: Any
) -> None:
    """Nothing rejects a duplicated resource in one payload, and the per-owner loop
    recorded an add followed by a units delta. Collapsing to a single add at the final
    allocation would quietly rewrite the audit trail, so the batched planner replays the
    payload entry by entry against an in-memory view of the row set."""
    res = _rostered(project, 1, prefix="K")[0]
    task = Task.objects.create(project=project, name="T", duration=1)

    apply_task_owners(
        task,
        [{"resource": res, "units": Decimal("1.0")}, {"resource": res, "units": Decimal("0.5")}],
        actor=owner_user,
        broadcast=False,
    )

    assert TaskResource.objects.filter(task=task, resource=res).count() == 1
    assert TaskResource.objects.get(task=task, resource=res).units == Decimal("0.50")
    # Asserted on the rows' CONTENT, not on ``order_by("created_at")``. The two audit
    # rows now get their ``auto_now_add`` stamps from consecutive ``Field.pre_save``
    # calls inside one ``bulk_create``, where the old loop had a full INSERT round-trip
    # between them — and ``TaskActivityEvent`` has no secondary sort key, so an ordering
    # assertion would be resolving a tie the database does not promise to break.
    rows = TaskActivityEvent.objects.filter(task=task)
    assert rows.count() == 2
    assert rows.get(event_type=TaskActivityEventType.ASSIGNEE_ADDED).detail["units"] == "1.00"
    assert rows.get(event_type=TaskActivityEventType.ASSIGNEE_UNITS_CHANGED).detail["units"] == {
        "from": "1.00",
        "to": "0.50",
    }


@pytest.mark.django_db
def test_owners_not_named_are_left_alone(project: Project, owner_user: Any) -> None:
    """Upsert, never replace-set — the unique constraint the ON CONFLICT targets must
    not become a delete-and-reinsert."""
    a, b = _rostered(project, 2, prefix="L")
    task = Task.objects.create(project=project, name="T", duration=1)
    keeper = TaskResource.objects.create(task=task, resource=b, units=Decimal("0.75"))

    apply_task_owners(task, _owners([a]), actor=owner_user, broadcast=False)

    assert set(TaskResource.objects.filter(task=task).values_list("resource_id", flat=True)) == {
        a.pk,
        b.pk,
    }
    keeper.refresh_from_db()
    assert keeper.units == Decimal("0.75")
    # The re-allocation upsert must reuse the existing row's pk, never mint a new one —
    # a fresh pk would orphan every client cache entry keyed on it.
    apply_task_owners(task, _owners([b], units="0.25"), actor=owner_user, broadcast=False)
    assert TaskResource.objects.get(task=task, resource=b).pk == keeper.pk


@pytest.mark.django_db(transaction=True)
def test_broadcast_is_still_deferred_to_on_commit_and_names_every_changed_row(
    project: Project, owner_user: Any
) -> None:
    """Batching must not move the fanout relative to ``transaction.on_commit``.

    The broadcast is an external side effect that must not fire for a rolled-back
    write, so it stays deferred; the audit rows stay inside the transaction. Both
    events are still emitted, one per changed row.
    """
    from django.db import transaction

    a, b = _rostered(project, 2, prefix="M")
    task = Task.objects.create(project=project, name="T", duration=1)
    TaskResource.objects.create(task=task, resource=a, units=Decimal("1.00"))

    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast:
        with transaction.atomic():
            apply_task_owners(
                task,
                [
                    {"resource": a, "units": Decimal("0.5")},
                    {"resource": b, "units": Decimal("1.0")},
                ],
                actor=owner_user,
                broadcast=True,
            )
            assert bcast.call_args_list == [], "fanout fired before commit"
        emitted = [call.args[1] for call in bcast.call_args_list]

    assert sorted(emitted) == ["assignment_created", "assignment_updated"]
    ids = {call.args[2]["id"] for call in bcast.call_args_list}
    assert ids == {
        str(pk) for pk in TaskResource.objects.filter(task=task).values_list("pk", flat=True)
    }


@pytest.mark.django_db
def test_a_rolled_back_owner_write_leaves_no_audit_row(project: Project, owner_user: Any) -> None:
    """The audit rows are DB rows, not deferred side effects — they must roll back with
    the assignment they describe."""
    from django.db import transaction

    res = _rostered(project, 1, prefix="N")
    task = Task.objects.create(project=project, name="T", duration=1)

    class _Rollback(Exception):
        pass

    with pytest.raises(_Rollback), transaction.atomic():
        apply_task_owners(task, _owners(res), actor=owner_user, broadcast=False)
        raise _Rollback

    assert TaskResource.objects.filter(task=task).count() == 0
    assert TaskActivityEvent.objects.filter(task=task).count() == 0
