"""SprintViewSet — CRUD, state transitions, permissions (ADR-0037)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintCloseRequest,
    SprintCloseRequestStatus,
    SprintState,
    Task,
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
