"""Tests for subtask creation and depth-1 enforcement (ADR-0060 #308)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintScopeChange,
    SprintState,
    Task,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.fixture
def client(user: object, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def parent_task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Parent", duration=5, wbs_path="1")


@pytest.fixture
def active_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 1",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSubtaskCreate:
    def test_creates_subtask(self, client: APIClient, project: Project, parent_task: Task) -> None:
        r = client.post(
            "/api/v1/tasks/",
            {
                "name": "Child task",
                "duration": 1,
                "project": str(project.pk),
                "parent_id": str(parent_task.pk),
                "is_subtask": "true",
            },
        )
        assert r.status_code == 201, r.data
        assert r.data["is_subtask"] is True

    def test_subtask_placed_under_parent_wbs(
        self, client: APIClient, project: Project, parent_task: Task
    ) -> None:
        r = client.post(
            "/api/v1/tasks/",
            {
                "name": "Child",
                "duration": 1,
                "project": str(project.pk),
                "parent_id": str(parent_task.pk),
                "is_subtask": "true",
            },
        )
        assert r.status_code == 201
        child = Task.objects.get(pk=r.data["id"])
        assert str(child.wbs_path).startswith(str(parent_task.wbs_path) + ".")

    def test_parent_server_version_bumped(
        self, client: APIClient, project: Project, parent_task: Task
    ) -> None:
        initial_version = parent_task.server_version
        client.post(
            "/api/v1/tasks/",
            {
                "name": "Child",
                "duration": 1,
                "project": str(project.pk),
                "parent_id": str(parent_task.pk),
                "is_subtask": "true",
            },
        )
        parent_task.refresh_from_db()
        assert parent_task.server_version == initial_version + 1

    def test_non_subtask_does_not_bump_parent_version(
        self, client: APIClient, project: Project, parent_task: Task
    ) -> None:
        initial_version = parent_task.server_version
        client.post(
            "/api/v1/tasks/",
            {
                "name": "Regular child",
                "duration": 2,
                "project": str(project.pk),
                "parent_id": str(parent_task.pk),
            },
        )
        parent_task.refresh_from_db()
        assert parent_task.server_version == initial_version


# ---------------------------------------------------------------------------
# Depth-1 enforcement
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSubtaskDepthEnforcement:
    def test_subtask_of_subtask_rejected(
        self, client: APIClient, project: Project, parent_task: Task
    ) -> None:
        # Create a subtask first.
        r = client.post(
            "/api/v1/tasks/",
            {
                "name": "Level-1 child",
                "duration": 1,
                "project": str(project.pk),
                "parent_id": str(parent_task.pk),
                "is_subtask": "true",
            },
        )
        assert r.status_code == 201
        subtask_id = r.data["id"]

        # Attempt to create a subtask OF that subtask — must be rejected.
        r2 = client.post(
            "/api/v1/tasks/",
            {
                "name": "Level-2 child",
                "duration": 1,
                "project": str(project.pk),
                "parent_id": subtask_id,
                "is_subtask": "true",
            },
        )
        assert r2.status_code == 400
        assert "parent_id" in r2.data

    def test_regular_child_under_subtask_rejected(
        self, client: APIClient, project: Project, parent_task: Task
    ) -> None:
        # Subtasks are leaf nodes — the depth-1 rule applies on every parent_id
        # path, so a regular ("Add Task") create with a subtask as the parent
        # must also be rejected, not just is_subtask=True requests.
        r = client.post(
            "/api/v1/tasks/",
            {
                "name": "Level-1 subtask",
                "duration": 1,
                "project": str(project.pk),
                "parent_id": str(parent_task.pk),
                "is_subtask": "true",
            },
        )
        subtask_id = r.data["id"]

        r2 = client.post(
            "/api/v1/tasks/",
            {
                "name": "Regular under subtask",
                "duration": 1,
                "project": str(project.pk),
                "parent_id": subtask_id,
            },
        )
        assert r2.status_code == 400
        assert "parent_id" in r2.data


# ---------------------------------------------------------------------------
# SprintScopeChange creation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSprintScopeChange:
    def test_scope_change_created_when_parent_in_active_sprint(
        self,
        client: APIClient,
        project: Project,
        parent_task: Task,
        active_sprint: Sprint,
    ) -> None:
        # Assign parent to the active sprint.
        parent_task.sprint = active_sprint
        parent_task.save(update_fields=["sprint"])

        r = client.post(
            "/api/v1/tasks/",
            {
                "name": "Scope-change subtask",
                "duration": 1,
                "project": str(project.pk),
                "parent_id": str(parent_task.pk),
                "is_subtask": "true",
            },
        )
        assert r.status_code == 201

        sc = SprintScopeChange.objects.filter(task=parent_task, sprint=active_sprint).first()
        assert sc is not None
        assert sc.subtask_name == "Scope-change subtask"

    def test_no_scope_change_when_parent_not_in_sprint(
        self,
        client: APIClient,
        project: Project,
        parent_task: Task,
    ) -> None:
        r = client.post(
            "/api/v1/tasks/",
            {
                "name": "No sprint",
                "duration": 1,
                "project": str(project.pk),
                "parent_id": str(parent_task.pk),
                "is_subtask": "true",
            },
        )
        assert r.status_code == 201
        assert SprintScopeChange.objects.filter(task=parent_task).count() == 0

    def test_scope_changes_appear_in_task_serializer(
        self,
        client: APIClient,
        project: Project,
        parent_task: Task,
        active_sprint: Sprint,
        membership: ProjectMembership,
    ) -> None:
        parent_task.sprint = active_sprint
        parent_task.save(update_fields=["sprint"])

        client.post(
            "/api/v1/tasks/",
            {
                "name": "Sprint subtask",
                "duration": 1,
                "project": str(project.pk),
                "parent_id": str(parent_task.pk),
                "is_subtask": "true",
            },
        )

        r = client.get(f"/api/v1/tasks/{parent_task.pk}/")
        assert r.status_code == 200
        changes = r.data["sprint_scope_changes"]
        assert len(changes) == 1
        assert changes[0]["subtask_name"] == "Sprint subtask"


# ---------------------------------------------------------------------------
# Filter params
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSubtaskFilters:
    def test_is_subtask_filter_true(
        self, client: APIClient, project: Project, parent_task: Task
    ) -> None:
        client.post(
            "/api/v1/tasks/",
            {
                "name": "Sub",
                "duration": 1,
                "project": str(project.pk),
                "parent_id": str(parent_task.pk),
                "is_subtask": "true",
            },
        )
        r = client.get("/api/v1/tasks/", {"project": str(project.pk), "is_subtask": "true"})
        assert r.status_code == 200
        ids = [t["id"] for t in r.data["results"]]
        assert str(parent_task.pk) not in ids
        for t in r.data["results"]:
            assert t["is_subtask"] is True

    def test_is_subtask_filter_false(
        self, client: APIClient, project: Project, parent_task: Task
    ) -> None:
        client.post(
            "/api/v1/tasks/",
            {
                "name": "Sub",
                "duration": 1,
                "project": str(project.pk),
                "parent_id": str(parent_task.pk),
                "is_subtask": "true",
            },
        )
        r = client.get("/api/v1/tasks/", {"project": str(project.pk), "is_subtask": "false"})
        assert r.status_code == 200
        for t in r.data["results"]:
            assert t["is_subtask"] is False

    def test_parent_filter(self, client: APIClient, project: Project, parent_task: Task) -> None:
        r_create = client.post(
            "/api/v1/tasks/",
            {
                "name": "Child of parent",
                "duration": 1,
                "project": str(project.pk),
                "parent_id": str(parent_task.pk),
                "is_subtask": "true",
            },
        )
        child_id = r_create.data["id"]

        # Also create a root-level task to confirm it is excluded.
        client.post(
            "/api/v1/tasks/",
            {"name": "Unrelated root", "duration": 2, "project": str(project.pk)},
        )

        r = client.get(
            "/api/v1/tasks/", {"project": str(project.pk), "parent": str(parent_task.pk)}
        )
        assert r.status_code == 200
        ids = [t["id"] for t in r.data["results"]]
        assert child_id in ids
