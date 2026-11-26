"""Velocity over MCP — the ADR-0104 gate on an ``mcp:read`` token.

``GET /projects/<pk>/velocity/`` is the read behind the ``get_sprint_velocity`` MCP
tool. The risk an agent surface adds is ADR-0104 §risk-1, the forgotten gate: a tool
that hand-builds velocity from the sprint model skips the suppression the team relies
on. These tests drive the endpoint with a real owner-scoped token, so they prove the
token path reaches the same gate as a browser session rather than restating it.

The case that matters most is the Admin token at the default audience. An Admin
resolves to the TEAM_SM_PM band, which sits outside the default TEAM audience, so the
answer must be the suppressed shape. If that ever reads the numbers, velocity has
become the management gauge the delivery lead's hard NO rules out.
"""

from __future__ import annotations

import secrets
from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    SCOPE_MCP_READ,
    ApiToken,
    Calendar,
    Project,
    ProjectSignalPrivacyPolicy,
    SignalAudience,
    Sprint,
    SprintState,
)
from trueppm_api.apps.projects.services import velocity_summary_unfiltered
from trueppm_api.apps.projects.signal_privacy_services import velocity_summary_for
from trueppm_api.apps.scheduling.answer_stamp import canonical_input_hash

User = get_user_model()

_GATED = (
    "rolling_avg_points",
    "rolling_stdev_points",
    "forecast_range_low",
    "forecast_range_high",
    "team_velocity_per_day",
)


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    proj = Project.objects.create(name="VelocityMcpProj", start_date=date(2026, 1, 1), calendar=cal)
    for i, pts in enumerate((18, 20, 22, 24)):
        Sprint.objects.create(
            project=proj,
            name=f"S{i + 1}",
            start_date=date(2026, 1, 1) + timedelta(days=i * 14),
            finish_date=date(2026, 1, 14) + timedelta(days=i * 14),
            state=SprintState.COMPLETED,
            committed_points=pts + 2,
            completed_points=pts,
            committed_task_count=5,
            completed_task_count=4,
            closed_at=timezone.now() - timedelta(days=4 - i),
        )
    return proj


def _member(project: Project, role: int, name: str) -> Any:
    user = User.objects.create_user(username=name, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


def _agent(owner: Any) -> APIClient:
    """A client authenticated by a real owner-scoped ``mcp:read`` token."""
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        owner=owner,
        name="velocity-agent",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        scopes=[SCOPE_MCP_READ],
    )
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    return client


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/velocity/"


def _assert_suppressed(data: dict[str, Any]) -> None:
    assert data["velocity_suppressed"] is True
    assert data["sprints"] == []
    assert data["excluded_count"] == 0
    for field in _GATED:
        # Suppress, don't 403: the key stays, the value is gone.
        assert field in data, field
        assert data[field] is None, field


@pytest.mark.django_db
def test_admin_token_gets_suppressed_velocity_at_default_audience(project: Project) -> None:
    admin = _member(project, Role.ADMIN, "vel_admin")
    resp = _agent(admin).get(_url(project))
    assert resp.status_code == 200, resp.data
    _assert_suppressed(resp.data)


@pytest.mark.django_db
def test_owner_token_is_suppressed_too(project: Project) -> None:
    """The ladder measures management distance, not role height (#2915)."""
    owner = _member(project, Role.OWNER, "vel_owner")
    resp = _agent(owner).get(_url(project))
    assert resp.status_code == 200, resp.data
    _assert_suppressed(resp.data)


@pytest.mark.django_db
def test_member_token_reads_the_team_velocity(project: Project) -> None:
    member = _member(project, Role.MEMBER, "vel_member")
    resp = _agent(member).get(_url(project))
    assert resp.status_code == 200, resp.data
    assert "velocity_suppressed" not in resp.data
    assert [s["completed_points"] for s in resp.data["sprints"]] == [18, 20, 22, 24]
    assert [s["committed_points"] for s in resp.data["sprints"]] == [20, 22, 24, 26]
    assert resp.data["forecast_range_low"] is not None
    assert resp.data["forecast_range_high"] is not None


@pytest.mark.django_db
def test_admin_token_reads_once_the_team_shares_upward(project: Project) -> None:
    """The mirror of the default case, so the suppression above is the gate and not
    a token path that never reaches the numbers at all."""
    ProjectSignalPrivacyPolicy.objects.create(
        project=project,
        signal_visibility={
            "velocity": {
                "audience": SignalAudience.TEAM_SM_PM.value,
                "ceiling": SignalAudience.TEAM_SM_PM.value,
            }
        },
    )
    admin = _member(project, Role.ADMIN, "vel_admin_shared")
    resp = _agent(admin).get(_url(project))
    assert resp.status_code == 200, resp.data
    assert "velocity_suppressed" not in resp.data
    assert len(resp.data["sprints"]) == 4


@pytest.mark.django_db
def test_non_member_token_is_refused(project: Project) -> None:
    outsider = User.objects.create_user(username="vel_outsider", password="pw")
    resp = _agent(outsider).get(_url(project))
    assert resp.status_code in (403, 404), resp.status_code


@pytest.mark.django_db
def test_opted_out_project_refuses_the_token(project: Project) -> None:
    member = _member(project, Role.MEMBER, "vel_member_optout")
    project.mcp_enabled = False
    project.save(update_fields=["mcp_enabled"])
    assert _agent(member).get(_url(project)).status_code == 403


@pytest.mark.django_db
def test_response_carries_provenance_over_the_gated_payload(project: Project) -> None:
    """The hash is computed over what the reader received, never over the
    unfiltered series, so a suppressed answer leaks no fingerprint of it."""
    admin = _member(project, Role.ADMIN, "vel_admin_stamp")
    resp = _agent(admin).get(_url(project))
    stamp = resp.data["_provenance"]
    assert set(stamp) == {
        "schema_version",
        "engine_version",
        "api_version",
        "input_hash",
        "computed_at",
    }
    body = {k: v for k, v in resp.data.items() if k != "_provenance"}
    assert stamp["input_hash"] == canonical_input_hash(body)
    # velocity-unfiltered-ok: the test compares against the raw series on purpose.
    raw = velocity_summary_unfiltered(project.pk)
    assert stamp["input_hash"] != canonical_input_hash(raw)


@pytest.mark.django_db
def test_gated_accessor_fails_closed_without_request(project: Project) -> None:
    _assert_suppressed(velocity_summary_for(None, project.pk))
