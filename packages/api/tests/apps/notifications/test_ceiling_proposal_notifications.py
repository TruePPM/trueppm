"""#1275 / ADR-0104 Amendment B — eligible voters are notified when a signal
ceiling-raise proposal opens / resolves.

The audience matrix, copy, and email-default are tested by sending the supply-only
``team_signal_ceiling_proposal_changed`` signal directly (the receiver runs
synchronously), then one end-to-end test drives the real ``/raise-ceiling/``
endpoint inside ``django_capture_on_commit_callbacks`` to prove the dispatch_uid
wiring actually reaches the receiver from the post-commit emission.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.notifications.models import (
    Notification,
    NotificationChannel,
    NotificationEventType,
    NotificationPreference,
)
from trueppm_api.apps.projects.models import (
    CeilingRaiseStatus,
    Project,
    SignalAudience,
    SignalCeilingRaiseProposal,
)
from trueppm_api.apps.projects.signals import team_signal_ceiling_proposal_changed
from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole

User = get_user_model()
pytestmark = pytest.mark.django_db

OPENED = NotificationEventType.SIGNAL_CEILING_PROPOSAL_OPENED
RESOLVED = NotificationEventType.SIGNAL_CEILING_PROPOSAL_RESOLVED


# --------------------------------------------------------------------------- #
# Fixtures / helpers (mirrors test_signal_privacy_ratification.py)
# --------------------------------------------------------------------------- #


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(name="Proj", start_date=date(2026, 1, 1))


@pytest.fixture
def team(project: Project) -> Team:
    # The auto-mirror signal is on_commit-deferred and does not fire inside the
    # test transaction — create the default team + roster explicitly.
    return Team.objects.create(project=project, name="Default", short_id="T01", is_default=True)


def _team_member(
    project: Project, team: Team, username: str, role: int = Role.MEMBER, *, sm: bool = False
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
    """A project member who is NOT on the default team (cannot vote / not notified)."""
    user = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


def _proposal(
    project: Project, proposer: Any, status: str, *, to: str = SignalAudience.PROGRAM_SHARED
) -> SignalCeilingRaiseProposal:
    return SignalCeilingRaiseProposal.objects.create(
        project=project,
        signal_key="velocity",
        from_ceiling=SignalAudience.TEAM,
        to_ceiling=to,
        proposed_by=proposer,
        status=status,
        expires_at=timezone.now() + timedelta(hours=72),
    )


def _emit(project: Project, proposal: SignalCeilingRaiseProposal, status: str) -> None:
    team_signal_ceiling_proposal_changed.send(
        sender=SignalCeilingRaiseProposal,
        project_id=str(project.pk),
        signal_key=proposal.signal_key,
        proposal_id=str(proposal.pk),
        status=status,
    )


def _recipients(event_type: str) -> set[Any]:
    return set(
        Notification.objects.filter(event_type=event_type).values_list("recipient_id", flat=True)
    )


# --------------------------------------------------------------------------- #
# Open — eligible voters minus the proposer
# --------------------------------------------------------------------------- #


def test_open_notifies_eligible_voters_except_proposer(project: Project, team: Team) -> None:
    proposer = _team_member(project, team, "sm", sm=True)
    dev2 = _team_member(project, team, "dev2")
    dev3 = _team_member(project, team, "dev3")

    proposal = _proposal(project, proposer, CeilingRaiseStatus.OPEN)
    _emit(project, proposal, CeilingRaiseStatus.OPEN)

    assert _recipients(OPENED) == {dev2.id, dev3.id}
    # The proposer already has the 202 + proposal confirmation — no self-notify.
    assert not Notification.objects.filter(recipient_id=proposer.id).exists()

    row = Notification.objects.filter(event_type=OPENED, recipient_id=dev2.id).get()
    assert "velocity" in row.body
    assert "Signal privacy" in row.body  # discovery deep-link hint
    assert row.task_id is None
    # Email is strictly opt-in — default OFF (Priya's hard-NO preserved).
    assert row.email_pending is False


# --------------------------------------------------------------------------- #
# Resolve — eligible voters plus the proposer; one event per terminal state
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("status", "word"),
    [
        (CeilingRaiseStatus.RATIFIED, "ratified"),
        (CeilingRaiseStatus.REJECTED, "rejected"),
        (CeilingRaiseStatus.EXPIRED, "expired"),
    ],
)
def test_resolution_notifies_voters_and_proposer(
    project: Project, team: Team, status: str, word: str
) -> None:
    proposer = _team_member(project, team, "sm", sm=True)
    dev2 = _team_member(project, team, "dev2")

    proposal = _proposal(project, proposer, status)
    _emit(project, proposal, status)

    assert _recipients(RESOLVED) == {proposer.id, dev2.id}
    row = Notification.objects.filter(event_type=RESOLVED, recipient_id=proposer.id).get()
    assert word in row.body
    assert row.email_pending is False


def test_superseded_notifies_no_one(project: Project, team: Team) -> None:
    proposer = _team_member(project, team, "sm", sm=True)
    _team_member(project, team, "dev2")

    proposal = _proposal(project, proposer, CeilingRaiseStatus.SUPERSEDED)
    _emit(project, proposal, CeilingRaiseStatus.SUPERSEDED)

    # The replacement proposal emits its own "opened" notice; superseded is silent.
    assert Notification.objects.count() == 0


# --------------------------------------------------------------------------- #
# The no-management-bypass boundary (ADR-0104 §A.2/§A.5)
# --------------------------------------------------------------------------- #


def test_non_team_project_admin_is_never_notified(project: Project, team: Team) -> None:
    proposer = _team_member(project, team, "sm", sm=True)
    dev2 = _team_member(project, team, "dev2")
    # A project Admin with NO team membership — cannot vote, must not be notified.
    outsider = _project_only_member(project, "pmo", Role.ADMIN)

    proposal = _proposal(project, proposer, CeilingRaiseStatus.OPEN)
    _emit(project, proposal, CeilingRaiseStatus.OPEN)

    assert _recipients(OPENED) == {dev2.id}
    assert not Notification.objects.filter(recipient_id=outsider.id).exists()


# --------------------------------------------------------------------------- #
# Email follows the recipient's existing preference (opt-in)
# --------------------------------------------------------------------------- #


def test_email_pending_set_only_when_recipient_opted_in(project: Project, team: Team) -> None:
    proposer = _team_member(project, team, "sm", sm=True)
    opted_in = _team_member(project, team, "dev2")
    default_user = _team_member(project, team, "dev3")
    NotificationPreference.objects.create(
        user=opted_in, event_type=OPENED, channel=NotificationChannel.EMAIL, enabled=True
    )

    proposal = _proposal(project, proposer, CeilingRaiseStatus.OPEN)
    _emit(project, proposal, CeilingRaiseStatus.OPEN)

    assert Notification.objects.get(recipient_id=opted_in.id).email_pending is True
    assert Notification.objects.get(recipient_id=default_user.id).email_pending is False


def test_in_app_can_be_muted_per_user(project: Project, team: Team) -> None:
    proposer = _team_member(project, team, "sm", sm=True)
    muted = _team_member(project, team, "dev2")
    _team_member(project, team, "dev3")
    NotificationPreference.objects.create(
        user=muted, event_type=OPENED, channel=NotificationChannel.IN_APP, enabled=False
    )

    proposal = _proposal(project, proposer, CeilingRaiseStatus.OPEN)
    _emit(project, proposal, CeilingRaiseStatus.OPEN)

    # The muted voter gets no inbox row; the other voter still does.
    assert not Notification.objects.filter(recipient_id=muted.id).exists()
    assert Notification.objects.filter(event_type=OPENED).count() == 1


# --------------------------------------------------------------------------- #
# End-to-end — the real raise endpoint reaches the receiver via on_commit
# --------------------------------------------------------------------------- #


def test_raise_endpoint_reaches_receiver(
    project: Project, team: Team, django_capture_on_commit_callbacks: Any
) -> None:
    proposer = _team_member(project, team, "sm", sm=True)
    dev2 = _team_member(project, team, "dev2")
    dev3 = _team_member(project, team, "dev3")

    client = APIClient()
    client.force_authenticate(user=proposer)
    with django_capture_on_commit_callbacks(execute=True):
        resp = client.post(
            f"/api/v1/projects/{project.pk}/signal-privacy/raise-ceiling/",
            {"signal": "velocity", "ceiling": "program_shared"},
            format="json",
        )

    assert resp.status_code == 202, resp.data
    assert resp.data["status"] == CeilingRaiseStatus.OPEN
    # The post-commit signal fired and the receiver fanned out to the two
    # non-proposer voters — proving the AppConfig.ready() wiring.
    assert _recipients(OPENED) == {dev2.id, dev3.id}
