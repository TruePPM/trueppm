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
    RiskComment,
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
# Risk framework fields (ADR-0043 — wave 7)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRiskFrameworkFields:
    """Coverage for the risk framework extension fields: category, response,
    mitigation_due_date, trigger, contingency. All five are nullable/blank;
    existing risks created without them must remain valid.
    """

    def test_create_with_all_framework_fields(
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
                    "notes": "Discussed in 2026-05-07 standup; revisit after vendor call.",
                },
                format="json",
            )
        assert r.status_code == 201, r.data
        assert r.data["category"] == RiskCategory.EXTERNAL
        assert r.data["response"] == RiskResponse.MITIGATE
        assert r.data["mitigation_due_date"] == "2026-06-15"
        assert r.data["trigger"] == "Vendor confirms delivery slip"
        assert r.data["contingency"].startswith("Pre-source backup vendor")
        assert r.data["notes"].startswith("Discussed in 2026-05-07 standup")

    def test_create_without_framework_fields_uses_defaults(
        self,
        client: APIClient,
        project: Project,
        owner_membership: ProjectMembership,
    ) -> None:
        # Existing minimal payload must still work — framework fields default to null/empty.
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
        assert r.data["notes"] == ""

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

    def test_patch_framework_fields_on_existing_risk(
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


# ---------------------------------------------------------------------------
# RiskCommentViewSet tests (ADR-0044, issue #244)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRiskComments:
    """Tests for the append-only risk comment endpoint."""

    def _url(self, project: Project, risk: Risk) -> str:
        return f"/api/v1/projects/{project.pk}/risks/{risk.pk}/comments/"

    def test_viewer_can_list_comments(
        self,
        viewer_client: APIClient,
        project: Project,
        risk: Risk,
        viewer_membership: ProjectMembership,
    ) -> None:
        r = viewer_client.get(self._url(project, risk))
        assert r.status_code == 200
        assert r.data["results"] == []

    def test_member_can_post_comment(
        self,
        member_client: APIClient,
        project: Project,
        risk: Risk,
        member_membership: ProjectMembership,
    ) -> None:
        r = member_client.post(
            self._url(project, risk),
            {"message": "Discussed with stakeholders."},
            format="json",
        )
        assert r.status_code == 201
        assert r.data["message"] == "Discussed with stakeholders."
        assert "created_at" in r.data
        assert r.data["author"]["display_name"] == "member"

    def test_viewer_cannot_post_comment(
        self,
        viewer_client: APIClient,
        project: Project,
        risk: Risk,
        viewer_membership: ProjectMembership,
    ) -> None:
        r = viewer_client.post(
            self._url(project, risk),
            {"message": "Just looking"},
            format="json",
        )
        assert r.status_code == 403

    def test_unauthenticated_cannot_list(
        self,
        project: Project,
        risk: Risk,
    ) -> None:
        r = APIClient().get(self._url(project, risk))
        assert r.status_code in (401, 403)

    def test_blank_message_rejected(
        self,
        member_client: APIClient,
        project: Project,
        risk: Risk,
        member_membership: ProjectMembership,
    ) -> None:
        r = member_client.post(
            self._url(project, risk),
            {"message": "   "},
            format="json",
        )
        assert r.status_code == 400
        assert "message" in r.data

    def test_comments_ordered_chronologically(
        self,
        member_client: APIClient,
        project: Project,
        risk: Risk,
        member_user: object,
        member_membership: ProjectMembership,
    ) -> None:
        RiskComment.objects.create(risk=risk, author=member_user, message="First")
        RiskComment.objects.create(risk=risk, author=member_user, message="Second")
        r = member_client.get(self._url(project, risk))
        assert r.status_code == 200
        messages = [c["message"] for c in r.data["results"]]
        assert messages == ["First", "Second"]

    def test_cross_project_isolation(
        self,
        member_client: APIClient,
        project: Project,
        risk: Risk,
        member_membership: ProjectMembership,
        calendar: Calendar,
    ) -> None:
        from datetime import date

        other_project = Project.objects.create(
            name="Other", start_date=date(2026, 1, 1), calendar=calendar
        )
        other_risk = Risk.objects.create(
            project=other_project, title="Other risk", probability=1, impact=1
        )
        r = member_client.get(
            f"/api/v1/projects/{other_project.pk}/risks/{other_risk.pk}/comments/"
        )
        # #254: project-nested routes return 403 to non-members so project IDs
        # cannot be probed by enumeration. Empty 200 was the prior IDOR-prone
        # behavior; membership is now enforced at has_permission.
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# #929 — dedicated decimal risk short_id (counter, display, qualified, backfill)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRiskShortId:
    """Risks use a dedicated decimal counter and server-owned display ids (#929).

    The 0.2 regression was three web formatters independently mis-parsing the
    shared 8-char hex ``short_id`` and collapsing every risk to ``R-0000``. The
    fix moves risks onto ``Project.risk_sequence`` (decimal) and serves the
    ``R-007`` / ``<CODE>-R-007`` forms from the API.
    """

    def test_new_risks_get_contiguous_decimal_short_ids(self, project: Project) -> None:
        r1 = Risk.objects.create(project=project, title="A", probability=1, impact=1)
        r2 = Risk.objects.create(project=project, title="B", probability=1, impact=1)
        r3 = Risk.objects.create(project=project, title="C", probability=1, impact=1)
        assert [r1.short_id, r2.short_id, r3.short_id] == ["1", "2", "3"]
        project.refresh_from_db()
        assert project.risk_sequence == 3

    def test_risk_counter_is_independent_of_task_and_sprint(self, project: Project) -> None:
        # Tasks/Sprints stay on the shared hex object_sequence; creating them must
        # not consume risk numbers (the whole point of the dedicated counter).
        from datetime import date

        Task.objects.create(
            project=project,
            name="T",
            duration=1,
            early_start=date(2026, 4, 1),
            early_finish=date(2026, 4, 2),
        )
        r1 = Risk.objects.create(project=project, title="A", probability=1, impact=1)
        assert r1.short_id == "1"  # not "2" — the task didn't bump the risk counter

    def test_short_id_display_is_zero_padded_to_three(
        self, client: APIClient, project: Project, owner_membership: ProjectMembership
    ) -> None:
        risk = Risk.objects.create(project=project, title="A", probability=1, impact=1)
        r = client.get(f"/api/v1/projects/{project.pk}/risks/{risk.pk}/")
        assert r.status_code == 200
        assert r.data["short_id"] == "1"
        assert r.data["short_id_display"] == "R-001"

    def test_short_id_display_overflows_naturally_past_999(self, project: Project) -> None:
        from trueppm_api.apps.projects.serializers import RiskSerializer

        project.risk_sequence = 999
        project.save(update_fields=["risk_sequence"])
        risk = Risk.objects.create(project=project, title="A", probability=1, impact=1)
        assert risk.short_id == "1000"
        assert RiskSerializer(risk).data["short_id_display"] == "R-1000"

    def test_qualified_id_uses_project_code_when_present(
        self, client: APIClient, project: Project, owner_membership: ProjectMembership
    ) -> None:
        project.code = "PLAT"
        project.save(update_fields=["code"])
        risk = Risk.objects.create(project=project, title="A", probability=1, impact=1)
        r = client.get(f"/api/v1/projects/{project.pk}/risks/{risk.pk}/")
        assert r.data["qualified_id"] == "PLAT-R-001"

    def test_qualified_id_falls_back_to_compact_without_code(
        self, client: APIClient, project: Project, owner_membership: ProjectMembership
    ) -> None:
        assert project.code == ""  # default
        risk = Risk.objects.create(project=project, title="A", probability=1, impact=1)
        r = client.get(f"/api/v1/projects/{project.pk}/risks/{risk.pk}/")
        assert r.data["qualified_id"] == "R-001"

    def test_short_id_is_immutable_across_updates(self, project: Project) -> None:
        risk = Risk.objects.create(project=project, title="A", probability=1, impact=1)
        original = risk.short_id
        risk.title = "A renamed"
        risk.impact = 5
        risk.save()
        risk.refresh_from_db()
        assert risk.short_id == original == "1"

    def test_numbers_are_not_reused_after_deletion(self, project: Project) -> None:
        r1 = Risk.objects.create(project=project, title="A", probability=1, impact=1)
        r2 = Risk.objects.create(project=project, title="B", probability=1, impact=1)
        Risk.objects.create(project=project, title="C", probability=1, impact=1)
        r2.soft_delete()  # leaves a gap at R-002
        r4 = Risk.objects.create(project=project, title="D", probability=1, impact=1)
        assert r4.short_id == "4"  # not "2" — deleted numbers are tombstoned
        assert r1.short_id == "1"

    def test_backfill_renumbers_existing_hex_short_ids(self, project: Project) -> None:
        """The 0073 data migration converts hex short_ids to contiguous decimals."""
        import importlib
        from datetime import UTC, datetime

        from django.apps import apps as django_apps

        # Simulate the pre-migration state: risks carrying hex short_ids from the
        # shared counter, with risk_sequence still 0. Pin distinct created_at so
        # the backfill ordering is deterministic. Include a soft-deleted risk in
        # the middle — it must consume a number so live risks keep their gap.
        r_a = Risk.objects.create(project=project, title="A", probability=1, impact=1)
        r_b = Risk.objects.create(project=project, title="B", probability=1, impact=1)
        r_c = Risk.objects.create(project=project, title="C", probability=1, impact=1)
        for i, r in enumerate([r_a, r_b, r_c]):
            Risk.objects.filter(pk=r.pk).update(
                short_id=f"{(i + 10):08X}",  # hex with letters → old R-0000 bug
                created_at=datetime(2026, 1, 1 + i, tzinfo=UTC),
            )
        Risk.objects.filter(pk=r_b.pk).update(is_deleted=True)
        Project.objects.filter(pk=project.pk).update(risk_sequence=0)
        versions_before = {r.pk: r.server_version for r in Risk.objects.filter(project=project)}

        migration = importlib.import_module(
            "trueppm_api.apps.projects.migrations.0073_risk_decimal_short_id"
        )
        migration.backfill_risk_short_ids(django_apps, None)

        r_a.refresh_from_db()
        r_b.refresh_from_db()
        r_c.refresh_from_db()
        # Ordered by created_at; the soft-deleted r_b keeps its slot (gap for live).
        assert r_a.short_id == "1"
        assert r_b.short_id == "2"  # soft-deleted but still numbered
        assert r_c.short_id == "3"
        project.refresh_from_db()
        assert project.risk_sequence == 3
        # server_version bumped so sync clients re-pull the corrected ids.
        for r in Risk.objects.filter(project=project):
            assert r.server_version == versions_before[r.pk] + 1
