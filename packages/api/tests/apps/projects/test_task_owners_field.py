"""The write-only ``owners`` field on task writes (ADR-0774, #2718).

The Project Designer's ``@ana`` token, the import Owner column, and the seeded-landing
owner action all express ownership through this one field. It exists because the obvious
implementation — setting ``Task.assignee`` — is silently wrong: every capacity,
utilization, heat-map and sprint-capacity computation sums ``TaskResource.units`` and
never reads ``assignee``, so a bare-assignee task contributes zero load forever with no
warning anywhere.

The final class here is the one that matters most: it asserts the whole loop, from an
``owners`` write to a non-zero number on the capacity endpoints. Everything else is a
guard around it.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
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

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def cal(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard", working_days=31, hours_per_day=8.0)


@pytest.fixture
def project(cal: Calendar) -> Project:
    # A Monday start keeps the heatmap's week boundaries predictable.
    return Project.objects.create(name="Designer", start_date=date(2026, 4, 27), calendar=cal)


@pytest.fixture
def owner_user(project: Project) -> object:
    u = User.objects.create_user(username="pm_owner", password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=Role.OWNER)
    return u


@pytest.fixture
def client(owner_user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=owner_user)
    return c


@pytest.fixture
def ana(project: Project) -> Resource:
    """A resource ON the project roster — the only kind ``owners`` accepts."""
    r = Resource.objects.create(
        name="Ana Rivera", email="ana@example.com", max_units=Decimal("1.0")
    )
    ProjectResource.objects.create(project=project, resource=r)
    return r


@pytest.fixture
def ben(project: Project) -> Resource:
    r = Resource.objects.create(
        name="Ben Okafor", email="ben@example.com", max_units=Decimal("1.0")
    )
    ProjectResource.objects.create(project=project, resource=r)
    return r


@pytest.fixture
def offroster(db: object) -> Resource:
    """A workspace-global resource that is on NO project roster."""
    return Resource.objects.create(
        name="Cara Global", email="cara@example.com", max_units=Decimal("1.0")
    )


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(
        project=project,
        name="Design",
        duration=5,
        early_start=date(2026, 4, 27),
        early_finish=date(2026, 5, 1),
        wbs_path="1",
    )


def _task_url(task: Task) -> str:
    return f"/api/v1/tasks/{task.pk}/"


# ---------------------------------------------------------------------------
# Create + update write TaskResource
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_create_with_owners_writes_task_resource(
    client: APIClient, project: Project, ana: Resource
) -> None:
    res = client.post(
        "/api/v1/tasks/",
        {
            "project": str(project.pk),
            "name": "Draft the migration plan",
            "duration": 5,
            "owners": [{"resource": str(ana.pk), "units": "0.5"}],
        },
        format="json",
    )
    assert res.status_code == 201, res.data

    assignment = TaskResource.objects.get(task_id=res.data["id"], resource=ana)
    assert assignment.units == Decimal("0.50")


@pytest.mark.django_db
def test_update_with_owners_writes_task_resource(
    client: APIClient, task: Task, ana: Resource
) -> None:
    res = client.patch(
        _task_url(task),
        {"name": "Draft plan", "owners": [{"resource": str(ana.pk)}]},
        format="json",
    )
    assert res.status_code == 200, res.data
    # A bare token defaults to a full allocation.
    assert TaskResource.objects.get(task=task, resource=ana).units == Decimal("1.00")


@pytest.mark.django_db
def test_owners_never_writes_assignee(client: APIClient, task: Task, ana: Resource) -> None:
    """The whole point: ownership lands on the axis the capacity engine reads."""
    client.patch(_task_url(task), {"owners": [{"resource": str(ana.pk)}]}, format="json")
    task.refresh_from_db()
    assert task.assignee_id is None
    assert TaskResource.objects.filter(task=task).count() == 1


@pytest.mark.django_db
def test_owners_is_write_only(client: APIClient, task: Task, ana: Resource) -> None:
    """``assignments`` is the read projection; ``owners`` must never echo back."""
    res = client.patch(_task_url(task), {"owners": [{"resource": str(ana.pk)}]}, format="json")
    assert "owners" not in res.data
    assert [a["resource_id"] for a in res.data["assignments"]] == [str(ana.pk)]


@pytest.mark.django_db
def test_owner_is_on_the_roster_after_the_write(
    client: APIClient, project: Project, task: Task, ana: Resource
) -> None:
    """An assigned owner can never be invisible in Roster / Allocation / Heatmap (#241).

    Resolution already requires roster membership, so ``ensure_project_resource`` is a
    belt-and-braces call on this path — but it is the invariant every future caller of
    ``apply_task_owners`` (the importer Owner column, the seeded-landing action) relies
    on, and the assertion is what keeps it true if resolution ever widens.
    """
    res = client.patch(_task_url(task), {"owners": [{"resource": str(ana.pk)}]}, format="json")
    assert res.status_code == 200, res.data
    assert ProjectResource.objects.filter(project=project, resource=ana, is_deleted=False).exists()

    roster = client.get("/api/v1/project-resources/", {"project": str(project.pk)})
    assert str(ana.pk) in {str(r["resource"]) for r in roster.data["results"]}


@pytest.mark.django_db
def test_bulk_create_carries_owners_through(
    client: APIClient, project: Project, ana: Resource
) -> None:
    """The batch path inherits the field, because it runs the same serializer.

    ``TaskBulkView`` is what #2723 hardens into the Designer's row-commit endpoint. It
    already routes ``create`` ops through ``TaskSerializer`` (``views.py``
    ``_bulk_create_task``), so pinning this now is what stops the batch surface growing
    its own second way to express ownership — the outcome this issue exists to prevent.
    """
    res = client.post(
        f"/api/v1/projects/{project.pk}/tasks/bulk/",
        {
            "operations": [
                {
                    "op": "create",
                    "data": {
                        "name": "Row from a batch",
                        "duration": 3,
                        "owners": [{"resource": str(ana.pk), "units": "0.75"}],
                    },
                }
            ]
        },
        format="json",
    )
    assert res.status_code == 200, res.data
    created_id = res.data["created"][0]["id"]
    assert TaskResource.objects.get(task_id=created_id, resource=ana).units == Decimal("0.75")


# ---------------------------------------------------------------------------
# Parity with the drawer's assignment path — audit trail and real-time
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_inline_owner_writes_the_activity_audit_row(
    client: APIClient, task: Task, ana: Resource, owner_user: object
) -> None:
    """An owner set by token must appear in task activity, like one set in the drawer.

    Otherwise a plan's ownership history depends on which affordance happened to be
    used, which is exactly the two-structurally-different-paths problem (ADR-0394).
    """
    client.patch(_task_url(task), {"owners": [{"resource": str(ana.pk)}]}, format="json")

    event = TaskActivityEvent.objects.get(
        task=task, event_type=TaskActivityEventType.ASSIGNEE_ADDED
    )
    assert event.detail["resource_id"] == str(ana.pk)
    assert event.detail["units"] == "1.00"
    assert event.actor_id == owner_user.pk  # type: ignore[attr-defined]


@pytest.mark.django_db
def test_reallocating_records_a_units_delta_not_a_second_add(
    client: APIClient, task: Task, ana: Resource
) -> None:
    client.patch(
        _task_url(task), {"owners": [{"resource": str(ana.pk), "units": "1.0"}]}, format="json"
    )
    client.patch(
        _task_url(task), {"owners": [{"resource": str(ana.pk), "units": "0.5"}]}, format="json"
    )

    assert (
        TaskActivityEvent.objects.filter(
            task=task, event_type=TaskActivityEventType.ASSIGNEE_ADDED
        ).count()
        == 1
    )
    delta = TaskActivityEvent.objects.get(
        task=task, event_type=TaskActivityEventType.ASSIGNEE_UNITS_CHANGED
    )
    assert delta.detail["units"] == {"from": "1.00", "to": "0.50"}


@pytest.mark.django_db
def test_rewriting_the_same_owner_at_the_same_units_records_nothing(
    client: APIClient, task: Task, ana: Resource
) -> None:
    """Committing an unchanged row is not an ownership change and must not read as one."""
    payload = {"owners": [{"resource": str(ana.pk), "units": "1.0"}]}
    client.patch(_task_url(task), payload, format="json")
    before = TaskActivityEvent.objects.filter(task=task).count()
    client.patch(_task_url(task), payload, format="json")
    assert TaskActivityEvent.objects.filter(task=task).count() == before


@pytest.mark.django_db(transaction=True)
def test_inline_owner_broadcasts_an_assignment_event(
    client: APIClient, task: Task, ana: Resource
) -> None:
    """`task_updated` alone is not enough — it does not refresh capacity views.

    ``useProjectWebSocket`` invalidates the allocation timeline and heat map on
    ``assignment_*`` only. Without this event a colleague watching capacity keeps seeing
    a stale zero, which is this issue's original complaint reappearing over the wire.
    """
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast:
        res = client.patch(_task_url(task), {"owners": [{"resource": str(ana.pk)}]}, format="json")
    assert res.status_code == 200, res.data
    events = {
        call.args[1] if len(call.args) > 1 else call.kwargs.get("event_type")
        for call in bcast.call_args_list
    }
    assert "assignment_created" in events


# ---------------------------------------------------------------------------
# Upsert, not replace-set
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_second_write_updates_units_rather_than_duplicating(
    client: APIClient, task: Task, ana: Resource
) -> None:
    client.patch(
        _task_url(task), {"owners": [{"resource": str(ana.pk), "units": "1.0"}]}, format="json"
    )
    client.patch(
        _task_url(task), {"owners": [{"resource": str(ana.pk), "units": "0.25"}]}, format="json"
    )
    assignments = TaskResource.objects.filter(task=task, resource=ana)
    assert assignments.count() == 1
    assert assignments.first().units == Decimal("0.25")


@pytest.mark.django_db
def test_naming_one_owner_does_not_remove_a_co_assignee(
    client: APIClient, task: Task, ana: Resource, ben: Resource
) -> None:
    """A single ``@ana`` edit must not silently delete somebody else's assignment."""
    TaskResource.objects.create(task=task, resource=ben, units=Decimal("1.0"))
    client.patch(_task_url(task), {"owners": [{"resource": str(ana.pk)}]}, format="json")
    assert set(TaskResource.objects.filter(task=task).values_list("resource_id", flat=True)) == {
        ana.pk,
        ben.pk,
    }


# ---------------------------------------------------------------------------
# Roster scoping — the security property
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_resource_outside_the_project_roster_is_rejected(
    client: APIClient, task: Task, offroster: Resource
) -> None:
    """``Resource`` is a workspace-global library; binding across projects is the hole."""
    res = client.patch(
        _task_url(task), {"owners": [{"resource": str(offroster.pk)}]}, format="json"
    )
    assert res.status_code == 400
    assert "owners" in res.data
    assert not TaskResource.objects.filter(task=task).exists()


@pytest.mark.django_db
def test_soft_deleted_roster_row_does_not_resolve(
    client: APIClient, project: Project, task: Task, ana: Resource
) -> None:
    ProjectResource.objects.filter(project=project, resource=ana).update(is_deleted=True)
    res = client.patch(_task_url(task), {"owners": [{"resource": str(ana.pk)}]}, format="json")
    assert res.status_code == 400


@pytest.mark.django_db
def test_rejection_is_atomic_with_the_rest_of_the_write(
    client: APIClient, task: Task, offroster: Resource
) -> None:
    """A bad owner must not leave the name change committed and the owner silently gone."""
    res = client.patch(
        _task_url(task),
        {"name": "Renamed", "owners": [{"resource": str(offroster.pk)}]},
        format="json",
    )
    assert res.status_code == 400
    task.refresh_from_db()
    assert task.name == "Design"


@pytest.mark.django_db
def test_unknown_resource_id_is_a_field_error_not_a_500(client: APIClient, task: Task) -> None:
    res = client.patch(
        _task_url(task),
        {"owners": [{"resource": "00000000-0000-0000-0000-000000000000"}]},
        format="json",
    )
    assert res.status_code == 400
    assert "owners" in res.data


# ---------------------------------------------------------------------------
# Allocation bounds and structural rules
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("units", ["0", "0.001", "2.5"])
def test_units_outside_the_allocation_range_is_rejected(
    client: APIClient, task: Task, ana: Resource, units: str
) -> None:
    res = client.patch(
        _task_url(task), {"owners": [{"resource": str(ana.pk), "units": units}]}, format="json"
    )
    assert res.status_code == 400


@pytest.mark.django_db
def test_summary_task_rejects_an_inline_owner(
    client: APIClient, project: Project, task: Task, ana: Resource
) -> None:
    """Same ADR-0024 rule TaskResourceViewSet enforces, via one shared helper."""
    Task.objects.create(project=project, name="Child", duration=2, wbs_path=f"{task.wbs_path}.1")
    res = client.patch(_task_url(task), {"owners": [{"resource": str(ana.pk)}]}, format="json")
    assert res.status_code == 400
    assert "owners" in res.data


@pytest.mark.django_db
def test_empty_owners_list_is_a_no_op(client: APIClient, task: Task, ben: Resource) -> None:
    TaskResource.objects.create(task=task, resource=ben, units=Decimal("1.0"))
    res = client.patch(_task_url(task), {"name": "Renamed", "owners": []}, format="json")
    assert res.status_code == 200
    # An empty list is "I named nobody", not "remove everyone" — removal has its own verb.
    assert TaskResource.objects.filter(task=task).count() == 1


# ---------------------------------------------------------------------------
# RBAC — authority is inherited from the surrounding task write, not restated
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_viewer_cannot_set_an_owner(project: Project, task: Task, ana: Resource) -> None:
    viewer = User.objects.create_user(username="viewer_o", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=viewer)

    res = c.patch(_task_url(task), {"owners": [{"resource": str(ana.pk)}]}, format="json")
    assert res.status_code in (403, 404)
    assert not TaskResource.objects.filter(task=task).exists()


@pytest.mark.django_db
def test_non_member_cannot_set_an_owner(project: Project, task: Task, ana: Resource) -> None:
    outsider = User.objects.create_user(username="outsider_o", password="pw")
    c = APIClient()
    c.force_authenticate(user=outsider)

    res = c.patch(_task_url(task), {"owners": [{"resource": str(ana.pk)}]}, format="json")
    assert res.status_code in (403, 404)
    assert not TaskResource.objects.filter(task=task).exists()


@pytest.mark.django_db
def test_member_may_set_an_owner_on_their_own_task(
    project: Project, task: Task, ana: Resource
) -> None:
    """ADR-0773 §1's ``◐ own-assigned`` cell: the row's bar, applied unchanged."""
    member = User.objects.create_user(username="member_o", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    task.assignee = member
    task.save(update_fields=["assignee"])
    c = APIClient()
    c.force_authenticate(user=member)

    res = c.patch(_task_url(task), {"owners": [{"resource": str(ana.pk)}]}, format="json")
    assert res.status_code == 200, res.data
    assert TaskResource.objects.filter(task=task, resource=ana).exists()


@pytest.mark.django_db
def test_member_cannot_set_an_owner_on_a_colleagues_task(
    project: Project, task: Task, ana: Resource, owner_user: object
) -> None:
    member = User.objects.create_user(username="member_o2", password="pw")
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    task.assignee = owner_user  # type: ignore[assignment]
    task.save(update_fields=["assignee"])
    c = APIClient()
    c.force_authenticate(user=member)

    res = c.patch(_task_url(task), {"owners": [{"resource": str(ana.pk)}]}, format="json")
    assert res.status_code in (403, 404)
    assert not TaskResource.objects.filter(task=task).exists()


# ---------------------------------------------------------------------------
# The axis split, pinned as it actually is
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_owners_does_not_put_the_task_in_the_owner_s_my_work_list(
    client: APIClient, project: Project, task: Task
) -> None:
    """Documents a real gap, in the direction opposite to the one #2718 assumed.

    #2718 states that contributor-facing views filter on the resource path. They do not:
    ``MeWorkView.get_queryset`` (``projects/views.py``) filters ``assignee_id`` and
    reads ``TaskResource`` nowhere. So the two axes are split the *other* way round for
    My Work — an owner set through ``owners`` gets correct capacity everywhere and still
    does not see the task in their own list.

    Closing that needs either an implicit ``Task.assignee`` write (which would also grant
    the person edit rights through ``can_user_edit_task``) or a change to a shipped,
    RBAC-sensitive endpoint. Both are decisions in their own right, tracked on #2750
    alongside #2747, which already owns "delete-rights and edit-rights disagree about
    what assignee means". This test exists so the behavior is recorded rather than
    assumed, and so it fails loudly the day either fix lands.
    """
    contributor = User.objects.create_user(username="priya_owner", password="pw")
    ProjectMembership.objects.create(project=project, user=contributor, role=Role.MEMBER)
    resource = Resource.objects.create(
        name="Priya P", email="priya@example.com", max_units=Decimal("1.0"), user=contributor
    )
    ProjectResource.objects.create(project=project, resource=resource)

    res = client.patch(_task_url(task), {"owners": [{"resource": str(resource.pk)}]}, format="json")
    assert res.status_code == 200, res.data
    assert TaskResource.objects.filter(task=task, resource=resource).exists()

    c = APIClient()
    c.force_authenticate(user=contributor)
    my_work = c.get("/api/v1/me/work/")
    assert my_work.status_code == 200, my_work.data
    assert str(task.pk) not in {row["id"] for row in my_work.data["results"]}


# ---------------------------------------------------------------------------
# The loop that matters: owners → non-zero capacity
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_a_project_assigned_only_through_owners_reports_real_utilization(
    client: APIClient, project: Project, ana: Resource
) -> None:
    """The regression this issue exists to prevent, asserted end to end.

    Assign work the way the designer does — nothing but ``owners`` — and the capacity
    surfaces must report a real number. With ``Task.assignee`` in place of this field
    every figure below is zero, and nothing anywhere says so.
    """
    start = date(2026, 4, 27)
    for i in range(3):
        res = client.post(
            "/api/v1/tasks/",
            {
                "project": str(project.pk),
                "name": f"Row {i}",
                "duration": 5,
                "planned_start": str(start),
                "owners": [{"resource": str(ana.pk), "units": "1.0"}],
            },
            format="json",
        )
        assert res.status_code == 201, res.data
        # CPM dates are what the utilization engine reads; pin them so the assertion is
        # about the assignment axis and not about scheduler timing.
        Task.objects.filter(pk=res.data["id"]).update(
            early_start=start, early_finish=start + timedelta(days=4), wbs_path=f"{i + 1}"
        )

    # The window defaults to the current week, so pin it to where the work actually is.
    heatmap = client.get(
        f"/api/v1/projects/{project.pk}/resources/heatmap/", {"start": str(start), "weeks": 4}
    )
    assert heatmap.status_code == 200, heatmap.data
    rows = [r for r in heatmap.data["resources"] if str(r["id"]) == str(ana.pk)]
    assert rows, "the owner never reached the heat map at all"
    assert any(pct > 0 for pct in rows[0]["util"])

    allocation = client.get(f"/api/v1/projects/{project.pk}/resource-allocation/")
    assert allocation.status_code == 200, allocation.data
    assigned = [r for r in allocation.data["resources"] if r["id"] == str(ana.pk)]
    assert assigned, "the owner has no spans on the allocation timeline"
    assert len(assigned[0]["tasks"]) == 3
