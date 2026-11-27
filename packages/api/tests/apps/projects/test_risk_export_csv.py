"""Server-side risk register CSV (#1200): rows, fields, order, dialect, RBAC, round-trip."""

from __future__ import annotations

import csv
import io
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Project, Risk
from trueppm_api.apps.projects.risk_export import HEADERS
from trueppm_api.apps.projects.risk_import import build_owner_index, parse_risk_csv

User = get_user_model()
pytestmark = pytest.mark.django_db


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(
        username="rx-owner", password="x", first_name="Marcus", last_name="Lee"
    )


@pytest.fixture
def project(owner: Any) -> Project:
    p = Project.objects.create(
        name="Register",
        code="REG",
        start_date=date(2026, 4, 1),
        calendar=Calendar.objects.create(name="Std"),
    )
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    Risk.objects.create(project=p, title="Low", probability=1, impact=2, created_by=owner)
    Risk.objects.create(
        project=p,
        title="=HYPERLINK(evil)",
        probability=5,
        impact=4,
        owner=owner,
        mitigation_due_date=date(2026, 6, 1),
        description="line one\nline, two",
        created_by=owner,
    )
    gone = Risk.objects.create(
        project=p, title="Deleted", probability=5, impact=5, created_by=owner
    )
    gone.soft_delete()
    return p


def _get(user: Any | None, project: Project) -> Any:
    client = APIClient()
    if user is not None:
        client.force_authenticate(user)
    return client.get(f"/api/v1/projects/{project.pk}/risks/export/")


def _rows(resp: Any) -> list[list[str]]:
    return list(csv.reader(io.StringIO(resp.content.decode("utf-8"))))


def test_register_rows_fields_and_order(owner: Any, project: Project) -> None:
    resp = _get(owner, project)
    assert resp.status_code == 200
    assert resp["Content-Type"].startswith("text/csv")
    assert 'filename="risks-REG-' in resp["Content-Disposition"]
    raw = resp.content
    assert not raw.startswith(b"\xef\xbb\xbf")  # spec §5.5: no BOM on write
    assert b"\r\n" in raw
    rows = _rows(resp)
    assert tuple(rows[0]) == HEADERS
    body = [dict(zip(rows[0], r, strict=True)) for r in rows[1:]]
    # Live risks only (the soft-deleted severity-25 risk is absent; risks have no
    # draft state), highest severity (P x I) first.
    assert [r["Severity"] for r in body] == ["20", "2"]
    assert "Deleted" not in {r["Title"] for r in body}
    top = body[0]
    assert top["Title"] == "'=HYPERLINK(evil)"  # formula neutralized
    assert top["Status"] == "OPEN"
    assert (top["P"], top["I"]) == ("5", "4")
    assert top["Owner"] == str(owner.pk)
    assert top["Owner Name"] == "Marcus Lee"
    assert top["Mitigation Due Date"] == "2026-06-01"
    assert top["Description"] == "line one\nline, two"
    assert top["ID"].startswith("REG-")
    assert body[1]["Owner"] == "" and body[1]["Owner Name"] == ""


def test_register_round_trips_through_the_importer_without_warnings(
    owner: Any, project: Project
) -> None:
    Risk.objects.create(
        project=project,
        title="+44 supplier line",
        probability=1,
        impact=1,
        description="- first point\n- second point",
        trigger="@ops paged",
        created_by=owner,
    )
    plan = parse_risk_csv(_get(owner, project).content, build_owner_index(str(project.pk)))
    assert plan.errors == [] and plan.warnings == []
    assert [d.owner for d in plan.drafts] == [owner, None, None]
    # The export's formula guard is undone on import: values come back as written.
    by_title = {d.title: d for d in plan.drafts}
    assert set(by_title) == {"=HYPERLINK(evil)", "Low", "+44 supplier line"}
    guarded = by_title["+44 supplier line"]
    assert guarded.description == "- first point\n- second point"
    assert guarded.trigger == "@ops paged"


def test_a_quote_not_guarding_a_formula_character_is_kept() -> None:
    raw = b"Title,Description\r\n'quoted title,'- guarded\r\n"
    plan = parse_risk_csv(raw, {})
    assert plan.errors == []
    assert plan.drafts[0].title == "'quoted title"
    assert plan.drafts[0].description == "- guarded"


@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER])
def test_any_member_can_export(project: Project, role: str) -> None:
    user = User.objects.create_user(username=f"rx-{role}", password="x")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    assert _get(user, project).status_code == 200


def test_outsider_and_anonymous_are_refused(project: Project) -> None:
    outsider = User.objects.create_user(username="rx-out", password="x")
    assert _get(outsider, project).status_code in (403, 404)
    assert _get(None, project).status_code == 401


def test_an_archived_project_can_still_export(owner: Any, project: Project) -> None:
    # Getting one's register out stays available after archiving, like the seed export.
    Project.objects.filter(pk=project.pk).update(is_archived=True)
    resp = _get(owner, project)
    assert resp.status_code == 200
    assert {r[1] for r in _rows(resp)[1:]} == {"Low", "'=HYPERLINK(evil)"}


def test_soft_deleted_risks_are_excluded(owner: Any, project: Project) -> None:
    Risk.objects.get(project=project, title="Low").soft_delete()
    titles = [r[1] for r in _rows(_get(owner, project))[1:]]
    assert titles == ["'=HYPERLINK(evil)"]


# ---- tokens: a token is narrowed to what its owner and scope can read -------------


def _token_client(*, owner: Any | None = None, project: Project | None = None) -> APIClient:
    import secrets

    from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
    from trueppm_api.apps.projects.models import SCOPE_MCP_READ, ApiToken

    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    creator = owner or User.objects.get(username="rx-owner")
    ApiToken.objects.create(
        owner=owner,
        project=project,
        name="rx-token",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=creator,
        scopes=[SCOPE_MCP_READ],
    )
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


def _export_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/risks/export/"


def test_a_personal_mcp_token_reads_its_owners_register(owner: Any, project: Project) -> None:
    resp = _token_client(owner=owner).get(_export_url(project))
    assert resp.status_code == 200, resp.content
    assert len(_rows(resp)) == 3


def test_a_personal_mcp_token_cannot_read_a_register_its_owner_cannot(
    owner: Any, project: Project
) -> None:
    stranger = User.objects.create_user(username="rx-stranger", password="x")
    assert _token_client(owner=stranger).get(_export_url(project)).status_code in (403, 404)


def test_a_project_token_is_confined_to_its_own_project(owner: Any, project: Project) -> None:
    other = Project.objects.create(
        name="Elsewhere", code="ELS", start_date=date(2026, 4, 1), calendar=project.calendar
    )
    ProjectMembership.objects.create(project=other, user=owner, role=Role.OWNER)
    resp = _token_client(project=other).get(_export_url(project))
    assert resp.status_code in (401, 403, 404), resp.content
    assert b"HYPERLINK" not in resp.content


def test_the_team_mcp_opt_out_withholds_every_row_from_an_agent_token(
    owner: Any, project: Project
) -> None:
    # RiskViewSet is a McpScope.QUERYSET view (ADR-0678): an opted-out project's rows
    # are filtered out of the queryset rather than the request being refused, so the
    # agent gets a 200 carrying the header row and nothing else.
    project.mcp_enabled = False
    project.save(update_fields=["mcp_enabled"])
    resp = _token_client(owner=owner).get(_export_url(project))
    assert resp.status_code == 200, resp.content
    assert _rows(resp) == [list(HEADERS)]
    # The opt-out restrains agents only; the human owner still exports.
    assert _get(owner, project).status_code == 200
