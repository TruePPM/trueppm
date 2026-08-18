"""Declared identity, and the shadow values that make the transition reversible (#2950).

The defect: container-ness is derived from a live child-count probe, so a row's
identity is retroactive and silent, and its own status and estimate stop belonging
to their author the moment somebody else drops work underneath.

These tests pin the three things that must stay true:

1. The declaration governs rendering only — never the math.
2. The server refuses a declaration the tree already contradicts, with 409.
3. Gaining and losing children parks and restores the author's values, and a
   DECLARED container is never silently un-declared.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    StructureRole,
    Task,
    structural_parent,
    sync_structure_shadow_values,
)


@pytest.fixture
def user(db: object) -> object:
    User = get_user_model()
    return User.objects.create_user(username="roleuser", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 3, 2), calendar=calendar)


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.mark.django_db
class TestDeclaredRole:
    def test_defaults_to_work(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Every existing row reads as work — no data migration, no backfill."""
        task = Task.objects.create(project=project, name="Pour", duration=5, wbs_path="1")
        r = client.get(f"/api/v1/tasks/{task.id}/", {"project": str(project.id)})
        assert r.status_code == 200
        assert r.data["structure_role"] == StructureRole.WORK

    def test_declaring_a_container_with_no_children_is_legal(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Empty, not zero. A declared phase with no work is a legal state."""
        task = Task.objects.create(project=project, name="Commissioning", duration=1, wbs_path="1")
        r = client.patch(
            f"/api/v1/tasks/{task.id}/",
            {"structure_role": "container", "project": str(project.id)},
            format="json",
        )
        assert r.status_code == 200
        assert r.data["structure_role"] == "container"
        # The derived fact is still honest: it has no children, so it is not a phase.
        assert r.data["is_phase"] is False


@pytest.mark.django_db
class TestContradictedDeclaration:
    def test_declaring_work_on_a_row_with_children_is_a_409(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """409, not 400 — the payload is fine, the tree is what forbids it.

        Storing it would leave the row rendering as a task while every rollup
        treats it as a phase, which is the exact lane-versus-card split ADR-0843
        exists to end.
        """
        parent = Task.objects.create(project=project, name="Mobilization", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="Permits", duration=4, wbs_path="1.1")

        r = client.patch(
            f"/api/v1/tasks/{parent.id}/",
            {"structure_role": "work", "project": str(project.id)},
            format="json",
        )
        assert r.status_code == 409
        # The derived fact travels in the body so the caller can act without a
        # second round trip.
        assert r.data["structure_role"] == StructureRole.CONTAINER
        assert r.data["code"] == "structure_role_contradicted"
        assert "has work under it" in str(r.data["detail"])
        # No boolean in the body: DRF wraps exception-detail values in
        # ErrorDetail (a str subclass), so `is_phase: True` would reach an
        # integrator as the string "True". `structure_role` carries the fact.
        assert "is_phase" not in r.data

    def test_the_refusal_does_not_write(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        parent = Task.objects.create(
            project=project,
            name="Mobilization",
            duration=1,
            wbs_path="1",
            structure_role=StructureRole.CONTAINER,
        )
        Task.objects.create(project=project, name="Permits", duration=4, wbs_path="1.1")
        client.patch(
            f"/api/v1/tasks/{parent.id}/",
            {"structure_role": "work", "project": str(project.id)},
            format="json",
        )
        parent.refresh_from_db()
        assert parent.structure_role == StructureRole.CONTAINER

    def test_declaring_container_on_a_row_with_children_is_fine(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Only the contradiction is refused — agreeing with the tree is not."""
        parent = Task.objects.create(project=project, name="Mobilization", duration=1, wbs_path="1")
        Task.objects.create(project=project, name="Permits", duration=4, wbs_path="1.1")
        r = client.patch(
            f"/api/v1/tasks/{parent.id}/",
            {"structure_role": "container", "project": str(project.id)},
            format="json",
        )
        assert r.status_code == 200


@pytest.mark.django_db
class TestStructuralParent:
    def test_resolves_through_the_wbs_path(self, project: Project) -> None:
        """Parenthood is the ltree path — there is no parent_id column."""
        p = Task.objects.create(project=project, name="Phase", duration=1, wbs_path="2")
        child = Task.objects.create(project=project, name="Work", duration=3, wbs_path="2.3")
        assert structural_parent(child) == p

    def test_a_root_row_has_no_structural_parent(self, project: Project) -> None:
        root = Task.objects.create(project=project, name="Solo", duration=1, wbs_path="1")
        assert structural_parent(root) is None


@pytest.mark.django_db
class TestShadowValues:
    def test_gaining_a_first_child_parks_the_authors_values(self, project: Project) -> None:
        """Kept, not cleared — the difference between a transition and a data loss."""
        parent = Task.objects.create(
            project=project, name="Mobilization", duration=7, wbs_path="1", status="IN_PROGRESS"
        )
        Task.objects.create(project=project, name="Permits", duration=4, wbs_path="1.1")

        assert sync_structure_shadow_values(parent) is True
        assert parent.own_estimate == 7
        assert parent.own_status == "IN_PROGRESS"
        # It became a container by accident, which is what makes the reverse safe.
        assert parent.structure_role == StructureRole.CONTAINER
        assert parent.auto_container is True

    def test_losing_the_last_child_restores_an_accidental_container(self, project: Project) -> None:
        parent = Task.objects.create(
            project=project, name="Cable trays", duration=5, wbs_path="1", status="NOT_STARTED"
        )
        child = Task.objects.create(project=project, name="Pull", duration=2, wbs_path="1.1")
        sync_structure_shadow_values(parent)
        parent.save()

        child.delete()
        parent.refresh_from_db()
        assert sync_structure_shadow_values(parent) is True
        assert parent.structure_role == StructureRole.WORK
        assert parent.duration == 5, "its own estimate is back"
        assert parent.own_estimate is None
        assert parent.auto_container is False

    def test_a_DECLARED_container_is_never_silently_un_declared(self, project: Project) -> None:
        """The rule that matters most.

        Reverting somebody's phase because its last task was deleted is the same
        silent identity change this whole field exists to remove. A declared
        container stays declared and becomes an empty lane; reverting is offered
        to the user, never applied here.
        """
        parent = Task.objects.create(
            project=project,
            name="Commissioning",
            duration=1,
            wbs_path="1",
            structure_role=StructureRole.CONTAINER,
        )
        child = Task.objects.create(project=project, name="SIT", duration=3, wbs_path="1.1")
        sync_structure_shadow_values(parent)
        parent.save()
        assert parent.auto_container is False, "it was declared, not promoted"

        child.delete()
        parent.refresh_from_db()
        assert sync_structure_shadow_values(parent) is False
        assert parent.structure_role == StructureRole.CONTAINER

    def test_parking_is_idempotent(self, project: Project) -> None:
        """A second child must not overwrite the parked values with rollup output."""
        parent = Task.objects.create(
            project=project, name="Phase", duration=9, wbs_path="1", status="NOT_STARTED"
        )
        Task.objects.create(project=project, name="A", duration=2, wbs_path="1.1")
        sync_structure_shadow_values(parent)
        parent.save()

        Task.objects.create(project=project, name="B", duration=3, wbs_path="1.2")
        parent.refresh_from_db()
        assert sync_structure_shadow_values(parent) is False
        assert parent.own_estimate == 9

    def test_a_subtask_never_triggers_the_transition(self, project: Project) -> None:
        """A checklist item is not structure, so it must not promote its task."""
        parent = Task.objects.create(project=project, name="Leaf", duration=4, wbs_path="1")
        Task.objects.create(
            project=project, name="Check A", duration=0, wbs_path="1.1", is_subtask=True
        )
        parent.refresh_from_db()
        assert sync_structure_shadow_values(parent) is False
        assert parent.structure_role == StructureRole.WORK
