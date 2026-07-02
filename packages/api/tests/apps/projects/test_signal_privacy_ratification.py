"""Tests for the ceiling-raise team-ratification flow (ADR-0104 Amendment A, #930).

The headline cases the amendment requires:
- a raise OPENS a proposal and does NOT apply until the team ratifies;
- a lone facilitator cannot raise a ceiling alone (proposer's auto-approve stays OPEN);
- a second approver ratifies and the ceiling applies + writes history;
- a non-team project Admin cannot vote (the ratification is the team's, not management's);
- a lower stays immediate and supersedes an open raise proposal;
- an expired proposal stays UNRATIFIED (silence is never consent);
- a second open proposal for the same signal is 409;
- there is NO management bypass (even an Owner's raise opens a proposal).
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
    CeilingRaiseStatus,
    Project,
    ProjectSignalPrivacyPolicy,
    SignalAudience,
    SignalCeilingRaiseProposal,
)
from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole

User = get_user_model()
pytestmark = pytest.mark.django_db


# --------------------------------------------------------------------------- #
# Fixtures / helpers
# --------------------------------------------------------------------------- #


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(name="Proj", start_date=date(2026, 1, 1))


@pytest.fixture
def team(project: Project) -> Team:
    # The auto-mirror signal is on_commit-deferred, so it does not fire in a
    # transaction-wrapped test — create the default team + roster explicitly.
    return Team.objects.create(project=project, name="Default", short_id="T01", is_default=True)


def _team_member(
    project: Project,
    team: Team,
    username: str,
    role: int = Role.MEMBER,
    *,
    sm: bool = False,
) -> Any:
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    TeamMembership.objects.create(
        team=team,
        user=user,
        role=TeamRole.ADMIN if role >= Role.ADMIN else TeamRole.MEMBER,
        is_scrum_master=sm,
    )
    return user


def _project_only_member(project: Project, username: str, role: int) -> Any:
    """A project member who is NOT on the default team (cannot vote)."""
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _raise_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/signal-privacy/raise-ceiling/"


def _policy_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/signal-privacy/"


def _proposals_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/signal-privacy/ceiling-proposals/"


def _vote_url(project: Project, proposal_id: Any) -> str:
    return f"/api/v1/projects/{project.pk}/signal-privacy/ceiling-proposals/{proposal_id}/vote/"


def _withdraw_url(project: Project, proposal_id: Any) -> str:
    return f"/api/v1/projects/{project.pk}/signal-privacy/ceiling-proposals/{proposal_id}/withdraw/"


def _ceiling(project: Project, signal: str = "velocity") -> str:
    return ProjectSignalPrivacyPolicy.objects.get(project=project).ceiling_of(signal)


# --------------------------------------------------------------------------- #
# Threshold math (Amendment A.2)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("eligible", "expected"),
    [(1, 1), (2, 2), (3, 2), (4, 3), (5, 3), (6, 4)],
)
def test_ratification_threshold_is_strict_majority(eligible: int, expected: int) -> None:
    assert svc.ratification_threshold(eligible) == expected


# --------------------------------------------------------------------------- #
# Raise opens a proposal and does not apply (the headline)
# --------------------------------------------------------------------------- #


def test_raise_opens_proposal_does_not_apply(project: Project, team: Team) -> None:
    sm = _team_member(project, team, "sm", sm=True)
    _team_member(project, team, "dev2")
    _team_member(project, team, "dev3")

    resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )

    assert resp.status_code == 202, resp.data
    assert resp.data["status"] == CeilingRaiseStatus.OPEN
    assert resp.data["to_ceiling"] == SignalAudience.PROGRAM_SHARED
    # Proposer's implicit approve is recorded but a 3-member team needs 2 (majority).
    assert resp.data["approve_count"] == 1
    assert resp.data["threshold"] == 2
    # The ceiling is NOT yet raised — it applies only on ratification.
    assert _ceiling(project) == SignalAudience.TEAM


def test_no_management_bypass_owner_raise_still_proposes(project: Project, team: Team) -> None:
    """Even a project Owner cannot raise unilaterally — the raise opens a proposal."""
    owner = _team_member(project, team, "owner", role=Role.OWNER)
    _team_member(project, team, "dev2")

    resp = _client(owner).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "team_sm_pm"}, format="json"
    )

    assert resp.status_code == 202
    assert resp.data["status"] == CeilingRaiseStatus.OPEN
    assert _ceiling(project) == SignalAudience.TEAM


# --------------------------------------------------------------------------- #
# Lone facilitator cannot raise alone; a second approver ratifies
# --------------------------------------------------------------------------- #


def test_lone_facilitator_cannot_raise_alone(project: Project, team: Team) -> None:
    sm = _team_member(project, team, "sm", sm=True)
    _team_member(project, team, "dev2")  # the second member has not voted

    resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )

    assert resp.status_code == 202
    assert resp.data["status"] == CeilingRaiseStatus.OPEN
    assert resp.data["approve_count"] == 1
    assert resp.data["threshold"] == 2
    assert _ceiling(project) == SignalAudience.TEAM


def test_second_approver_ratifies_and_applies(project: Project, team: Team) -> None:
    sm = _team_member(project, team, "sm", sm=True)
    dev = _team_member(project, team, "dev2")

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    proposal_id = open_resp.data["id"]

    vote_resp = _client(dev).post(
        _vote_url(project, proposal_id), {"choice": "approve"}, format="json"
    )

    assert vote_resp.status_code == 200, vote_resp.data
    assert vote_resp.data["status"] == CeilingRaiseStatus.RATIFIED
    assert vote_resp.data["approve_count"] == 2
    # The ceiling is now applied.
    assert _ceiling(project) == SignalAudience.PROGRAM_SHARED
    # And the policy history records the team-owned raise.
    policy = ProjectSignalPrivacyPolicy.objects.get(project=project)
    latest = policy.history.first()
    assert latest is not None
    assert "ceiling" in (latest.history_change_reason or "")


def test_solo_team_proposer_ratifies_immediately(project: Project, team: Team) -> None:
    """A 1-member team has no one else to consult — the sole member ratifies on propose."""
    solo = _team_member(project, team, "solo", sm=True)

    resp = _client(solo).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "team_sm_pm"}, format="json"
    )

    assert resp.status_code == 202
    assert resp.data["status"] == CeilingRaiseStatus.RATIFIED
    assert _ceiling(project) == SignalAudience.TEAM_SM_PM


def test_reject_majority_rejects_early(project: Project, team: Team) -> None:
    sm = _team_member(project, team, "sm", sm=True)
    dev2 = _team_member(project, team, "dev2")
    dev3 = _team_member(project, team, "dev3")

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    proposal_id = open_resp.data["id"]

    _client(dev2).post(_vote_url(project, proposal_id), {"choice": "reject"}, format="json")
    final = _client(dev3).post(_vote_url(project, proposal_id), {"choice": "reject"}, format="json")

    # Approval can no longer reach 2 (1 approve + 2 rejects of 3) — rejected early.
    assert final.status_code == 200
    assert final.data["status"] == CeilingRaiseStatus.REJECTED
    assert _ceiling(project) == SignalAudience.TEAM


# --------------------------------------------------------------------------- #
# Voter eligibility (Amendment A.2 — team membership, not project role)
# --------------------------------------------------------------------------- #


def test_non_team_project_admin_cannot_vote(project: Project, team: Team) -> None:
    sm = _team_member(project, team, "sm", sm=True)
    _team_member(project, team, "dev2")
    # A project Admin who is NOT on the team (no TeamMembership row).
    outside_admin = _project_only_member(project, "pmo", Role.ADMIN)

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    proposal_id = open_resp.data["id"]

    resp = _client(outside_admin).post(
        _vote_url(project, proposal_id), {"choice": "approve"}, format="json"
    )

    assert resp.status_code == 403
    assert _ceiling(project) == SignalAudience.TEAM


def test_vote_is_changeable_while_open(project: Project, team: Team) -> None:
    sm = _team_member(project, team, "sm", sm=True)
    dev2 = _team_member(project, team, "dev2")
    _team_member(project, team, "dev3")  # keeps the team at 3 (threshold 2)

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    proposal_id = open_resp.data["id"]

    _client(dev2).post(_vote_url(project, proposal_id), {"choice": "reject"}, format="json")
    changed = _client(dev2).post(
        _vote_url(project, proposal_id), {"choice": "approve"}, format="json"
    )

    # The reject was replaced by an approve (upsert) → now 2 approves → ratified.
    assert changed.status_code == 200
    assert changed.data["status"] == CeilingRaiseStatus.RATIFIED
    assert changed.data["approve_count"] == 2


# --------------------------------------------------------------------------- #
# Lower stays immediate + supersedes an open raise (Amendment A.4)
# --------------------------------------------------------------------------- #


def test_lower_is_immediate_and_supersedes_open_raise(project: Project, team: Team) -> None:
    sm = _team_member(project, team, "sm", sm=True)
    _team_member(project, team, "dev2")
    # Establish a raised ceiling at TEAM_SM_PM directly (the low-level applier).
    policy, _ = ProjectSignalPrivacyPolicy.objects.get_or_create(project=project)
    svc.raise_signal_ceiling(policy, "velocity", SignalAudience.TEAM_SM_PM, actor=sm)

    # Open a raise proposal TEAM_SM_PM -> PROGRAM_SHARED.
    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    proposal_id = open_resp.data["id"]
    assert open_resp.data["status"] == CeilingRaiseStatus.OPEN

    # Now LOWER the ceiling — immediate, single-action, and it supersedes the proposal.
    lower_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "team_sm"}, format="json"
    )

    assert lower_resp.status_code == 200  # policy returned (not a proposal)
    assert _ceiling(project) == SignalAudience.TEAM_SM
    proposal = SignalCeilingRaiseProposal.objects.get(pk=proposal_id)
    assert proposal.status == CeilingRaiseStatus.SUPERSEDED


# --------------------------------------------------------------------------- #
# One-open-per-signal + expiry (Amendment A.3 / A.4)
# --------------------------------------------------------------------------- #


def test_second_open_proposal_for_same_signal_conflicts(project: Project, team: Team) -> None:
    sm = _team_member(project, team, "sm", sm=True)
    _team_member(project, team, "dev2")

    _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    second = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "team_sm_pm"}, format="json"
    )

    assert second.status_code == 409
    assert second.data["code"] == "proposal_already_open"


def test_expired_proposal_stays_unratified_and_frees_the_signal(
    project: Project, team: Team
) -> None:
    sm = _team_member(project, team, "sm", sm=True)
    _team_member(project, team, "dev2")

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    proposal_id = open_resp.data["id"]
    # Force the proposal past its TTL.
    SignalCeilingRaiseProposal.objects.filter(pk=proposal_id).update(
        expires_at=timezone.now() - timedelta(hours=1)
    )

    # A fresh proposal for the same signal now succeeds (the stale one is GC'd).
    second = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "team_sm_pm"}, format="json"
    )

    assert second.status_code == 202
    expired = SignalCeilingRaiseProposal.objects.get(pk=proposal_id)
    assert expired.status == CeilingRaiseStatus.EXPIRED
    # The ceiling was never applied by the expired proposal.
    assert _ceiling(project) == SignalAudience.TEAM


def test_vote_on_expired_proposal_conflicts(project: Project, team: Team) -> None:
    sm = _team_member(project, team, "sm", sm=True)
    dev = _team_member(project, team, "dev2")

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    proposal_id = open_resp.data["id"]
    SignalCeilingRaiseProposal.objects.filter(pk=proposal_id).update(
        expires_at=timezone.now() - timedelta(hours=1)
    )

    resp = _client(dev).post(_vote_url(project, proposal_id), {"choice": "approve"}, format="json")

    assert resp.status_code == 409
    assert resp.data["code"] == "proposal_closed"
    assert _ceiling(project) == SignalAudience.TEAM


# --------------------------------------------------------------------------- #
# Withdraw + team-readable surface (Amendment A.3 / A.6)
# --------------------------------------------------------------------------- #


def test_proposer_can_withdraw_open_proposal(project: Project, team: Team) -> None:
    sm = _team_member(project, team, "sm", sm=True)
    _team_member(project, team, "dev2")

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    proposal_id = open_resp.data["id"]

    resp = _client(sm).post(_withdraw_url(project, proposal_id), format="json")

    assert resp.status_code == 200
    assert resp.data["status"] == CeilingRaiseStatus.REJECTED
    # The signal is free for a fresh proposal.
    again = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    assert again.status_code == 202


def test_proposals_are_team_readable(project: Project, team: Team) -> None:
    sm = _team_member(project, team, "sm", sm=True)
    dev = _team_member(project, team, "dev2")

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    proposal_id = open_resp.data["id"]

    # A plain team member reads the proposal and the votes cast on it.
    listing = _client(dev).get(_proposals_url(project))
    assert listing.status_code == 200
    row = next(p for p in listing.data if p["id"] == proposal_id)
    assert row["signal"] == "velocity"
    assert len(row["votes"]) == 1  # the proposer's implicit approve
    assert row["can_vote"] is True  # dev is a team member and the proposal is open


def test_policy_get_surfaces_open_proposal_pending_indicator(project: Project, team: Team) -> None:
    sm = _team_member(project, team, "sm", sm=True)
    dev = _team_member(project, team, "dev2")

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )

    body = _client(dev).get(_policy_url(project)).data
    assert body["can_vote"] is True
    assert "velocity" in body["open_proposals"]
    pending = body["open_proposals"]["velocity"]
    assert pending["id"] == open_resp.data["id"]
    assert pending["to_ceiling"] == SignalAudience.PROGRAM_SHARED
    assert pending["threshold"] == 2
    assert pending["your_vote"] is None  # dev has not voted yet


# --------------------------------------------------------------------------- #
# Per-voter choices stay team-scoped (ADR-0104 §2 / Amendment A.6, issue 1553)
# --------------------------------------------------------------------------- #


def test_non_team_admin_list_read_redacts_per_voter_choices(project: Project, team: Team) -> None:
    """A non-team project Admin sees the aggregate tally but NOT individual votes."""
    sm = _team_member(project, team, "sm", sm=True)
    dev = _team_member(project, team, "dev2")
    outside_admin = _project_only_member(project, "pmo", Role.ADMIN)

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    proposal_id = open_resp.data["id"]
    # A second team member casts a real vote so per-voter detail is non-empty.
    _client(dev).post(_vote_url(project, proposal_id), {"choice": "reject"}, format="json")

    listing = _client(outside_admin).get(_proposals_url(project))
    assert listing.status_code == 200
    row = next(p for p in listing.data if p["id"] == proposal_id)
    # The governance aggregate is still visible (management pending indicator)...
    assert row["approve_count"] == 1
    assert row["reject_count"] == 1
    assert row["threshold"] == 2
    assert row["to_ceiling"] == SignalAudience.PROGRAM_SHARED
    # ...but the individual per-voter choices are redacted for a non-team reader.
    assert row["votes"] == []
    assert row["can_vote"] is False


def test_non_team_viewer_policy_get_redacts_per_voter_choices(project: Project, team: Team) -> None:
    """A non-team Viewer reading the policy GET pending block gets no per-voter detail."""
    sm = _team_member(project, team, "sm", sm=True)
    _team_member(project, team, "dev2")
    outside_viewer = _project_only_member(project, "viewer", Role.VIEWER)

    _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )

    body = _client(outside_viewer).get(_policy_url(project)).data
    assert body["can_vote"] is False
    pending = body["open_proposals"]["velocity"]
    assert pending["votes"] == []
    # The aggregate the non-team reader may legitimately see is intact.
    assert pending["threshold"] == 2
    assert pending["to_ceiling"] == SignalAudience.PROGRAM_SHARED


def test_team_member_list_read_gets_full_per_voter_detail(project: Project, team: Team) -> None:
    """A team member still reads the full per-voter list (no regression)."""
    sm = _team_member(project, team, "sm", sm=True)
    dev = _team_member(project, team, "dev2")

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    proposal_id = open_resp.data["id"]

    listing = _client(dev).get(_proposals_url(project))
    row = next(p for p in listing.data if p["id"] == proposal_id)
    assert len(row["votes"]) == 1  # the proposer's implicit approve is visible to the team
    assert row["votes"][0]["choice"] == "approve"
    assert row["can_vote"] is True
