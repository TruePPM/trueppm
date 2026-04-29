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
    RiskCategory,
    RiskResponse,
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

    @pytest.mark.django_db(transaction=True)
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
        assert len(r.data["results"]) >= 1

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
        assert all(item["status"] == "OPEN" for item in r.data["results"])

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
        severities = [item["severity"] for item in r.data["results"]]
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

    @pytest.mark.django_db(transaction=True)
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

    @pytest.mark.django_db(transaction=True)
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


# ---------------------------------------------------------------------------
# PMI framework fields (ADR-0043 — wave 7)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRiskPMIFields:
    """Coverage for the PMI extension fields: category, response,
    mitigation_due_date, trigger, contingency. All five are nullable/blank;
    existing risks created without them must remain valid.
    """

    def test_create_with_all_pmi_fields(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = client.post(
                f"/api/v1/projects/{project.pk}/risks/",
                {
                    "title": "Vendor delay",
                    "probability": 3,
                    "impact": 4,
                    "category": RiskCategory.EXTERNAL,
                    "response": RiskResponse.MITIGATE,
                    "mitigation_due_date": "2026-06-15",
                    "trigger": "Vendor confirms delivery slip",
                    "contingency": "Pre-source backup vendor; reserve $20k",
                },
                format="json",
            )
        assert r.status_code == 201, r.data
        assert r.data["category"] == RiskCategory.EXTERNAL
        assert r.data["response"] == RiskResponse.MITIGATE
        assert r.data["mitigation_due_date"] == "2026-06-15"
        assert r.data["trigger"] == "Vendor confirms delivery slip"
        assert r.data["contingency"].startswith("Pre-source backup vendor")

    def test_create_without_pmi_fields_uses_defaults(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        # Existing minimal payload must still work — PMI fields default to null/empty.
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = client.post(
                f"/api/v1/projects/{project.pk}/risks/",
                {"title": "Minimal", "probability": 1, "impact": 1},
                format="json",
            )
        assert r.status_code == 201
        assert r.data["category"] is None
        assert r.data["response"] is None
        assert r.data["mitigation_due_date"] is None
        assert r.data["trigger"] == ""
        assert r.data["contingency"] == ""

    def test_invalid_category_choice_rejected(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        r = client.post(
            f"/api/v1/projects/{project.pk}/risks/",
            {
                "title": "Bad category",
                "probability": 1,
                "impact": 1,
                "category": "NOT_A_VALID_CATEGORY",
            },
            format="json",
        )
        assert r.status_code == 400
        assert "category" in r.data

    def test_invalid_response_choice_rejected(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        # Crucially, "ACCEPTED" (the status value) must NOT be a valid response
        # — they are different vocabularies. Response uses bare verbs (ACCEPT).
        r = client.post(
            f"/api/v1/projects/{project.pk}/risks/",
            {
                "title": "Wrong response value",
                "probability": 1,
                "impact": 1,
                "response": "ACCEPTED",
            },
            format="json",
        )
        assert r.status_code == 400
        assert "response" in r.data

    def test_response_accept_is_distinct_from_status_accepted(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        # A risk can have status=ACCEPTED (lifecycle) and response=ACCEPT (strategy)
        # simultaneously — they describe different things and must coexist.
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = client.post(
                f"/api/v1/projects/{project.pk}/risks/",
                {
                    "title": "Acknowledged risk",
                    "probability": 1,
                    "impact": 2,
                    "status": RiskStatus.ACCEPTED,
                    "response": RiskResponse.ACCEPT,
                },
                format="json",
            )
        assert r.status_code == 201, r.data
        assert r.data["status"] == RiskStatus.ACCEPTED
        assert r.data["response"] == RiskResponse.ACCEPT

    def test_patch_pmi_fields_on_existing_risk(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        risk = Risk.objects.create(
            project=project,
            title="Pre-existing",
            probability=2,
            impact=3,
        )
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
            r = client.patch(
                f"/api/v1/projects/{project.pk}/risks/{risk.pk}/",
                {
                    "category": RiskCategory.TECHNICAL,
                    "trigger": "If load test exceeds 200ms p99",
                },
                format="json",
            )
        assert r.status_code == 200, r.data
        assert r.data["category"] == RiskCategory.TECHNICAL
        assert r.data["trigger"] == "If load test exceeds 200ms p99"
        # Untouched fields stay intact
        assert r.data["response"] is None
        assert r.data["mitigation_due_date"] is None

    def test_invalid_mitigation_due_date_format_rejected(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        r = client.post(
            f"/api/v1/projects/{project.pk}/risks/",
            {
                "title": "Bad date",
                "probability": 1,
                "impact": 1,
                "mitigation_due_date": "not-a-date",
            },
            format="json",
        )
        assert r.status_code == 400
        assert "mitigation_due_date" in r.data
