"""Tests for the Decisions feature (ADR-0167, #748).

Covers the three surfaces #748 adds on top of the shipped Notes sub-resource
(ADR-0143, #740):

  * the ``decision`` toggle action on a task note (mirrors ``pin``);
  * the project/sprint Decisions list (``GET /projects/{id}/decisions/?sprint=``);
  * the team-owned oversight-visibility consent endpoint
    (``GET``/``PATCH /projects/{id}/decisions-policy/``).

Fixtures mirror ``test_task_notes.py``. The visibility gate is role-based — "team +
PM" is ``Role.MEMBER`` and above; a Viewer is the oversight reader gated until a
project Admin opts in.
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
    Project,
    ProjectDecisionsPolicy,
    Sprint,
    SprintState,
    Task,
    TaskNote,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _mute_broadcasts() -> object:
    """Every write path schedules an on_commit broadcast; mute it for unit tests."""
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        yield


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def admin(db: object) -> object:
    return User.objects.create_user(username="admin", password="pw")


@pytest.fixture
def member(db: object) -> object:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def member2(db: object) -> object:
    return User.objects.create_user(username="member2", password="pw")


@pytest.fixture
def viewer(db: object) -> object:
    return User.objects.create_user(username="viewer", password="pw")


@pytest.fixture
def outsider(db: object) -> object:
    return User.objects.create_user(username="outsider", password="pw")


@pytest.fixture
def memberships(
    project: Project,
    admin: object,
    member: object,
    member2: object,
    viewer: object,
) -> None:
    ProjectMembership.objects.create(project=project, user=admin, role=Role.ADMIN)
    ProjectMembership.objects.create(project=project, user=member, role=Role.MEMBER)
    ProjectMembership.objects.create(project=project, user=member2, role=Role.MEMBER)
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)


def _client_for(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def admin_client(admin: object) -> APIClient:
    return _client_for(admin)


@pytest.fixture
def member_client(member: object) -> APIClient:
    return _client_for(member)


@pytest.fixture
def member2_client(member2: object) -> APIClient:
    return _client_for(member2)


@pytest.fixture
def viewer_client(viewer: object) -> APIClient:
    return _client_for(viewer)


@pytest.fixture
def outsider_client(outsider: object) -> APIClient:
    return _client_for(outsider)


@pytest.fixture
def task(project: Project) -> Task:
    return Task.objects.create(project=project, name="Foundation", duration=1)


@pytest.fixture
def active_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 2",
        start_date=date(2026, 3, 1),
        finish_date=date(2026, 3, 14),
        state=SprintState.ACTIVE,
    )


@pytest.fixture
def closed_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Sprint 1",
        start_date=date(2026, 2, 1),
        finish_date=date(2026, 2, 14),
        state=SprintState.COMPLETED,
    )


def _note_decision_url(project: Project, task: Task, note_pk: object) -> str:
    return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/notes/{note_pk}/decision/"


def _decisions_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/decisions/"


def _decisions_policy_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/decisions-policy/"


def _make_note(
    task: Task, author: object, body: str = "We chose X.", *, decision: bool = False
) -> TaskNote:
    return TaskNote.objects.create(task=task, author=author, body=body, decision=decision)


# ---------------------------------------------------------------------------
# 1. Decision toggle (mirrors pin)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDecisionToggle:
    def test_member_can_toggle_decision(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
    ) -> None:
        note = _make_note(task, member)
        r1 = member_client.post(_note_decision_url(project, task, note.pk))
        assert r1.status_code == 200, r1.data
        assert r1.data["decision"] is True
        assert TaskNote.objects.get(pk=note.pk).decision is True

        r2 = member_client.post(_note_decision_url(project, task, note.pk))
        assert r2.status_code == 200
        assert r2.data["decision"] is False
        assert TaskNote.objects.get(pk=note.pk).decision is False

    def test_decision_is_not_author_gated(
        self,
        member_client: APIClient,
        member2_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
    ) -> None:
        """Flagging a decision is curation, not authorship — any writer may flag another's note."""
        note = _make_note(task, member)
        r = member2_client.post(_note_decision_url(project, task, note.pk))
        assert r.status_code == 200
        assert r.data["decision"] is True

    def test_viewer_cannot_toggle_decision(
        self,
        viewer_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
    ) -> None:
        note = _make_note(task, member)
        r = viewer_client.post(_note_decision_url(project, task, note.pk))
        assert r.status_code == 403

    def test_outsider_cannot_toggle_decision(
        self,
        outsider_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
    ) -> None:
        note = _make_note(task, member)
        r = outsider_client.post(_note_decision_url(project, task, note.pk))
        assert r.status_code in (403, 404)

    def test_toggle_broadcasts_decision_event(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
        django_capture_on_commit_callbacks: object,
    ) -> None:
        """The toggle fires a deferred ``task_note_decision_toggled`` board event with no body."""
        note = _make_note(task, member)
        with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event", Mock()) as mock_bcast:
            with django_capture_on_commit_callbacks(execute=True):  # type: ignore[operator]
                r = member_client.post(_note_decision_url(project, task, note.pk))
            assert r.status_code == 200, r.data
        assert mock_bcast.call_count == 1
        _project_id, event_type, payload = mock_bcast.call_args.args
        assert event_type == "task_note_decision_toggled"
        assert payload == {"id": str(note.pk), "task_id": str(task.pk), "decision": True}
        # The event must never carry the note body (ADR-0124 privacy idiom).
        assert "body" not in payload


# ---------------------------------------------------------------------------
# 2. Decisions list (project + sprint scope)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDecisionsList:
    def test_only_decision_flagged_notes_returned(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
    ) -> None:
        _make_note(task, member, "plain note", decision=False)
        decided = _make_note(task, member, "we decided X", decision=True)
        r = member_client.get(_decisions_url(project))
        assert r.status_code == 200, r.data
        ids = [row["id"] for row in r.data["results"]]
        assert str(decided.pk) in ids
        assert len(ids) == 1

    def test_soft_deleted_decision_excluded(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
    ) -> None:
        gone = _make_note(task, member, "obsolete decision", decision=True)
        gone.soft_delete(actor=member)
        r = member_client.get(_decisions_url(project))
        assert r.status_code == 200
        assert r.data["results"] == []

    def test_row_carries_task_and_sprint_context(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        active_sprint: Sprint,
        memberships: None,
    ) -> None:
        task.sprint = active_sprint
        task.save(update_fields=["sprint"])
        decided = _make_note(task, member, "sprint decision", decision=True)
        r = member_client.get(_decisions_url(project))
        row = next(x for x in r.data["results"] if x["id"] == str(decided.pk))
        assert row["task"] == {"id": str(task.pk), "name": "Foundation"}
        assert row["sprint"]["id"] == str(active_sprint.pk)
        assert row["sprint"]["name"] == "Sprint 2"
        assert row["sprint"]["state"] == SprintState.ACTIVE
        assert row["body"] == "sprint decision"
        assert row["author"]["username"] == "member"

    def test_backlog_decision_has_null_sprint(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
    ) -> None:
        decided = _make_note(task, member, "backlog decision", decision=True)
        r = member_client.get(_decisions_url(project))
        row = next(x for x in r.data["results"] if x["id"] == str(decided.pk))
        assert row["sprint"] is None

    def test_sprint_filter_scopes_to_that_sprint(
        self,
        member_client: APIClient,
        project: Project,
        member: object,
        active_sprint: Sprint,
        closed_sprint: Sprint,
        memberships: None,
    ) -> None:
        t_active = Task.objects.create(project=project, name="A", duration=1, sprint=active_sprint)
        t_closed = Task.objects.create(project=project, name="C", duration=1, sprint=closed_sprint)
        d_active = _make_note(t_active, member, "active decision", decision=True)
        d_closed = _make_note(t_closed, member, "closed decision", decision=True)

        r = member_client.get(_decisions_url(project), {"sprint": str(active_sprint.pk)})
        ids = [row["id"] for row in r.data["results"]]
        assert ids == [str(d_active.pk)]
        assert str(d_closed.pk) not in ids

    def test_project_view_includes_closed_sprint_and_orders_newest_sprint_first(
        self,
        member_client: APIClient,
        project: Project,
        member: object,
        active_sprint: Sprint,
        closed_sprint: Sprint,
        memberships: None,
    ) -> None:
        """No sprint param → every decision, closed sprints included, newest sprint first,
        backlog (no sprint) trailing (Alex's closed-sprint recall)."""
        t_active = Task.objects.create(project=project, name="A", duration=1, sprint=active_sprint)
        t_closed = Task.objects.create(project=project, name="C", duration=1, sprint=closed_sprint)
        t_backlog = Task.objects.create(project=project, name="B", duration=1)
        d_active = _make_note(t_active, member, "active", decision=True)
        d_closed = _make_note(t_closed, member, "closed", decision=True)
        d_backlog = _make_note(t_backlog, member, "backlog", decision=True)

        r = member_client.get(_decisions_url(project))
        ids = [row["id"] for row in r.data["results"]]
        # Active sprint (start 2026-03) → closed sprint (2026-02) → backlog (null) last.
        assert ids == [str(d_active.pk), str(d_closed.pk), str(d_backlog.pk)]

    def test_invalid_sprint_id_is_400(
        self, member_client: APIClient, project: Project, memberships: None
    ) -> None:
        r = member_client.get(_decisions_url(project), {"sprint": "not-a-uuid"})
        assert r.status_code == 400

    def test_response_is_paginated(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
    ) -> None:
        _make_note(task, member, "d", decision=True)
        r = member_client.get(_decisions_url(project))
        assert set(r.data.keys()) >= {"count", "results"}


# ---------------------------------------------------------------------------
# 3. Visibility gate
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDecisionsVisibility:
    def test_member_sees_decisions_by_default(
        self,
        member_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
    ) -> None:
        _make_note(task, member, "d", decision=True)
        assert member_client.get(_decisions_url(project)).status_code == 200

    def test_admin_sees_decisions_by_default(
        self,
        admin_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
    ) -> None:
        _make_note(task, member, "d", decision=True)
        assert admin_client.get(_decisions_url(project)).status_code == 200

    def test_viewer_denied_by_default(
        self,
        viewer_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
    ) -> None:
        _make_note(task, member, "d", decision=True)
        r = viewer_client.get(_decisions_url(project))
        assert r.status_code == 403

    def test_viewer_sees_after_admin_opts_in(
        self,
        admin_client: APIClient,
        viewer_client: APIClient,
        project: Project,
        task: Task,
        member: object,
        memberships: None,
    ) -> None:
        _make_note(task, member, "d", decision=True)
        # Default-closed → viewer suppressed.
        assert viewer_client.get(_decisions_url(project)).status_code == 403
        # Team-admin consent: an Admin opts oversight readers in.
        patch_r = admin_client.patch(
            _decisions_policy_url(project), {"oversight_visible": True}, format="json"
        )
        assert patch_r.status_code == 200, patch_r.data
        # Now the viewer (oversight reader) may read.
        assert viewer_client.get(_decisions_url(project)).status_code == 200

    def test_gate_runs_before_sprint_filter(
        self,
        admin_client: APIClient,
        viewer_client: APIClient,
        project: Project,
        member: object,
        active_sprint: Sprint,
        memberships: None,
    ) -> None:
        """A ``?sprint`` param is not a hole around the gate — a denied viewer gets 403
        regardless of the filter."""
        r = viewer_client.get(_decisions_url(project), {"sprint": str(active_sprint.pk)})
        assert r.status_code == 403


# ---------------------------------------------------------------------------
# 4. Consent endpoint (decisions-policy)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestDecisionsPolicy:
    def test_get_default_posture(
        self, member_client: APIClient, project: Project, memberships: None
    ) -> None:
        r = member_client.get(_decisions_policy_url(project))
        assert r.status_code == 200, r.data
        assert r.data["oversight_visible"] is False
        # A Member is not the consent authority.
        assert r.data["can_edit"] is False

    def test_get_can_edit_true_for_admin(
        self, admin_client: APIClient, project: Project, memberships: None
    ) -> None:
        r = admin_client.get(_decisions_policy_url(project))
        assert r.data["can_edit"] is True

    def test_admin_can_set_oversight_visible(
        self, admin_client: APIClient, project: Project, memberships: None
    ) -> None:
        r = admin_client.patch(
            _decisions_policy_url(project), {"oversight_visible": True}, format="json"
        )
        assert r.status_code == 200, r.data
        assert r.data["oversight_visible"] is True
        assert ProjectDecisionsPolicy.objects.get(project=project).oversight_visible is True

    def test_member_cannot_set_oversight_visible(
        self, member_client: APIClient, project: Project, memberships: None
    ) -> None:
        r = member_client.patch(
            _decisions_policy_url(project), {"oversight_visible": True}, format="json"
        )
        assert r.status_code == 403
        assert not ProjectDecisionsPolicy.objects.filter(
            project=project, oversight_visible=True
        ).exists()

    def test_viewer_cannot_set_oversight_visible(
        self, viewer_client: APIClient, project: Project, memberships: None
    ) -> None:
        r = viewer_client.patch(
            _decisions_policy_url(project), {"oversight_visible": True}, format="json"
        )
        assert r.status_code == 403

    def test_outsider_cannot_read_policy(
        self, outsider_client: APIClient, project: Project, memberships: None
    ) -> None:
        r = outsider_client.get(_decisions_policy_url(project))
        assert r.status_code in (403, 404)
