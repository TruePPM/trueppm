"""Tests for the Baseline and BaselineTask API (issue #9)."""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Calendar,
    ImmutableModelError,
    Project,
    Task,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="pm", password="pw")


@pytest.fixture
def viewer(db: object) -> object:
    return User.objects.create_user(username="viewer", password="pw")


@pytest.fixture
def member(db: object) -> object:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def viewer_client(viewer: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=viewer)
    return c


@pytest.fixture
def member_client(member: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=member)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 3, 2), calendar=calendar)


@pytest.fixture
def owner_membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.fixture
def viewer_membership(viewer: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)


@pytest.fixture
def member_membership(member: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)


@pytest.fixture
def tasks_with_cpm(project: Project) -> list[Task]:
    """Three tasks with CPM dates set — baseline creation can snapshot them."""
    return [
        Task.objects.create(
            project=project,
            name=f"Task {i}",
            duration=5 + i,
            early_start=date(2026, 4, 1),
            early_finish=date(2026, 4, 6 + i),
        )
        for i in range(3)
    ]


@pytest.fixture
def tasks_without_cpm(project: Project) -> list[Task]:
    """Three tasks with no CPM dates — baseline will have has_cpm_dates=False."""
    return [Task.objects.create(project=project, name=f"NoCpm {i}", duration=3) for i in range(3)]


# ---------------------------------------------------------------------------
# Model: BaselineTask immutability
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestBaselineTaskImmutability:
    def test_create_succeeds(self, project: Project, tasks_with_cpm: list[Task]) -> None:
        baseline = Baseline.objects.create(project=project, name="B1")
        bt = BaselineTask(
            baseline=baseline,
            task_id=tasks_with_cpm[0].id,
            task_name="Task 0",
            start=date(2026, 4, 1),
            finish=date(2026, 4, 6),
            duration=5,
        )
        bt.save()  # INSERT — must succeed
        assert BaselineTask.objects.filter(pk=bt.pk).exists()

    def test_update_raises_immutable_error(
        self, project: Project, tasks_with_cpm: list[Task]
    ) -> None:
        baseline = Baseline.objects.create(project=project, name="B1")
        bt = BaselineTask.objects.create(
            baseline=baseline,
            task_id=tasks_with_cpm[0].id,
            task_name="Task 0",
            start=date(2026, 4, 1),
            finish=date(2026, 4, 6),
            duration=5,
        )
        bt.task_name = "Mutated"
        with pytest.raises(ImmutableModelError):
            bt.save()


# ---------------------------------------------------------------------------
# API: create baseline
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestBaselineCreate:
    def test_create_snapshots_all_tasks(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = client.post(f"/api/v1/projects/{project.pk}/baselines/")
        assert r.status_code == 201
        baseline_id = r.data["id"]
        assert BaselineTask.objects.filter(baseline_id=baseline_id).count() == 3
        assert r.data["task_count"] == 3
        assert r.data["has_cpm_dates"] is True

    def test_auto_name_increments(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r1 = client.post(f"/api/v1/projects/{project.pk}/baselines/")
            r2 = client.post(f"/api/v1/projects/{project.pk}/baselines/")
        assert r1.data["name"] == "Baseline 1"
        assert r2.data["name"] == "Baseline 2"

    def test_custom_name_accepted(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = client.post(
                f"/api/v1/projects/{project.pk}/baselines/",
                {"name": "Pre-concrete pour"},
                format="json",
            )
        assert r.status_code == 201
        assert r.data["name"] == "Pre-concrete pour"

    def test_duplicate_name_rejected(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            client.post(
                f"/api/v1/projects/{project.pk}/baselines/",
                {"name": "Sprint 1"},
                format="json",
            )
            r = client.post(
                f"/api/v1/projects/{project.pk}/baselines/",
                {"name": "Sprint 1"},
                format="json",
            )
        assert r.status_code == 400

    def test_has_cpm_dates_false_when_no_cpm(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        tasks_without_cpm: list[Task],
    ) -> None:
        """Option C: baseline creation succeeds even without CPM dates; flag is set."""
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = client.post(f"/api/v1/projects/{project.pk}/baselines/")
        assert r.status_code == 201
        assert r.data["has_cpm_dates"] is False

    def test_member_cannot_create(
        self,
        member_client: APIClient,
        project: Project,
        member_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        r = member_client.post(f"/api/v1/projects/{project.pk}/baselines/")
        assert r.status_code == 403

    def test_viewer_cannot_create(
        self,
        viewer_client: APIClient,
        project: Project,
        viewer_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        r = viewer_client.post(f"/api/v1/projects/{project.pk}/baselines/")
        assert r.status_code == 403

    @pytest.mark.django_db(transaction=True)
    def test_broadcasts_baseline_created(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast:
            r = client.post(f"/api/v1/projects/{project.pk}/baselines/")
        assert r.status_code == 201
        event_types = [call.args[1] for call in mock_broadcast.call_args_list]
        assert "baseline_created" in event_types


# ---------------------------------------------------------------------------
# API: list / retrieve
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestBaselineRead:
    def test_list_returns_project_baselines(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            client.post(f"/api/v1/projects/{project.pk}/baselines/")
            client.post(f"/api/v1/projects/{project.pk}/baselines/")
        r = client.get(f"/api/v1/projects/{project.pk}/baselines/")
        assert r.status_code == 200
        assert len(r.data.get("results", r.data)) == 2

    def test_retrieve_includes_task_snapshot(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            create_r = client.post(f"/api/v1/projects/{project.pk}/baselines/")
        baseline_id = create_r.data["id"]
        r = client.get(f"/api/v1/projects/{project.pk}/baselines/{baseline_id}/")
        assert r.status_code == 200
        assert len(r.data["tasks"]) == 3
        task_data = r.data["tasks"][0]
        assert "task_id" in task_data
        assert "start" in task_data
        assert "finish" in task_data

    def test_viewer_can_read(
        self,
        viewer_client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        viewer_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            Baseline.objects.create(project=project, name="B1")
        r = viewer_client.get(f"/api/v1/projects/{project.pk}/baselines/")
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# API: delete
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestBaselineDelete:
    def test_owner_can_delete(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            create_r = client.post(f"/api/v1/projects/{project.pk}/baselines/")
            baseline_id = create_r.data["id"]
            r = client.delete(f"/api/v1/projects/{project.pk}/baselines/{baseline_id}/")
        assert r.status_code == 204
        assert not Baseline.objects.filter(pk=baseline_id, is_deleted=False).exists()

    def test_project_manager_cannot_delete(
        self,
        project: Project,
        owner_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        pm_user = User.objects.create_user(username="pm2", password="pw")
        ProjectMembership.objects.create(project=project, user=pm_user, role=Role.ADMIN)
        pm_client = APIClient()
        pm_client.force_authenticate(user=pm_user)
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            b = Baseline.objects.create(project=project, name="B1")
        r = pm_client.delete(f"/api/v1/projects/{project.pk}/baselines/{b.pk}/")
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# API: activate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestBaselineActivate:
    def test_activate_sets_is_active(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            b = Baseline.objects.create(project=project, name="B1")
            r = client.post(f"/api/v1/projects/{project.pk}/baselines/{b.pk}/activate/")
        assert r.status_code == 200
        assert r.data["is_active"] is True

    def test_activate_deactivates_others(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            b1 = Baseline.objects.create(project=project, name="B1", is_active=True)
            b2 = Baseline.objects.create(project=project, name="B2")
            client.post(f"/api/v1/projects/{project.pk}/baselines/{b2.pk}/activate/")
        b1.refresh_from_db()
        b2.refresh_from_db()
        assert b1.is_active is False
        assert b2.is_active is True

    @pytest.mark.django_db(transaction=True)
    def test_activate_broadcasts_event(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        b = Baseline.objects.create(project=project, name="B1")
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast:
            client.post(f"/api/v1/projects/{project.pk}/baselines/{b.pk}/activate/")
        event_types = [call.args[1] for call in mock_broadcast.call_args_list]
        assert "baseline_activated" in event_types

    def test_member_cannot_activate(
        self,
        member_client: APIClient,
        project: Project,
        member_membership: ProjectMembership,
    ) -> None:
        b = Baseline.objects.create(project=project, name="B1")
        r = member_client.post(f"/api/v1/projects/{project.pk}/baselines/{b.pk}/activate/")
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# API: is_active is read-only — activation is owned solely by the activate
# endpoint, never a direct serializer write (#1349). The detail route exposes
# only retrieve + destroy (no update), so the create path is the only write
# vector for is_active.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestBaselineIsActiveReadOnly:
    def test_create_with_is_active_is_ignored(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        """POST {is_active: true} cannot create a pre-activated baseline."""
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = client.post(
                f"/api/v1/projects/{project.pk}/baselines/",
                {"name": "Sneaky", "is_active": True},
                format="json",
            )
        assert r.status_code == 201
        assert r.data["is_active"] is False
        assert Baseline.objects.get(pk=r.data["id"]).is_active is False

    def test_create_second_active_does_not_500(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        """The read-only field blocks the bypass that previously raised a 500.

        With one active baseline, a create that tried to set is_active=true used
        to hit the partial-unique constraint → unhandled IntegrityError → 500.
        Now the field is dropped: 201, the new baseline stays inactive, and the
        existing active baseline is untouched.
        """
        active = Baseline.objects.create(project=project, name="Active", is_active=True)
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = client.post(
                f"/api/v1/projects/{project.pk}/baselines/",
                {"name": "Second", "is_active": True},
                format="json",
            )
        assert r.status_code == 201
        assert r.data["is_active"] is False
        active.refresh_from_db()
        assert active.is_active is True
        assert Baseline.objects.filter(project=project, is_active=True).count() == 1

    def test_activate_endpoint_still_works(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        """The dedicated endpoint remains the one path that activates a baseline."""
        b = Baseline.objects.create(project=project, name="B1", is_active=False)
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = client.post(f"/api/v1/projects/{project.pk}/baselines/{b.pk}/activate/")
        assert r.status_code == 200
        assert r.data["is_active"] is True

    def test_double_activate_does_not_500(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        """Re-activating the already-active baseline is idempotent, not a 500."""
        b = Baseline.objects.create(project=project, name="B1", is_active=True)
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = client.post(f"/api/v1/projects/{project.pk}/baselines/{b.pk}/activate/")
        assert r.status_code == 200
        assert r.data["is_active"] is True


# ---------------------------------------------------------------------------
# API: task list with baseline overlay
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestTaskListBaselineOverlay:
    def test_active_baseline_annotates_tasks(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            create_r = client.post(f"/api/v1/projects/{project.pk}/baselines/")
            baseline_id = create_r.data["id"]
            client.post(f"/api/v1/projects/{project.pk}/baselines/{baseline_id}/activate/")
        r = client.get(f"/api/v1/tasks/?project={project.pk}")
        assert r.status_code == 200
        tasks = r.data.get("results", r.data)
        assert any(t["baseline_start"] is not None for t in tasks)

    def test_explicit_baseline_param_overrides_active(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r1 = client.post(f"/api/v1/projects/{project.pk}/baselines/")
            b1_id = r1.data["id"]
            # Change task dates so a second baseline captures different values
            for t in tasks_with_cpm:
                t.early_start = date(2026, 5, 1)
                t.early_finish = date(2026, 5, 10)
                t.save(update_fields=["early_start", "early_finish"])
            r2 = client.post(f"/api/v1/projects/{project.pk}/baselines/")
            b2_id = r2.data["id"]
            # Activate b2
            client.post(f"/api/v1/projects/{project.pk}/baselines/{b2_id}/activate/")
        # Explicit ?baseline=b1 should return b1 dates (April), not b2 dates (May)
        r = client.get(f"/api/v1/tasks/?project={project.pk}&baseline={b1_id}")
        tasks = r.data.get("results", r.data)
        starts = [t["baseline_start"] for t in tasks if t["baseline_start"]]
        assert all(s.startswith("2026-04") for s in starts)

    def test_no_baseline_returns_null_overlay(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        tasks_with_cpm: list[Task],
    ) -> None:
        r = client.get(f"/api/v1/tasks/?project={project.pk}")
        assert r.status_code == 200
        tasks = r.data.get("results", r.data)
        assert all(t["baseline_start"] is None for t in tasks)
