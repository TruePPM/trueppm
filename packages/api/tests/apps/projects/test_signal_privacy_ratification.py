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
from unittest.mock import MagicMock, patch

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


# --------------------------------------------------------------------------- #
# Live-update broadcasts (#2845)
# --------------------------------------------------------------------------- #


def _bcast_events(mock: Any) -> list[str]:
    return [c.args[1] for c in mock.call_args_list]


def test_opening_a_proposal_broadcasts_the_transition(
    project: Project, team: Team, django_capture_on_commit_callbacks: Any
) -> None:
    """The ceiling-raise UI is a real multi-user vote and emitted nothing before #2845.

    ``useSignalPrivacy`` has a 60s/30s ``staleTime`` and no ``refetchInterval``, so a
    proposal opened by one member was invisible to the others until they navigated.
    The architecturally equivalent feature — Planning Poker — broadcasts on every
    open/vote/reveal/commit.
    """
    sm = _team_member(project, team, "sm", sm=True)
    _team_member(project, team, "dev2")

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event", MagicMock()) as bcast,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = _client(sm).post(
            _raise_url(project),
            {"signal": "velocity", "ceiling": "program_shared"},
            format="json",
        )
    assert resp.status_code == 202, resp.data
    assert "signal_ceiling_proposal_changed" in _bcast_events(bcast)


def test_a_vote_that_does_not_settle_broadcasts_the_tally(
    project: Project, team: Team, django_capture_on_commit_callbacks: Any
) -> None:
    """An OPEN-leaving vote emits ``signal_ceiling_vote_cast``.

    ``_emit_proposal_changed`` only fires on a *status* change, so without this a
    vote that moved the count but not the outcome was silent — and the running count
    is exactly what the other voters are watching.
    """
    sm = _team_member(project, team, "sm", sm=True)
    _team_member(project, team, "dev2")
    _team_member(project, team, "dev3")
    _team_member(project, team, "dev4")

    proposal_id = (
        _client(sm)
        .post(
            _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
        )
        .data["id"]
    )

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event", MagicMock()) as bcast,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = _client(_team_member(project, team, "dev5")).post(
            _vote_url(project, proposal_id), {"choice": "reject"}, format="json"
        )
    assert resp.status_code == 200, resp.data
    assert resp.data["status"] == CeilingRaiseStatus.OPEN
    events = _bcast_events(bcast)
    assert "signal_ceiling_vote_cast" in events
    # The status did not change, so no transition event should be emitted.
    assert "signal_ceiling_proposal_changed" not in events


def test_a_settling_vote_broadcasts_the_transition_not_the_vote(
    project: Project, team: Team, django_capture_on_commit_callbacks: Any
) -> None:
    """When the tally settles the proposal, the status event already tells the story.

    Emitting both would make every client re-read twice for one decision.
    """
    sm = _team_member(project, team, "sm", sm=True)
    dev = _team_member(project, team, "dev2")

    proposal_id = (
        _client(sm)
        .post(
            _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
        )
        .data["id"]
    )

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event", MagicMock()) as bcast,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = _client(dev).post(
            _vote_url(project, proposal_id), {"choice": "approve"}, format="json"
        )
    assert resp.data["status"] == CeilingRaiseStatus.RATIFIED
    events = _bcast_events(bcast)
    assert "signal_ceiling_proposal_changed" in events
    assert "signal_ceiling_vote_cast" not in events
    # Ratifying applies the ceiling, which is itself a policy write.
    assert "signal_privacy_changed" in events


def test_no_broadcast_payload_carries_a_vote_or_a_voter(
    project: Project, team: Team, django_capture_on_commit_callbacks: Any
) -> None:
    """Payloads stay ID-only — the privacy gate is REST-side, and must stay there."""
    sm = _team_member(project, team, "sm", sm=True)
    dev = _team_member(project, team, "dev2")

    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event", MagicMock()) as bcast:
        with django_capture_on_commit_callbacks(execute=True):
            proposal_id = (
                _client(sm)
                .post(
                    _raise_url(project),
                    {"signal": "velocity", "ceiling": "program_shared"},
                    format="json",
                )
                .data["id"]
            )
        # A second capture block, not a combined `with`: the propose and the vote must
        # commit separately or the vote runs before the proposal row is durable.
        with django_capture_on_commit_callbacks(execute=True):
            _client(dev).post(_vote_url(project, proposal_id), {"choice": "approve"}, format="json")

    for call in bcast.call_args_list:
        payload = call.args[2]
        assert "voter" not in payload and "voter_id" not in payload
        assert "choice" not in payload and "votes" not in payload
        assert "approve_count" not in payload and "reject_count" not in payload


def test_a_ratchet_to_team_broadcasts_the_policy_change(
    project: Project, team: Team, django_capture_on_commit_callbacks: Any
) -> None:
    """``ratchet_down_to_team`` is the SM panic button; it must reach live clients."""
    sm = _team_member(project, team, "sm", sm=True)
    solo_policy = svc.get_or_create_policy(project)
    svc.raise_signal_ceiling(solo_policy, "velocity", SignalAudience.TEAM_SM_PM, actor=sm)
    svc.set_signal_audience(solo_policy, "velocity", SignalAudience.TEAM_SM_PM, actor=sm)

    with (
        patch("trueppm_api.apps.sync.broadcast.broadcast_board_event", MagicMock()) as bcast,
        django_capture_on_commit_callbacks(execute=True),
    ):
        svc.ratchet_down_to_team(solo_policy, actor=sm)

    assert "signal_privacy_changed" in _bcast_events(bcast)


# --------------------------------------------------------------------------- #
# Amendment C (#3387) — the roster is team membership ∩ live project membership
# --------------------------------------------------------------------------- #


def _offboard(project: Project, user: Any) -> None:
    """Revoke project access, leaving the mirrored TeamMembership live.

    This is exactly what production does: the ADR-0078 §F mirror is create-only, so
    there is no delete-side counterpart and no FK a cascade could travel over. The
    residual team row is the ghost Amendment C exists to stop counting.
    """
    ProjectMembership.objects.filter(project=project, user=user).update(is_deleted=True)
    assert TeamMembership.objects.filter(user=user, is_deleted=False).exists()


def test_offboarding_shrinks_the_denominator_and_the_bar(project: Project, team: Team) -> None:
    """``eligible_count`` / ``threshold`` exclude a revoked project member (C.2)."""
    sm = _team_member(project, team, "sm", sm=True)
    _team_member(project, team, "dev2")
    leaver = _team_member(project, team, "dev3")

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    assert open_resp.data["eligible_count"] == 3
    assert open_resp.data["threshold"] == 2

    _offboard(project, leaver)

    policy = _client(sm).get(_policy_url(project))
    tally = policy.data["open_proposals"]["velocity"]
    assert tally["eligible_count"] == 2
    assert tally["threshold"] == 2


def test_a_previously_unratifiable_proposal_now_ratifies(project: Project, team: Team) -> None:
    """The headline governance defect: offboarding used to make a raise unreachable.

    Six team members, three of whom leave the project. The old denominator counted all
    six forever, so the bar stayed at ``floor(6/2)+1 = 4`` while only three people could
    ever cast a vote — the proposal was arithmetically **unratifiable**, and the pending
    indicator faithfully reported a threshold no one could reach. Under Amendment C the
    roster is the three who remain, the bar is 2, and the team can decide its own
    signal-sharing again.
    """
    sm = _team_member(project, team, "sm", sm=True)
    stays = _team_member(project, team, "stays")
    _team_member(project, team, "quiet")
    leavers = [_team_member(project, team, f"leaver{i}") for i in range(3)]

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    proposal_id = open_resp.data["id"]
    # The pre-amendment state: 6 eligible, bar of 4, and the proposer's auto-approve.
    assert open_resp.data["eligible_count"] == 6
    assert open_resp.data["threshold"] == 4
    assert open_resp.data["status"] == CeilingRaiseStatus.OPEN

    for leaver in leavers:
        _offboard(project, leaver)

    # One remaining member approves. Roster is now 3, so the bar is 2 and the
    # proposer's auto-approve plus this one clears it.
    vote = _client(stays).post(
        _vote_url(project, proposal_id), {"choice": "approve"}, format="json"
    )

    assert vote.status_code == 200, vote.data
    assert vote.data["eligible_count"] == 3
    assert vote.data["threshold"] == 2
    assert vote.data["status"] == CeilingRaiseStatus.RATIFIED
    assert _ceiling(project) == SignalAudience.PROGRAM_SHARED


def test_an_offboarded_members_cast_vote_stops_counting(project: Project, team: Team) -> None:
    """The already-cast-vote rule (C.3): a vote counts only while its caster is eligible.

    Numerator and denominator move together, so a proposal can never ratify on an
    absent member's approval. Here the departing member's APPROVE is the only thing
    that would have cleared the bar; with them gone it is disregarded, the proposal
    stays OPEN, and ``disregarded_vote_count`` says so rather than leaving a reader to
    infer it from a number that quietly moved.
    """
    sm = _team_member(project, team, "sm", sm=True)
    leaver = _team_member(project, team, "leaver")
    _team_member(project, team, "dev3")
    _team_member(project, team, "dev4")

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    proposal_id = open_resp.data["id"]
    voted = _client(leaver).post(
        _vote_url(project, proposal_id), {"choice": "approve"}, format="json"
    )
    # 4 eligible, bar of 3, two approvals in hand — still short, still OPEN.
    assert voted.data["approve_count"] == 2
    assert voted.data["threshold"] == 3
    assert voted.data["disregarded_vote_count"] == 0

    _offboard(project, leaver)

    after = _client(sm).get(_policy_url(project)).data["open_proposals"]["velocity"]
    # Their approval is gone from the numerator at the same instant their seat leaves
    # the denominator: 3 eligible, bar of 2, and only the proposer's approve remains.
    assert after["approve_count"] == 1
    assert after["eligible_count"] == 3
    assert after["threshold"] == 2
    assert after["status"] == CeilingRaiseStatus.OPEN
    assert after["disregarded_vote_count"] == 1
    assert _ceiling(project) == SignalAudience.TEAM

    # And the vote ROW survives as the audit record — disregarded is not deleted.
    proposal = SignalCeilingRaiseProposal.objects.get(pk=proposal_id)
    assert proposal.votes.filter(voter=leaver).exists()


def test_a_ratified_proposal_is_not_retroactively_flipped(project: Project, team: Team) -> None:
    """C.3(3): recomputation reaches only OPEN proposals; a decision made is a fact.

    This is the hazard the live-roster rule is accused of. It does not arise, because
    ``_tally_and_maybe_apply`` short-circuits off a terminal status and the raise was
    applied inside the OPEN→RATIFIED transition. A later offboarding cannot un-share a
    signal; a team that wants the ceiling back lowers it, which §1.1 always allowed.
    """
    sm = _team_member(project, team, "sm", sm=True)
    approver = _team_member(project, team, "dev2")
    _team_member(project, team, "dev3")

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    proposal_id = open_resp.data["id"]
    ratifying = _client(approver).post(
        _vote_url(project, proposal_id), {"choice": "approve"}, format="json"
    )
    assert ratifying.data["status"] == CeilingRaiseStatus.RATIFIED
    assert _ceiling(project) == SignalAudience.PROGRAM_SHARED

    # Both approvers leave. Under a naive recompute the tally would fall below the bar.
    _offboard(project, sm)
    _offboard(project, approver)

    proposal = SignalCeilingRaiseProposal.objects.get(pk=proposal_id)
    assert proposal.status == CeilingRaiseStatus.RATIFIED
    assert _ceiling(project) == SignalAudience.PROGRAM_SHARED


def test_re_seating_a_member_restores_their_vote(project: Project, team: Team) -> None:
    """C.3(4): disregarding is not deleting — the vote comes back with the member."""
    sm = _team_member(project, team, "sm", sm=True)
    boomerang = _team_member(project, team, "boomerang")
    _team_member(project, team, "dev3")

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "team_sm_pm"}, format="json"
    )
    proposal_id = open_resp.data["id"]
    _client(boomerang).post(_vote_url(project, proposal_id), {"choice": "reject"}, format="json")

    _offboard(project, boomerang)
    gone = _client(sm).get(_policy_url(project)).data["open_proposals"]["velocity"]
    assert gone["reject_count"] == 0
    assert gone["disregarded_vote_count"] == 1

    ProjectMembership.objects.filter(project=project, user=boomerang).update(is_deleted=False)

    back = _client(sm).get(_policy_url(project)).data["open_proposals"]["velocity"]
    assert back["reject_count"] == 1
    assert back["disregarded_vote_count"] == 0


def test_a_revoked_project_member_cannot_vote(project: Project, team: Team) -> None:
    """The write gate agrees with the denominator — ``is_team_member`` carries the floor.

    They are 403'd by ``IsProjectMember`` before the roster is consulted, which is why
    this was never an authorization hole; the point is that the two seams now give the
    same answer, so the tally cannot count a roster the vote gate rejects.
    """
    sm = _team_member(project, team, "sm", sm=True)
    _team_member(project, team, "dev2")
    leaver = _team_member(project, team, "leaver")

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )
    proposal_id = open_resp.data["id"]

    _offboard(project, leaver)

    resp = _client(leaver).post(
        _vote_url(project, proposal_id), {"choice": "approve"}, format="json"
    )
    assert resp.status_code in (403, 404)
    assert _ceiling(project) == SignalAudience.TEAM


def test_non_team_project_admin_is_not_in_the_eligible_count(project: Project, team: Team) -> None:
    """ANTI-STUFFING, pinned on the governance surface as well as the seam (C.2).

    The intersection Amendment C adds could only widen the roster if it were a union;
    this asserts on the number a raise is actually measured against, so a future refactor
    to ``T ∪ M`` would fail here and not merely in the teams-service unit test.
    """
    sm = _team_member(project, team, "sm", sm=True)
    _team_member(project, team, "dev2")
    _project_only_member(project, "pmo", Role.ADMIN)
    _project_only_member(project, "sponsor", Role.OWNER)

    open_resp = _client(sm).post(
        _raise_url(project), {"signal": "velocity", "ceiling": "program_shared"}, format="json"
    )

    # Two team members. The Admin and the Owner are project members and not voters.
    assert open_resp.data["eligible_count"] == 2
    assert open_resp.data["threshold"] == 2
