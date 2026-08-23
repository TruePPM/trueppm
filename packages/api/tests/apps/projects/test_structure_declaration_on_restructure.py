"""Declaring a container on the FORWARD restructure paths (#3010, #2950).

``sync_structure_shadow_values`` is not only a shadow-value sync — it is the function
that **declares a row a container**. Group, ungroup, create and delete all called it;
indent, outdent, reparent and reorder did not. So the most common way a user makes a
phase — indent a row under the one above — produced an *underived* container: the row
above kept ``structure_role = work`` while every rollup treated it as a phase, and its
authored ``status`` / ``duration`` were never parked, so the first rollup overwrote them
with no way back.

Nothing caught it because the gap sits between two green suites. Group's tests assert the
declaration, because group declares it. Indent's tests assert the resulting *tree shape*,
which was correct either way.

These tests assert the **declaration**, never the shape.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.board_lanes import ROOT_LANE_ID, build_lanes
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    StructureRole,
    Task,
    cascade_task_children_restore,
)

pytestmark = pytest.mark.django_db


@pytest.fixture
def user() -> Any:
    return get_user_model().objects.create_user(username="restructurer", password="pw")


@pytest.fixture
def calendar() -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 3, 2), calendar=calendar)


@pytest.fixture
def owner_client(user: Any, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _task(project: Project, name: str, path: str, **kwargs: Any) -> Task:
    kwargs.setdefault("duration", 3)
    kwargs.setdefault("status", "NOT_STARTED")
    return Task.objects.create(project=project, name=name, wbs_path=path, **kwargs)


# ── Indent: the flagship path ───────────────────────────────────────────────────


class TestIndentDeclaresTheContainerItCreates:
    def test_indent_promotes_the_previous_sibling(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """The claim the indent copy makes out loud: "that row becomes a phase"."""
        head = _task(project, "Mobilization", "1", duration=7, status="IN_PROGRESS")
        mover = _task(project, "Permits", "2", duration=4)

        r = owner_client.post(f"/api/v1/projects/{project.id}/tasks/{mover.id}/indent/")
        assert r.status_code == 200

        head.refresh_from_db()
        assert head.structure_role == StructureRole.CONTAINER
        assert head.auto_container is True, "promoted by the act, so the reverse is automatic"

    def test_indent_parks_the_authors_status_and_estimate(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """Kept, not cleared. Without the park, the first rollup destroys them."""
        head = _task(project, "Mobilization", "1", duration=7, status="IN_PROGRESS")
        mover = _task(project, "Permits", "2", duration=4)

        owner_client.post(f"/api/v1/projects/{project.id}/tasks/{mover.id}/indent/")

        head.refresh_from_db()
        assert head.own_estimate == 7
        assert head.own_status == "IN_PROGRESS"

    def test_the_promotion_bumps_server_version(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """A declaration invisible to the delta pull leaves the row a task on mobile."""
        head = _task(project, "Mobilization", "1")
        mover = _task(project, "Permits", "2")
        before = Task.objects.get(pk=head.pk).server_version

        owner_client.post(f"/api/v1/projects/{project.id}/tasks/{mover.id}/indent/")

        head.refresh_from_db()
        assert head.server_version > before

    def test_a_row_that_was_already_a_container_is_not_re_parked(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """A second child must not overwrite the parked values with rollup output."""
        head = _task(project, "Mobilization", "1", duration=7)
        first = _task(project, "Permits", "2")
        second = _task(project, "Survey", "3")

        owner_client.post(f"/api/v1/projects/{project.id}/tasks/{first.id}/indent/")
        head.refresh_from_db()
        head.duration = 99  # what a rollup would write
        head.save(update_fields=["duration"])

        owner_client.post(f"/api/v1/projects/{project.id}/tasks/{second.id}/indent/")
        head.refresh_from_db()
        assert head.own_estimate == 7, "the author's value, not the rollup's"


# ── Outdent: the reverse, which only works because the promotion was recorded ────


class TestOutdentReversesAnAccidentalContainer:
    def test_outdenting_the_last_child_restores_work_and_its_values(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """The whole point of recording `auto_container` on the way in."""
        head = _task(project, "Mobilization", "1", duration=7, status="IN_PROGRESS")
        mover = _task(project, "Permits", "2", duration=4)

        owner_client.post(f"/api/v1/projects/{project.id}/tasks/{mover.id}/indent/")
        head.refresh_from_db()
        # Stand in for the rollup, which owns these fields while the row is a phase.
        head.duration = 4
        head.status = "NOT_STARTED"
        head.save(update_fields=["duration", "status"])

        mover.refresh_from_db()
        r = owner_client.post(f"/api/v1/projects/{project.id}/tasks/{mover.id}/outdent/")
        assert r.status_code == 200

        head.refresh_from_db()
        assert head.structure_role == StructureRole.WORK
        assert head.auto_container is False
        assert head.duration == 7, "its own estimate is back"
        assert head.status == "IN_PROGRESS"
        assert head.own_estimate is None
        assert head.own_status is None

    def test_a_DECLARED_container_survives_losing_its_last_child(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """The rule that matters most, now enforced on the outdent path too.

        Reverting somebody's phase because its last task was outdented is the same
        silent identity change `structure_role` exists to remove.
        """
        head = _task(project, "Commissioning", "1", structure_role=StructureRole.CONTAINER)
        child = _task(project, "SIT", "1.1")

        r = owner_client.post(f"/api/v1/projects/{project.id}/tasks/{child.id}/outdent/")
        assert r.status_code == 200

        head.refresh_from_db()
        assert head.structure_role == StructureRole.CONTAINER
        assert head.auto_container is False

    def test_outdent_declares_the_task_that_adopts_its_followers(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """Outdent moves both ways at once — the mover can BECOME a container.

        MS Project convention: the following siblings become the outdented row's
        children, so the row it promotes is the row that moved.
        """
        _task(project, "Phase", "1")
        mover = _task(project, "Design", "1.1", duration=6, status="IN_PROGRESS")
        _task(project, "Build", "1.2")
        _task(project, "Test", "1.3")

        r = owner_client.post(f"/api/v1/projects/{project.id}/tasks/{mover.id}/outdent/")
        assert r.status_code == 200

        mover.refresh_from_db()
        assert mover.structure_role == StructureRole.CONTAINER
        assert mover.auto_container is True
        assert mover.own_estimate == 6
        assert mover.own_status == "IN_PROGRESS"


# ── Reparent: both sides move ───────────────────────────────────────────────────


class TestReparentDeclaresBothSides:
    def test_the_new_parent_is_promoted(self, owner_client: APIClient, project: Project) -> None:
        target = _task(project, "Commissioning", "1", duration=9)
        mover = _task(project, "Punch list", "2")

        r = owner_client.post(
            f"/api/v1/projects/{project.id}/tasks/{mover.id}/reparent/",
            {"new_parent_id": str(target.id)},
            format="json",
        )
        assert r.status_code == 200

        target.refresh_from_db()
        assert target.structure_role == StructureRole.CONTAINER
        assert target.auto_container is True
        assert target.own_estimate == 9

    def test_the_emptied_former_parent_is_demoted(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """A one-sided call would leave an emptied accidental container declared."""
        former = _task(project, "Mobilization", "1", duration=7)
        mover = _task(project, "Permits", "2")
        owner_client.post(f"/api/v1/projects/{project.id}/tasks/{mover.id}/indent/")
        former.refresh_from_db()
        assert former.structure_role == StructureRole.CONTAINER

        target = _task(project, "Closeout", "2", duration=5)
        mover.refresh_from_db()
        r = owner_client.post(
            f"/api/v1/projects/{project.id}/tasks/{mover.id}/reparent/",
            {"new_parent_id": str(target.id)},
            format="json",
        )
        assert r.status_code == 200

        former.refresh_from_db()
        assert former.structure_role == StructureRole.WORK, "it lost its last child"
        assert former.auto_container is False
        assert former.duration == 7
        target.refresh_from_db()
        assert target.structure_role == StructureRole.CONTAINER

    def test_reparent_to_root_demotes_the_former_parent(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """`new_parent_id: null` has no new parent — only the former side moves."""
        former = _task(project, "Mobilization", "1", duration=7)
        mover = _task(project, "Permits", "2")
        owner_client.post(f"/api/v1/projects/{project.id}/tasks/{mover.id}/indent/")

        mover.refresh_from_db()
        r = owner_client.post(
            f"/api/v1/projects/{project.id}/tasks/{mover.id}/reparent/",
            {"new_parent_id": None},
            format="json",
        )
        assert r.status_code == 200

        former.refresh_from_db()
        assert former.structure_role == StructureRole.WORK
        assert former.duration == 7


# ── Reorder: convergence only, and it must not corrupt anything ─────────────────


class TestReorderConverges:
    def test_reorder_repairs_a_parent_whose_declaration_drifted(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """Reorder cannot change a child SET, so this is repair, not promotion.

        A row indented before this fix landed is a container the database never
        declared. The next reorder of its level heals it.
        """
        head = _task(project, "Phase", "1", duration=8)
        a = _task(project, "A", "1.1")
        b = _task(project, "B", "1.2")
        assert head.structure_role == StructureRole.WORK, "the pre-fix state, staged by hand"

        r = owner_client.post(
            f"/api/v1/projects/{project.id}/tasks/reorder/",
            {"parent_path": "1", "ordered_ids": [str(b.id), str(a.id)]},
            format="json",
        )
        assert r.status_code == 200

        head.refresh_from_db()
        assert head.structure_role == StructureRole.CONTAINER
        assert head.own_estimate == 8

    def test_a_root_level_reorder_has_no_parent_to_sync(
        self, owner_client: APIClient, project: Project
    ) -> None:
        a = _task(project, "A", "1")
        b = _task(project, "B", "2")
        r = owner_client.post(
            f"/api/v1/projects/{project.id}/tasks/reorder/",
            {"parent_path": "", "ordered_ids": [str(b.id), str(a.id)]},
            format="json",
        )
        assert r.status_code == 200


# ── The Board invariant the declaration exists to serve ─────────────────────────


class TestBoardRendersAnIndentedPhaseAsALane:
    def test_a_row_promoted_by_indent_is_a_lane_never_a_card(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """Invariant 1 of ADR-0843: a container is never a card.

        Honest scope: ``build_lanes`` derives container-ness from the child count, so
        this passes with or without the declaration — that is exactly *why* the
        declaration is needed. It is pinned here so that when the board is moved onto
        the declared role, an indent-created phase is already covered.
        """
        head = _task(project, "Mobilization", "1")
        mover = _task(project, "Permits", "2")
        owner_client.post(f"/api/v1/projects/{project.id}/tasks/{mover.id}/indent/")

        head.refresh_from_db()
        assert head.structure_role == StructureRole.CONTAINER

        tasks = list(Task.objects.filter(project=project, is_deleted=False))
        lanes, _crumbs = build_lanes(tasks, project_name=project.name)

        head_lane = next((lane for lane in lanes if lane.id == str(head.id)), None)
        assert head_lane is not None, "the promoted row is a lane"
        assert str(mover.id) in head_lane.task_ids
        # And it is nowhere a card: no lane, including the project node, carries it.
        assert not any(str(head.id) in lane.task_ids for lane in lanes)
        assert all(str(head.id) not in lane.task_ids for lane in lanes if lane.id == ROOT_LANE_ID)


# ── Undo: the resync ran but was never written ─────────────────────────────────


class TestUndoPersistsItsResync:
    def test_undoing_an_indent_writes_the_demotion(
        self, owner_client: APIClient, project: Project
    ) -> None:
        """`_resync_shadow_values` synced in memory and discarded it (#3010).

        Undo's own tests assert the restored tree shape, and the shape was always
        right — the declaration was the part that never reached the database.
        """
        head = _task(project, "Mobilization", "1", duration=7)
        mover = _task(project, "Permits", "2")

        r = owner_client.post(f"/api/v1/projects/{project.id}/tasks/{mover.id}/indent/")
        operation_id = r.data["operation_id"]
        head.refresh_from_db()
        assert head.structure_role == StructureRole.CONTAINER

        undo = owner_client.post(f"/api/v1/structural-operations/{operation_id}/undo/")
        assert undo.status_code == 200, undo.data

        head.refresh_from_db()
        assert head.structure_role == StructureRole.WORK, "undone in the DB, not just in memory"
        assert head.auto_container is False
        assert head.duration == 7


# ── The unscoped cascade filed with this issue ─────────────────────────────────


class TestCascadeRestoreIsProjectScoped:
    def test_a_restore_does_not_reach_into_another_project(self, calendar: Calendar) -> None:
        """Every project numbers from "1", so an unscoped prefix matches all of them.

        Reachable with two ordinary projects and no unusual data — the failure needs
        only that both have a row at wbs_path "1" with a tombstoned subtask under it.
        """
        mine = Project.objects.create(name="Mine", start_date=date(2026, 3, 2), calendar=calendar)
        theirs = Project.objects.create(
            name="Theirs", start_date=date(2026, 3, 2), calendar=calendar
        )

        my_parent = _task(mine, "Parent", "1")
        my_subtask = _task(mine, "Check", "1.1", is_subtask=True)
        their_parent = _task(theirs, "Parent", "1")
        their_subtask = _task(theirs, "Their check", "1.1", is_subtask=True)

        my_parent.soft_delete()
        their_subtask.soft_delete()
        assert Task.objects.get(pk=their_subtask.pk).is_deleted is True

        my_parent.refresh_from_db()
        my_parent.is_deleted = False
        my_parent.save(update_fields=["is_deleted"])
        cascade_task_children_restore(my_parent)

        assert Task.objects.get(pk=my_subtask.pk).is_deleted is False, "mine comes back"
        assert Task.objects.get(pk=their_subtask.pk).is_deleted is True, (
            "another project's tombstone is not mine to lift"
        )
        assert their_parent.project_id != mine.pk

    def test_it_does_not_restore_another_projects_dependency_edges(
        self, calendar: Calendar
    ) -> None:
        mine = Project.objects.create(name="Mine", start_date=date(2026, 3, 2), calendar=calendar)
        theirs = Project.objects.create(
            name="Theirs", start_date=date(2026, 3, 2), calendar=calendar
        )

        my_parent = _task(mine, "Parent", "1")
        their_a = _task(theirs, "A", "1.1")
        their_b = _task(theirs, "B", "1.2")
        edge = Dependency.objects.create(predecessor=their_a, successor=their_b)
        edge.soft_delete()

        cascade_task_children_restore(my_parent)

        edge.refresh_from_db()
        assert edge.is_deleted is True


# ── RBAC on the endpoints this change writes through ───────────────────────────


@pytest.mark.parametrize(
    ("role", "expected"),
    [
        (Role.VIEWER, 403),
        (Role.MEMBER, 403),
        (Role.SCHEDULER, 403),
        (Role.ADMIN, 200),
        (Role.OWNER, 200),
    ],
)
def test_indent_authority_is_unchanged_by_the_declaration(
    project: Project, role: int, expected: int
) -> None:
    """The promotion is a side effect of a gated act — it must not widen the gate.

    MEMBER is refused because the mover is not theirs (ADR-0133); SCHEDULER is the
    resource-management band, excluded from task content outright.
    """
    actor = get_user_model().objects.create_user(username=f"u{int(role)}", password="pw")
    ProjectMembership.objects.create(project=project, user=actor, role=role)
    client = APIClient()
    client.force_authenticate(user=actor)

    head = _task(project, "Mobilization", "1")
    mover = _task(project, "Permits", "2")

    r = client.post(f"/api/v1/projects/{project.id}/tasks/{mover.id}/indent/")
    assert r.status_code == expected

    head.refresh_from_db()
    if expected == 200:
        assert head.structure_role == StructureRole.CONTAINER
    else:
        assert head.structure_role == StructureRole.WORK, "a refusal declares nothing"


def test_an_unauthenticated_caller_cannot_indent(project: Project) -> None:
    _task(project, "Mobilization", "1")
    mover = _task(project, "Permits", "2")
    r = APIClient().post(f"/api/v1/projects/{project.id}/tasks/{mover.id}/indent/")
    assert r.status_code in (401, 403)
