"""API tests for the workshops app — session lifecycle and phase reorder."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.workshops.models import WorkshopSession


@pytest.fixture
def user(db: object) -> object:
    User = get_user_model()
    return User.objects.create_user(username="workshopuser", password="pw")


@pytest.fixture
def other_user(db: object) -> object:
    User = get_user_model()
    return User.objects.create_user(username="otheruser", password="pw")


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
    return Project.objects.create(name="WS Project", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def admin_membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)


@pytest.fixture
def member_membership(other_user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=other_user, role=Role.MEMBER)


# ---------------------------------------------------------------------------
# WorkshopStartView
# ---------------------------------------------------------------------------


class TestWorkshopStart:
    def test_admin_can_start(
        self, client: APIClient, project: Project, admin_membership: ProjectMembership
    ) -> None:
        res = client.post(f"/api/v1/projects/{project.pk}/workshop/start/")
        assert res.status_code == 201
        data = res.json()
        assert data["project_id"] == str(project.pk)
        assert data["ended_at"] is None

    def test_start_creates_db_session(
        self, client: APIClient, project: Project, admin_membership: ProjectMembership
    ) -> None:
        client.post(f"/api/v1/projects/{project.pk}/workshop/start/")
        assert WorkshopSession.objects.filter(project=project, ended_at__isnull=True).exists()

    def test_second_start_returns_409(
        self, client: APIClient, project: Project, admin_membership: ProjectMembership
    ) -> None:
        client.post(f"/api/v1/projects/{project.pk}/workshop/start/")
        res = client.post(f"/api/v1/projects/{project.pk}/workshop/start/")
        assert res.status_code == 409

    def test_member_cannot_start(
        self, project: Project, other_user: object, member_membership: ProjectMembership
    ) -> None:
        c = APIClient()
        c.force_authenticate(user=other_user)
        res = c.post(f"/api/v1/projects/{project.pk}/workshop/start/")
        assert res.status_code == 403

    def test_unauthenticated_returns_401(self, project: Project) -> None:
        c = APIClient()
        res = c.post(f"/api/v1/projects/{project.pk}/workshop/start/")
        assert res.status_code == 401


# ---------------------------------------------------------------------------
# WorkshopEndView
# ---------------------------------------------------------------------------


class TestWorkshopEnd:
    @pytest.fixture
    def active_session(self, project: Project, user: object) -> WorkshopSession:
        return WorkshopSession.objects.create(project=project, started_by=user)

    def test_admin_can_end(
        self,
        client: APIClient,
        project: Project,
        admin_membership: ProjectMembership,
        active_session: WorkshopSession,
    ) -> None:
        res = client.post(f"/api/v1/projects/{project.pk}/workshop/end/")
        assert res.status_code == 200
        active_session.refresh_from_db()
        assert active_session.ended_at is not None

    def test_end_is_idempotent(
        self,
        client: APIClient,
        project: Project,
        admin_membership: ProjectMembership,
        active_session: WorkshopSession,
    ) -> None:
        client.post(f"/api/v1/projects/{project.pk}/workshop/end/")
        res = client.post(f"/api/v1/projects/{project.pk}/workshop/end/")
        # Second call returns 404 because there's no active session any more.
        assert res.status_code == 404

    def test_no_active_session_returns_404(
        self, client: APIClient, project: Project, admin_membership: ProjectMembership
    ) -> None:
        res = client.post(f"/api/v1/projects/{project.pk}/workshop/end/")
        assert res.status_code == 404

    def test_session_owner_can_end(
        self, project: Project, user: object, admin_membership: ProjectMembership
    ) -> None:
        """The user who started the session can end it even without ADMIN role."""
        session = WorkshopSession.objects.create(project=project, started_by=user)
        # Downgrade membership to MEMBER
        admin_membership.role = Role.MEMBER
        admin_membership.save()

        c = APIClient()
        c.force_authenticate(user=user)
        res = c.post(f"/api/v1/projects/{project.pk}/workshop/end/")
        assert res.status_code == 200
        session.refresh_from_db()
        assert session.ended_at is not None

    def test_non_owner_member_cannot_end(
        self,
        project: Project,
        user: object,
        other_user: object,
        admin_membership: ProjectMembership,
        member_membership: ProjectMembership,
    ) -> None:
        """A MEMBER who did not start the session must be rejected."""
        WorkshopSession.objects.create(project=project, started_by=user)
        c = APIClient()
        c.force_authenticate(user=other_user)
        res = c.post(f"/api/v1/projects/{project.pk}/workshop/end/")
        assert res.status_code == 403

    def test_unauthenticated_returns_401(self, project: Project) -> None:
        res = APIClient().post(f"/api/v1/projects/{project.pk}/workshop/end/")
        assert res.status_code == 401

    def test_non_member_cannot_end(
        self, project: Project, other_user: object, user: object
    ) -> None:
        """A user with no project membership must not learn whether a session exists."""
        WorkshopSession.objects.create(project=project, started_by=user)
        c = APIClient()
        c.force_authenticate(user=other_user)
        res = c.post(f"/api/v1/projects/{project.pk}/workshop/end/")
        # Must be 403, not 404 — non-members must not enumerate session existence.
        assert res.status_code == 403


# ---------------------------------------------------------------------------
# WorkshopForceEndView
# ---------------------------------------------------------------------------


class TestWorkshopForceEnd:
    @pytest.fixture
    def active_session(self, project: Project, user: object) -> WorkshopSession:
        return WorkshopSession.objects.create(project=project, started_by=user)

    def test_admin_can_force_end(
        self,
        client: APIClient,
        project: Project,
        admin_membership: ProjectMembership,
        active_session: WorkshopSession,
    ) -> None:
        res = client.post(f"/api/v1/projects/{project.pk}/workshop/force-end/")
        assert res.status_code == 200
        active_session.refresh_from_db()
        assert active_session.ended_at is not None

    def test_non_admin_returns_403(
        self, project: Project, other_user: object, member_membership: ProjectMembership
    ) -> None:
        c = APIClient()
        c.force_authenticate(user=other_user)
        res = c.post(f"/api/v1/projects/{project.pk}/workshop/force-end/")
        assert res.status_code == 403

    def test_unauthenticated_returns_401(self, project: Project) -> None:
        res = APIClient().post(f"/api/v1/projects/{project.pk}/workshop/force-end/")
        assert res.status_code == 401

    def test_no_active_session_returns_404(
        self, client: APIClient, project: Project, admin_membership: ProjectMembership
    ) -> None:
        res = client.post(f"/api/v1/projects/{project.pk}/workshop/force-end/")
        assert res.status_code == 404


# ---------------------------------------------------------------------------
# WorkshopCurrentView
# ---------------------------------------------------------------------------


class TestWorkshopCurrent:
    def test_returns_session_when_active(
        self, client: APIClient, project: Project, user: object, admin_membership: ProjectMembership
    ) -> None:
        WorkshopSession.objects.create(project=project, started_by=user)
        res = client.get(f"/api/v1/projects/{project.pk}/workshop/current/")
        assert res.status_code == 200
        assert res.json()["ended_at"] is None

    def test_returns_404_when_no_session(
        self, client: APIClient, project: Project, admin_membership: ProjectMembership
    ) -> None:
        res = client.get(f"/api/v1/projects/{project.pk}/workshop/current/")
        assert res.status_code == 404

    def test_member_can_read(
        self,
        project: Project,
        user: object,
        other_user: object,
        member_membership: ProjectMembership,
    ) -> None:
        WorkshopSession.objects.create(project=project, started_by=user)
        c = APIClient()
        c.force_authenticate(user=other_user)
        res = c.get(f"/api/v1/projects/{project.pk}/workshop/current/")
        assert res.status_code == 200

    def test_unauthenticated_returns_401(self, project: Project) -> None:
        res = APIClient().get(f"/api/v1/projects/{project.pk}/workshop/current/")
        assert res.status_code == 401


# ---------------------------------------------------------------------------
# PhaseReorderView
# ---------------------------------------------------------------------------


class TestPhaseReorder:
    @pytest.fixture
    def phases(self, project: Project) -> list[Task]:
        """Two root-level tasks acting as phase columns."""
        t1 = Task.objects.create(project=project, name="Phase 1", wbs_path="1", duration=0)
        t2 = Task.objects.create(project=project, name="Phase 2", wbs_path="2", duration=0)
        return [t1, t2]

    def test_member_can_reorder(
        self,
        client: APIClient,
        project: Project,
        admin_membership: ProjectMembership,
        phases: list[Task],
    ) -> None:
        ordered = [str(phases[1].pk), str(phases[0].pk)]
        res = client.patch(
            f"/api/v1/projects/{project.pk}/phases/reorder/",
            data={"ordered_ids": ordered},
            format="json",
        )
        assert res.status_code == 200
        phases[1].refresh_from_db()
        phases[0].refresh_from_db()
        # Phase 2 should now have rank 10 (first position); Phase 1 rank 20.
        assert phases[1].priority_rank == 10
        assert phases[0].priority_rank == 20

    def test_unknown_id_returns_400(
        self,
        client: APIClient,
        project: Project,
        admin_membership: ProjectMembership,
        phases: list[Task],
    ) -> None:
        import uuid

        res = client.patch(
            f"/api/v1/projects/{project.pk}/phases/reorder/",
            data={"ordered_ids": [str(uuid.uuid4())]},
            format="json",
        )
        assert res.status_code == 400

    def test_empty_list_returns_400(
        self,
        client: APIClient,
        project: Project,
        admin_membership: ProjectMembership,
    ) -> None:
        res = client.patch(
            f"/api/v1/projects/{project.pk}/phases/reorder/",
            data={"ordered_ids": []},
            format="json",
        )
        assert res.status_code == 400

    def test_viewer_cannot_reorder(
        self,
        project: Project,
        other_user: object,
        phases: list[Task],
    ) -> None:
        ProjectMembership.objects.create(project=project, user=other_user, role=Role.VIEWER)
        c = APIClient()
        c.force_authenticate(user=other_user)
        res = c.patch(
            f"/api/v1/projects/{project.pk}/phases/reorder/",
            data={"ordered_ids": [str(phases[0].pk), str(phases[1].pk)]},
            format="json",
        )
        assert res.status_code == 403

    def test_unauthenticated_returns_401(self, project: Project, phases: list[Task]) -> None:
        res = APIClient().patch(
            f"/api/v1/projects/{project.pk}/phases/reorder/",
            data={"ordered_ids": [str(phases[0].pk), str(phases[1].pk)]},
            format="json",
        )
        assert res.status_code == 401

    def test_non_member_returns_403(
        self,
        project: Project,
        other_user: object,
        phases: list[Task],
    ) -> None:
        c = APIClient()
        c.force_authenticate(user=other_user)
        res = c.patch(
            f"/api/v1/projects/{project.pk}/phases/reorder/",
            data={"ordered_ids": [str(phases[0].pk), str(phases[1].pk)]},
            format="json",
        )
        assert res.status_code == 403
