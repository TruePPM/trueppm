"""SprintViewSet — CRUD, state transitions, permissions (ADR-0037)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    AcceptanceCriterion,
    Baseline,
    BaselineTask,
    Calendar,
    Project,
    ScopeChangeStatus,
    Sprint,
    SprintCloseRequest,
    SprintCloseRequestStatus,
    SprintScopeChange,
    SprintState,
    SprintTaskOutcome,
    Task,
    TaskStatus,
    TaskType,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def member_user(db: object) -> object:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def viewer_user(db: object) -> object:
    return User.objects.create_user(username="viewer", password="pw")


@pytest.fixture
def stranger(db: object) -> object:
    return User.objects.create_user(username="stranger", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def owner_membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.fixture
def member_membership(member_user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)


@pytest.fixture
def viewer_membership(viewer_user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=viewer_user, role=Role.VIEWER)


@pytest.fixture
def client(user: object, owner_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def member_client(member_user: object, member_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=member_user)
    return c


@pytest.fixture
def scheduler_user(db: object) -> object:
    return User.objects.create_user(username="scheduler", password="pw")


@pytest.fixture
def scheduler_membership(scheduler_user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(
        project=project, user=scheduler_user, role=Role.SCHEDULER
    )


@pytest.fixture
def scheduler_client(scheduler_user: object, scheduler_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=scheduler_user)
    return c


@pytest.fixture
def viewer_client(viewer_user: object, viewer_membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=viewer_user)
    return c


@pytest.fixture
def stranger_client(stranger: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=stranger)
    return c


def _make_sprint(project: Project, **kwargs: object) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=kwargs.pop("name", "Sprint 1"),
        start_date=kwargs.pop("start_date", date(2026, 4, 1)),
        finish_date=kwargs.pop("finish_date", date(2026, 4, 14)),
        **kwargs,
    )


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


def _list(resp_json: object) -> list[dict[str, object]]:
    """Unwrap DRF pagination envelope when present."""
    if isinstance(resp_json, dict) and "results" in resp_json:
        return resp_json["results"]
    return resp_json  # type: ignore[return-value]


def test_list_returns_sprints_for_member(member_client: APIClient, project: Project) -> None:
    _make_sprint(project, name="A")
    _make_sprint(project, name="B")
    resp = member_client.get(f"/api/v1/projects/{project.pk}/sprints/")
    assert resp.status_code == 200
    rows = _list(resp.json())
    names = sorted(s["name"] for s in rows)
    assert names == ["A", "B"]


def test_list_filters_by_state(member_client: APIClient, project: Project) -> None:
    _make_sprint(project, name="P")  # PLANNED
    s2 = _make_sprint(project, name="C", state=SprintState.COMPLETED)
    resp = member_client.get(
        f"/api/v1/projects/{project.pk}/sprints/?state={SprintState.COMPLETED}"
    )
    assert resp.status_code == 200
    rows = _list(resp.json())
    ids = [r["id"] for r in rows]
    assert ids == [str(s2.pk)]


def test_create_sprint_requires_member(stranger_client: APIClient, project: Project) -> None:
    resp = stranger_client.post(
        f"/api/v1/projects/{project.pk}/sprints/",
        {
            "name": "S1",
            "start_date": "2026-04-01",
            "finish_date": "2026-04-14",
        },
        format="json",
    )
    assert resp.status_code in (403, 404)


def test_member_can_create_sprint(member_client: APIClient, project: Project) -> None:
    resp = member_client.post(
        f"/api/v1/projects/{project.pk}/sprints/",
        {"name": "S1", "start_date": "2026-04-01", "finish_date": "2026-04-14"},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.json()["short_id_display"].startswith("SP-")
    assert resp.json()["state"] == SprintState.PLANNED
    # ADR-0048: notes is exposed and defaults to empty string.
    assert resp.json()["notes"] == ""


def test_create_sprint_with_notes(member_client: APIClient, project: Project) -> None:
    resp = member_client.post(
        f"/api/v1/projects/{project.pk}/sprints/",
        {
            "name": "S1",
            "start_date": "2026-04-01",
            "finish_date": "2026-04-14",
            "notes": "Carry-over from S0; revisit capacity after retro.",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.json()["notes"].startswith("Carry-over from S0")


def test_active_sprint_accepts_notes_patch(client: APIClient, project: Project) -> None:
    # notes are PM annotations and remain editable past the PLANNED state —
    # only name/goal/dates are frozen on activation.
    s = _make_sprint(project, name="Active sprint", state=SprintState.ACTIVE)
    resp = client.patch(f"/api/v1/sprints/{s.pk}/", {"notes": "Mid-sprint update"}, format="json")
    assert resp.status_code == 200, resp.content
    s.refresh_from_db()
    assert s.notes == "Mid-sprint update"


def test_viewer_cannot_create(viewer_client: APIClient, project: Project) -> None:
    resp = viewer_client.post(
        f"/api/v1/projects/{project.pk}/sprints/",
        {"name": "S", "start_date": "2026-04-01", "finish_date": "2026-04-14"},
        format="json",
    )
    assert resp.status_code == 403


def test_planned_sprint_can_patch_name(client: APIClient, project: Project) -> None:
    s = _make_sprint(project, name="Original")
    resp = client.patch(f"/api/v1/sprints/{s.pk}/", {"name": "Updated"}, format="json")
    assert resp.status_code == 200, resp.content
    s.refresh_from_db()
    assert s.name == "Updated"


def test_active_sprint_rejects_name_patch(client: APIClient, project: Project) -> None:
    s = _make_sprint(project, name="Original", state=SprintState.ACTIVE)
    resp = client.patch(f"/api/v1/sprints/{s.pk}/", {"name": "X"}, format="json")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# capacity_points (ADR-0073) — planning target distinct from committed_points
# ---------------------------------------------------------------------------


def test_planned_sprint_accepts_capacity_points(client: APIClient, project: Project) -> None:
    s = _make_sprint(project)
    resp = client.patch(f"/api/v1/sprints/{s.pk}/", {"capacity_points": 40}, format="json")
    assert resp.status_code == 200, resp.content
    s.refresh_from_db()
    assert s.capacity_points == 40


def test_active_sprint_accepts_capacity_points_patch(client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.ACTIVE)
    resp = client.patch(f"/api/v1/sprints/{s.pk}/", {"capacity_points": 35}, format="json")
    assert resp.status_code == 200, resp.content
    s.refresh_from_db()
    assert s.capacity_points == 35


def test_completed_sprint_rejects_capacity_points_patch(
    client: APIClient, project: Project
) -> None:
    s = _make_sprint(project, state=SprintState.COMPLETED, capacity_points=30)
    resp = client.patch(f"/api/v1/sprints/{s.pk}/", {"capacity_points": 50}, format="json")
    assert resp.status_code == 400


def test_cancelled_sprint_rejects_capacity_points_patch(
    client: APIClient, project: Project
) -> None:
    s = _make_sprint(project, state=SprintState.CANCELLED, capacity_points=30)
    resp = client.patch(f"/api/v1/sprints/{s.pk}/", {"capacity_points": 50}, format="json")
    assert resp.status_code == 400


def test_viewer_cannot_patch_capacity_points(viewer_client: APIClient, project: Project) -> None:
    s = _make_sprint(project)
    resp = viewer_client.patch(f"/api/v1/sprints/{s.pk}/", {"capacity_points": 40}, format="json")
    assert resp.status_code == 403


def test_member_cannot_patch_capacity_points(member_client: APIClient, project: Project) -> None:
    """Capacity is the team's planning target — SCHEDULER+ only (ADR-0073)."""
    s = _make_sprint(project)
    resp = member_client.patch(f"/api/v1/sprints/{s.pk}/", {"capacity_points": 40}, format="json")
    assert resp.status_code == 400, resp.content
    s.refresh_from_db()
    assert s.capacity_points is None


def test_scheduler_can_patch_capacity_points(scheduler_client: APIClient, project: Project) -> None:
    s = _make_sprint(project)
    resp = scheduler_client.patch(
        f"/api/v1/sprints/{s.pk}/", {"capacity_points": 40}, format="json"
    )
    assert resp.status_code == 200, resp.content
    s.refresh_from_db()
    assert s.capacity_points == 40


def test_capacity_points_null_is_default(client: APIClient, project: Project) -> None:
    s = _make_sprint(project)
    resp = client.get(f"/api/v1/sprints/{s.pk}/")
    assert resp.status_code == 200
    assert resp.json()["capacity_points"] is None


def test_capacity_points_can_be_cleared(client: APIClient, project: Project) -> None:
    s = _make_sprint(project, capacity_points=40)
    resp = client.patch(f"/api/v1/sprints/{s.pk}/", {"capacity_points": None}, format="json")
    assert resp.status_code == 200, resp.content
    s.refresh_from_db()
    assert s.capacity_points is None


def test_capacity_points_patch_bumps_server_version(client: APIClient, project: Project) -> None:
    s = _make_sprint(project, capacity_points=10)
    initial_version = s.server_version
    resp = client.patch(f"/api/v1/sprints/{s.pk}/", {"capacity_points": 20}, format="json")
    assert resp.status_code == 200
    s.refresh_from_db()
    assert s.server_version > initial_version


def test_capacity_points_history_recorded(client: APIClient, project: Project) -> None:
    s = _make_sprint(project)
    client.patch(f"/api/v1/sprints/{s.pk}/", {"capacity_points": 30}, format="json")
    client.patch(f"/api/v1/sprints/{s.pk}/", {"capacity_points": 35}, format="json")
    s.refresh_from_db()
    history = list(s.history.order_by("history_date").values_list("capacity_points", flat=True))
    assert 30 in history
    assert 35 in history


# ---------------------------------------------------------------------------
# exclude_from_velocity (ADR-0113, #1092) — Sprint 0 escape hatch. SCHEDULER+
# field-gate like capacity_points, but UNLIKE it, editable in EVERY state
# including COMPLETED (teams realise the contamination retrospectively).
# ---------------------------------------------------------------------------


def test_scheduler_can_set_exclude_from_velocity(
    scheduler_client: APIClient, project: Project
) -> None:
    s = _make_sprint(project)
    resp = scheduler_client.patch(
        f"/api/v1/sprints/{s.pk}/", {"exclude_from_velocity": True}, format="json"
    )
    assert resp.status_code == 200, resp.content
    s.refresh_from_db()
    assert s.exclude_from_velocity is True


def test_member_cannot_set_exclude_from_velocity(
    member_client: APIClient, project: Project
) -> None:
    """Team-owned planning field — SCHEDULER+ only (ADR-0113)."""
    s = _make_sprint(project)
    resp = member_client.patch(
        f"/api/v1/sprints/{s.pk}/", {"exclude_from_velocity": True}, format="json"
    )
    assert resp.status_code == 400, resp.content
    s.refresh_from_db()
    assert s.exclude_from_velocity is False


def test_viewer_cannot_set_exclude_from_velocity(
    viewer_client: APIClient, project: Project
) -> None:
    s = _make_sprint(project)
    resp = viewer_client.patch(
        f"/api/v1/sprints/{s.pk}/", {"exclude_from_velocity": True}, format="json"
    )
    assert resp.status_code == 403


def test_completed_sprint_accepts_exclude_from_velocity(
    scheduler_client: APIClient, project: Project
) -> None:
    """The distinguishing behaviour: editable AFTER close, unlike capacity_points."""
    s = _make_sprint(project, state=SprintState.COMPLETED, completed_points=3)
    resp = scheduler_client.patch(
        f"/api/v1/sprints/{s.pk}/", {"exclude_from_velocity": True}, format="json"
    )
    assert resp.status_code == 200, resp.content
    s.refresh_from_db()
    assert s.exclude_from_velocity is True
    # The flag must not mutate the close-time snapshot.
    assert s.completed_points == 3


def test_exclude_from_velocity_defaults_false(client: APIClient, project: Project) -> None:
    s = _make_sprint(project)
    resp = client.get(f"/api/v1/sprints/{s.pk}/")
    assert resp.status_code == 200
    assert resp.json()["exclude_from_velocity"] is False


def test_exclude_from_velocity_history_recorded(
    scheduler_client: APIClient, project: Project
) -> None:
    s = _make_sprint(project)
    scheduler_client.patch(
        f"/api/v1/sprints/{s.pk}/", {"exclude_from_velocity": True}, format="json"
    )
    s.refresh_from_db()
    flags = list(s.history.order_by("history_date").values_list("exclude_from_velocity", flat=True))
    # The audit trail (ADR-0113) captures the change — Marcus's visibility ask.
    assert True in flags


# ---------------------------------------------------------------------------
# wip_limit (#546) — per-sprint WIP-overload threshold. Same field-level gate
# as capacity_points: SCHEDULER+ writes, editable PLANNED + ACTIVE, locked on
# COMPLETED + CANCELLED, history recorded. wip_count is a read-only annotation.
# ---------------------------------------------------------------------------


def test_planned_sprint_accepts_wip_limit(client: APIClient, project: Project) -> None:
    s = _make_sprint(project)
    resp = client.patch(f"/api/v1/sprints/{s.pk}/", {"wip_limit": 5}, format="json")
    assert resp.status_code == 200, resp.content
    s.refresh_from_db()
    assert s.wip_limit == 5


def test_active_sprint_accepts_wip_limit_patch(client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.ACTIVE)
    resp = client.patch(f"/api/v1/sprints/{s.pk}/", {"wip_limit": 4}, format="json")
    assert resp.status_code == 200, resp.content
    s.refresh_from_db()
    assert s.wip_limit == 4


def test_completed_sprint_rejects_wip_limit_patch(client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.COMPLETED, wip_limit=5)
    resp = client.patch(f"/api/v1/sprints/{s.pk}/", {"wip_limit": 9}, format="json")
    assert resp.status_code == 400


def test_cancelled_sprint_rejects_wip_limit_patch(client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.CANCELLED, wip_limit=5)
    resp = client.patch(f"/api/v1/sprints/{s.pk}/", {"wip_limit": 9}, format="json")
    assert resp.status_code == 400


def test_viewer_cannot_patch_wip_limit(viewer_client: APIClient, project: Project) -> None:
    s = _make_sprint(project)
    resp = viewer_client.patch(f"/api/v1/sprints/{s.pk}/", {"wip_limit": 5}, format="json")
    assert resp.status_code == 403


def test_member_cannot_patch_wip_limit(member_client: APIClient, project: Project) -> None:
    """WIP limit is a team planning knob — SCHEDULER+ only (same gate as capacity)."""
    s = _make_sprint(project)
    resp = member_client.patch(f"/api/v1/sprints/{s.pk}/", {"wip_limit": 5}, format="json")
    assert resp.status_code == 400, resp.content
    s.refresh_from_db()
    assert s.wip_limit is None


def test_scheduler_can_patch_wip_limit(scheduler_client: APIClient, project: Project) -> None:
    s = _make_sprint(project)
    resp = scheduler_client.patch(f"/api/v1/sprints/{s.pk}/", {"wip_limit": 5}, format="json")
    assert resp.status_code == 200, resp.content
    s.refresh_from_db()
    assert s.wip_limit == 5


def test_wip_limit_null_is_default(client: APIClient, project: Project) -> None:
    s = _make_sprint(project)
    resp = client.get(f"/api/v1/sprints/{s.pk}/")
    assert resp.status_code == 200
    assert resp.json()["wip_limit"] is None


def test_wip_limit_can_be_cleared(client: APIClient, project: Project) -> None:
    s = _make_sprint(project, wip_limit=5)
    resp = client.patch(f"/api/v1/sprints/{s.pk}/", {"wip_limit": None}, format="json")
    assert resp.status_code == 200, resp.content
    s.refresh_from_db()
    assert s.wip_limit is None


def test_wip_limit_history_recorded(client: APIClient, project: Project) -> None:
    s = _make_sprint(project)
    client.patch(f"/api/v1/sprints/{s.pk}/", {"wip_limit": 3}, format="json")
    client.patch(f"/api/v1/sprints/{s.pk}/", {"wip_limit": 6}, format="json")
    s.refresh_from_db()
    history = list(s.history.order_by("history_date").values_list("wip_limit", flat=True))
    assert 3 in history
    assert 6 in history


def test_wip_count_annotation_counts_in_flight_tasks(client: APIClient, project: Project) -> None:
    """wip_count = IN_PROGRESS + REVIEW only — not BACKLOG/NOT_STARTED/COMPLETE."""
    s = _make_sprint(project, state=SprintState.ACTIVE, wip_limit=2)
    Task.objects.create(
        project=project, name="prog", duration=1, sprint=s, status=TaskStatus.IN_PROGRESS
    )
    Task.objects.create(project=project, name="rev", duration=1, sprint=s, status=TaskStatus.REVIEW)
    Task.objects.create(
        project=project, name="todo", duration=1, sprint=s, status=TaskStatus.NOT_STARTED
    )
    Task.objects.create(
        project=project, name="done", duration=1, sprint=s, status=TaskStatus.COMPLETE
    )
    # Detail (via list queryset annotation):
    resp = client.get(f"/api/v1/sprints/{s.pk}/")
    assert resp.status_code == 200
    assert resp.json()["wip_count"] == 2


# ---------------------------------------------------------------------------
# goal_outcome (#983) — SCHEDULER+ writable, NOT locked on COMPLETED (it is the
# post-close verdict), exposed read on the serializer.
# ---------------------------------------------------------------------------


def test_goal_outcome_exposed_on_serializer(client: APIClient, project: Project) -> None:
    s = _make_sprint(project)
    resp = client.get(f"/api/v1/sprints/{s.pk}/")
    assert resp.status_code == 200
    assert "goal_outcome" in resp.json()
    assert resp.json()["goal_outcome"] is None


def test_scheduler_can_set_goal_outcome_on_completed_sprint(
    scheduler_client: APIClient, project: Project
) -> None:
    """Unlike capacity/WIP, goal_outcome is editable after close (the verdict)."""
    s = _make_sprint(project, state=SprintState.COMPLETED)
    resp = scheduler_client.patch(
        f"/api/v1/sprints/{s.pk}/", {"goal_outcome": "PARTIAL"}, format="json"
    )
    assert resp.status_code == 200, resp.content
    s.refresh_from_db()
    assert s.goal_outcome == "PARTIAL"


def test_member_cannot_set_goal_outcome(member_client: APIClient, project: Project) -> None:
    s = _make_sprint(project)
    resp = member_client.patch(f"/api/v1/sprints/{s.pk}/", {"goal_outcome": "MET"}, format="json")
    assert resp.status_code == 400, resp.content
    s.refresh_from_db()
    assert s.goal_outcome is None


def test_destroy_only_when_planned(client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.ACTIVE)
    resp = client.delete(f"/api/v1/sprints/{s.pk}/")
    assert resp.status_code == 400


def test_admin_can_destroy_planned(client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.PLANNED)
    resp = client.delete(f"/api/v1/sprints/{s.pk}/")
    assert resp.status_code == 204
    s.refresh_from_db()
    assert s.is_deleted is True


def test_member_cannot_destroy(member_client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.PLANNED)
    resp = member_client.delete(f"/api/v1/sprints/{s.pk}/")
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Activate
# ---------------------------------------------------------------------------


def test_activate_planned_sprint_snapshots_committed(
    member_client: APIClient, project: Project
) -> None:
    s = _make_sprint(project)
    Task.objects.create(project=project, name="A", duration=2, sprint=s, story_points=5)
    Task.objects.create(project=project, name="B", duration=3, sprint=s, story_points=8)
    Task.objects.create(project=project, name="C", duration=1, sprint=s)  # null points

    resp = member_client.post(f"/api/v1/sprints/{s.pk}/activate/")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["state"] == SprintState.ACTIVE
    assert body["committed_points"] == 13
    assert body["committed_task_count"] == 3
    assert "warnings" in body
    s.refresh_from_db()
    assert s.activated_at is not None


def test_activate_rejects_when_other_sprint_active(
    member_client: APIClient, project: Project
) -> None:
    _make_sprint(project, name="Already", state=SprintState.ACTIVE)
    s = _make_sprint(
        project,
        name="Pending",
        start_date=date(2026, 5, 1),
        finish_date=date(2026, 5, 14),
    )
    resp = member_client.post(f"/api/v1/sprints/{s.pk}/activate/")
    assert resp.status_code == 409
    assert "conflicting_sprint_id" in resp.json()


def test_activate_only_from_planned(member_client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.COMPLETED)
    resp = member_client.post(f"/api/v1/sprints/{s.pk}/activate/")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Cancel
# ---------------------------------------------------------------------------


def test_cancel_planned_sprint(member_client: APIClient, project: Project) -> None:
    s = _make_sprint(project)
    resp = member_client.post(f"/api/v1/sprints/{s.pk}/cancel/")
    assert resp.status_code == 200
    s.refresh_from_db()
    assert s.state == SprintState.CANCELLED


def test_cancel_active_rejected(member_client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.ACTIVE)
    resp = member_client.post(f"/api/v1/sprints/{s.pk}/cancel/")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Close (returns 202 — drain handles the rest)
# ---------------------------------------------------------------------------


def test_close_active_sprint_returns_202(member_client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.ACTIVE)
    resp = member_client.post(
        f"/api/v1/sprints/{s.pk}/close/",
        {"carry_over_to": "backlog"},
        format="json",
    )
    assert resp.status_code == 202, resp.content
    body = resp.json()
    assert body["queued"] is True
    assert "request_id" in body
    req = SprintCloseRequest.objects.get(pk=body["request_id"])
    assert req.status == SprintCloseRequestStatus.PENDING
    assert req.carry_over_to == "backlog"


def test_close_only_from_active(member_client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.PLANNED)
    resp = member_client.post(f"/api/v1/sprints/{s.pk}/close/")
    assert resp.status_code == 400


def test_close_rejects_invalid_carry_over_to(member_client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.ACTIVE)
    resp = member_client.post(
        f"/api/v1/sprints/{s.pk}/close/",
        {"carry_over_to": "not-a-uuid"},
        format="json",
    )
    assert resp.status_code == 400


def test_close_rejects_carry_over_to_other_project(
    member_client: APIClient, project: Project, calendar: Calendar
) -> None:
    other = Project.objects.create(name="Other", start_date=date(2026, 4, 1), calendar=calendar)
    target = Sprint.objects.create(
        project=other,
        name="Future",
        start_date=date(2026, 6, 1),
        finish_date=date(2026, 6, 14),
    )
    s = _make_sprint(project, state=SprintState.ACTIVE)
    resp = member_client.post(
        f"/api/v1/sprints/{s.pk}/close/",
        {"carry_over_to": str(target.pk)},
        format="json",
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Burndown
# ---------------------------------------------------------------------------


def test_burndown_returns_sprint_and_snapshots(member_client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.ACTIVE)
    from trueppm_api.apps.projects.models import SprintBurnSnapshot

    SprintBurnSnapshot.objects.create(
        sprint=s,
        snapshot_date=date(2026, 4, 5),
        remaining_points=5,
        remaining_task_count=2,
        completed_points=3,
        completed_task_count=1,
    )
    resp = member_client.get(f"/api/v1/sprints/{s.pk}/burndown/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["sprint"]["id"] == str(s.pk)
    assert len(body["snapshots"]) == 1
    snap = body["snapshots"][0]
    assert snap["snapshot_date"] == "2026-04-05"
    assert snap["remaining_points"] == 5


def test_burndown_requires_membership(stranger_client: APIClient, project: Project) -> None:
    s = _make_sprint(project)
    resp = stranger_client.get(f"/api/v1/sprints/{s.pk}/burndown/")
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# Velocity
# ---------------------------------------------------------------------------


def test_velocity_empty_returns_nulls(member_client: APIClient, project: Project) -> None:
    resp = member_client.get(f"/api/v1/projects/{project.pk}/velocity/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["sprints"] == []
    assert body["rolling_avg_points"] is None


def test_velocity_with_two_closed_sprints_has_stdev(
    member_client: APIClient, project: Project
) -> None:
    from django.utils import timezone

    Sprint.objects.create(
        project=project,
        name="S1",
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
        state=SprintState.COMPLETED,
        committed_points=20,
        completed_points=18,
        committed_task_count=10,
        completed_task_count=9,
        closed_at=timezone.now(),
    )
    Sprint.objects.create(
        project=project,
        name="S2",
        start_date=date(2026, 2, 1),
        finish_date=date(2026, 2, 14),
        state=SprintState.COMPLETED,
        committed_points=24,
        completed_points=22,
        committed_task_count=12,
        completed_task_count=11,
        closed_at=timezone.now(),
    )
    resp = member_client.get(f"/api/v1/projects/{project.pk}/velocity/")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["sprints"]) == 2
    assert body["rolling_avg_points"] == 20.0  # (18+22)/2
    assert body["rolling_stdev_points"] is not None
    assert body["forecast_range_low"] is not None
    assert body["forecast_range_high"] >= body["forecast_range_low"]


# ---------------------------------------------------------------------------
# Task ?sprint=… filter
# ---------------------------------------------------------------------------


def test_task_filter_by_sprint(member_client: APIClient, project: Project) -> None:
    s = _make_sprint(project)
    in_sprint = Task.objects.create(project=project, name="In", duration=1, sprint=s)
    Task.objects.create(project=project, name="Backlog", duration=1)  # sprint=None
    resp = member_client.get(f"/api/v1/tasks/?project={project.pk}&sprint={s.pk}")
    assert resp.status_code == 200
    ids = [t["id"] for t in _list(resp.json())]
    assert ids == [str(in_sprint.pk)]


def test_task_filter_sprint_none_returns_backlog(
    member_client: APIClient, project: Project
) -> None:
    s = _make_sprint(project)
    Task.objects.create(project=project, name="In", duration=1, sprint=s)
    backlog = Task.objects.create(project=project, name="Backlog", duration=1)
    resp = member_client.get(f"/api/v1/tasks/?project={project.pk}&sprint=none")
    assert resp.status_code == 200
    ids = [t["id"] for t in _list(resp.json())]
    assert ids == [str(backlog.pk)]


def test_target_milestone_detail_inlined_when_set(
    member_client: APIClient, project: Project
) -> None:
    """SprintSerializer nests milestone task fields for the AdvancingToMilestone card."""
    milestone = Task.objects.create(
        project=project, name="FAT review", duration=1, is_milestone=True
    )
    s = _make_sprint(project, target_milestone=milestone)
    resp = member_client.get(f"/api/v1/sprints/{s.pk}/")
    assert resp.status_code == 200
    detail = resp.data["target_milestone_detail"]
    assert detail is not None
    assert detail["id"] == str(milestone.pk)
    assert detail["name"] == "FAT review"


def test_target_milestone_detail_null_when_unset(
    member_client: APIClient, project: Project
) -> None:
    s = _make_sprint(project)
    resp = member_client.get(f"/api/v1/sprints/{s.pk}/")
    assert resp.status_code == 200
    assert resp.data["target_milestone_detail"] is None


# ---------------------------------------------------------------------------
# /capacity/ endpoint (issue #228)
# ---------------------------------------------------------------------------


def test_capacity_endpoint_returns_aggregate_and_members(
    member_client: APIClient, project: Project
) -> None:
    s = _make_sprint(project)
    resp = member_client.get(f"/api/v1/sprints/{s.pk}/capacity/")
    assert resp.status_code == 200
    assert "members" in resp.data
    assert "totals" in resp.data
    totals = resp.data["totals"]
    for key in ("committed_hours", "available_hours", "ratio", "buffer_hours", "label", "pto_days"):
        assert key in totals
    assert totals["pto_days"] == 0
    assert totals["label"] in ("on_track", "at_risk", "over_capacity")


def test_capacity_endpoint_requires_membership(
    stranger_client: APIClient, project: Project
) -> None:
    s = _make_sprint(project)
    resp = stranger_client.get(f"/api/v1/sprints/{s.pk}/capacity/")
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# GET /sprints/{id}/outcome/ — consolidated sprint-review read (#985)
# ---------------------------------------------------------------------------


def _closed_with_outcomes(project: Project) -> Sprint:
    s = _make_sprint(
        project,
        state=SprintState.COMPLETED,
        committed_points=10,
        completed_points=8,
        completed_task_count=1,
        committed_task_count=2,
        goal_outcome="MET",
    )
    SprintTaskOutcome.objects.create(
        sprint=s,
        task=None,
        task_short_id="T-1",
        task_title="Done thing",
        story_points=8,
        final_status="COMPLETE",
        disposition="completed",
    )
    SprintTaskOutcome.objects.create(
        sprint=s,
        task=None,
        task_short_id="T-2",
        task_title="Carried thing",
        story_points=3,
        final_status="IN_PROGRESS",
        disposition="carried",
    )
    return s


def test_outcome_closed_sprint_returns_review(member_client: APIClient, project: Project) -> None:
    s = _closed_with_outcomes(project)
    resp = member_client.get(f"/api/v1/sprints/{s.pk}/outcome/")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["state"] == "COMPLETED"
    assert body["provisional"] is False
    assert body["outcome_recorded"] is True
    assert body["goal_outcome"] == "MET"
    assert body["commitment"]["completion_ratio_points"] == 0.8
    # Completed row excluded; only the carried one is "didn't ship".
    assert len(body["didnt_ship"]) == 1
    assert body["didnt_ship"][0]["disposition"] == "carried"
    assert body["didnt_ship"][0]["story_points"] == 3  # MEMBER is in the team band
    assert body["didnt_ship_summary"]["carried_count"] == 1
    # MEMBER (TEAM band) reads the velocity block.
    assert body["velocity"] is not None


def test_outcome_velocity_suppressed_for_management_band(
    client: APIClient, project: Project
) -> None:
    """OWNER (>= ADMIN → TEAM_SM_PM band) is above velocity's TEAM default."""
    s = _closed_with_outcomes(project)
    resp = client.get(f"/api/v1/sprints/{s.pk}/outcome/")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["velocity"] is None  # suppressed
    # Side-channel guard: per-task points nulled, but titles/dispositions stay.
    assert body["didnt_ship"][0]["story_points"] is None
    assert body["didnt_ship"][0]["disposition"] == "carried"
    assert body["didnt_ship"][0]["task_title"] == "Carried thing"
    # Commitment completion ratio stays (the milestone-health carve-out).
    assert body["commitment"]["completion_ratio_points"] == 0.8


def test_outcome_active_sprint_is_provisional(member_client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.ACTIVE, committed_points=10)
    Task.objects.create(
        project=project, name="Open", duration=1, sprint=s, status=TaskStatus.IN_PROGRESS
    )
    resp = member_client.get(f"/api/v1/sprints/{s.pk}/outcome/")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["provisional"] is True
    assert body["outcome_recorded"] is False
    assert len(body["didnt_ship"]) == 1
    assert body["didnt_ship"][0]["disposition"] is None  # decided at close


def test_outcome_pre_feature_closed_sprint(member_client: APIClient, project: Project) -> None:
    """A sprint closed before #982 has no outcome rows → outcome_recorded False."""
    s = _make_sprint(project, state=SprintState.COMPLETED, committed_points=10, completed_points=10)
    resp = member_client.get(f"/api/v1/sprints/{s.pk}/outcome/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["outcome_recorded"] is False
    assert body["didnt_ship"] == []


def test_outcome_viewer_can_read(viewer_client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.COMPLETED)
    resp = viewer_client.get(f"/api/v1/sprints/{s.pk}/outcome/")
    assert resp.status_code == 200


def test_outcome_non_member_denied(stranger_client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.COMPLETED)
    resp = stranger_client.get(f"/api/v1/sprints/{s.pk}/outcome/")
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# Sprint Review: accepted-vs-not breakdown + demo list (#924, ADR-0118)
# ---------------------------------------------------------------------------


def _closed_with_review(project: Project) -> tuple[Sprint, SprintTaskOutcome]:
    """A closed sprint with three shipped stories: one fully accepted (all criteria
    met), one with an unmet criterion, one with no criteria. Returns the sprint and
    the accepted story's outcome row (for demo-toggle tests)."""
    s = _make_sprint(project, state=SprintState.COMPLETED, committed_points=12, completed_points=12)

    def shipped(name: str, pts: int, criteria: list[bool]) -> SprintTaskOutcome:
        task = Task.objects.create(
            project=project,
            name=name,
            duration=1,
            sprint=s,
            status=TaskStatus.COMPLETE,
            story_points=pts,
        )
        for i, met in enumerate(criteria):
            AcceptanceCriterion.objects.create(task=task, text=f"AC{i}", met=met, position=i)
        return SprintTaskOutcome.objects.create(
            sprint=s,
            task=task,
            task_short_id=f"T-{name}",
            task_title=name,
            story_points=pts,
            final_status="COMPLETE",
            disposition="completed",
        )

    accepted_row = shipped("alpha", 5, [True, True])  # fully accepted
    shipped("beta", 4, [True, False])  # has criteria, not all met → not_accepted
    shipped("gamma", 3, [])  # no criteria
    return s, accepted_row


def test_review_accepted_buckets(member_client: APIClient, project: Project) -> None:
    s, _ = _closed_with_review(project)
    body = member_client.get(f"/api/v1/sprints/{s.pk}/outcome/").json()
    r = body["review"]
    assert r["accepted_count"] == 1
    assert r["not_accepted_count"] == 1
    assert r["no_criteria_count"] == 1
    assert r["accepted_points"] == 5  # MEMBER is in the team band
    assert r["not_accepted_points"] == 4
    # shipped[] carries acceptance + the outcome row id for the demo toggle.
    by_title = {row["task_title"]: row for row in r["shipped"]}
    assert by_title["alpha"]["acceptance"] == {"met": 2, "total": 2}
    assert by_title["beta"]["acceptance"] == {"met": 1, "total": 2}
    assert by_title["gamma"]["acceptance"] == {"met": 0, "total": 0}
    assert by_title["alpha"]["outcome_id"] is not None


def test_review_points_gated_for_management_band(client: APIClient, project: Project) -> None:
    """OWNER (>= ADMIN) is above velocity's TEAM default → points null, counts stay."""
    s, _ = _closed_with_review(project)
    r = client.get(f"/api/v1/sprints/{s.pk}/outcome/").json()["review"]
    assert r["accepted_count"] == 1  # counts visible
    assert r["accepted_points"] is None  # gated
    assert r["not_accepted_points"] is None
    assert all(row["story_points"] is None for row in r["shipped"])


def test_demo_toggle_member_curates_list(member_client: APIClient, project: Project) -> None:
    s, row = _closed_with_review(project)
    resp = member_client.post(
        f"/api/v1/sprint-task-outcomes/{row.pk}/toggle-demo/", {"demo_ready": True}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["demo_ready"] is True
    # The outcome read now lists it in the demo list + flags the shipped row.
    r = member_client.get(f"/api/v1/sprints/{s.pk}/outcome/").json()["review"]
    assert "T-alpha" in r["demo_list"]
    assert next(x for x in r["shipped"] if x["task_title"] == "alpha")["demo_ready"] is True


def test_demo_toggle_idempotent(member_client: APIClient, project: Project) -> None:
    _, row = _closed_with_review(project)
    url = f"/api/v1/sprint-task-outcomes/{row.pk}/toggle-demo/"
    member_client.post(url, {"demo_ready": True}, format="json")
    member_client.post(url, {"demo_ready": True}, format="json")
    row.refresh_from_db()
    assert row.demo_ready is True


def test_demo_toggle_viewer_forbidden(viewer_client: APIClient, project: Project) -> None:
    _, row = _closed_with_review(project)
    resp = viewer_client.post(
        f"/api/v1/sprint-task-outcomes/{row.pk}/toggle-demo/", {"demo_ready": True}, format="json"
    )
    assert resp.status_code in (403, 404)
    row.refresh_from_db()
    assert row.demo_ready is False


def test_demo_toggle_non_member_denied(stranger_client: APIClient, project: Project) -> None:
    _, row = _closed_with_review(project)
    resp = stranger_client.post(
        f"/api/v1/sprint-task-outcomes/{row.pk}/toggle-demo/", {"demo_ready": True}, format="json"
    )
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# milestone_slip — realized schedule slip vs baseline on the CLOSED card (#1098)
# ---------------------------------------------------------------------------


def _bind_milestone_with_baseline(
    project: Project,
    sprint: Sprint,
    *,
    early_finish: date,
    baseline_finish: date | None,
    actual_finish: date | None = None,
    with_baseline: bool = True,
) -> Task:
    milestone = Task.objects.create(
        project=project,
        name="GA",
        duration=0,
        is_milestone=True,
        early_finish=early_finish,
        actual_finish=actual_finish,
    )
    sprint.target_milestone = milestone
    sprint.save(update_fields=["target_milestone"])
    if with_baseline:
        baseline = Baseline.objects.create(project=project, name="B1", is_active=True)
        BaselineTask.objects.bulk_create(
            [
                BaselineTask(
                    baseline=baseline,
                    task_id=milestone.pk,
                    task_name="GA",
                    duration=0,
                    finish=baseline_finish,
                )
            ]
        )
    return milestone


def test_outcome_milestone_slip_forecast_late(member_client: APIClient, project: Project) -> None:
    """Bound milestone, forecast 12d past its baseline → realized slip on the card."""
    s = _closed_with_outcomes(project)
    _bind_milestone_with_baseline(
        project, s, early_finish=date(2026, 5, 13), baseline_finish=date(2026, 5, 1)
    )
    body = member_client.get(f"/api/v1/sprints/{s.pk}/outcome/").json()
    slip = body["milestone_slip"]
    assert slip is not None
    assert slip["slip_days"] == 12
    assert slip["basis"] == "forecast"
    assert slip["milestone_name"] == "GA"
    assert slip["baseline_finish"] == "2026-05-01"
    assert slip["forecast_finish"] == "2026-05-13"


def test_outcome_milestone_slip_uses_actual_finish_once_hit(
    member_client: APIClient, project: Project
) -> None:
    s = _closed_with_outcomes(project)
    _bind_milestone_with_baseline(
        project,
        s,
        early_finish=date(2026, 5, 20),  # ignored once actual is set
        actual_finish=date(2026, 5, 4),
        baseline_finish=date(2026, 5, 1),
    )
    slip = member_client.get(f"/api/v1/sprints/{s.pk}/outcome/").json()["milestone_slip"]
    assert slip["basis"] == "actual"
    assert slip["slip_days"] == 3
    assert slip["forecast_finish"] == "2026-05-04"


def test_outcome_milestone_slip_negative_when_ahead(
    member_client: APIClient, project: Project
) -> None:
    s = _closed_with_outcomes(project)
    _bind_milestone_with_baseline(
        project, s, early_finish=date(2026, 4, 28), baseline_finish=date(2026, 5, 1)
    )
    slip = member_client.get(f"/api/v1/sprints/{s.pk}/outcome/").json()["milestone_slip"]
    assert slip["slip_days"] == -3


def test_outcome_milestone_slip_null_without_baseline(
    member_client: APIClient, project: Project
) -> None:
    s = _closed_with_outcomes(project)
    _bind_milestone_with_baseline(
        project, s, early_finish=date(2026, 5, 13), baseline_finish=None, with_baseline=False
    )
    assert member_client.get(f"/api/v1/sprints/{s.pk}/outcome/").json()["milestone_slip"] is None


def test_outcome_milestone_slip_null_when_unbound(
    member_client: APIClient, project: Project
) -> None:
    s = _closed_with_outcomes(project)
    assert member_client.get(f"/api/v1/sprints/{s.pk}/outcome/").json()["milestone_slip"] is None


def test_outcome_milestone_slip_visible_to_management_band(
    client: APIClient, project: Project
) -> None:
    """The slip is a SCHEDULE fact, not velocity-private: an OWNER (suppressed on
    velocity by default) still reads it, even though the velocity block is None."""
    s = _closed_with_outcomes(project)
    _bind_milestone_with_baseline(
        project, s, early_finish=date(2026, 5, 13), baseline_finish=date(2026, 5, 1)
    )
    body = client.get(f"/api/v1/sprints/{s.pk}/outcome/").json()
    assert body["velocity"] is None  # velocity suppressed for the management band
    assert body["milestone_slip"] is not None  # but the schedule slip is not gated


# ---------------------------------------------------------------------------
# Wave D — Sprint Review polish (#1129/#1130/#1131/#1132/#1133)
# ---------------------------------------------------------------------------


def _closed_with_polish(project: Project) -> tuple[Sprint, dict[str, SprintTaskOutcome]]:
    """A closed sprint with one fully-accepted shipped story (demo-flagged), one
    criteria-incomplete shipped story, one criteria-not-set shipped story, and a
    carried row. Returns the sprint and a {title: outcome} map for write tests."""
    s = _make_sprint(
        project,
        state=SprintState.COMPLETED,
        committed_points=12,
        completed_points=10,
        committed_task_count=4,
        completed_task_count=3,
        goal_outcome="PARTIAL",
    )
    rows: dict[str, SprintTaskOutcome] = {}

    def shipped(name: str, pts: int, criteria: list[bool], *, demo: bool = False) -> None:
        task = Task.objects.create(
            project=project,
            name=name,
            duration=1,
            sprint=s,
            status=TaskStatus.COMPLETE,
            story_points=pts,
        )
        for i, met in enumerate(criteria):
            AcceptanceCriterion.objects.create(task=task, text=f"{name}-AC{i}", met=met, position=i)
        rows[name] = SprintTaskOutcome.objects.create(
            sprint=s,
            task=task,
            task_short_id=f"T-{name}",
            task_title=name,
            story_points=pts,
            final_status="COMPLETE",
            disposition="completed",
            demo_ready=demo,
        )

    shipped("alpha", 5, [True, True], demo=True)  # fully accepted, demo-flagged
    shipped("beta", 4, [True, False])  # criteria incomplete (1/2)
    shipped("gamma", 3, [])  # criteria not set
    # A carried (not-shipped) row.
    rows["delta"] = SprintTaskOutcome.objects.create(
        sprint=s,
        task=None,
        task_short_id="T-delta",
        task_title="delta",
        story_points=2,
        final_status="IN_PROGRESS",
        disposition="carried",
    )
    return s, rows


def test_review_commitment_counts_present_and_not_gated(
    client: APIClient, project: Project
) -> None:
    """#1129: committed→shipped→carried COUNTS are visible even to the management
    band that has points suppressed (the team knows what it committed)."""
    s, _ = _closed_with_polish(project)
    # OWNER client = management band → velocity/points suppressed.
    body = client.get(f"/api/v1/sprints/{s.pk}/outcome/").json()
    assert body["velocity"] is None  # points gated
    c = body["review"]["commitment"]
    assert c["committed_count"] == 4  # snapshot committed_task_count
    assert c["shipped_count"] == 3
    assert c["carried_count"] == 1


def test_review_commitment_carried_null_on_provisional(
    member_client: APIClient, project: Project
) -> None:
    s = _make_sprint(project, state=SprintState.ACTIVE, committed_task_count=5)
    Task.objects.create(
        project=project, name="Open", duration=1, sprint=s, status=TaskStatus.IN_PROGRESS
    )
    c = member_client.get(f"/api/v1/sprints/{s.pk}/outcome/").json()["review"]["commitment"]
    assert c["committed_count"] == 5
    assert c["carried_count"] is None  # disposition not yet decided


def test_review_exposes_unmet_criteria(member_client: APIClient, project: Project) -> None:
    """#1131: each shipped story carries the names of its UNMET criteria."""
    s, _ = _closed_with_polish(project)
    r = member_client.get(f"/api/v1/sprints/{s.pk}/outcome/").json()["review"]
    by_title = {row["task_title"]: row for row in r["shipped"]}
    assert [c["text"] for c in by_title["beta"]["unmet_criteria"]] == ["beta-AC1"]
    assert by_title["alpha"]["unmet_criteria"] == []  # fully accepted
    assert by_title["gamma"]["unmet_criteria"] == []  # no criteria


def test_review_shipped_carries_demo_order_and_presenter(
    member_client: APIClient, project: Project
) -> None:
    """#1130: shipped items carry demo_order + presenter; the demo list is sorted."""
    s, _rows = _closed_with_polish(project)
    r = member_client.get(f"/api/v1/sprints/{s.pk}/outcome/").json()["review"]
    alpha = next(x for x in r["shipped"] if x["task_title"] == "alpha")
    assert "demo_order" in alpha
    assert "presenter" in alpha
    assert r["demo_list"] == ["T-alpha"]


# --- demo reorder (#1130) ---------------------------------------------------


def test_demo_reorder_writes_dense_order(member_client: APIClient, project: Project) -> None:
    s, rows = _closed_with_polish(project)
    # Flag beta + gamma as demo too so we have three demo-flagged rows to order.
    rows["beta"].demo_ready = True
    rows["beta"].save(update_fields=["demo_ready"])
    rows["gamma"].demo_ready = True
    rows["gamma"].save(update_fields=["demo_ready"])
    ordered = [str(rows["gamma"].pk), str(rows["alpha"].pk), str(rows["beta"].pk)]
    resp = member_client.post(
        f"/api/v1/sprints/{s.pk}/demo-list/reorder/", {"outcome_ids": ordered}, format="json"
    )
    assert resp.status_code == 200, resp.content
    rows["gamma"].refresh_from_db()
    rows["alpha"].refresh_from_db()
    rows["beta"].refresh_from_db()
    assert (rows["gamma"].demo_order, rows["alpha"].demo_order, rows["beta"].demo_order) == (
        1,
        2,
        3,
    )


def test_demo_reorder_conflict_on_set_drift(member_client: APIClient, project: Project) -> None:
    """A reorder whose set differs from the live demo-flagged set is a 409."""
    s, rows = _closed_with_polish(project)
    # Only alpha is demo-flagged; supplying beta (not flagged) is drift.
    resp = member_client.post(
        f"/api/v1/sprints/{s.pk}/demo-list/reorder/",
        {"outcome_ids": [str(rows["beta"].pk)]},
        format="json",
    )
    assert resp.status_code == 409, resp.content


def test_demo_reorder_member_only(viewer_client: APIClient, project: Project) -> None:
    s, rows = _closed_with_polish(project)
    resp = viewer_client.post(
        f"/api/v1/sprints/{s.pk}/demo-list/reorder/",
        {"outcome_ids": [str(rows["alpha"].pk)]},
        format="json",
    )
    assert resp.status_code in (403, 404)


def test_demo_reorder_non_member_denied(stranger_client: APIClient, project: Project) -> None:
    s, rows = _closed_with_polish(project)
    resp = stranger_client.post(
        f"/api/v1/sprints/{s.pk}/demo-list/reorder/",
        {"outcome_ids": [str(rows["alpha"].pk)]},
        format="json",
    )
    assert resp.status_code in (403, 404)


def test_demo_reorder_rejects_empty_body(member_client: APIClient, project: Project) -> None:
    s, _ = _closed_with_polish(project)
    resp = member_client.post(
        f"/api/v1/sprints/{s.pk}/demo-list/reorder/", {"outcome_ids": []}, format="json"
    )
    assert resp.status_code == 400


# --- presenter (#1130) ------------------------------------------------------


def test_set_presenter_member(member_client: APIClient, project: Project) -> None:
    _, rows = _closed_with_polish(project)
    resp = member_client.post(
        f"/api/v1/sprint-task-outcomes/{rows['alpha'].pk}/set-presenter/",
        {"presenter": "Alex"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    rows["alpha"].refresh_from_db()
    assert rows["alpha"].presenter == "Alex"


def test_set_presenter_viewer_forbidden(viewer_client: APIClient, project: Project) -> None:
    _, rows = _closed_with_polish(project)
    resp = viewer_client.post(
        f"/api/v1/sprint-task-outcomes/{rows['alpha'].pk}/set-presenter/",
        {"presenter": "Alex"},
        format="json",
    )
    assert resp.status_code in (403, 404)


def test_set_presenter_non_member_denied(stranger_client: APIClient, project: Project) -> None:
    _, rows = _closed_with_polish(project)
    resp = stranger_client.post(
        f"/api/v1/sprint-task-outcomes/{rows['alpha'].pk}/set-presenter/",
        {"presenter": "Alex"},
        format="json",
    )
    assert resp.status_code in (403, 404)


# --- review note (#1131) ----------------------------------------------------


def test_set_note_member(member_client: APIClient, project: Project) -> None:
    _, rows = _closed_with_polish(project)
    resp = member_client.post(
        f"/api/v1/sprint-task-outcomes/{rows['beta'].pk}/set-note/",
        {"note": "Refined next sprint"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    rows["beta"].refresh_from_db()
    assert rows["beta"].review_note == "Refined next sprint"


def test_set_note_truncates_over_200(member_client: APIClient, project: Project) -> None:
    _, rows = _closed_with_polish(project)
    long_note = "x" * 250
    resp = member_client.post(
        f"/api/v1/sprint-task-outcomes/{rows['beta'].pk}/set-note/",
        {"note": long_note},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    rows["beta"].refresh_from_db()
    assert len(rows["beta"].review_note) == 200


def test_set_note_non_member_denied(stranger_client: APIClient, project: Project) -> None:
    _, rows = _closed_with_polish(project)
    resp = stranger_client.post(
        f"/api/v1/sprint-task-outcomes/{rows['beta'].pk}/set-note/",
        {"note": "x"},
        format="json",
    )
    assert resp.status_code in (403, 404)


def test_set_note_viewer_forbidden(viewer_client: APIClient, project: Project) -> None:
    _, rows = _closed_with_polish(project)
    resp = viewer_client.post(
        f"/api/v1/sprint-task-outcomes/{rows['beta'].pk}/set-note/",
        {"note": "x"},
        format="json",
    )
    assert resp.status_code in (403, 404)


# --- flag for backlog (#1132) -----------------------------------------------


def test_flag_for_backlog_creates_backlog_task(member_client: APIClient, project: Project) -> None:
    _, rows = _closed_with_polish(project)
    resp = member_client.post(
        f"/api/v1/sprint-task-outcomes/{rows['beta'].pk}/flag-for-backlog/", {}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["flagged_to_backlog"] is True
    rows["beta"].refresh_from_db()
    assert rows["beta"].flagged_to_backlog_task_id is not None
    task = Task.objects.get(pk=rows["beta"].flagged_to_backlog_task_id)
    assert task.status == TaskStatus.BACKLOG
    assert task.sprint_id is None
    assert task.name == "beta"
    assert task.story_points == 4


def test_flag_for_backlog_is_idempotent(member_client: APIClient, project: Project) -> None:
    _, rows = _closed_with_polish(project)
    url = f"/api/v1/sprint-task-outcomes/{rows['beta'].pk}/flag-for-backlog/"
    member_client.post(url, {}, format="json")
    rows["beta"].refresh_from_db()
    first_task = rows["beta"].flagged_to_backlog_task_id
    member_client.post(url, {}, format="json")
    rows["beta"].refresh_from_db()
    assert rows["beta"].flagged_to_backlog_task_id == first_task
    # Exactly one BACKLOG task spawned from this outcome.
    assert Task.objects.filter(project=project, status=TaskStatus.BACKLOG, name="beta").count() == 1


def test_flag_for_backlog_viewer_forbidden(viewer_client: APIClient, project: Project) -> None:
    _, rows = _closed_with_polish(project)
    resp = viewer_client.post(
        f"/api/v1/sprint-task-outcomes/{rows['beta'].pk}/flag-for-backlog/", {}, format="json"
    )
    assert resp.status_code in (403, 404)


def test_flag_for_backlog_non_member_denied(stranger_client: APIClient, project: Project) -> None:
    _, rows = _closed_with_polish(project)
    resp = stranger_client.post(
        f"/api/v1/sprint-task-outcomes/{rows['beta'].pk}/flag-for-backlog/", {}, format="json"
    )
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# GET /sprints/{id}/incoming_carryover/ — Planning-side carryover preview (#865)
# ---------------------------------------------------------------------------


def _prior_and_planned(project: Project) -> tuple[Sprint, Sprint]:
    """A prior COMPLETED sprint (with task outcomes) + a following PLANNED sprint."""
    prior = _make_sprint(
        project,
        name="S-prev",
        state=SprintState.COMPLETED,
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
    )
    planned = _make_sprint(
        project,
        name="S-next",
        state=SprintState.PLANNED,
        start_date=date(2026, 4, 15),
        finish_date=date(2026, 4, 28),
    )
    return prior, planned


def test_incoming_carryover_lists_prior_unfinished_with_pulled_flag(
    member_client: APIClient, project: Project
) -> None:
    prior, planned = _prior_and_planned(project)
    # A carried task that the team actually pulled into the planned sprint.
    pulled = Task.objects.create(
        project=project, name="Carried", duration=1, sprint=planned, story_points=3
    )
    # A carried task that was NOT pulled in (left in the backlog).
    Task.objects.create(project=project, name="Left behind", duration=1, story_points=5)
    # Outcomes snapshotted at the prior sprint's close.
    SprintTaskOutcome.objects.create(
        sprint=prior,
        task=pulled,
        task_short_id="T-1",
        task_title="Carried",
        story_points=3,
        final_status="IN_PROGRESS",
        disposition="carried",
    )
    SprintTaskOutcome.objects.create(
        sprint=prior,
        task=None,
        task_short_id="T-2",
        task_title="Left behind",
        story_points=5,
        final_status="NOT_STARTED",
        disposition="dropped",
    )
    # A COMPLETED row must be excluded — it did not "carry over".
    SprintTaskOutcome.objects.create(
        sprint=prior,
        task=None,
        task_short_id="T-3",
        task_title="Shipped",
        story_points=2,
        final_status="COMPLETE",
        disposition="completed",
    )

    resp = member_client.get(f"/api/v1/sprints/{planned.pk}/incoming_carryover/")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["prior_sprint"]["id"] == str(prior.pk)
    assert body["prior_sprint"]["short_id_display"].startswith("SP-")
    # Two unfinished rows (the COMPLETE one is excluded); ordered by short id.
    assert [t["short_id"] for t in body["tasks"]] == ["T-1", "T-2"]
    by_id = {t["short_id"]: t for t in body["tasks"]}
    assert by_id["T-1"]["pulled_in_to_current"] is True
    assert by_id["T-2"]["pulled_in_to_current"] is False
    assert by_id["T-2"]["id"] is None  # hard-deleted task → denormalized row survives


def test_incoming_carryover_empty_when_no_prior_sprint(
    member_client: APIClient, project: Project
) -> None:
    planned = _make_sprint(project, state=SprintState.PLANNED, start_date=date(2026, 4, 1))
    resp = member_client.get(f"/api/v1/sprints/{planned.pk}/incoming_carryover/")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["prior_sprint"] is None
    assert body["tasks"] == []


def test_incoming_carryover_ignores_prior_in_other_project(
    member_client: APIClient, project: Project, calendar: Calendar
) -> None:
    other = Project.objects.create(name="Other", start_date=date(2026, 4, 1), calendar=calendar)
    other_prior = _make_sprint(other, state=SprintState.COMPLETED, finish_date=date(2026, 4, 14))
    SprintTaskOutcome.objects.create(
        sprint=other_prior,
        task=None,
        task_short_id="X-1",
        task_title="Other proj",
        story_points=1,
        final_status="IN_PROGRESS",
        disposition="carried",
    )
    planned = _make_sprint(
        project,
        state=SprintState.PLANNED,
        start_date=date(2026, 4, 15),
        finish_date=date(2026, 4, 28),
    )
    resp = member_client.get(f"/api/v1/sprints/{planned.pk}/incoming_carryover/")
    assert resp.status_code == 200, resp.content
    assert resp.json()["prior_sprint"] is None


def test_incoming_carryover_requires_membership(
    stranger_client: APIClient, project: Project
) -> None:
    planned = _make_sprint(project, state=SprintState.PLANNED)
    resp = stranger_client.get(f"/api/v1/sprints/{planned.pk}/incoming_carryover/")
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# GET /sprints/{id}/scope-changes/ — mid-sprint scope audit + delta (#543/#550)
# ---------------------------------------------------------------------------


def _scope_change(
    sprint: Sprint, project: Project, user: object, *, points: int, status: str, name: str
) -> SprintScopeChange:
    task = Task.objects.create(
        project=project, name=name, duration=1, sprint=sprint, story_points=points
    )
    return SprintScopeChange.objects.create(
        sprint=sprint, task=task, subtask_name=name, added_by=user, status=status
    )


def test_scope_changes_returns_audit_and_delta(
    member_client: APIClient, project: Project, user: object, member_membership: object
) -> None:
    s = _make_sprint(project, state=SprintState.ACTIVE)
    _scope_change(
        s, project, user, points=5, status=ScopeChangeStatus.ACCEPTED, name="Accepted add"
    )
    _scope_change(s, project, user, points=3, status=ScopeChangeStatus.PENDING, name="Pending add")
    _scope_change(
        s, project, user, points=8, status=ScopeChangeStatus.REJECTED, name="Rejected out"
    )

    resp = member_client.get(f"/api/v1/sprints/{s.pk}/scope-changes/")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    # Added = pending + accepted (5 + 3); removed = rejected (8); 2 still in.
    assert body["summary"] == {
        "points_added": 8,
        "points_removed": 8,
        "added_mid_sprint_count": 2,
        "total": 3,
    }
    assert len(body["events"]) == 3
    ev = body["events"][0]
    assert {
        "id",
        "item_name",
        "story_points",
        "added_by_name",
        "added_at",
        "goal_impact",
        "status",
    } <= set(ev)
    statuses = {e["item_name"]: e["status"] for e in body["events"]}
    assert statuses["Rejected out"] == ScopeChangeStatus.REJECTED


def test_scope_changes_empty_when_none(member_client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.ACTIVE)
    resp = member_client.get(f"/api/v1/sprints/{s.pk}/scope-changes/")
    assert resp.status_code == 200, resp.content
    body = resp.json()
    assert body["events"] == []
    assert body["summary"]["total"] == 0
    assert body["summary"]["added_mid_sprint_count"] == 0


def test_scope_changes_viewer_can_read(viewer_client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.ACTIVE)
    resp = viewer_client.get(f"/api/v1/sprints/{s.pk}/scope-changes/")
    assert resp.status_code == 200  # team-readable first (Viewer+)


def test_scope_changes_requires_membership(stranger_client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.ACTIVE)
    resp = stranger_client.get(f"/api/v1/sprints/{s.pk}/scope-changes/")
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# GET /sprints/{id}/daily-delta/ — team standup "what changed since yesterday" (#925)
# ---------------------------------------------------------------------------


def _active_with_history(project: Project, actor: object) -> tuple[Sprint, Task]:
    """An ACTIVE sprint (activated 2 days ago) with a task moved NOT_STARTED →
    IN_PROGRESS → ON_HOLD by ``actor``, so the window has two status moves and one
    new blocker."""
    from datetime import timedelta

    from django.utils import timezone

    s = _make_sprint(
        project, state=SprintState.ACTIVE, activated_at=timezone.now() - timedelta(days=2)
    )
    t = Task.objects.create(
        project=project, name="Login flow", duration=1, sprint=s, status=TaskStatus.NOT_STARTED
    )
    t._history_user = actor  # type: ignore[attr-defined]
    t.status = TaskStatus.IN_PROGRESS
    t.save()
    t._history_user = actor  # type: ignore[attr-defined]
    t.status = TaskStatus.ON_HOLD
    t.save()
    return s, t


def test_daily_delta_status_moves_and_blockers(
    member_client: APIClient, project: Project, member_user: object
) -> None:
    s, _ = _active_with_history(project, member_user)
    body = member_client.get(f"/api/v1/sprints/{s.pk}/daily-delta/").json()
    tos = {c["to"] for c in body["task_changes"]}
    assert "IN_PROGRESS" in tos
    assert "ON_HOLD" in tos
    assert len(body["new_blockers"]) == 1
    assert body["new_blockers"][0]["task_title"] == "Login flow"
    actor = next(a for a in body["per_actor"] if a["actor_username"] == "member")
    assert actor["moved"] >= 2
    assert actor["blocked"] == 1
    assert actor["completed"] == 0


def test_daily_delta_includes_scope_added(
    member_client: APIClient, project: Project, member_user: object
) -> None:
    from datetime import timedelta

    from django.utils import timezone

    s = _make_sprint(
        project, state=SprintState.ACTIVE, activated_at=timezone.now() - timedelta(days=2)
    )
    task = Task.objects.create(project=project, name="Injected", duration=1, sprint=s)
    SprintScopeChange.objects.create(
        sprint=s,
        task=task,
        subtask_name="Injected",
        added_by=member_user,
        status=ScopeChangeStatus.PENDING,
    )
    body = member_client.get(f"/api/v1/sprints/{s.pk}/daily-delta/").json()
    assert len(body["scope_added"]) == 1
    assert body["scope_added"][0]["task_title"] == "Injected"
    actor = next(a for a in body["per_actor"] if a["actor_username"] == "member")
    assert actor["added"] == 1


def test_daily_delta_burndown_swing(member_client: APIClient, project: Project) -> None:
    from datetime import timedelta

    from django.utils import timezone

    from trueppm_api.apps.projects.models import SprintBurnSnapshot

    s = _make_sprint(
        project, state=SprintState.ACTIVE, activated_at=timezone.now() - timedelta(days=3)
    )
    today = timezone.now().date()
    SprintBurnSnapshot.objects.create(
        sprint=s,
        snapshot_date=today - timedelta(days=1),
        remaining_points=20,
        remaining_task_count=8,
        completed_points=5,
        completed_task_count=2,
    )
    SprintBurnSnapshot.objects.create(
        sprint=s,
        snapshot_date=today,
        remaining_points=12,
        remaining_task_count=5,
        completed_points=13,
        completed_task_count=5,
    )
    body = member_client.get(f"/api/v1/sprints/{s.pk}/daily-delta/").json()
    assert body["burndown_delta"]["remaining_delta"] == -8
    assert body["burndown_delta"]["completed_delta"] == 8


def test_daily_delta_explicit_future_since_excludes_changes(
    member_client: APIClient, project: Project, member_user: object
) -> None:
    """An explicit `since` after the changes yields an empty window (the param works)."""
    from datetime import timedelta

    from django.utils import timezone

    s, _ = _active_with_history(project, member_user)
    future = (timezone.now() + timedelta(hours=1)).isoformat()
    # Pass via the params dict so the +00:00 offset is URL-encoded (a raw `+` in the
    # query string decodes to a space; the real axios client encodes it correctly).
    body = member_client.get(f"/api/v1/sprints/{s.pk}/daily-delta/", {"since": future}).json()
    assert body["task_changes"] == []
    assert body["new_blockers"] == []


def test_daily_delta_member_can_read_empty(member_client: APIClient, project: Project) -> None:
    s = _make_sprint(project, state=SprintState.ACTIVE)
    resp = member_client.get(f"/api/v1/sprints/{s.pk}/daily-delta/")
    assert resp.status_code == 200
    assert resp.json()["task_changes"] == []


def test_daily_delta_non_member_denied(stranger_client: APIClient, project: Project) -> None:
    """PMO/org principals are non-members → denied (Morgan: no PMO sprint-internals view)."""
    s = _make_sprint(project, state=SprintState.ACTIVE)
    resp = stranger_client.get(f"/api/v1/sprints/{s.pk}/daily-delta/")
    assert resp.status_code in (403, 404)


def test_daily_delta_malformed_since_falls_back(member_client: APIClient, project: Project) -> None:
    """A well-formed-but-out-of-range `since` (month 13) must 200 on the default
    window, never 500 (parse_datetime raises ValueError on it)."""
    s = _make_sprint(project, state=SprintState.ACTIVE)
    resp = member_client.get(
        f"/api/v1/sprints/{s.pk}/daily-delta/", {"since": "2026-13-45T00:00:00"}
    )
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Wave C polish — per-actor scoping, aggregate, scope cost, sprint load
# (#1126 / #1127)
# ---------------------------------------------------------------------------


def test_daily_delta_aggregate_and_member_sees_per_actor(
    member_client: APIClient, project: Project, member_user: object
) -> None:
    """Member+ get the per-actor breakdown AND the team aggregate (#1126)."""
    s, _ = _active_with_history(project, member_user)
    body = member_client.get(f"/api/v1/sprints/{s.pk}/daily-delta/").json()
    assert body["per_actor"], "a Member must see the per-actor breakdown"
    agg = body["actor_aggregate"]
    # Aggregate equals the sum across the (suppressed-zero) per-actor rows.
    assert agg["moved"] == sum(a["moved"] for a in body["per_actor"])
    assert agg["blocked"] == sum(a["blocked"] for a in body["per_actor"])


def test_daily_delta_viewer_gets_aggregate_only_no_per_actor(
    viewer_client: APIClient, project: Project, member_user: object
) -> None:
    """A Viewer-role member sees the team aggregate but NO per-person breakdown
    (#1126, ADR-0119) — the anti-leaderboard privacy boundary."""
    s, _ = _active_with_history(project, member_user)
    resp = viewer_client.get(f"/api/v1/sprints/{s.pk}/daily-delta/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["per_actor"] == [], "a Viewer must NOT receive per-person rows"
    # But the team total is still present and non-empty (there were two moves).
    assert body["actor_aggregate"]["moved"] >= 2


def test_daily_delta_suppresses_zero_activity_actors(
    member_client: APIClient, project: Project, member_user: object, user: object
) -> None:
    """An actor with zero moves/dones/adds/blocks never appears (#1126)."""
    s, _ = _active_with_history(project, member_user)
    # `user` (owner) touched nothing in this sprint — must be absent from per_actor.
    body = member_client.get(f"/api/v1/sprints/{s.pk}/daily-delta/").json()
    usernames = {a["actor_username"] for a in body["per_actor"]}
    assert "owner" not in usernames
    for a in body["per_actor"]:
        assert a["moved"] or a["completed"] or a["added"] or a["blocked"]


def test_daily_delta_scope_carries_points_and_epic(
    member_client: APIClient, project: Project, member_user: object
) -> None:
    """Each scope_added item carries story_points (velocity-readable for a member)
    and its epic {id, name} grouping label (#1127)."""
    from datetime import timedelta

    from django.utils import timezone

    s = _make_sprint(
        project,
        state=SprintState.ACTIVE,
        activated_at=timezone.now() - timedelta(days=2),
        committed_points=20,
    )
    epic = Task.objects.create(project=project, name="Checkout", duration=0, type=TaskType.EPIC)
    task = Task.objects.create(
        project=project, name="Injected", duration=1, sprint=s, story_points=3, parent_epic=epic
    )
    SprintScopeChange.objects.create(
        sprint=s,
        task=task,
        subtask_name="Injected",
        added_by=member_user,
        status=ScopeChangeStatus.PENDING,
    )
    body = member_client.get(f"/api/v1/sprints/{s.pk}/daily-delta/").json()
    item = body["scope_added"][0]
    # A project member is TEAM-tier and reads the velocity signal → points visible.
    assert item["story_points"] == 3
    assert item["epic"] == {"id": str(epic.pk), "name": "Checkout"}


def test_daily_delta_scope_epic_null_when_ungrouped(
    member_client: APIClient, project: Project, member_user: object
) -> None:
    """A scope item with no parent epic reports epic: null, never a stub (#1127)."""
    from datetime import timedelta

    from django.utils import timezone

    s = _make_sprint(
        project, state=SprintState.ACTIVE, activated_at=timezone.now() - timedelta(days=2)
    )
    task = Task.objects.create(project=project, name="Ungrouped", duration=1, sprint=s)
    SprintScopeChange.objects.create(
        sprint=s, task=task, subtask_name="Ungrouped", added_by=member_user
    )
    body = member_client.get(f"/api/v1/sprints/{s.pk}/daily-delta/").json()
    assert body["scope_added"][0]["epic"] is None


def test_daily_delta_sprint_load_block(member_client: APIClient, project: Project) -> None:
    """The sprint_load block reports committed vs current points and pct_loaded
    against capacity when set (#1127)."""
    from datetime import timedelta

    from django.utils import timezone

    s = _make_sprint(
        project,
        state=SprintState.ACTIVE,
        activated_at=timezone.now() - timedelta(days=2),
        committed_points=10,
        capacity_points=20,
    )
    Task.objects.create(project=project, name="A", duration=1, sprint=s, story_points=8)
    Task.objects.create(project=project, name="B", duration=1, sprint=s, story_points=4)
    body = member_client.get(f"/api/v1/sprints/{s.pk}/daily-delta/").json()
    load = body["sprint_load"]
    assert load["committed_points"] == 10
    assert load["current_points"] == 12  # 8 + 4 current committed load
    assert load["delta_points"] == 2  # 12 current − 10 committed snapshot
    # pct_loaded measured against capacity (20): 12 / 20 = 0.6.
    assert load["pct_loaded"] == 0.6
