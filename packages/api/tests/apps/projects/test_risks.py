"""Tests for the Risk Register API (issue #52)."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Risk,
    RiskStatus,
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
def member_user(db: object) -> object:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def viewer_user(db: object) -> object:
    return User.objects.create_user(username="viewer", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def member_client(member_user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=member_user)
    return c


@pytest.fixture
def viewer_client(viewer_user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=viewer_user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    from datetime import date

    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def owner_membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.fixture
def member_membership(member_user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)


@pytest.fixture
def viewer_membership(viewer_user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=viewer_user, role=Role.VIEWER)


@pytest.fixture
def risk(project: Project, user: object) -> Risk:
    return Risk.objects.create(
        project=project,
        title="Schedule slippage",
        probability=3,
        impact=4,
        created_by=user,
    )


@pytest.fixture
def task(project: Project) -> Task:
    from datetime import date

    return Task.objects.create(
        project=project,
        name="Foundation work",
        duration=10,
        early_start=date(2026, 4, 1),
        early_finish=date(2026, 4, 14),
    )


# ---------------------------------------------------------------------------
# CRUD: create
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRiskCreate:
    def test_owner_can_create(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = client.post(
                f"/api/v1/projects/{project.pk}/risks/",
                {"title": "Budget overrun", "probability": 2, "impact": 5},
                format="json",
            )
        assert r.status_code == 201
        assert r.data["title"] == "Budget overrun"
        assert r.data["severity"] == 10  # 2 × 5
        assert r.data["status"] == RiskStatus.OPEN

    def test_member_can_create(
        self,
        member_client: APIClient,
        project: Project,
        member_membership: ProjectMembership,
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = member_client.post(
                f"/api/v1/projects/{project.pk}/risks/",
                {"title": "Resource conflict", "probability": 4, "impact": 3},
                format="json",
            )
        assert r.status_code == 201

    def test_viewer_cannot_create(
        self,
        viewer_client: APIClient,
        project: Project,
        viewer_membership: ProjectMembership,
    ) -> None:
        r = viewer_client.post(
            f"/api/v1/projects/{project.pk}/risks/",
            {"title": "Bad risk", "probability": 1, "impact": 1},
            format="json",
        )
        assert r.status_code == 403

    def test_probability_out_of_range_rejected(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        r = client.post(
            f"/api/v1/projects/{project.pk}/risks/",
            {"title": "Bad", "probability": 6, "impact": 3},
            format="json",
        )
        assert r.status_code == 400

    def test_probability_zero_rejected(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        r = client.post(
            f"/api/v1/projects/{project.pk}/risks/",
            {"title": "Bad", "probability": 0, "impact": 3},
            format="json",
        )
        assert r.status_code == 400

    def test_impact_out_of_range_rejected(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        r = client.post(
            f"/api/v1/projects/{project.pk}/risks/",
            {"title": "Bad", "probability": 3, "impact": 0},
            format="json",
        )
        assert r.status_code == 400

    def test_created_by_set_from_request_user(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        user: object,
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = client.post(
                f"/api/v1/projects/{project.pk}/risks/",
                {"title": "Delay", "probability": 2, "impact": 2},
                format="json",
            )
        assert r.status_code == 201
        assert r.data["created_by"] == user.pk  # type: ignore[attr-defined]

    def test_broadcasts_risk_created(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast:
            client.post(
                f"/api/v1/projects/{project.pk}/risks/",
                {"title": "New risk", "probability": 1, "impact": 1},
                format="json",
            )
        event_types = [call.args[1] for call in mock_broadcast.call_args_list]
        assert "risk_created" in event_types


# ---------------------------------------------------------------------------
# CRUD: list / retrieve
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRiskRead:
    def test_viewer_can_list(
        self,
        viewer_client: APIClient,
        project: Project,
        viewer_membership: ProjectMembership,
        risk: Risk,
    ) -> None:
        r = viewer_client.get(f"/api/v1/projects/{project.pk}/risks/")
        assert r.status_code == 200
        assert len(r.data) >= 1

    def test_viewer_can_retrieve(
        self,
        viewer_client: APIClient,
        project: Project,
        viewer_membership: ProjectMembership,
        risk: Risk,
    ) -> None:
        r = viewer_client.get(f"/api/v1/projects/{project.pk}/risks/{risk.pk}/")
        assert r.status_code == 200
        assert r.data["title"] == risk.title

    def test_severity_field_is_product(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        risk: Risk,
    ) -> None:
        r = client.get(f"/api/v1/projects/{project.pk}/risks/{risk.pk}/")
        assert r.data["severity"] == risk.probability * risk.impact

    def test_status_filter(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        risk: Risk,
    ) -> None:
        # Create a second risk with RESOLVED status
        Risk.objects.create(
            project=project,
            title="Resolved risk",
            probability=1,
            impact=1,
            status=RiskStatus.RESOLVED,
        )
        r = client.get(f"/api/v1/projects/{project.pk}/risks/?status=OPEN")
        assert r.status_code == 200
        assert all(item["status"] == "OPEN" for item in r.data)

    def test_ordering_by_severity(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        Risk.objects.create(project=project, title="Low", probability=1, impact=1)
        Risk.objects.create(project=project, title="High", probability=5, impact=5)
        Risk.objects.create(project=project, title="Med", probability=3, impact=3)
        r = client.get(f"/api/v1/projects/{project.pk}/risks/?ordering=-severity")
        assert r.status_code == 200
        severities = [item["severity"] for item in r.data]
        assert severities == sorted(severities, reverse=True)


# ---------------------------------------------------------------------------
# CRUD: update
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRiskUpdate:
    def test_member_can_update_status(
        self,
        member_client: APIClient,
        project: Project,
        member_membership: ProjectMembership,
        risk: Risk,
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = member_client.patch(
                f"/api/v1/projects/{project.pk}/risks/{risk.pk}/",
                {"status": "MITIGATING"},
                format="json",
            )
        assert r.status_code == 200
        assert r.data["status"] == "MITIGATING"

    def test_viewer_cannot_update(
        self,
        viewer_client: APIClient,
        project: Project,
        viewer_membership: ProjectMembership,
        risk: Risk,
    ) -> None:
        r = viewer_client.patch(
            f"/api/v1/projects/{project.pk}/risks/{risk.pk}/",
            {"status": "RESOLVED"},
            format="json",
        )
        assert r.status_code == 403

    def test_broadcasts_risk_updated(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        risk: Risk,
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast:
            client.patch(
                f"/api/v1/projects/{project.pk}/risks/{risk.pk}/",
                {"status": "ACCEPTED"},
                format="json",
            )
        event_types = [call.args[1] for call in mock_broadcast.call_args_list]
        assert "risk_updated" in event_types


# ---------------------------------------------------------------------------
# CRUD: delete
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRiskDelete:
    def test_owner_can_delete(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        risk: Risk,
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = client.delete(f"/api/v1/projects/{project.pk}/risks/{risk.pk}/")
        assert r.status_code == 204
        assert not Risk.objects.filter(pk=risk.pk, is_deleted=False).exists()

    def test_member_cannot_delete(
        self,
        member_client: APIClient,
        project: Project,
        member_membership: ProjectMembership,
        risk: Risk,
    ) -> None:
        r = member_client.delete(f"/api/v1/projects/{project.pk}/risks/{risk.pk}/")
        assert r.status_code == 403

    def test_soft_delete_tombstone_retained(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        risk: Risk,
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            client.delete(f"/api/v1/projects/{project.pk}/risks/{risk.pk}/")
        # Row still exists but is_deleted=True
        deleted = Risk.objects.filter(pk=risk.pk, is_deleted=True)
        assert deleted.exists()

    def test_broadcasts_risk_deleted(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        risk: Risk,
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast:
            client.delete(f"/api/v1/projects/{project.pk}/risks/{risk.pk}/")
        event_types = [call.args[1] for call in mock_broadcast.call_args_list]
        assert "risk_deleted" in event_types


# ---------------------------------------------------------------------------
# Task links
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRiskTaskLinks:
    def test_can_link_tasks_on_create(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        task: Task,
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = client.post(
                f"/api/v1/projects/{project.pk}/risks/",
                {
                    "title": "Linked risk",
                    "probability": 2,
                    "impact": 3,
                    "tasks": [str(task.pk)],
                },
                format="json",
            )
        assert r.status_code == 201
        assert str(task.pk) in [str(t) for t in r.data["tasks"]]

    def test_more_than_10_tasks_rejected(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        from datetime import date

        tasks = [
            Task.objects.create(
                project=project,
                name=f"T{i}",
                duration=1,
                early_start=date(2026, 4, 1),
                early_finish=date(2026, 4, 2),
            )
            for i in range(11)
        ]
        r = client.post(
            f"/api/v1/projects/{project.pk}/risks/",
            {
                "title": "Too many links",
                "probability": 1,
                "impact": 1,
                "tasks": [str(t.pk) for t in tasks],
            },
            format="json",
        )
        assert r.status_code == 400

    def test_cross_project_task_link_rejected(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
        calendar: Calendar,
    ) -> None:
        from datetime import date

        other_project = Project.objects.create(
            name="Other", start_date=date(2026, 4, 1), calendar=calendar
        )
        other_task = Task.objects.create(
            project=other_project,
            name="Foreign task",
            duration=1,
        )
        r = client.post(
            f"/api/v1/projects/{project.pk}/risks/",
            {
                "title": "Cross-project risk",
                "probability": 1,
                "impact": 1,
                "tasks": [str(other_task.pk)],
            },
            format="json",
        )
        assert r.status_code == 400
