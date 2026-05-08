"""Tests for the ?mine=true filter on TaskViewSet (issue #198).

Drives the "My tasks" Board filter for contributors. Returns tasks whose
TaskResource.resource is linked to the requesting user — either via
Resource.user (preferred) or Resource.email (fallback for legacy rows).
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.resources.models import Resource, TaskResource


@pytest.fixture
def user_alice(db: object) -> object:
    User = get_user_model()
    return User.objects.create_user(username="alice", email="alice@example.com", password="pw")


@pytest.fixture
def user_bob(db: object) -> object:
    User = get_user_model()
    return User.objects.create_user(username="bob", email="bob@example.com", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Default")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Mine Filter Project",
        start_date=date(2026, 1, 1),
        calendar=calendar,
    )


@pytest.fixture
def memberships(
    user_alice: object, user_bob: object, project: Project
) -> tuple[ProjectMembership, ProjectMembership]:
    return (
        ProjectMembership.objects.create(project=project, user=user_alice, role=Role.MEMBER),
        ProjectMembership.objects.create(project=project, user=user_bob, role=Role.MEMBER),
    )


@pytest.fixture
def tasks_with_assignments(
    project: Project, user_alice: object, user_bob: object
) -> dict[str, Task]:
    """Three tasks: one assigned to Alice via FK, one to Bob via email, one unassigned."""
    alice_resource = Resource.objects.create(
        name="Alice Person", email="alice@example.com", user=user_alice
    )
    # Bob is assigned via email match only (Resource.user is null)
    bob_resource = Resource.objects.create(name="Bob Person", email="BOB@example.com")
    other_resource = Resource.objects.create(name="Charlie Person", email="charlie@example.com")

    t_alice = Task.objects.create(project=project, name="Alice's task")
    t_bob = Task.objects.create(project=project, name="Bob's task")
    t_other = Task.objects.create(project=project, name="Other task")
    t_unassigned = Task.objects.create(project=project, name="Unassigned task")

    TaskResource.objects.create(task=t_alice, resource=alice_resource, units=1.0)
    TaskResource.objects.create(task=t_bob, resource=bob_resource, units=1.0)
    TaskResource.objects.create(task=t_other, resource=other_resource, units=1.0)

    return {
        "alice": t_alice,
        "bob": t_bob,
        "other": t_other,
        "unassigned": t_unassigned,
    }


def _names(resp: object) -> set[str]:
    return {t["name"] for t in resp.json()["results"]}


@pytest.mark.django_db
class TestMineFilter:
    def test_mine_returns_only_tasks_assigned_via_user_fk(
        self,
        user_alice: object,
        project: Project,
        tasks_with_assignments: dict[str, Task],
        memberships: tuple[ProjectMembership, ProjectMembership],
    ) -> None:
        client = APIClient()
        client.force_authenticate(user=user_alice)
        resp = client.get("/api/v1/tasks/", {"project": str(project.pk), "mine": "true"})
        assert resp.status_code == 200
        assert _names(resp) == {"Alice's task"}

    def test_mine_falls_back_to_email_when_user_fk_null(
        self,
        user_bob: object,
        project: Project,
        tasks_with_assignments: dict[str, Task],
        memberships: tuple[ProjectMembership, ProjectMembership],
    ) -> None:
        # Bob's Resource has user=NULL but email matches (case-insensitive).
        client = APIClient()
        client.force_authenticate(user=user_bob)
        resp = client.get("/api/v1/tasks/", {"project": str(project.pk), "mine": "true"})
        assert resp.status_code == 200
        assert _names(resp) == {"Bob's task"}

    def test_mine_false_returns_all_tasks(
        self,
        user_alice: object,
        project: Project,
        tasks_with_assignments: dict[str, Task],
        memberships: tuple[ProjectMembership, ProjectMembership],
    ) -> None:
        client = APIClient()
        client.force_authenticate(user=user_alice)
        resp = client.get("/api/v1/tasks/", {"project": str(project.pk), "mine": "false"})
        assert resp.status_code == 200
        assert len(_names(resp)) == 4

    def test_mine_omitted_returns_all_tasks(
        self,
        user_alice: object,
        project: Project,
        tasks_with_assignments: dict[str, Task],
        memberships: tuple[ProjectMembership, ProjectMembership],
    ) -> None:
        client = APIClient()
        client.force_authenticate(user=user_alice)
        resp = client.get("/api/v1/tasks/", {"project": str(project.pk)})
        assert resp.status_code == 200
        assert len(_names(resp)) == 4

    def test_mine_returns_empty_when_user_has_no_assignments(
        self, project: Project, calendar: Calendar
    ) -> None:
        # User with no resource at all and no matching email — empty result.
        User = get_user_model()
        loner = User.objects.create_user(username="loner", email="loner@example.com", password="pw")
        ProjectMembership.objects.create(project=project, user=loner, role=Role.MEMBER)
        Task.objects.create(project=project, name="A task")
        client = APIClient()
        client.force_authenticate(user=loner)
        resp = client.get("/api/v1/tasks/", {"project": str(project.pk), "mine": "true"})
        assert resp.status_code == 200
        assert _names(resp) == set()

    def test_mine_does_not_return_duplicates_for_multiple_assignments(
        self, user_alice: object, project: Project
    ) -> None:
        # Alice is on two resources both assigned to the same task — should
        # appear once, not twice (distinct() collapses the M2M join).
        ProjectMembership.objects.create(project=project, user=user_alice, role=Role.MEMBER)
        r1 = Resource.objects.create(name="Alice A", user=user_alice)
        r2 = Resource.objects.create(name="Alice B", email="alice@example.com")
        t = Task.objects.create(project=project, name="Double assigned")
        TaskResource.objects.create(task=t, resource=r1, units=0.5)
        TaskResource.objects.create(task=t, resource=r2, units=0.5)
        client = APIClient()
        client.force_authenticate(user=user_alice)
        resp = client.get("/api/v1/tasks/", {"project": str(project.pk), "mine": "true"})
        assert resp.status_code == 200
        names = [t["name"] for t in resp.json()["results"]]
        assert names == ["Double assigned"]

    def test_mine_requires_project_membership(
        self,
        project: Project,
        tasks_with_assignments: dict[str, Task],
    ) -> None:
        # Outsider user (not a member of the project) cannot bypass auth via ?mine.
        User = get_user_model()
        outsider = User.objects.create_user(
            username="outsider", email="outsider@example.com", password="pw"
        )
        client = APIClient()
        client.force_authenticate(user=outsider)
        resp = client.get("/api/v1/tasks/", {"project": str(project.pk), "mine": "true"})
        # IsProjectMember rejects non-members; either 200 with empty list (filter)
        # or 403 (permission). Accept either — the contract is "no leak."
        if resp.status_code == 200:
            assert _names(resp) == set()
        else:
            assert resp.status_code == 403
