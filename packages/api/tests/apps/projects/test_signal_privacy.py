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
    Task,
    TaskStatus,
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


def test_scrum_master_reads_as_team_and_can_write(project: Project, dev: Any) -> None:
    """The SM is a team insider: they read team signals as TEAM (the facet does not
    raise the *read* band) — but the facet *does* grant the write gate (#927)."""
    team = Team.objects.create(project=project, name="Default", short_id="T01", is_default=True)
    TeamMembership.objects.create(team=team, user=dev, role=TeamRole.MEMBER, is_scrum_master=True)

    class _Req:
        user = dev

    # SM reads as a team insider, not an elevated band.
    assert svc.requester_signal_tier(_Req(), project.pk) == SignalAudience.TEAM  # type: ignore[arg-type]
    # ...but the facet grants the write gate: the policy GET reports can_set_audience.
    resp = _client(dev).get(_url(project))
    assert resp.status_code == 200
    assert resp.data["can_set_audience"] is True


# --------------------------------------------------------------------------- #
# Velocity suppression (ADR-0104 §2.1) — team-private by default, shared upward
# --------------------------------------------------------------------------- #


def test_velocity_regression_guard_member_reads_full_at_default(
    project: Project, dev: Any, closed_sprints: None
) -> None:
    """The 🔴 regression guard: an ordinary MEMBER's velocity read at the default
    policy keeps the full series — the team never loses its own read."""
    resp = _client(dev).get(f"/api/v1/projects/{project.pk}/velocity/")
    assert resp.status_code == 200
    assert len(resp.data["sprints"]) == 2
    assert resp.data["rolling_avg_points"] is not None
    assert "velocity_suppressed" not in resp.data


def test_velocity_hidden_from_pm_by_default_shared_after_opt_up(
    project: Project, pm: Any, dev: Any, closed_sprints: None
) -> None:
    """ADR-0104's core guarantee (Morgan's hard-NO): the PM does NOT read velocity at
    the default (team-private) — only the aggregate shape, no series. The team raising
    velocity's audience to TEAM_SM_PM is what shares it up to the PM. Ordinary members
    read throughout."""
    # Default: PM is suppressed; the ordinary member still reads.
    pm_default = _client(pm).get(f"/api/v1/projects/{project.pk}/velocity/")
    assert pm_default.status_code == 200
    assert pm_default.data["velocity_suppressed"] is True
    assert pm_default.data["sprints"] == []
    assert pm_default.data["rolling_avg_points"] is None

    member_default = _client(dev).get(f"/api/v1/projects/{project.pk}/velocity/")
    assert len(member_default.data["sprints"]) == 2

    # Team shares velocity up to the PM band → the PM now reads the full series.
    policy, _ = ProjectSignalPrivacyPolicy.objects.get_or_create(project=project)
    svc.raise_signal_ceiling(policy, "velocity", SignalAudience.TEAM_SM_PM)
    svc.set_signal_audience(policy, "velocity", SignalAudience.TEAM_SM_PM)

    pm_shared = _client(pm).get(f"/api/v1/projects/{project.pk}/velocity/")
    assert pm_shared.status_code == 200
    assert len(pm_shared.data["sprints"]) == 2
    assert "velocity_suppressed" not in pm_shared.data
    # The ordinary member still reads after the upward share (never regressed).
    assert len(_client(dev).get(f"/api/v1/projects/{project.pk}/velocity/").data["sprints"]) == 2


def test_forecast_applies_velocity_gate(
    project: Project, pm: Any, dev: Any, closed_sprints: None
) -> None:
    """#981: /forecast/ embeds the velocity series and derives sprints-to-complete
    (and the remaining-points basis) from it, so the ADR-0104 velocity gate must
    fire here too. A PM suppressed on /velocity/ gets a suppressed velocity block
    and null sprints-to-complete; an in-audience MEMBER reads the full payload."""
    # An active sprint with an incomplete committed task so the member's
    # sprints-to-complete band is genuinely non-null — proving the gate, not
    # absent data, is what nulls it for the suppressed PM.
    active = Sprint.objects.create(
        project=project,
        name="Active",
        start_date=date(2026, 3, 1),
        finish_date=date(2026, 3, 14),
        state=SprintState.ACTIVE,
    )
    Task.objects.create(
        project=project,
        name="Remaining",
        duration=3,
        sprint=active,
        story_points=8,
        status=TaskStatus.IN_PROGRESS,
    )

    member_resp = _client(dev).get(f"/api/v1/projects/{project.pk}/forecast/")
    assert member_resp.status_code == 200
    assert len(member_resp.data["velocity"]["sprints"]) == 2
    assert "velocity_suppressed" not in member_resp.data["velocity"]
    assert member_resp.data["sprints_to_complete_low"] is not None
    assert member_resp.data["remaining_committed_points"] is not None

    pm_resp = _client(pm).get(f"/api/v1/projects/{project.pk}/forecast/")
    assert pm_resp.status_code == 200
    assert pm_resp.data["velocity"]["velocity_suppressed"] is True
    assert pm_resp.data["velocity"]["sprints"] == []
    assert pm_resp.data["sprints_to_complete_low"] is None
    assert pm_resp.data["sprints_to_complete_high"] is None
    assert pm_resp.data["remaining_committed_points"] is None
    # Milestones are separately-gated ForecastSnapshot artifacts — still present.
    assert "milestones" in pm_resp.data


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
        f"{_url(project)}raise-ceiling/",
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

    resp = _client(pm).post(f"{_url(project)}ratchet-down/")
    assert resp.status_code == 200
    assert resp.data["signals"]["throughput_rollup"]["audience"] == SignalAudience.TEAM


@pytest.mark.parametrize("legacy_segment", ["raise_ceiling", "ratchet_down"])
def test_legacy_snake_case_action_paths_are_gone(
    project: Project, pm: Any, legacy_segment: str
) -> None:
    """The pre-0.3 snake_case action URLs were renamed to kebab-case (#1017).

    Signal privacy is unshipped before 0.3, so the rename is a clean break with no
    redirect shim — the old paths must 404 so no external consumer silently binds
    to a URL that will not exist."""
    resp = _client(pm).post(f"{_url(project)}{legacy_segment}/")
    assert resp.status_code == 404


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
