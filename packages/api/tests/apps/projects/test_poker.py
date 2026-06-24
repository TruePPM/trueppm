"""Tests for sprint-planning estimation poker (ADR-0179, #863).

Covers the round lifecycle (open → vote → reveal → reopen → commit/cancel), the
facilitator-vs-participant RBAC split, the state-driven vote-privacy boundary (no
participant reads another's value pre-reveal), the commit write to Task.story_points, and
the poker_session_updated broadcast.

Facilitator = Admin OR Scrum-Master/Product-Owner facet (real TeamMembership rows).
Participant = a default-team member.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import Mock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    PokerSession,
    PokerVote,
    Project,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.teams.models import Team, TeamMembership, TeamRole

User = get_user_model()


@pytest.fixture(autouse=True)
def _mute_broadcasts() -> object:
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        yield


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=calendar)


def _user(name: str) -> object:
    return User.objects.create_user(username=name, password="pw")


@pytest.fixture
def admin(db: object) -> object:
    return _user("admin")


@pytest.fixture
def sm(db: object) -> object:
    return _user("sm")


@pytest.fixture
def member(db: object) -> object:
    return _user("member")


@pytest.fixture
def member2(db: object) -> object:
    return _user("member2")


@pytest.fixture
def viewer(db: object) -> object:
    return _user("viewer")


@pytest.fixture
def outsider(db: object) -> object:
    return _user("outsider")


@pytest.fixture
def setup_team(
    project: Project,
    admin: object,
    sm: object,
    member: object,
    member2: object,
    viewer: object,
) -> Team:
    """ProjectMemberships + a default Team. admin=Admin (facilitator via role); sm=Member with
    the Scrum-Master facet (facilitator via facet); member/member2=team participants;
    viewer=project Viewer NOT on the team (a non-participant)."""
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    ProjectMembership.objects.create(project=project, user=sm, role=Role.MEMBER)
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    ProjectMembership.objects.create(project=project, user=member2, role=Role.MEMBER)
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    team = Team.objects.create(project=project, name="Default", short_id="T01", is_default=True)
    TeamMembership.objects.create(team=team, user=admin, role=TeamRole.MEMBER)
    TeamMembership.objects.create(team=team, user=sm, role=TeamRole.MEMBER, is_scrum_master=True)
    TeamMembership.objects.create(team=team, user=member, role=TeamRole.MEMBER)
    TeamMembership.objects.create(team=team, user=member2, role=TeamRole.MEMBER)
    return team


@pytest.fixture
def sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 1",
        start_date=date(2026, 2, 1),
        finish_date=date(2026, 2, 14),
        state=SprintState.PLANNED,
    )


@pytest.fixture
def task(project: Project, sprint: Sprint) -> Task:
    return Task.objects.create(project=project, name="Login redesign", duration=1, sprint=sprint)


def _c(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def admin_client(admin: object) -> APIClient:
    return _c(admin)


@pytest.fixture
def sm_client(sm: object) -> APIClient:
    return _c(sm)


@pytest.fixture
def member_client(member: object) -> APIClient:
    return _c(member)


@pytest.fixture
def member2_client(member2: object) -> APIClient:
    return _c(member2)


@pytest.fixture
def viewer_client(viewer: object) -> APIClient:
    return _c(viewer)


@pytest.fixture
def outsider_client(outsider: object) -> APIClient:
    return _c(outsider)


def _sprint_poker_url(sprint: Sprint) -> str:
    return f"/api/v1/sprints/{sprint.pk}/poker/"


def _action_url(session: PokerSession, action: str) -> str:
    return f"/api/v1/poker/{session.pk}/{action}/"


def _open(client: APIClient, sprint: Sprint, task: Task) -> object:
    return client.post(_sprint_poker_url(sprint), {"task": str(task.pk)}, format="json")


# ---------------------------------------------------------------------------
# 1. Open
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestOpen:
    def test_admin_can_open(
        self, admin_client: APIClient, sprint: Sprint, task: Task, setup_team: Team
    ) -> None:
        r = _open(admin_client, sprint, task)
        assert r.status_code == 200, r.data
        assert r.data["state"] == "open"
        assert r.data["task"] == {"id": str(task.pk), "name": "Login redesign"}

    def test_scrum_master_facet_can_open(
        self, sm_client: APIClient, sprint: Sprint, task: Task, setup_team: Team
    ) -> None:
        r = _open(sm_client, sprint, task)
        assert r.status_code == 200, r.data

    def test_plain_member_cannot_open(
        self, member_client: APIClient, sprint: Sprint, task: Task, setup_team: Team
    ) -> None:
        r = _open(member_client, sprint, task)
        assert r.status_code == 403

    def test_outsider_cannot_open(
        self, outsider_client: APIClient, sprint: Sprint, task: Task, setup_team: Team
    ) -> None:
        r = _open(outsider_client, sprint, task)
        assert r.status_code in (403, 404)

    def test_open_requires_planned_sprint(
        self, admin_client: APIClient, sprint: Sprint, task: Task, setup_team: Team
    ) -> None:
        sprint.state = SprintState.ACTIVE
        sprint.save(update_fields=["state"])
        r = _open(admin_client, sprint, task)
        assert r.status_code == 409
        assert r.data["code"] == "sprint_not_planned"

    def test_open_rejects_task_in_other_sprint(
        self, admin_client: APIClient, project: Project, sprint: Sprint, setup_team: Team
    ) -> None:
        other = Task.objects.create(project=project, name="Stray", duration=1)  # no sprint
        r = _open(admin_client, sprint, other)
        assert r.status_code == 400

    def test_double_open_same_task_conflicts(
        self, admin_client: APIClient, sprint: Sprint, task: Task, setup_team: Team
    ) -> None:
        assert _open(admin_client, sprint, task).status_code == 200
        r2 = _open(admin_client, sprint, task)
        assert r2.status_code == 409
        assert r2.data["code"] == "already_live"


# ---------------------------------------------------------------------------
# 2. Vote
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestVote:
    def _open_session(self, admin_client: APIClient, sprint: Sprint, task: Task) -> PokerSession:
        sid = _open(admin_client, sprint, task).data["id"]
        return PokerSession.objects.get(pk=sid)

    def test_member_votes_and_my_vote_is_returned(
        self,
        admin_client: APIClient,
        member_client: APIClient,
        sprint: Sprint,
        task: Task,
        setup_team: Team,
    ) -> None:
        session = self._open_session(admin_client, sprint, task)
        r = member_client.post(
            _action_url(session, "vote"), {"value": 5, "comment": "auth scope"}, format="json"
        )
        assert r.status_code == 200, r.data
        assert r.data["my_vote"] == {"value": 5, "comment": "auth scope"}
        assert r.data["vote_count"] == 1

    def test_vote_is_upsert(
        self,
        admin_client: APIClient,
        member_client: APIClient,
        sprint: Sprint,
        task: Task,
        setup_team: Team,
    ) -> None:
        session = self._open_session(admin_client, sprint, task)
        member_client.post(_action_url(session, "vote"), {"value": 3}, format="json")
        r = member_client.post(_action_url(session, "vote"), {"value": 8}, format="json")
        assert r.data["my_vote"]["value"] == 8
        assert PokerVote.objects.filter(session=session).count() == 1

    def test_unsure_card_null_allowed(
        self,
        admin_client: APIClient,
        member_client: APIClient,
        sprint: Sprint,
        task: Task,
        setup_team: Team,
    ) -> None:
        session = self._open_session(admin_client, sprint, task)
        r = member_client.post(_action_url(session, "vote"), {"value": None}, format="json")
        assert r.status_code == 200
        assert r.data["my_vote"]["value"] is None

    def test_invalid_card_rejected(
        self,
        admin_client: APIClient,
        member_client: APIClient,
        sprint: Sprint,
        task: Task,
        setup_team: Team,
    ) -> None:
        session = self._open_session(admin_client, sprint, task)
        r = member_client.post(_action_url(session, "vote"), {"value": 4}, format="json")
        assert r.status_code == 400

    def test_non_team_user_cannot_vote(
        self,
        admin_client: APIClient,
        viewer_client: APIClient,
        sprint: Sprint,
        task: Task,
        setup_team: Team,
    ) -> None:
        session = self._open_session(admin_client, sprint, task)
        r = viewer_client.post(_action_url(session, "vote"), {"value": 5}, format="json")
        assert r.status_code == 403

    def test_cannot_vote_after_reveal(
        self,
        admin_client: APIClient,
        member_client: APIClient,
        sprint: Sprint,
        task: Task,
        setup_team: Team,
    ) -> None:
        session = self._open_session(admin_client, sprint, task)
        member_client.post(_action_url(session, "vote"), {"value": 5}, format="json")
        admin_client.post(_action_url(session, "reveal"))
        r = member_client.post(_action_url(session, "vote"), {"value": 8}, format="json")
        assert r.status_code == 409
        assert r.data["code"] == "not_open"


# ---------------------------------------------------------------------------
# 3. Privacy boundary (the load-bearing control)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestPrivacy:
    def _opened_with_two_votes(
        self, admin_client, member_client, member2_client, sprint, task
    ) -> PokerSession:
        sid = _open(admin_client, sprint, task).data["id"]
        session = PokerSession.objects.get(pk=sid)
        member_client.post(_action_url(session, "vote"), {"value": 3}, format="json")
        member2_client.post(_action_url(session, "vote"), {"value": 13}, format="json")
        return session

    def test_pre_reveal_hides_others_values(
        self,
        admin_client: APIClient,
        member_client: APIClient,
        member2_client: APIClient,
        sprint: Sprint,
        task: Task,
        setup_team: Team,
    ) -> None:
        self._opened_with_two_votes(admin_client, member_client, member2_client, sprint, task)
        # member sees the count + their own vote, but NOT member2's value.
        r = member_client.get(_sprint_poker_url(sprint))
        row = r.data[0]
        assert row["vote_count"] == 2
        assert row["my_vote"]["value"] == 3
        assert row["votes"] == []  # privacy: no per-member values pre-reveal

    def test_my_vote_survives_refetch(
        self,
        admin_client: APIClient,
        member_client: APIClient,
        member2_client: APIClient,
        sprint: Sprint,
        task: Task,
        setup_team: Team,
    ) -> None:
        self._opened_with_two_votes(admin_client, member_client, member2_client, sprint, task)
        # A fresh GET (a page refresh) still returns the caller's own card.
        r = member_client.get(_sprint_poker_url(sprint))
        assert r.data[0]["my_vote"]["value"] == 3

    def test_reveal_exposes_all_votes(
        self,
        admin_client: APIClient,
        member_client: APIClient,
        member2_client: APIClient,
        sprint: Sprint,
        task: Task,
        setup_team: Team,
    ) -> None:
        session = self._opened_with_two_votes(
            admin_client, member_client, member2_client, sprint, task
        )
        admin_client.post(_action_url(session, "reveal"))
        r = member_client.get(_sprint_poker_url(sprint))
        values = sorted(v["value"] for v in r.data[0]["votes"])
        assert values == [3, 13]


# ---------------------------------------------------------------------------
# 4. Reveal / reopen
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestRevealReopen:
    def _open(self, admin_client, sprint, task) -> PokerSession:
        return PokerSession.objects.get(pk=_open(admin_client, sprint, task).data["id"])

    def test_facilitator_reveals(
        self, admin_client: APIClient, sprint: Sprint, task: Task, setup_team: Team
    ) -> None:
        session = self._open(admin_client, sprint, task)
        r = admin_client.post(_action_url(session, "reveal"))
        assert r.status_code == 200
        assert r.data["state"] == "revealed"

    def test_member_cannot_reveal(
        self,
        admin_client: APIClient,
        member_client: APIClient,
        sprint: Sprint,
        task: Task,
        setup_team: Team,
    ) -> None:
        session = self._open(admin_client, sprint, task)
        assert member_client.post(_action_url(session, "reveal")).status_code == 403

    def test_reopen_retains_votes(
        self,
        admin_client: APIClient,
        member_client: APIClient,
        sprint: Sprint,
        task: Task,
        setup_team: Team,
    ) -> None:
        session = self._open(admin_client, sprint, task)
        member_client.post(_action_url(session, "vote"), {"value": 5}, format="json")
        admin_client.post(_action_url(session, "reveal"))
        r = admin_client.post(_action_url(session, "reopen"))
        assert r.status_code == 200
        assert r.data["state"] == "open"
        assert PokerVote.objects.filter(session=session).count() == 1  # vote retained
        # Privacy re-suppressed: the votes exist in the DB (post-reveal) but reopening to
        # `open` must hide their values again so a re-vote isn't anchored on the reveal.
        assert r.data["votes"] == []


# ---------------------------------------------------------------------------
# 5. Commit / cancel
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestCommitCancel:
    def _revealed(self, admin_client, member_client, sprint, task) -> PokerSession:
        session = PokerSession.objects.get(pk=_open(admin_client, sprint, task).data["id"])
        member_client.post(_action_url(session, "vote"), {"value": 8}, format="json")
        admin_client.post(_action_url(session, "reveal"))
        return session

    def test_commit_writes_story_points(
        self,
        admin_client: APIClient,
        member_client: APIClient,
        sprint: Sprint,
        task: Task,
        setup_team: Team,
    ) -> None:
        session = self._revealed(admin_client, member_client, sprint, task)
        r = admin_client.post(_action_url(session, "commit"), {"points": 8}, format="json")
        assert r.status_code == 200, r.data
        assert r.data["state"] == "committed"
        assert r.data["committed_points"] == 8
        task.refresh_from_db()
        assert task.story_points == 8

    def test_member_cannot_commit(
        self,
        admin_client: APIClient,
        member_client: APIClient,
        sprint: Sprint,
        task: Task,
        setup_team: Team,
    ) -> None:
        session = self._revealed(admin_client, member_client, sprint, task)
        assert (
            member_client.post(
                _action_url(session, "commit"), {"points": 8}, format="json"
            ).status_code
            == 403
        )

    def test_commit_rejects_non_fibonacci(
        self,
        admin_client: APIClient,
        member_client: APIClient,
        sprint: Sprint,
        task: Task,
        setup_team: Team,
    ) -> None:
        session = self._revealed(admin_client, member_client, sprint, task)
        assert (
            admin_client.post(
                _action_url(session, "commit"), {"points": 7}, format="json"
            ).status_code
            == 400
        )

    def test_new_round_allowed_after_commit(
        self,
        admin_client: APIClient,
        member_client: APIClient,
        sprint: Sprint,
        task: Task,
        setup_team: Team,
    ) -> None:
        session = self._revealed(admin_client, member_client, sprint, task)
        admin_client.post(_action_url(session, "commit"), {"points": 8}, format="json")
        # The one-live-per-task constraint is released once the round is terminal.
        assert _open(admin_client, sprint, task).status_code == 200

    def test_cancel_does_not_write_points(
        self, admin_client: APIClient, sprint: Sprint, task: Task, setup_team: Team
    ) -> None:
        session = PokerSession.objects.get(pk=_open(admin_client, sprint, task).data["id"])
        r = admin_client.post(_action_url(session, "cancel"))
        assert r.status_code == 200
        assert r.data["state"] == "cancelled"
        assert r.data["votes"] == []  # a cancelled round never exposes votes
        task.refresh_from_db()
        assert task.story_points is None


# ---------------------------------------------------------------------------
# 6. Broadcast
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestBroadcast:
    def test_open_broadcasts_session_updated_without_vote_values(
        self,
        admin_client: APIClient,
        sprint: Sprint,
        task: Task,
        setup_team: Team,
        django_capture_on_commit_callbacks: object,
    ) -> None:
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event", Mock()) as bcast:
            with django_capture_on_commit_callbacks(execute=True):  # type: ignore[operator]
                r = _open(admin_client, sprint, task)
            assert r.status_code == 200
        assert bcast.call_count == 1
        _pid, event_type, payload = bcast.call_args.args
        assert event_type == "poker_session_updated"
        assert set(payload.keys()) == {"id", "task_id", "state"}
        assert "value" not in payload and "votes" not in payload
