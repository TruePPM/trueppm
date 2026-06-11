"""Tests for the live multi-writer retro board + team-health pulse (ADR-0117, #851/#923).

Headline guard-rails:
- the **pulse privacy 🔴** — the per-sprint trend is read by the team + Scrum-Master
  band only; the PM band gets ``{gated: true}`` with NO data; a non-member is denied
  outright; the trend is aggregate-only (an individual's raw mood never leaves);
- the **editable-window guard** — the board/pulse reject writes on PLANNED/CANCELLED
  sprints and accept them on ACTIVE/COMPLETED;
- **convert-to-action idempotency** and that the converted item flows into the
  unchanged #858 promote path.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import signal_privacy_services as svc
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    PulseResponse,
    RetroActionItem,
    RetroBoardItem,
    SignalAudience,
    Sprint,
    SprintRetro,
    SprintState,
)

User = get_user_model()
pytestmark = pytest.mark.django_db


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture
def calendar() -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=calendar)


def _member(project: Project, username: str, role: int) -> Any:
    u = User.objects.create_user(username=username, password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=role)
    return u


@pytest.fixture
def member(project: Project) -> Any:
    return _member(project, "member", Role.MEMBER)


@pytest.fixture
def member2(project: Project) -> Any:
    return _member(project, "member2", Role.MEMBER)


@pytest.fixture
def viewer(project: Project) -> Any:
    return _member(project, "viewer", Role.VIEWER)


@pytest.fixture
def pm(project: Project) -> Any:
    return _member(project, "pm", Role.ADMIN)


@pytest.fixture
def stranger() -> Any:
    return User.objects.create_user(username="stranger", password="pw")


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _sprint(project: Project, state: str = SprintState.ACTIVE, name: str = "S1") -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=state,
    )


# --------------------------------------------------------------------------- #
# Board stickies — CRUD + RBAC
# --------------------------------------------------------------------------- #


def test_member_creates_sticky_and_reads_board(project: Project, member: Any) -> None:
    s = _sprint(project)
    resp = _client(member).post(
        f"/api/v1/sprints/{s.pk}/retro-board/",
        {"column": "went_well", "text": "Pairing helped"},
        format="json",
    )
    assert resp.status_code == 201, resp.data
    assert resp.data["author_username"] == "member"
    assert resp.data["column"] == "went_well"

    board = _client(member).get(f"/api/v1/sprints/{s.pk}/retro-board/")
    assert board.status_code == 200
    assert [c["key"] for c in board.data["columns"]] == ["went_well", "to_improve", "ideas"]
    assert len(board.data["items"]) == 1
    assert board.data["items"][0]["text"] == "Pairing helped"


def test_viewer_can_read_board_but_not_create(project: Project, viewer: Any) -> None:
    s = _sprint(project)
    assert _client(viewer).get(f"/api/v1/sprints/{s.pk}/retro-board/").status_code == 200
    resp = _client(viewer).post(
        f"/api/v1/sprints/{s.pk}/retro-board/",
        {"column": "went_well", "text": "nope"},
        format="json",
    )
    assert resp.status_code == 403


def test_stranger_denied_board(project: Project, stranger: Any) -> None:
    s = _sprint(project)
    assert _client(stranger).get(f"/api/v1/sprints/{s.pk}/retro-board/").status_code == 403


def test_edit_and_move_sticky(project: Project, member: Any) -> None:
    s = _sprint(project)
    item = RetroBoardItem.objects.create(
        retro=SprintRetro.objects.create(sprint=s, created_by=member),
        column="went_well",
        text="orig",
        author=member,
        position=1.0,
    )
    # edit text
    r = _client(member).patch(f"/api/v1/retro-items/{item.pk}/", {"text": "edited"}, format="json")
    assert r.status_code == 200 and r.data["text"] == "edited"
    # move to another column + fractional position
    r = _client(member).patch(
        f"/api/v1/retro-items/{item.pk}/",
        {"column": "to_improve", "position": 2.5},
        format="json",
    )
    assert r.status_code == 200 and r.data["column"] == "to_improve" and r.data["position"] == 2.5


def test_delete_sticky_soft_deletes(project: Project, member: Any) -> None:
    s = _sprint(project)
    item = RetroBoardItem.objects.create(
        retro=SprintRetro.objects.create(sprint=s, created_by=member),
        column="ideas",
        text="x",
        author=member,
    )
    assert _client(member).delete(f"/api/v1/retro-items/{item.pk}/").status_code == 204
    item.refresh_from_db()
    assert item.is_deleted is True


def test_stranger_cannot_reach_other_teams_sticky(
    project: Project, member: Any, stranger: Any
) -> None:
    """Object-level gate: a non-member 404s rather than editing another team's sticky."""
    s = _sprint(project)
    item = RetroBoardItem.objects.create(
        retro=SprintRetro.objects.create(sprint=s, created_by=member),
        column="went_well",
        text="secret",
        author=member,
    )
    r = _client(stranger).patch(f"/api/v1/retro-items/{item.pk}/", {"text": "hax"}, format="json")
    assert r.status_code in (403, 404)
    item.refresh_from_db()
    assert item.text == "secret"


# --------------------------------------------------------------------------- #
# Editable-window guard (ADR-0117 §6)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("state", [SprintState.ACTIVE, SprintState.COMPLETED])
def test_board_writable_when_active_or_completed(project: Project, member: Any, state: str) -> None:
    s = _sprint(project, state=state)
    r = _client(member).post(
        f"/api/v1/sprints/{s.pk}/retro-board/",
        {"column": "went_well", "text": "ok"},
        format="json",
    )
    assert r.status_code == 201, r.data


@pytest.mark.parametrize("state", [SprintState.PLANNED, SprintState.CANCELLED])
def test_board_read_only_when_planned_or_cancelled(
    project: Project, member: Any, state: str
) -> None:
    s = _sprint(project, state=state)
    r = _client(member).post(
        f"/api/v1/sprints/{s.pk}/retro-board/",
        {"column": "went_well", "text": "no"},
        format="json",
    )
    assert r.status_code == 400


def test_empty_sticky_rejected(project: Project, member: Any) -> None:
    s = _sprint(project)
    r = _client(member).post(
        f"/api/v1/sprints/{s.pk}/retro-board/", {"column": "ideas", "text": "   "}, format="json"
    )
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# Convert sticky -> action item (ADR-0117 §1) + the #858 promote loop
# --------------------------------------------------------------------------- #


def test_convert_to_action_is_idempotent(project: Project, member: Any) -> None:
    s = _sprint(project)
    item = RetroBoardItem.objects.create(
        retro=SprintRetro.objects.create(sprint=s, created_by=member),
        column="to_improve",
        text="Shorten standup",
        author=member,
    )
    first = _client(member).post(f"/api/v1/retro-items/{item.pk}/convert-to-action/")
    assert first.status_code == 201
    action_id = first.data["id"]
    assert RetroActionItem.objects.filter(pk=action_id, text="Shorten standup").exists()

    # second convert is a no-op returning the same action item (200, not a dup)
    second = _client(member).post(f"/api/v1/retro-items/{item.pk}/convert-to-action/")
    assert second.status_code == 200
    assert second.data["id"] == action_id
    assert RetroActionItem.objects.filter(retro__sprint=s, is_deleted=False).count() == 1


def test_converted_action_item_promotes_to_backlog(project: Project, member: Any) -> None:
    """The discussion->action->backlog loop: a converted item flows into #858 promote."""
    s = _sprint(project)
    item = RetroBoardItem.objects.create(
        retro=SprintRetro.objects.create(sprint=s, created_by=member),
        column="to_improve",
        text="Add CI retry budget",
        author=member,
    )
    action_id = _client(member).post(f"/api/v1/retro-items/{item.pk}/convert-to-action/").data["id"]
    promote = _client(member).post(
        f"/api/v1/sprints/{s.pk}/retrospective/action-items/{action_id}/promote/"
    )
    assert promote.status_code in (200, 201), promote.data
    RetroActionItem.objects.get(pk=action_id).refresh_from_db()
    assert RetroActionItem.objects.get(pk=action_id).promoted_task_id is not None


# --------------------------------------------------------------------------- #
# Pulse upsert (#923)
# --------------------------------------------------------------------------- #


def test_pulse_upsert_is_one_per_person(project: Project, member: Any) -> None:
    s = _sprint(project)
    c = _client(member)
    r = c.put(f"/api/v1/sprints/{s.pk}/pulse/", {"mood": 4, "energy": 3}, format="json")
    assert r.status_code == 200 and r.data["mood"] == 4
    # re-tap updates, never duplicates
    r = c.put(
        f"/api/v1/sprints/{s.pk}/pulse/", {"mood": 2, "energy": 5, "confidence": 4}, format="json"
    )
    assert r.status_code == 200 and r.data["mood"] == 2 and r.data["confidence"] == 4
    assert PulseResponse.objects.filter(retro__sprint=s, is_deleted=False).count() == 1


def test_pulse_get_echoes_own_response_or_204(project: Project, member: Any) -> None:
    s = _sprint(project)
    c = _client(member)
    assert c.get(f"/api/v1/sprints/{s.pk}/pulse/").status_code == 204
    c.put(f"/api/v1/sprints/{s.pk}/pulse/", {"mood": 5, "energy": 5}, format="json")
    got = c.get(f"/api/v1/sprints/{s.pk}/pulse/")
    assert got.status_code == 200 and got.data["mood"] == 5


@pytest.mark.parametrize(
    "payload", [{"mood": 0, "energy": 3}, {"mood": 6, "energy": 3}, {"mood": 3}]
)
def test_pulse_validation(project: Project, member: Any, payload: dict[str, int]) -> None:
    s = _sprint(project)
    r = _client(member).put(f"/api/v1/sprints/{s.pk}/pulse/", payload, format="json")
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# Pulse trend privacy — the 🔴 (ADR-0117 §5 / ADR-0104 pulse gate)
# --------------------------------------------------------------------------- #


def _seed_pulse(sprint: Sprint, users: list[Any]) -> None:
    retro = SprintRetro.objects.create(sprint=sprint)
    for i, u in enumerate(users):
        PulseResponse.objects.create(retro=retro, respondent=u, mood=3 + (i % 3), energy=4)


def test_team_member_reads_pulse_trend(project: Project, member: Any, member2: Any) -> None:
    s = _sprint(project)
    _seed_pulse(s, [member, member2])
    r = _client(member).get(f"/api/v1/sprints/{s.pk}/pulse-trend/")
    assert r.status_code == 200
    assert r.data["gated"] is False
    assert len(r.data["points"]) == 1
    assert r.data["points"][0]["response_count"] == 2
    # aggregate-only: no individual raw response leaks into a point
    assert "respondent" not in r.data["points"][0]
    assert "mood" not in r.data["points"][0]  # only avg_mood is exposed
    assert r.data["points"][0]["avg_energy"] == 4.0


def test_pm_band_pulse_trend_is_gated_with_no_data(project: Project, member: Any, pm: Any) -> None:
    """🔴 Morgan: the PM band sees {gated: true} and NOTHING else at the default."""
    s = _sprint(project)
    _seed_pulse(s, [member])
    r = _client(pm).get(f"/api/v1/sprints/{s.pk}/pulse-trend/")
    assert r.status_code == 200
    assert r.data == {"gated": True}  # no points, no count, nothing to infer from


def test_non_member_denied_pulse_trend(project: Project, member: Any, stranger: Any) -> None:
    s = _sprint(project)
    _seed_pulse(s, [member])
    assert _client(stranger).get(f"/api/v1/sprints/{s.pk}/pulse-trend/").status_code == 403


def test_pm_reads_pulse_only_after_team_shares_up(project: Project, member: Any, pm: Any) -> None:
    """Team-owned raise: PM reads the pulse trend only once the team lifts the audience."""
    s = _sprint(project)
    _seed_pulse(s, [member])
    policy = svc.get_or_create_policy(project)
    svc.raise_signal_ceiling(policy, "pulse", SignalAudience.TEAM_SM_PM)
    svc.set_signal_audience(policy, "pulse", SignalAudience.TEAM_SM_PM)
    r = _client(pm).get(f"/api/v1/sprints/{s.pk}/pulse-trend/")
    assert r.status_code == 200 and r.data["gated"] is False
    assert len(r.data["points"]) == 1


def test_energy_declining_flag(project: Project, member: Any) -> None:
    """Server computes the 'two sprints before velocity' early-warning flag."""
    # three sprints across consecutive months, energy falling 5 -> 4 -> 2
    for i, (energy, month) in enumerate([(5, 4), (4, 5), (2, 6)]):
        sp = Sprint.objects.create(
            project=project,
            name=f"S{i}",
            start_date=date(2026, month, 1),
            finish_date=date(2026, month, 14),
            state=SprintState.COMPLETED,
        )
        PulseResponse.objects.create(
            retro=SprintRetro.objects.create(sprint=sp), respondent=member, mood=3, energy=energy
        )
    latest = Sprint.objects.filter(project=project).order_by("-start_date").first()
    assert latest is not None
    r = _client(member).get(f"/api/v1/sprints/{latest.pk}/pulse-trend/")
    assert r.status_code == 200
    assert r.data["energy_declining"] is True
    assert len(r.data["points"]) == 3


# --------------------------------------------------------------------------- #
# Broadcast wiring (best-effort, on commit) — ADR-0117 §4 / §DE.1
# --------------------------------------------------------------------------- #


def test_sticky_create_broadcasts_on_commit(
    project: Project,
    member: Any,
    monkeypatch: pytest.MonkeyPatch,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "trueppm_api.apps.sync.broadcast.broadcast_board_event",
        lambda pid, event_type, payload: calls.append((event_type, payload.get("id", ""))),
    )
    s = _sprint(project)
    with django_capture_on_commit_callbacks(execute=True):
        _client(member).post(
            f"/api/v1/sprints/{s.pk}/retro-board/",
            {"column": "went_well", "text": "broadcast me"},
            format="json",
        )
    assert any(event == "retro_item_created" for event, _ in calls)


def test_pulse_upsert_does_not_broadcast(
    project: Project,
    member: Any,
    monkeypatch: pytest.MonkeyPatch,
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Pulse must NOT broadcast — a project-board event reaches the PM band as a
    read-receipt (Morgan 🔴)."""
    calls: list[str] = []
    monkeypatch.setattr(
        "trueppm_api.apps.sync.broadcast.broadcast_board_event",
        lambda pid, event_type, payload: calls.append(event_type),
    )
    s = _sprint(project)
    with django_capture_on_commit_callbacks(execute=True):
        _client(member).put(
            f"/api/v1/sprints/{s.pk}/pulse/", {"mood": 3, "energy": 3}, format="json"
        )
    assert calls == []
