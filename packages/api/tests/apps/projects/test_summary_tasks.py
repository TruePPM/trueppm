"""Tests for summary task annotations, indent/outdent, and assignment guard."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.resources.models import Resource, TaskResource


@pytest.fixture
def user(db: object) -> object:
    User = get_user_model()
    return User.objects.create_user(username="testuser", password="pw")


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
class TestSummaryAnnotations:
    """is_summary and parent_id are computed annotations, not stored fields."""

    def test_leaf_task_is_not_summary(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """A task with no children is not a summary task."""
        task = Task.objects.create(project=project, name="Leaf", duration=3, wbs_path="1")
        r = client.get(f"/api/v1/tasks/{task.id}/", {"project": str(project.id)})
        assert r.status_code == 200
        assert r.data["is_summary"] is False
        assert r.data["parent_id"] is None

    def test_parent_becomes_summary(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """A task with at least one direct child is a summary task."""
        parent = Task.objects.create(project=project, name="Phase 1", duration=0, wbs_path="1")
        Task.objects.create(project=project, name="Child A", duration=5, wbs_path="1.1")
        r = client.get(f"/api/v1/tasks/{parent.id}/", {"project": str(project.id)})
        assert r.status_code == 200
        assert r.data["is_summary"] is True

    def test_child_has_parent_id(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """A child task's parent_id points to its direct parent."""
        parent = Task.objects.create(project=project, name="Phase 1", duration=0, wbs_path="1")
        child = Task.objects.create(project=project, name="Child A", duration=5, wbs_path="1.1")
        r = client.get(f"/api/v1/tasks/{child.id}/", {"project": str(project.id)})
        assert r.status_code == 200
        assert r.data["parent_id"] == str(parent.id)

    def test_root_task_has_null_parent(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Root-level tasks have parent_id = null."""
        Task.objects.create(project=project, name="Root", duration=3, wbs_path="1")
        r = client.get("/api/v1/tasks/", {"project": str(project.id)})
        assert r.status_code == 200
        assert r.data["results"][0]["parent_id"] is None

    def test_grandchild_parent_is_intermediate(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """A grandchild's parent_id points to the intermediate task, not the root."""
        Task.objects.create(project=project, name="Root", duration=0, wbs_path="1")
        mid = Task.objects.create(project=project, name="Sub-phase", duration=0, wbs_path="1.1")
        gc = Task.objects.create(project=project, name="Work item", duration=3, wbs_path="1.1.1")
        r = client.get(f"/api/v1/tasks/{gc.id}/", {"project": str(project.id)})
        assert r.status_code == 200
        assert r.data["parent_id"] == str(mid.id)

    def test_deleted_child_does_not_make_summary(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Soft-deleted children don't count — the parent is not summary."""
        parent = Task.objects.create(project=project, name="Phase", duration=0, wbs_path="1")
        Task.objects.create(
            project=project, name="Dead child", duration=5, wbs_path="1.1", is_deleted=True
        )
        r = client.get(f"/api/v1/tasks/{parent.id}/", {"project": str(project.id)})
        assert r.status_code == 200
        assert r.data["is_summary"] is False

    def test_null_wbs_path_not_summary(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """A task with null wbs_path is never summary and has no parent."""
        task = Task.objects.create(project=project, name="Orphan", duration=3, wbs_path=None)
        r = client.get(f"/api/v1/tasks/{task.id}/", {"project": str(project.id)})
        assert r.status_code == 200
        assert r.data["is_summary"] is False
        assert r.data["parent_id"] is None

    def test_cross_project_children_ignored(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Children in another project don't make a task summary."""
        calendar = Calendar.objects.create(name="Other Cal")
        other = Project.objects.create(name="Other", start_date=date(2026, 4, 1), calendar=calendar)
        parent = Task.objects.create(project=project, name="Phase", duration=0, wbs_path="1")
        # Same wbs_path "1.1" but in a different project — shouldn't count.
        Task.objects.create(project=other, name="Other child", duration=5, wbs_path="1.1")
        r = client.get(f"/api/v1/tasks/{parent.id}/", {"project": str(project.id)})
        assert r.status_code == 200
        assert r.data["is_summary"] is False

    def test_list_includes_annotations(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """The list endpoint includes is_summary and parent_id for all tasks."""
        parent = Task.objects.create(project=project, name="Phase", duration=0, wbs_path="1")
        child = Task.objects.create(project=project, name="Work", duration=3, wbs_path="1.1")
        r = client.get("/api/v1/tasks/", {"project": str(project.id)})
        assert r.status_code == 200
        by_id = {t["id"]: t for t in r.data["results"]}
        assert by_id[str(parent.id)]["is_summary"] is True
        assert by_id[str(parent.id)]["parent_id"] is None
        assert by_id[str(child.id)]["is_summary"] is False
        assert by_id[str(child.id)]["parent_id"] == str(parent.id)


@pytest.mark.django_db
class TestPercentCompleteRollup:
    """Summary tasks derive percent_complete from duration-weighted child average."""

    def test_weighted_average(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """percent_complete is duration-weighted average of direct children."""
        parent = Task.objects.create(project=project, name="Phase", duration=0, wbs_path="1")
        # Child A: 10 days, 50% complete → contributes 500
        Task.objects.create(
            project=project, name="A", duration=10, percent_complete=50, wbs_path="1.1"
        )
        # Child B: 5 days, 100% complete → contributes 500
        Task.objects.create(
            project=project, name="B", duration=5, percent_complete=100, wbs_path="1.2"
        )
        # Weighted = (500 + 500) / 15 = 66.67
        r = client.get(f"/api/v1/tasks/{parent.id}/", {"project": str(project.id)})
        assert r.status_code == 200
        assert r.data["percent_complete"] == 66.67

    def test_zero_duration_children_ignored(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """If all children have zero duration, parent keeps its own percent_complete."""
        parent = Task.objects.create(
            project=project, name="Phase", duration=0, percent_complete=0, wbs_path="1"
        )
        Task.objects.create(
            project=project, name="Milestone", duration=0, percent_complete=100, wbs_path="1.1"
        )
        r = client.get(f"/api/v1/tasks/{parent.id}/", {"project": str(project.id)})
        assert r.status_code == 200
        assert r.data["percent_complete"] == 0  # Falls through — total_duration is 0

    def test_grandchildren_excluded(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Only direct children contribute to the rollup, not grandchildren."""
        root = Task.objects.create(project=project, name="Root", duration=0, wbs_path="1")
        Task.objects.create(
            project=project, name="Sub", duration=10, percent_complete=50, wbs_path="1.1"
        )
        # Grandchild at 100% should not affect root's rollup.
        Task.objects.create(
            project=project, name="Leaf", duration=5, percent_complete=100, wbs_path="1.1.1"
        )
        r = client.get(f"/api/v1/tasks/{root.id}/", {"project": str(project.id)})
        assert r.status_code == 200
        # Only child "Sub" (10d, 50%) contributes → 50.0
        assert r.data["percent_complete"] == 50.0


@pytest.mark.django_db
class TestIndentEndpoint:
    """POST /api/v1/projects/{pk}/tasks/{task_id}/indent/"""

    def test_indent_basic(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Second sibling becomes last child of first sibling."""
        t1 = Task.objects.create(project=project, name="T1", duration=5, wbs_path="1")
        t2 = Task.objects.create(project=project, name="T2", duration=3, wbs_path="2")
        r = client.post(f"/api/v1/projects/{project.id}/tasks/{t2.id}/indent/")
        assert r.status_code == 200
        t2.refresh_from_db()
        assert t2.wbs_path == "1.1"
        # T1 is now a summary task.
        r2 = client.get(f"/api/v1/tasks/{t1.id}/", {"project": str(project.id)})
        assert r2.data["is_summary"] is True

    def test_indent_first_at_level_400(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Cannot indent the first task at its level."""
        t1 = Task.objects.create(project=project, name="T1", duration=5, wbs_path="1")
        r = client.post(f"/api/v1/projects/{project.id}/tasks/{t1.id}/indent/")
        assert r.status_code == 400
        assert "first at its level" in r.data["detail"]

    def test_indent_with_descendants(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Descendants move with the indented task."""
        Task.objects.create(project=project, name="T1", duration=5, wbs_path="1")
        t2 = Task.objects.create(project=project, name="T2", duration=0, wbs_path="2")
        child = Task.objects.create(project=project, name="C1", duration=3, wbs_path="2.1")
        r = client.post(f"/api/v1/projects/{project.id}/tasks/{t2.id}/indent/")
        assert r.status_code == 200
        t2.refresh_from_db()
        child.refresh_from_db()
        assert t2.wbs_path == "1.1"
        assert child.wbs_path == "1.1.1"

    def test_indent_returns_assignment_warning(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Warning returned when indent makes a task summary and it has assignments."""
        t1 = Task.objects.create(project=project, name="T1", duration=5, wbs_path="1")
        t2 = Task.objects.create(project=project, name="T2", duration=3, wbs_path="2")
        resource = Resource.objects.create(name="Alice")
        TaskResource.objects.create(task=t1, resource=resource, units=1.0)
        r = client.post(f"/api/v1/projects/{project.id}/tasks/{t2.id}/indent/")
        assert r.status_code == 200
        assert r.data["warning"] == "has_assignments"


@pytest.mark.django_db
class TestOutdentEndpoint:
    """POST /api/v1/projects/{pk}/tasks/{task_id}/outdent/"""

    def test_outdent_basic(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Child promotes to parent's level."""
        Task.objects.create(project=project, name="Phase", duration=0, wbs_path="1")
        child = Task.objects.create(project=project, name="Work", duration=5, wbs_path="1.1")
        r = client.post(f"/api/v1/projects/{project.id}/tasks/{child.id}/outdent/")
        assert r.status_code == 200
        child.refresh_from_db()
        # Should be at root level, after the parent.
        assert child.wbs_path == "2"

    def test_outdent_root_400(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Cannot outdent a root-level task."""
        t1 = Task.objects.create(project=project, name="T1", duration=5, wbs_path="1")
        r = client.post(f"/api/v1/projects/{project.id}/tasks/{t1.id}/outdent/")
        assert r.status_code == 400
        assert "root level" in r.data["detail"]

    def test_outdent_adopts_following_siblings(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """MS Project convention: following siblings become children of outdented task."""
        Task.objects.create(project=project, name="Phase", duration=0, wbs_path="1")
        t1 = Task.objects.create(project=project, name="Work A", duration=5, wbs_path="1.1")
        t2 = Task.objects.create(project=project, name="Work B", duration=3, wbs_path="1.2")
        r = client.post(f"/api/v1/projects/{project.id}/tasks/{t1.id}/outdent/")
        assert r.status_code == 200
        t1.refresh_from_db()
        t2.refresh_from_db()
        assert t1.wbs_path == "2"
        # T2 was a following sibling — adopted as child of t1.
        assert t2.wbs_path == "2.1"


@pytest.mark.django_db
class TestReparentEndpoint:
    """POST /api/v1/projects/{pk}/tasks/{task_id}/reparent/"""

    def test_reparent_under_summary(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Task moves under an arbitrary summary (not just previous sibling)."""
        Task.objects.create(project=project, name="Phase A", duration=0, wbs_path="1")
        Task.objects.create(project=project, name="A child", duration=3, wbs_path="1.1")
        phase_b = Task.objects.create(project=project, name="Phase B", duration=0, wbs_path="2")
        t = Task.objects.create(project=project, name="Stray", duration=5, wbs_path="3")
        r = client.post(
            f"/api/v1/projects/{project.id}/tasks/{t.id}/reparent/",
            {"new_parent_id": str(phase_b.id)},
            format="json",
        )
        assert r.status_code == 200
        t.refresh_from_db()
        assert t.wbs_path == "2.1"

    def test_reparent_to_root(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """null new_parent_id promotes the task to root level."""
        Task.objects.create(project=project, name="Root A", duration=0, wbs_path="1")
        child = Task.objects.create(project=project, name="Child", duration=5, wbs_path="1.1")
        r = client.post(
            f"/api/v1/projects/{project.id}/tasks/{child.id}/reparent/",
            {"new_parent_id": None},
            format="json",
        )
        assert r.status_code == 200
        child.refresh_from_db()
        assert child.wbs_path == "2"

    def test_reparent_with_descendants(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Descendants follow the reparented task."""
        phase_b = Task.objects.create(project=project, name="Phase B", duration=0, wbs_path="1")
        t = Task.objects.create(project=project, name="Moving", duration=0, wbs_path="2")
        grand = Task.objects.create(project=project, name="Grand", duration=3, wbs_path="2.1")
        r = client.post(
            f"/api/v1/projects/{project.id}/tasks/{t.id}/reparent/",
            {"new_parent_id": str(phase_b.id)},
            format="json",
        )
        assert r.status_code == 200
        t.refresh_from_db()
        grand.refresh_from_db()
        assert t.wbs_path == "1.1"
        assert grand.wbs_path == "1.1.1"

    def test_reparent_cycle_rejected(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Cannot reparent a task under its own descendant."""
        t = Task.objects.create(project=project, name="Ancestor", duration=0, wbs_path="1")
        desc = Task.objects.create(project=project, name="Descendant", duration=3, wbs_path="1.1")
        r = client.post(
            f"/api/v1/projects/{project.id}/tasks/{t.id}/reparent/",
            {"new_parent_id": str(desc.id)},
            format="json",
        )
        assert r.status_code == 400
        assert "descendant" in r.data["detail"]

    def test_reparent_self_rejected(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Cannot reparent a task under itself."""
        t = Task.objects.create(project=project, name="Self", duration=3, wbs_path="1")
        r = client.post(
            f"/api/v1/projects/{project.id}/tasks/{t.id}/reparent/",
            {"new_parent_id": str(t.id)},
            format="json",
        )
        assert r.status_code == 400

    def test_reparent_unknown_parent_404(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Unknown new_parent_id returns 404."""
        import uuid

        t = Task.objects.create(project=project, name="T", duration=3, wbs_path="1")
        r = client.post(
            f"/api/v1/projects/{project.id}/tasks/{t.id}/reparent/",
            {"new_parent_id": str(uuid.uuid4())},
            format="json",
        )
        assert r.status_code == 404

    def test_reparent_same_parent_noop(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Reparenting to the current parent is a no-op."""
        parent = Task.objects.create(project=project, name="P", duration=0, wbs_path="1")
        child = Task.objects.create(project=project, name="C", duration=3, wbs_path="1.1")
        r = client.post(
            f"/api/v1/projects/{project.id}/tasks/{child.id}/reparent/",
            {"new_parent_id": str(parent.id)},
            format="json",
        )
        assert r.status_code == 200
        assert r.data["updated"] == []
        child.refresh_from_db()
        assert child.wbs_path == "1.1"

    def test_reparent_returns_assignment_warning(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Warning returned when reparent makes target a summary with assignments."""
        target = Task.objects.create(project=project, name="Target", duration=5, wbs_path="1")
        resource = Resource.objects.create(name="Dee")
        TaskResource.objects.create(task=target, resource=resource, units=1.0)
        t = Task.objects.create(project=project, name="Moving", duration=3, wbs_path="2")
        r = client.post(
            f"/api/v1/projects/{project.id}/tasks/{t.id}/reparent/",
            {"new_parent_id": str(target.id)},
            format="json",
        )
        assert r.status_code == 200
        assert r.data["warning"] == "has_assignments"

    def test_reparent_renumbers_old_siblings(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Removing the task from its old parent closes the gap in sibling order."""
        target = Task.objects.create(project=project, name="Target", duration=0, wbs_path="1")
        a = Task.objects.create(project=project, name="A", duration=3, wbs_path="2")
        t = Task.objects.create(project=project, name="Mid", duration=3, wbs_path="3")
        c = Task.objects.create(project=project, name="C", duration=3, wbs_path="4")
        r = client.post(
            f"/api/v1/projects/{project.id}/tasks/{t.id}/reparent/",
            {"new_parent_id": str(target.id)},
            format="json",
        )
        assert r.status_code == 200
        a.refresh_from_db()
        c.refresh_from_db()
        assert a.wbs_path == "2"
        # C was at "4", now closes the gap to "3".
        assert c.wbs_path == "3"


@pytest.mark.django_db
class TestAssignmentGuard:
    """TaskResource creation blocked for summary tasks."""

    def test_assignment_to_leaf_ok(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Assigning a resource to a leaf task succeeds."""
        task = Task.objects.create(project=project, name="Leaf", duration=5, wbs_path="1")
        resource = Resource.objects.create(name="Bob")
        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(task.id), "resource": str(resource.id), "units": 1.0},
        )
        assert r.status_code == 201

    def test_assignment_to_summary_blocked(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Assigning a resource to a summary task returns 400."""
        parent = Task.objects.create(project=project, name="Phase", duration=0, wbs_path="1")
        Task.objects.create(project=project, name="Child", duration=5, wbs_path="1.1")
        resource = Resource.objects.create(name="Carol")
        r = client.post(
            "/api/v1/task-resources/",
            {"task": str(parent.id), "resource": str(resource.id), "units": 1.0},
        )
        assert r.status_code == 400
        assert "summary task" in str(r.data["task"])


@pytest.mark.django_db
class TestPercentCompleteRollupDeepWbs:
    """percent_complete_rollup must aggregate leaf descendants at any depth (#397)."""

    def test_3_level_wbs_grandparent_rollup(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Grandparent rollup uses leaf grandchildren, not the intermediate summary's stored 0."""
        # 3-level WBS:
        #   1         grandparent (summary)
        #   1.1       intermediate summary
        #   1.1.1     leaf A  — 5 days, 50%
        #   1.1.2     leaf B  — 5 days, 100%
        # Expected grandparent rollup: (5*50 + 5*100) / (5+5) = 75
        grandparent = Task.objects.create(project=project, name="Phase", duration=0, wbs_path="1")
        Task.objects.create(project=project, name="Sub-phase", duration=0, wbs_path="1.1")
        Task.objects.create(
            project=project, name="Leaf A", duration=5, wbs_path="1.1.1", percent_complete=50
        )
        Task.objects.create(
            project=project, name="Leaf B", duration=5, wbs_path="1.1.2", percent_complete=100
        )

        r = client.get(f"/api/v1/tasks/{grandparent.pk}/")
        assert r.status_code == 200
        assert r.data["percent_complete"] == 75.0

    def test_2_level_wbs_rollup_unchanged(
        self, client: APIClient, project: Project, membership: ProjectMembership
    ) -> None:
        """Existing 2-level rollup still works after the fix."""
        parent = Task.objects.create(project=project, name="Phase", duration=0, wbs_path="1")
        Task.objects.create(
            project=project, name="Leaf A", duration=4, wbs_path="1.1", percent_complete=25
        )
        Task.objects.create(
            project=project, name="Leaf B", duration=4, wbs_path="1.2", percent_complete=75
        )

        r = client.get(f"/api/v1/tasks/{parent.pk}/")
        assert r.status_code == 200
        assert r.data["percent_complete"] == 50.0
