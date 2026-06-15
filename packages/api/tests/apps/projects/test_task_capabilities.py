"""Server-derived task edit capabilities (ADR-0132, #1144).

Two layers:
  1. ``can_user_edit_task`` — the shared predicate that backs BOTH the
     IsProjectMemberWriteOrOwn permission class and the serializer fields, so the
     contract the client gates off can never drift from the enforced contract.
  2. ``TaskSerializer.can_edit`` / ``can_delete`` — the per-task verdict the API
     emits for the requesting user, exercised end-to-end through the tasks list.

The predicate cases mirror the enforcement matrix in ``test_rbac.py`` so the two
files fail together if the rule ever changes — that co-failure is the point.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.access.permissions import can_user_edit_task
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskType
from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    return User.objects.create_user(username="bob", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Proj", start_date=date(2026, 1, 1), calendar=calendar)


def _make_request(user: object, method: str = "PATCH") -> MagicMock:
    req = MagicMock()
    req.user = user
    req.method = method
    return req


def _add_member(user: object, project: Project, role: int) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=role)


# ---------------------------------------------------------------------------
# can_user_edit_task — the shared predicate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestCanUserEditTaskPredicate:
    def test_unauthenticated_user_cannot_edit(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        anon = MagicMock()
        anon.is_authenticated = False
        req = MagicMock()
        req.user = anon
        assert can_user_edit_task(req, task) is False

    def test_non_member_cannot_edit(self, user: object, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1, assignee=user)
        # No membership added.
        assert can_user_edit_task(_make_request(user), task) is False

    def test_viewer_cannot_edit(self, user: object, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        _add_member(user, project, Role.VIEWER)
        assert can_user_edit_task(_make_request(user), task) is False

    def test_member_can_edit_own_task(self, user: object, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1, assignee=user)
        _add_member(user, project, Role.MEMBER)
        assert can_user_edit_task(_make_request(user), task) is True

    def test_member_cannot_edit_others_task(
        self, user: object, other_user: object, project: Project
    ) -> None:
        task = Task.objects.create(project=project, name="T", duration=1, assignee=other_user)
        _add_member(user, project, Role.MEMBER)
        assert can_user_edit_task(_make_request(user), task) is False

    def test_member_cannot_edit_unassigned_task(self, user: object, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1, assignee=None)
        _add_member(user, project, Role.MEMBER)
        assert can_user_edit_task(_make_request(user), task) is False

    def test_scheduler_cannot_edit_task_content(self, user: object, project: Project) -> None:
        """Resource Manager is read-only for task content — the client rule got this wrong."""
        task = Task.objects.create(project=project, name="T", duration=1, assignee=user)
        _add_member(user, project, Role.SCHEDULER)
        assert can_user_edit_task(_make_request(user), task) is False

    def test_admin_can_edit_any_task(
        self, user: object, other_user: object, project: Project
    ) -> None:
        task = Task.objects.create(project=project, name="T", duration=1, assignee=other_user)
        _add_member(user, project, Role.ADMIN)
        assert can_user_edit_task(_make_request(user), task) is True

    def test_product_owner_can_edit_but_not_delete_story(
        self, user: object, project: Project
    ) -> None:
        """The PO facet grooms (edits) EPIC/STORY items below Admin — but DELETE is
        excluded, so can_edit and can_delete legitimately diverge for a PO."""
        story = Task.objects.create(
            project=project, name="S", duration=1, type=TaskType.STORY, assignee=None
        )
        _add_member(user, project, Role.MEMBER)
        team = Team.objects.create(
            project=project, name="Default Team", short_id="T01", is_default=True
        )
        TeamMembership.objects.create(
            team=team, user=user, role=TeamRole.MEMBER, is_product_owner=True
        )
        # The would-be verb is the explicit ``method`` kwarg (the serializer passes
        # "PATCH"/"DELETE"; the permission class passes ``request.method``).
        assert can_user_edit_task(_make_request(user), story, method="PATCH") is True
        assert can_user_edit_task(_make_request(user), story, method="DELETE") is False

    def test_product_owner_facet_does_not_widen_to_non_story(
        self, user: object, other_user: object, project: Project
    ) -> None:
        """The facet is scoped to EPIC/STORY — it never widens write access to a
        plain schedule task the PO is not assigned to."""
        task = Task.objects.create(project=project, name="T", duration=1, assignee=other_user)
        _add_member(user, project, Role.MEMBER)
        team = Team.objects.create(
            project=project, name="Default Team", short_id="T01", is_default=True
        )
        TeamMembership.objects.create(
            team=team, user=user, role=TeamRole.MEMBER, is_product_owner=True
        )
        assert can_user_edit_task(_make_request(user), task) is False


# ---------------------------------------------------------------------------
# TaskSerializer.can_edit / can_delete — end-to-end via the tasks list
# ---------------------------------------------------------------------------


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _fetch_task(user: object, project: Project, task: Task) -> dict:
    resp = _client(user).get(f"/api/v1/tasks/?project={project.pk}")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    rows = body["results"] if isinstance(body, dict) and "results" in body else body
    match = [r for r in rows if r["id"] == str(task.pk)]
    assert match, f"task {task.pk} not in response"
    return match[0]


@pytest.mark.django_db
class TestTaskCapabilityFields:
    def test_viewer_sees_can_edit_false(self, user: object, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1)
        _add_member(user, project, Role.VIEWER)
        row = _fetch_task(user, project, task)
        assert row["can_edit"] is False
        assert row["can_delete"] is False

    def test_member_own_task_can_edit_and_delete(self, user: object, project: Project) -> None:
        task = Task.objects.create(project=project, name="T", duration=1, assignee=user)
        _add_member(user, project, Role.MEMBER)
        row = _fetch_task(user, project, task)
        assert row["can_edit"] is True
        assert row["can_delete"] is True

    def test_member_others_task_can_edit_false(
        self, user: object, other_user: object, project: Project
    ) -> None:
        task = Task.objects.create(project=project, name="T", duration=1, assignee=other_user)
        _add_member(user, project, Role.MEMBER)
        row = _fetch_task(user, project, task)
        assert row["can_edit"] is False
        assert row["can_delete"] is False

    def test_scheduler_can_edit_false(self, user: object, project: Project) -> None:
        """The drift the field fixes: the old client rule showed Scheduler edit
        controls; the server says no."""
        task = Task.objects.create(project=project, name="T", duration=1, assignee=user)
        _add_member(user, project, Role.SCHEDULER)
        row = _fetch_task(user, project, task)
        assert row["can_edit"] is False

    def test_admin_can_edit_true(
        self, user: object, other_user: object, project: Project
    ) -> None:
        task = Task.objects.create(project=project, name="T", duration=1, assignee=other_user)
        _add_member(user, project, Role.ADMIN)
        row = _fetch_task(user, project, task)
        assert row["can_edit"] is True
        assert row["can_delete"] is True
