"""Tests for phase rollup hardening (ADR-0293, #1753).

A *phase* is a non-subtask task with at least one structural (non-subtask) child.
It is a pure rollup: its status, 3-point estimate, assignee, percent, and logged
time are all computed from its children and cannot be set directly. The critical
distinction under test is phase vs. leaf-with-subtasks: a leaf whose only children
are drawer subtasks is ``is_summary=True`` but ``is_phase=False`` and stays fully
writable.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task, TaskStatus

User = get_user_model()


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def assignee_user(db: object) -> object:
    return User.objects.create_user(username="worker", password="pw")


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


@pytest.fixture
def assignee_membership(assignee_user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=assignee_user, role=Role.MEMBER)


def _phase_with_child(project: Project) -> tuple[Task, Task]:
    """A phase (parent at "1") with one structural (non-subtask) child at "1.1"."""
    phase = Task.objects.create(project=project, name="Phase 1", duration=0, wbs_path="1")
    child = Task.objects.create(project=project, name="Work", duration=5, wbs_path="1.1")
    return phase, child


def _leaf_with_subtask(project: Project) -> tuple[Task, Task]:
    """A leaf-with-subtasks: parent at "2" whose only child at "2.1" is a drawer subtask."""
    leaf = Task.objects.create(project=project, name="Leaf", duration=5, wbs_path="2")
    subtask = Task.objects.create(
        project=project, name="Subtask", duration=1, wbs_path="2.1", is_subtask=True
    )
    return leaf, subtask


# ---------------------------------------------------------------------------
# is_phase annotation — the critical phase vs. leaf-with-subtasks distinction
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestIsPhaseAnnotation:
    def test_phase_with_structural_child_is_phase(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        phase, _ = _phase_with_child(project)
        r = client.get(f"/api/v1/tasks/{phase.id}/", {"project": str(project.id)})
        assert r.status_code == 200
        assert r.data["is_summary"] is True
        assert r.data["is_phase"] is True

    def test_leaf_with_subtasks_is_summary_not_phase(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """THE critical distinction: is_summary=True but is_phase=False."""
        leaf, _ = _leaf_with_subtask(project)
        r = client.get(f"/api/v1/tasks/{leaf.id}/", {"project": str(project.id)})
        assert r.status_code == 200
        assert r.data["is_summary"] is True
        assert r.data["is_phase"] is False

    def test_plain_leaf_is_neither(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        leaf = Task.objects.create(project=project, name="Solo", duration=3, wbs_path="1")
        r = client.get(f"/api/v1/tasks/{leaf.id}/", {"project": str(project.id)})
        assert r.status_code == 200
        assert r.data["is_summary"] is False
        assert r.data["is_phase"] is False

    def test_list_includes_is_phase(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        phase, child = _phase_with_child(project)
        r = client.get("/api/v1/tasks/", {"project": str(project.id)})
        assert r.status_code == 200
        by_id = {t["id"]: t for t in r.data["results"]}
        assert by_id[str(phase.id)]["is_phase"] is True
        assert by_id[str(child.id)]["is_phase"] is False


# ---------------------------------------------------------------------------
# status lock — phase_status_rollup_locked
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestPhaseStatusLock:
    def test_leaf_accepts_status(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        leaf = Task.objects.create(project=project, name="Leaf", duration=3, wbs_path="1")
        r = client.patch(
            f"/api/v1/tasks/{leaf.id}/", {"status": TaskStatus.IN_PROGRESS}, format="json"
        )
        assert r.status_code == 200
        assert r.data["status"] == TaskStatus.IN_PROGRESS

    def test_phase_rejects_status(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        phase, _ = _phase_with_child(project)
        r = client.patch(
            f"/api/v1/tasks/{phase.id}/", {"status": TaskStatus.IN_PROGRESS}, format="json"
        )
        assert r.status_code == 400
        assert r.data["status"][0].code == "phase_status_rollup_locked"

    def test_phase_partial_update_without_status_succeeds(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        phase, _ = _phase_with_child(project)
        r = client.patch(f"/api/v1/tasks/{phase.id}/", {"name": "Renamed phase"}, format="json")
        assert r.status_code == 200
        assert r.data["name"] == "Renamed phase"

    def test_phase_noop_status_resend_succeeds(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Re-sending the phase's current status is a no-op, not a change → allowed."""
        phase, _ = _phase_with_child(project)
        r = client.patch(
            f"/api/v1/tasks/{phase.id}/", {"status": TaskStatus.NOT_STARTED}, format="json"
        )
        assert r.status_code == 200

    def test_leaf_with_subtasks_accepts_status(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        leaf, _ = _leaf_with_subtask(project)
        r = client.patch(
            f"/api/v1/tasks/{leaf.id}/", {"status": TaskStatus.IN_PROGRESS}, format="json"
        )
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# estimate lock — phase_estimate_rollup_locked
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestPhaseEstimateLock:
    def test_leaf_accepts_estimate(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        leaf = Task.objects.create(project=project, name="Leaf", duration=3, wbs_path="1")
        r = client.patch(
            f"/api/v1/tasks/{leaf.id}/",
            {"optimistic_duration": 2, "most_likely_duration": 3, "pessimistic_duration": 5},
            format="json",
        )
        assert r.status_code == 200

    def test_phase_rejects_estimate(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        phase, _ = _phase_with_child(project)
        r = client.patch(f"/api/v1/tasks/{phase.id}/", {"optimistic_duration": 2}, format="json")
        assert r.status_code == 400
        assert r.data["optimistic_duration"][0].code == "phase_estimate_rollup_locked"

    def test_phase_partial_update_without_estimate_succeeds(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        phase, _ = _phase_with_child(project)
        r = client.patch(f"/api/v1/tasks/{phase.id}/", {"name": "Phase renamed"}, format="json")
        assert r.status_code == 200

    def test_leaf_with_subtasks_accepts_estimate(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        leaf, _ = _leaf_with_subtask(project)
        r = client.patch(f"/api/v1/tasks/{leaf.id}/", {"most_likely_duration": 4}, format="json")
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# assignee lock — assignee_on_phase
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestPhaseAssigneeLock:
    def test_leaf_accepts_assignee(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
        assignee_user: object,
        assignee_membership: ProjectMembership,
    ) -> None:
        leaf = Task.objects.create(project=project, name="Leaf", duration=3, wbs_path="1")
        r = client.patch(
            f"/api/v1/tasks/{leaf.id}/", {"assignee": str(assignee_user.id)}, format="json"
        )
        assert r.status_code == 200

    def test_phase_rejects_assignee(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
        assignee_user: object,
        assignee_membership: ProjectMembership,
    ) -> None:
        phase, _ = _phase_with_child(project)
        r = client.patch(
            f"/api/v1/tasks/{phase.id}/", {"assignee": str(assignee_user.id)}, format="json"
        )
        assert r.status_code == 400
        assert r.data["assignee"][0].code == "assignee_on_phase"

    def test_phase_partial_update_without_assignee_succeeds(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        phase, _ = _phase_with_child(project)
        r = client.patch(f"/api/v1/tasks/{phase.id}/", {"name": "Phase X"}, format="json")
        assert r.status_code == 200

    def test_leaf_with_subtasks_accepts_assignee(
        self,
        client: APIClient,
        project: Project,
        membership: ProjectMembership,
        assignee_user: object,
        assignee_membership: ProjectMembership,
    ) -> None:
        leaf, _ = _leaf_with_subtask(project)
        r = client.patch(
            f"/api/v1/tasks/{leaf.id}/", {"assignee": str(assignee_user.id)}, format="json"
        )
        assert r.status_code == 200
