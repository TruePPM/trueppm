"""Deactivating a resource removes it from every downstream surface (#3572).

``DELETE /api/v1/resources/{id}/`` soft-deletes the catalog row. Before this
issue nothing downstream read that flag — ``grep -rn "resource__is_deleted"``
matched only the ``restore`` action — so a deactivated person kept a full row on
every project roster, kept drawing load on the heat map, kept being counted in
``resources/summary`` headcount, and kept contributing *capacity* to the team
utilization denominator, which understates team load at exactly the moment an
off-boarding makes the remaining team busier.

The ruling (option (b)) is: assignment rows stay intact for audit, the roster
rows cascade, and every capacity read filters the deactivated resource out
through ``ResourceScopedManager.active()``. ``restore`` reverses both halves.

Each test below names the surface it pins. Every one of them fails on the
unfixed code — the point of the issue is that none of these surfaces had any
assertion at all.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Program, Project, Task
from trueppm_api.apps.projects.utilization import compute_team_utilization
from trueppm_api.apps.resources.models import (
    ProjectResource,
    Resource,
    ResourceSkill,
    Skill,
    TaskResource,
)
from trueppm_api.apps.resources.services import rostered_resource_ids

User = get_user_model()

# The measured window: a Monday-anchored fortnight, so working-day counts are
# stable and the utilization arithmetic below is exact rather than approximate.
WINDOW_START = date(2026, 4, 27)  # a Monday
WINDOW_END = date(2026, 5, 8)  # the Friday of the following week


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def cal(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard", working_days=31, hours_per_day=8.0)


@pytest.fixture
def program(db: object) -> Program:
    return Program.objects.create(name="GA Launch", code="GALA")


@pytest.fixture
def project(cal: Calendar, program: Program) -> Project:
    return Project.objects.create(
        name="Alpha", start_date=WINDOW_START, calendar=cal, program=program
    )


@pytest.fixture
def admin(project: Project, program: Program) -> Any:
    """One user who is org admin, project Scheduler+, and program Scheduler+.

    OWNER on the project satisfies ``IsOrgAdmin`` (derived from membership, no
    separate org-admin entity in OSS) as well as every project-scoped gate the
    capacity endpoints apply; the program membership covers resource-contention.
    """
    user = User.objects.create_user(username="pm_3572", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    ProgramMembership.objects.create(program=program, user=user, role=Role.OWNER)
    return user


@pytest.fixture
def client(admin: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=admin)
    return c


@pytest.fixture
def alice(db: object) -> Resource:
    """The resource that gets deactivated."""
    return Resource.objects.create(
        name="Alice Leaver", email="alice@trueppm.demo", max_units=Decimal("1.00")
    )


@pytest.fixture
def bob(db: object) -> Resource:
    """The resource that stays — every assertion needs a control that survives."""
    return Resource.objects.create(
        name="Bob Stayer", email="bob@trueppm.demo", max_units=Decimal("1.00")
    )


def _task(project: Project, name: str, wbs: str) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        duration=10,
        early_start=WINDOW_START,
        early_finish=WINDOW_END,
        status="NOT_STARTED",
        wbs_path=wbs,
    )


@pytest.fixture
def staffed(project: Project, alice: Resource, bob: Resource) -> dict[str, Any]:
    """Both resources rostered and assigned across the whole measured window.

    Alice at 0.5 units, Bob at 1.0, so the team utilization ratio moves in a way
    that distinguishes "her load left the numerator" from "her capacity left the
    denominator" — both have to happen, and only one of them is obvious.
    """
    ProjectResource.objects.create(project=project, resource=alice)
    ProjectResource.objects.create(project=project, resource=bob)
    task_a = _task(project, "Migrate", "1")
    task_b = _task(project, "Harden", "2")
    TaskResource.objects.create(task=task_a, resource=alice, units=Decimal("0.50"))
    TaskResource.objects.create(task=task_b, resource=bob, units=Decimal("1.00"))
    return {"task_a": task_a, "task_b": task_b}


def _deactivate(client: APIClient, resource: Resource) -> None:
    resp = client.delete(f"/api/v1/resources/{resource.pk}/")
    assert resp.status_code == 204, resp.content


def _restore(client: APIClient, resource: Resource) -> None:
    resp = client.post(f"/api/v1/resources/{resource.pk}/restore/")
    assert resp.status_code == 200, resp.content


def _this_monday() -> date:
    today = date.today()
    return today - timedelta(days=today.weekday())


def _sibling_project(cal: Calendar, program: Program, admin: Any, name: str) -> Project:
    """A second project the admin can read, anchored on the current week.

    The heat map and ``resources/summary`` measure an 8-week window from *this*
    Monday, so their fixtures cannot use the fixed measured window above.
    """
    project = Project.objects.create(
        name=name, start_date=_this_monday(), calendar=cal, program=program
    )
    ProjectMembership.objects.create(project=project, user=admin, role=Role.OWNER)
    return project


def _window_params() -> dict[str, str]:
    return {"start": WINDOW_START.isoformat(), "end": WINDOW_END.isoformat()}


# ---------------------------------------------------------------------------
# Surface 1 — the project roster
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRoster:
    def _roster_ids(self, client: APIClient, project: Project) -> set[str]:
        resp = client.get("/api/v1/project-resources/", {"project": str(project.pk)})
        assert resp.status_code == 200, resp.content
        return {row["resource"] for row in resp.json()["results"]}

    def test_deactivated_resource_leaves_every_roster(
        self,
        client: APIClient,
        project: Project,
        alice: Resource,
        bob: Resource,
        staffed: dict[str, Any],
    ) -> None:
        assert self._roster_ids(client, project) == {str(alice.pk), str(bob.pk)}
        _deactivate(client, alice)
        assert self._roster_ids(client, project) == {str(bob.pk)}

    def test_restore_puts_the_roster_row_back(
        self,
        client: APIClient,
        project: Project,
        alice: Resource,
        bob: Resource,
        staffed: dict[str, Any],
    ) -> None:
        _deactivate(client, alice)
        # Assert the removal first: without it the round-trip passes vacuously on
        # the unfixed code, where the roster row was never taken away at all.
        assert self._roster_ids(client, project) == {str(bob.pk)}
        _restore(client, alice)
        assert self._roster_ids(client, project) == {str(alice.pk), str(bob.pk)}

    def test_cascade_stamps_the_discriminator(
        self, client: APIClient, project: Project, alice: Resource, staffed: dict[str, Any]
    ) -> None:
        _deactivate(client, alice)
        row = ProjectResource.objects.get(project=project, resource=alice)
        assert row.is_deleted is True
        assert row.deactivated_with_resource is True

    def test_restore_does_not_resurrect_a_hand_removed_membership(
        self, client: APIClient, cal: Calendar, program: Program, alice: Resource
    ) -> None:
        """The whole reason the discriminator exists.

        A pure guard — it passes on the unfixed code too, because unfixed code
        resurrects nothing. It exists to pin the direction the cascade must NOT go.

        A membership someone ended before the deactivation must stay ended:
        reactivating an employee is not a licence to re-add them to a project a
        PM had deliberately taken them off.
        """
        other = Project.objects.create(
            name="Beta", start_date=WINDOW_START, calendar=cal, program=program
        )
        hand_removed = ProjectResource.objects.create(
            project=other, resource=alice, is_deleted=True
        )
        _deactivate(client, alice)
        _restore(client, alice)

        hand_removed.refresh_from_db()
        assert hand_removed.is_deleted is True
        assert hand_removed.deactivated_with_resource is False

    def test_owner_resolution_stops_binding_a_deactivated_person(
        self, client: APIClient, project: Project, alice: Resource, staffed: dict[str, Any]
    ) -> None:
        """``rostered_resource_ids`` is the index every ``@mention`` resolves against.

        If it still returned a deactivated person, an inline authoring surface
        would re-create the membership the deactivation just removed.
        """
        assert str(alice.pk) in rostered_resource_ids(project)
        _deactivate(client, alice)
        assert str(alice.pk) not in rostered_resource_ids(project)


# ---------------------------------------------------------------------------
# Surface 2 — the daily engine, the heat map, and the digest that reads them
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestUtilizationEngine:
    def _utilization_ids(self, client: APIClient, project: Project) -> set[str]:
        resp = client.get(f"/api/v1/projects/{project.pk}/utilization/", _window_params())
        assert resp.status_code == 200, resp.content
        return {row["resource_id"] for row in resp.json()["resources"]}

    def _heatmap_ids(self, client: APIClient, project: Project) -> set[str]:
        resp = client.get(f"/api/v1/projects/{project.pk}/resources/heatmap/")
        assert resp.status_code == 200, resp.content
        return {row["id"] for row in resp.json()["resources"]}

    def test_daily_utilization_drops_the_deactivated_resource(
        self,
        client: APIClient,
        project: Project,
        alice: Resource,
        bob: Resource,
        staffed: dict[str, Any],
    ) -> None:
        assert self._utilization_ids(client, project) == {str(alice.pk), str(bob.pk)}
        _deactivate(client, alice)
        assert self._utilization_ids(client, project) == {str(bob.pk)}

    def test_weekly_heatmap_drops_the_deactivated_resource(
        self,
        client: APIClient,
        cal: Calendar,
        program: Program,
        admin: Any,
        alice: Resource,
        bob: Resource,
    ) -> None:
        monday = _this_monday()
        project = _sibling_project(cal, program, admin, "Heat")
        for resource in (alice, bob):
            ProjectResource.objects.create(project=project, resource=resource)
            task = Task.objects.create(
                project=project,
                name=f"Work {resource.name}",
                duration=5,
                early_start=monday,
                early_finish=monday + timedelta(days=4),
                status="NOT_STARTED",
            )
            TaskResource.objects.create(task=task, resource=resource, units=Decimal("1.00"))

        assert self._heatmap_ids(client, project) == {str(alice.pk), str(bob.pk)}
        _deactivate(client, alice)
        assert self._heatmap_ids(client, project) == {str(bob.pk)}

    def test_restore_brings_the_load_back(
        self,
        client: APIClient,
        project: Project,
        alice: Resource,
        bob: Resource,
        staffed: dict[str, Any],
    ) -> None:
        _deactivate(client, alice)
        assert self._utilization_ids(client, project) == {str(bob.pk)}
        _restore(client, alice)
        assert self._utilization_ids(client, project) == {str(alice.pk), str(bob.pk)}

    def test_retained_assignment_row_is_not_deleted(
        self, client: APIClient, alice: Resource, staffed: dict[str, Any]
    ) -> None:
        """Option (b): the audit trail survives. The read filters; the row stays.

        A pure guard, like the hand-removal test above: it passes on the unfixed
        code as well. It pins that we did not implement option (a) — cascading the
        delete into the assignment rows — which would destroy assignment history at
        the one moment the record matters most.
        """
        _deactivate(client, alice)
        assert TaskResource.objects.filter(resource=alice).count() == 1


# ---------------------------------------------------------------------------
# Surface 3 — resources/summary headcount
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSummaryHeadcount:
    def _headcount(self, client: APIClient, project: Project) -> int:
        resp = client.get(f"/api/v1/projects/{project.pk}/resources/summary/")
        assert resp.status_code == 200, resp.content
        return int(resp.json()["headcount"])

    def test_headcount_drops_by_one(
        self,
        client: APIClient,
        cal: Calendar,
        program: Program,
        admin: Any,
        alice: Resource,
        bob: Resource,
    ) -> None:
        monday = _this_monday()
        project = _sibling_project(cal, program, admin, "Count")
        # resources/summary 409s without CPM dates, so give it one dated task.
        task = Task.objects.create(
            project=project,
            name="Anything",
            duration=5,
            early_start=monday,
            early_finish=monday + timedelta(days=4),
            status="NOT_STARTED",
        )
        TaskResource.objects.create(task=task, resource=bob, units=Decimal("1.00"))
        for resource in (alice, bob):
            ProjectResource.objects.create(project=project, resource=resource)

        assert self._headcount(client, project) == 2
        _deactivate(client, alice)
        assert self._headcount(client, project) == 1
        _restore(client, alice)
        assert self._headcount(client, project) == 2


# ---------------------------------------------------------------------------
# Surface 4 — the team-utilization denominator
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTeamUtilizationDenominator:
    def test_off_boarding_raises_the_ratio_instead_of_leaving_it_flat(
        self,
        client: APIClient,
        project: Project,
        alice: Resource,
        bob: Resource,
        staffed: dict[str, Any],
    ) -> None:
        """The bug the Overview card showed: capacity that nobody can supply.

        Alice at 0.5 units and Bob at 1.0, both across the whole window, is
        1.5 units of load against 2.0 units of capacity — 75%. Deactivating
        Alice must remove *both* her load and her capacity, leaving Bob alone
        at 100%. Leaving her capacity behind reports 50% and tells the PM the
        team got less busy by losing someone.
        """
        before = compute_team_utilization(project, WINDOW_START, WINDOW_END)
        assert before["pct"] == pytest.approx(75.0)

        _deactivate(client, alice)
        after = compute_team_utilization(project, WINDOW_START, WINDOW_END)
        assert after["pct"] == pytest.approx(100.0)

        _restore(client, alice)
        restored = compute_team_utilization(project, WINDOW_START, WINDOW_END)
        assert restored["pct"] == pytest.approx(75.0)

    def test_idle_roster_member_stops_diluting_the_denominator(
        self, client: APIClient, project: Project, alice: Resource, bob: Resource
    ) -> None:
        """A roster member with no assignments is pure capacity — the hardest case.

        She never appears in the engine rows, so the *only* thing that removes
        her is the roster read. This is also the person an off-boarding is most
        likely to leave behind.
        """
        ProjectResource.objects.create(project=project, resource=alice)
        ProjectResource.objects.create(project=project, resource=bob)
        task = _task(project, "Harden", "1")
        TaskResource.objects.create(task=task, resource=bob, units=Decimal("1.00"))

        assert compute_team_utilization(project, WINDOW_START, WINDOW_END)["pct"] == pytest.approx(
            50.0
        )
        _deactivate(client, alice)
        assert compute_team_utilization(project, WINDOW_START, WINDOW_END)["pct"] == pytest.approx(
            100.0
        )


# ---------------------------------------------------------------------------
# Surface 5 — resource-allocation and resource-contention
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestAllocationAndContention:
    def _allocation_ids(self, client: APIClient, project: Project) -> set[str]:
        resp = client.get(f"/api/v1/projects/{project.pk}/resource-allocation/", _window_params())
        assert resp.status_code == 200, resp.content
        return {row["id"] for row in resp.json()["resources"]}

    def _contention_ids(self, client: APIClient, program: Program) -> set[str]:
        resp = client.get(f"/api/v1/programs/{program.pk}/resource-contention/", _window_params())
        assert resp.status_code == 200, resp.content
        return {row["id"] for row in resp.json()["resources"]}

    def test_allocation_timeline_drops_the_deactivated_resource(
        self,
        client: APIClient,
        project: Project,
        alice: Resource,
        bob: Resource,
        staffed: dict[str, Any],
    ) -> None:
        assert self._allocation_ids(client, project) == {str(alice.pk), str(bob.pk)}
        _deactivate(client, alice)
        assert self._allocation_ids(client, project) == {str(bob.pk)}
        _restore(client, alice)
        assert self._allocation_ids(client, project) == {str(alice.pk), str(bob.pk)}

    def test_program_contention_drops_the_deactivated_resource(
        self,
        client: APIClient,
        program: Program,
        alice: Resource,
        bob: Resource,
        staffed: dict[str, Any],
    ) -> None:
        assert self._contention_ids(client, program) == {str(alice.pk), str(bob.pk)}
        _deactivate(client, alice)
        assert self._contention_ids(client, program) == {str(bob.pk)}
        _restore(client, alice)
        assert self._contention_ids(client, program) == {str(alice.pk), str(bob.pk)}


# ---------------------------------------------------------------------------
# Surface 6 — the resource-skills list
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestResourceSkills:
    @pytest.fixture
    def tagged(self, alice: Resource, bob: Resource) -> None:
        skill = Skill.objects.create(name="Rust", normalized_name="rust")
        ResourceSkill.objects.create(resource=alice, skill=skill)
        ResourceSkill.objects.create(resource=bob, skill=skill)

    def _skill_resource_ids(self, client: APIClient) -> set[str]:
        resp = client.get("/api/v1/resource-skills/")
        assert resp.status_code == 200, resp.content
        return {row["resource"] for row in resp.json()["results"]}

    def test_tags_of_a_deactivated_resource_are_not_listed(
        self, client: APIClient, alice: Resource, bob: Resource, tagged: None
    ) -> None:
        """The catalog row is admin-only once deactivated; its tags leaked to everyone."""
        assert self._skill_resource_ids(client) == {str(alice.pk), str(bob.pk)}
        _deactivate(client, alice)
        assert self._skill_resource_ids(client) == {str(bob.pk)}

    def test_a_plain_member_cannot_see_them_either(
        self, client: APIClient, project: Project, alice: Resource, bob: Resource, tagged: None
    ) -> None:
        """The leak that mattered: the row is admin-gated, the tag list was not."""
        _deactivate(client, alice)
        member = User.objects.create_user(username="member_3572", password="pw")
        ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
        member_client = APIClient()
        member_client.force_authenticate(user=member)
        assert self._skill_resource_ids(member_client) == {str(bob.pk)}

    def test_restore_relists_them(
        self, client: APIClient, alice: Resource, bob: Resource, tagged: None
    ) -> None:
        _deactivate(client, alice)
        assert self._skill_resource_ids(client) == {str(bob.pk)}
        _restore(client, alice)
        assert self._skill_resource_ids(client) == {str(alice.pk), str(bob.pk)}
