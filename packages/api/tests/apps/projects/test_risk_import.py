"""Tests for risk register CSV import (issue 223, ADR-0043 addendum).

Two layers:
  * ``TestParseRiskCsv`` — the pure parser/validator (no DB), exercising the
    row policy (errors skip, warnings coerce) and the file-level guards.
  * ``TestRiskImportEndpoint`` — the ``POST .../risks/import/`` action: RBAC,
    owner matching scoped to members, partial success, limits, and the single
    batched broadcast.
"""

from __future__ import annotations

import csv
import io
from collections.abc import Callable
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Risk,
    RiskCategory,
    RiskResponse,
    RiskStatus,
)
from trueppm_api.apps.projects.risk_import import (
    MAX_ROWS,
    RiskImportError,
    build_owner_index,
    parse_risk_csv,
)

User = get_user_model()

_HEADER = [
    "Title",
    "Status",
    "Category",
    "Response",
    "P",
    "I",
    "Owner",
    "Mitigation Due Date",
    "Trigger",
    "Contingency",
    "Description",
]


def _csv(*rows: list[str], header: list[str] | None = None) -> bytes:
    """Serialize a header + data rows to CSV bytes (UTF-8)."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header if header is not None else _HEADER)
    writer.writerows(rows)
    return buf.getvalue().encode("utf-8")


# ---------------------------------------------------------------------------
# Pure parser
# ---------------------------------------------------------------------------


class TestParseRiskCsv:
    def test_happy_path_two_rows(self) -> None:
        raw = _csv(
            ["Budget overrun", "Open", "Technical", "Mitigate", "2", "5", "", "", "", "", "Costs"],
            ["Scope creep", "Mitigating", "External", "Avoid", "3", "4", "", "", "", "", ""],
        )
        plan = parse_risk_csv(raw, {})
        assert len(plan.drafts) == 2
        assert plan.errors == []
        assert plan.warnings == []
        first = plan.drafts[0]
        assert first.title == "Budget overrun"
        assert first.status == RiskStatus.OPEN
        assert first.category == RiskCategory.TECHNICAL
        assert first.response == RiskResponse.MITIGATE
        assert first.probability == 2
        assert first.impact == 5
        assert first.description == "Costs"

    def test_accepts_raw_enum_values_and_labels(self) -> None:
        # Raw value ("MITIGATING") and label ("Project Management") both resolve.
        raw = _csv(
            ["A", "MITIGATING", "Project Management", "ACCEPT", "1", "1", "", "", "", "", ""],
        )
        plan = parse_risk_csv(raw, {})
        assert plan.warnings == []
        draft = plan.drafts[0]
        assert draft.status == RiskStatus.MITIGATING
        assert draft.category == RiskCategory.PROJECT_MANAGEMENT
        assert draft.response == RiskResponse.ACCEPT

    def test_export_artifact_columns_ignored(self) -> None:
        # A verbatim export carries ID + Severity columns; they round-trip in.
        header = ["ID", "Title", "Severity", "P", "I"]
        plan = parse_risk_csv(_csv(["R-1", "Roundtrip", "9", "3", "3"], header=header), {})
        assert len(plan.drafts) == 1
        assert plan.drafts[0].title == "Roundtrip"
        assert plan.warnings == []

    def test_missing_title_column_raises(self) -> None:
        with pytest.raises(RiskImportError, match="Title"):
            parse_risk_csv(_csv(["x"], header=["Status", "P", "I"]), {})

    def test_empty_file_raises(self) -> None:
        with pytest.raises(RiskImportError, match="empty"):
            parse_risk_csv(b"", {})

    def test_header_only_raises(self) -> None:
        with pytest.raises(RiskImportError, match="No data rows"):
            parse_risk_csv(_csv(), {})

    def test_blank_title_row_is_error_and_skipped(self) -> None:
        raw = _csv(
            ["", "Open", "", "", "2", "2", "", "", "", "", ""],
            ["Valid", "Open", "", "", "2", "2", "", "", "", "", ""],
        )
        plan = parse_risk_csv(raw, {})
        assert len(plan.drafts) == 1
        assert plan.skipped == 1
        assert plan.errors[0].row == 2
        assert plan.errors[0].field == "Title"

    def test_probability_out_of_range_is_error(self) -> None:
        plan = parse_risk_csv(_csv(["A", "Open", "", "", "6", "2", "", "", "", "", ""]), {})
        assert plan.drafts == []
        assert plan.skipped == 1
        assert any(e.field == "P" and "between 1 and 5" in e.message for e in plan.errors)

    def test_probability_non_numeric_is_error(self) -> None:
        plan = parse_risk_csv(_csv(["A", "Open", "", "", "high", "2", "", "", "", "", ""]), {})
        assert plan.drafts == []
        assert any(e.field == "P" and "whole number" in e.message for e in plan.errors)

    def test_blank_pi_defaults_to_one_with_warning(self) -> None:
        plan = parse_risk_csv(_csv(["A", "Open", "", "", "", "", "", "", "", "", ""]), {})
        assert len(plan.drafts) == 1
        assert plan.drafts[0].probability == 1
        assert plan.drafts[0].impact == 1
        assert {w.field for w in plan.warnings} == {"P", "I"}

    def test_unrecognized_status_warns_and_defaults_open(self) -> None:
        plan = parse_risk_csv(_csv(["A", "Wibble", "", "", "2", "2", "", "", "", "", ""]), {})
        assert plan.drafts[0].status == RiskStatus.OPEN
        assert any(w.field == "Status" for w in plan.warnings)

    def test_unrecognized_category_and_response_warn_and_blank(self) -> None:
        plan = parse_risk_csv(_csv(["A", "Open", "Nope", "Huh", "2", "2", "", "", "", "", ""]), {})
        assert plan.drafts[0].category is None
        assert plan.drafts[0].response is None
        assert {w.field for w in plan.warnings} == {"Category", "Response"}

    @pytest.mark.parametrize("value", ["2026-06-09", "Jun 9, 2026", "June 9, 2026"])
    def test_date_formats_parse(self, value: str) -> None:
        plan = parse_risk_csv(_csv(["A", "Open", "", "", "2", "2", "", value, "", "", ""]), {})
        d = plan.drafts[0].mitigation_due_date
        assert d is not None and d.isoformat() == "2026-06-09"

    def test_bad_date_warns_and_blanks(self) -> None:
        plan = parse_risk_csv(
            _csv(["A", "Open", "", "", "2", "2", "", "not-a-date", "", "", ""]), {}
        )
        assert plan.drafts[0].mitigation_due_date is None
        assert any(w.field == "Mitigation Due Date" for w in plan.warnings)

    def test_unmatched_owner_warns_and_unassigns(self) -> None:
        plan = parse_risk_csv(
            _csv(["A", "Open", "", "", "2", "2", "ghost@example.com", "", "", "", ""]), {}
        )
        assert plan.drafts[0].owner is None
        assert any(w.field == "Owner" for w in plan.warnings)

    def test_skipped_counts_distinct_rows_not_issues(self) -> None:
        # A single row with two bad fields counts as one skipped row.
        plan = parse_risk_csv(_csv(["A", "Open", "", "", "9", "9", "", "", "", "", ""]), {})
        assert plan.drafts == []
        assert len(plan.errors) == 2
        assert plan.skipped == 1

    def test_too_many_rows_raises(self) -> None:
        rows = [["R", "Open", "", "", "1", "1", "", "", "", "", ""] for _ in range(MAX_ROWS + 1)]
        with pytest.raises(RiskImportError, match="Too many rows"):
            parse_risk_csv(_csv(*rows), {})

    def test_utf8_bom_is_stripped(self) -> None:
        # The export prepends a BOM; the first header cell must still match.
        raw = b"\xef\xbb\xbf" + _csv(["A", "Open", "", "", "2", "2", "", "", "", "", ""])
        plan = parse_risk_csv(raw, {})
        assert len(plan.drafts) == 1
        assert plan.drafts[0].title == "A"


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="owner", password="pw", email="owner@example.com")


@pytest.fixture
def member_user(db: object) -> Any:
    return User.objects.create_user(username="member", password="pw", email="member@example.com")


@pytest.fixture
def viewer_user(db: object) -> Any:
    return User.objects.create_user(username="viewer", password="pw")


@pytest.fixture
def outsider(db: object) -> Any:
    return User.objects.create_user(username="outsider", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    from datetime import date

    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def member_membership(member_user: Any, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)


@pytest.fixture
def viewer_membership(viewer_user: Any, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=viewer_user, role=Role.VIEWER)


@pytest.fixture
def member_client(member_user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=member_user)
    return c


@pytest.fixture
def viewer_client(viewer_user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=viewer_user)
    return c


@pytest.fixture
def outsider_client(outsider: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=outsider)
    return c


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/risks/import/"


def _upload(content: bytes, name: str = "risks.csv") -> SimpleUploadedFile:
    return SimpleUploadedFile(name, content, content_type="text/csv")


@pytest.mark.django_db
class TestRiskImportEndpoint:
    def test_member_can_import(
        self,
        member_client: APIClient,
        project: Project,
        member_membership: ProjectMembership,
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        raw = _csv(
            ["Budget overrun", "Open", "Technical", "Mitigate", "2", "5", "", "", "", "", ""],
            ["Scope creep", "Mitigating", "External", "Avoid", "3", "4", "", "", "", "", ""],
        )
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast,
            django_capture_on_commit_callbacks(execute=True),
        ):
            r = member_client.post(_url(project), {"file": _upload(raw)}, format="multipart")
        assert r.status_code == 200
        assert r.data["imported"] == 2
        assert r.data["skipped"] == 0
        assert Risk.objects.filter(project=project, is_deleted=False).count() == 2
        # Exactly one batched broadcast, not one per row.
        broadcast.assert_called_once()
        args = broadcast.call_args[0]
        assert args[0] == str(project.pk)
        assert args[1] == "risks_imported"
        assert args[2]["count"] == 2

    def test_viewer_cannot_import(
        self,
        viewer_client: APIClient,
        project: Project,
        viewer_membership: ProjectMembership,
    ) -> None:
        raw = _csv(["A", "Open", "", "", "2", "2", "", "", "", "", ""])
        r = viewer_client.post(_url(project), {"file": _upload(raw)}, format="multipart")
        assert r.status_code == 403
        assert Risk.objects.filter(project=project).count() == 0

    def test_outsider_cannot_import(
        self,
        outsider_client: APIClient,
        project: Project,
    ) -> None:
        raw = _csv(["A", "Open", "", "", "2", "2", "", "", "", "", ""])
        r = outsider_client.post(_url(project), {"file": _upload(raw)}, format="multipart")
        assert r.status_code in (403, 404)
        assert Risk.objects.filter(project=project).count() == 0

    def test_owner_matched_by_username_email_and_uuid(
        self,
        member_client: APIClient,
        member_user: Any,
        project: Project,
        member_membership: ProjectMembership,
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        raw = _csv(
            ["By username", "Open", "", "", "2", "2", "member", "", "", "", ""],
            ["By email", "Open", "", "", "2", "2", "member@example.com", "", "", "", ""],
            ["By uuid", "Open", "", "", "2", "2", str(member_user.pk), "", "", "", ""],
        )
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
            django_capture_on_commit_callbacks(execute=True),
        ):
            r = member_client.post(_url(project), {"file": _upload(raw)}, format="multipart")
        assert r.status_code == 200
        assert r.data["imported"] == 3
        owners = set(Risk.objects.filter(project=project).values_list("owner_id", flat=True))
        assert owners == {member_user.pk}

    def test_owner_outside_project_is_not_matched(
        self,
        member_client: APIClient,
        outsider: Any,
        project: Project,
        member_membership: ProjectMembership,
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        # A non-member email must NOT be assignable (no cross-project assignment).
        raw = _csv(["A", "Open", "", "", "2", "2", "outsider", "", "", "", ""])
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
            django_capture_on_commit_callbacks(execute=True),
        ):
            r = member_client.post(_url(project), {"file": _upload(raw)}, format="multipart")
        assert r.status_code == 200
        assert r.data["imported"] == 1
        assert Risk.objects.get(project=project).owner_id is None
        assert any(w["field"] == "Owner" for w in r.data["warnings"])

    def test_partial_success(
        self,
        member_client: APIClient,
        project: Project,
        member_membership: ProjectMembership,
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        raw = _csv(
            ["Good", "Open", "", "", "2", "2", "", "", "", "", ""],
            ["", "Open", "", "", "2", "2", "", "", "", "", ""],  # missing title
            ["Bad PI", "Open", "", "", "9", "2", "", "", "", "", ""],  # P out of range
        )
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"),
            django_capture_on_commit_callbacks(execute=True),
        ):
            r = member_client.post(_url(project), {"file": _upload(raw)}, format="multipart")
        assert r.status_code == 200
        assert r.data["imported"] == 1
        assert r.data["skipped"] == 2
        assert len(r.data["errors"]) == 2
        assert Risk.objects.filter(project=project).count() == 1

    def test_no_import_sends_no_broadcast(
        self,
        member_client: APIClient,
        project: Project,
        member_membership: ProjectMembership,
        django_capture_on_commit_callbacks: Callable[..., Any],
    ) -> None:
        raw = _csv(["", "Open", "", "", "2", "2", "", "", "", "", ""])  # only bad rows
        with (
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast,
            django_capture_on_commit_callbacks(execute=True),
        ):
            r = member_client.post(_url(project), {"file": _upload(raw)}, format="multipart")
        assert r.status_code == 200
        assert r.data["imported"] == 0
        broadcast.assert_not_called()

    def test_missing_file_returns_400(
        self,
        member_client: APIClient,
        project: Project,
        member_membership: ProjectMembership,
    ) -> None:
        r = member_client.post(_url(project), {}, format="multipart")
        assert r.status_code == 400
        assert "file" in r.data["detail"].lower()

    def test_file_too_large_returns_400(
        self,
        member_client: APIClient,
        project: Project,
        member_membership: ProjectMembership,
    ) -> None:
        big = b"Title\n" + b"a\n" * 1_100_000  # > 2 MB
        r = member_client.post(_url(project), {"file": _upload(big)}, format="multipart")
        assert r.status_code == 400
        assert "too large" in r.data["detail"].lower()
        assert Risk.objects.filter(project=project).count() == 0

    def test_missing_title_column_returns_400(
        self,
        member_client: APIClient,
        project: Project,
        member_membership: ProjectMembership,
    ) -> None:
        raw = _csv(["x", "2", "2"], header=["Status", "P", "I"])
        r = member_client.post(_url(project), {"file": _upload(raw)}, format="multipart")
        assert r.status_code == 400
        assert "Title" in r.data["detail"]


@pytest.mark.django_db
class TestBuildOwnerIndex:
    def test_indexes_members_by_uuid_email_username(
        self,
        member_user: Any,
        project: Project,
        member_membership: ProjectMembership,
    ) -> None:
        index = build_owner_index(str(project.pk))
        assert index[str(member_user.pk).lower()] == member_user
        assert index["member@example.com"] == member_user
        assert index["member"] == member_user

    def test_excludes_non_members(
        self,
        outsider: Any,
        project: Project,
    ) -> None:
        index = build_owner_index(str(project.pk))
        assert "outsider" not in index
