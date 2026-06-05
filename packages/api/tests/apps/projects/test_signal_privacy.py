"""Tests for the Unified Team-Signal Privacy Model (ADR-0104, #553/#854).

The headline cases are the ADR's three named guard-rail tests:
- the **velocity-regression guard** — a plain MEMBER's velocity read at the default
  policy is unchanged (the series is present, not suppressed);
- the **back-door close** — a non-member is denied every signal regardless of role;
- the **ceiling invariant** — set-audience above the ceiling is rejected, raising the
  ceiling is gated, and lowering it clamps the audience down.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import signal_privacy_services as svc
from trueppm_api.apps.projects.models import (
    Project,
    ProjectSignalPrivacyPolicy,
    SignalAudience,
    Sprint,
    SprintState,
)
from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole

User = get_user_model()
pytestmark = pytest.mark.django_db


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(name="Proj", start_date=date(2026, 1, 1))


def _member(project: Project, username: str, role: int) -> Any:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


@pytest.fixture
def pm(project: Project) -> Any:
    return _member(project, "pm", Role.ADMIN)


@pytest.fixture
def dev(project: Project) -> Any:
    return _member(project, "dev", Role.MEMBER)


@pytest.fixture
def viewer(project: Project) -> Any:
    return _member(project, "viewer", Role.VIEWER)


@pytest.fixture
def outsider(db: object) -> Any:
    return User.objects.create_user(username="outsider", password="pw")


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def closed_sprints(project: Project) -> None:
    """Two closed sprints so velocity_summary returns a real series + stdev."""
    base = date(2026, 1, 6)
    for i in range(2):
        Sprint.objects.create(
            project=project,
            name=f"Sprint {i + 1}",
            start_date=base + timedelta(days=14 * i),
            finish_date=base + timedelta(days=14 * i + 10),
            state=SprintState.COMPLETED,
            completed_points=20 + i,
            completed_task_count=5 + i,
            closed_at=timezone.now() - timedelta(days=14 * (2 - i)),
        )


def _url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/signal-privacy/"


# --------------------------------------------------------------------------- #
# Reader tier + the back-door close (ADR-0104 §2)
# --------------------------------------------------------------------------- #


def test_requester_tier_non_member_is_below_team(project: Project, outsider: Any) -> None:
    """The 🔴 back-door: a non-member resolves to None (below TEAM) — denied always."""

    class _Req:
        user = outsider

    assert svc.requester_signal_tier(_Req(), project.pk) is None  # type: ignore[arg-type]
    policy, _ = ProjectSignalPrivacyPolicy.objects.get_or_create(project=project)
    assert svc.audience_can_read(policy, "velocity", None) is False


def test_requester_tier_by_role(project: Project, pm: Any, dev: Any) -> None:
    class _Req:
        def __init__(self, u: Any) -> None:
            self.user = u

    assert svc.requester_signal_tier(_Req(pm), project.pk) == SignalAudience.TEAM_SM_PM  # type: ignore[arg-type]
    assert svc.requester_signal_tier(_Req(dev), project.pk) == SignalAudience.TEAM  # type: ignore[arg-type]


def test_scrum_master_facet_lifts_tier(project: Project, dev: Any) -> None:
    """A non-admin member with the SM facet resolves to TEAM_SM (wires #927)."""
    team = Team.objects.create(project=project, name="Default", short_id="T01", is_default=True)
    TeamMembership.objects.create(team=team, user=dev, role=TeamRole.MEMBER, is_scrum_master=True)

    class _Req:
        user = dev

    assert svc.requester_signal_tier(_Req(), project.pk) == SignalAudience.TEAM_SM  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# Velocity suppression (ADR-0104 §2.1)
# --------------------------------------------------------------------------- #


def test_velocity_regression_guard_member_reads_full_at_default(
    project: Project, dev: Any, closed_sprints: None
) -> None:
    """The 🔴 regression guard: a plain MEMBER's velocity read at the default policy
    keeps the full series — no suppression, no velocity_suppressed flag."""
    resp = _client(dev).get(f"/api/v1/projects/{project.pk}/velocity/")
    assert resp.status_code == 200
    assert len(resp.data["sprints"]) == 2
    assert resp.data["rolling_avg_points"] is not None
    assert "velocity_suppressed" not in resp.data


def test_velocity_suppressed_for_member_after_opt_up(
    project: Project, pm: Any, dev: Any, closed_sprints: None
) -> None:
    """After the team opts velocity up to TEAM_SM_PM, a below-tier MEMBER gets the
    aggregate shape but not the gated series; the PM (tier TEAM_SM_PM) still reads."""
    policy, _ = ProjectSignalPrivacyPolicy.objects.get_or_create(project=project)
    svc.raise_signal_ceiling(policy, "velocity", SignalAudience.TEAM_SM_PM)
    svc.set_signal_audience(policy, "velocity", SignalAudience.TEAM_SM_PM)

    member_resp = _client(dev).get(f"/api/v1/projects/{project.pk}/velocity/")
    assert member_resp.status_code == 200
    assert member_resp.data["velocity_suppressed"] is True
    assert member_resp.data["sprints"] == []
    assert member_resp.data["rolling_avg_points"] is None

    pm_resp = _client(pm).get(f"/api/v1/projects/{project.pk}/velocity/")
    assert pm_resp.status_code == 200
    assert len(pm_resp.data["sprints"]) == 2


# --------------------------------------------------------------------------- #
# Ceiling invariant + the two write gates (ADR-0104 §1.1)
# --------------------------------------------------------------------------- #


def test_set_audience_above_ceiling_rejected(project: Project, pm: Any) -> None:
    """The 🔴 ceiling invariant: velocity default ceiling is TEAM, so a PATCH to
    TEAM_SM_PM is rejected 400 — you must raise the ceiling first (a team act)."""
    resp = _client(pm).patch(
        _url(project), {"signal": "velocity", "audience": SignalAudience.TEAM_SM_PM}
    )
    assert resp.status_code == 400


def test_raise_ceiling_then_set_audience(project: Project, pm: Any) -> None:
    raise_resp = _client(pm).post(
        f"{_url(project)}raise_ceiling/",
        {"signal": "velocity", "ceiling": SignalAudience.TEAM_SM_PM},
    )
    assert raise_resp.status_code == 200
    # Raising the ceiling does NOT move the dial.
    assert raise_resp.data["signals"]["velocity"]["audience"] == SignalAudience.TEAM
    assert raise_resp.data["signals"]["velocity"]["ceiling"] == SignalAudience.TEAM_SM_PM

    set_resp = _client(pm).patch(
        _url(project), {"signal": "velocity", "audience": SignalAudience.TEAM_SM}
    )
    assert set_resp.status_code == 200
    assert set_resp.data["signals"]["velocity"]["audience"] == SignalAudience.TEAM_SM


def test_lower_ceiling_clamps_audience(project: Project) -> None:
    policy, _ = ProjectSignalPrivacyPolicy.objects.get_or_create(project=project)
    svc.raise_signal_ceiling(policy, "velocity", SignalAudience.TEAM_SM_PM)
    svc.set_signal_audience(policy, "velocity", SignalAudience.TEAM_SM_PM)
    # Lower the ceiling back to TEAM — the audience must clamp down with it.
    svc.raise_signal_ceiling(policy, "velocity", SignalAudience.TEAM)
    policy.refresh_from_db()
    assert policy.audience_of("velocity") == SignalAudience.TEAM
    assert policy.ceiling_of("velocity") == SignalAudience.TEAM


def test_set_audience_rejects_ceiling_field(project: Project, pm: Any) -> None:
    """🔴-1: the set-audience endpoint cannot move a ceiling (no generic field PATCH).
    A ceiling key in the body is ignored — the ceiling is unchanged."""
    resp = _client(pm).patch(
        _url(project),
        {
            "signal": "velocity",
            "audience": SignalAudience.TEAM,
            "ceiling": SignalAudience.PROGRAM_SHARED,
        },
    )
    assert resp.status_code == 200
    assert resp.data["signals"]["velocity"]["ceiling"] == SignalAudience.TEAM


# --------------------------------------------------------------------------- #
# Permission gate
# --------------------------------------------------------------------------- #


def test_plain_member_cannot_set_audience(project: Project, dev: Any) -> None:
    resp = _client(dev).patch(
        _url(project), {"signal": "velocity", "audience": SignalAudience.TEAM}
    )
    assert resp.status_code == 403


def test_non_member_cannot_read_policy(project: Project, outsider: Any) -> None:
    resp = _client(outsider).get(_url(project))
    assert resp.status_code == 403


def test_member_can_read_policy(project: Project, dev: Any) -> None:
    resp = _client(dev).get(_url(project))
    assert resp.status_code == 200
    assert resp.data["signals"]["velocity"]["audience"] == SignalAudience.TEAM
    assert resp.data["can_set_audience"] is False


# --------------------------------------------------------------------------- #
# Ratchet + sharing provider
# --------------------------------------------------------------------------- #


def test_ratchet_down_sets_all_to_team(project: Project, pm: Any) -> None:
    policy, _ = ProjectSignalPrivacyPolicy.objects.get_or_create(project=project)
    svc.raise_signal_ceiling(policy, "throughput_rollup", SignalAudience.PROGRAM_SHARED)
    svc.set_signal_audience(policy, "throughput_rollup", SignalAudience.PROGRAM_SHARED)

    resp = _client(pm).post(f"{_url(project)}ratchet_down/")
    assert resp.status_code == 200
    assert resp.data["signals"]["throughput_rollup"]["audience"] == SignalAudience.TEAM


def test_get_shared_team_signals_none_until_opt_in(project: Project) -> None:
    assert svc.get_shared_team_signals(project) is None
    policy, _ = ProjectSignalPrivacyPolicy.objects.get_or_create(project=project)
    # throughput ceiling already permits PROGRAM_SHARED — opting in is one step.
    svc.set_signal_audience(policy, "throughput_rollup", SignalAudience.PROGRAM_SHARED)
    shared = svc.get_shared_team_signals(project)
    assert shared == {"throughput_rollup": SignalAudience.PROGRAM_SHARED}


# --------------------------------------------------------------------------- #
# Neutral default-posture seam (the Enterprise extension point, OSS side)
# --------------------------------------------------------------------------- #


def test_default_posture_seam_seeds_new_policy(project: Project) -> None:
    """OSS ships no provider (coded defaults); a registered provider seeds a new
    policy at creation only. Restored after so other tests see the OSS default."""
    assert svc.get_or_create_policy(project).audience_of("velocity") == SignalAudience.TEAM

    def _provider(_p: Project) -> dict[str, dict[str, str]]:
        return {"velocity": {"audience": SignalAudience.TEAM, "ceiling": SignalAudience.TEAM_SM_PM}}

    other = Project.objects.create(name="Seeded", start_date=date(2026, 1, 1))
    svc.register_default_posture_provider(_provider)
    try:
        seeded = svc.get_or_create_policy(other)
        assert seeded.ceiling_of("velocity") == SignalAudience.TEAM_SM_PM
    finally:
        svc.register_default_posture_provider(None)
