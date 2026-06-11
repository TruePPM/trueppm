"""Sprint → milestone rollup service + API surface (ADR-0074, issue #409)."""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.services import (
    compute_milestone_rollup_payload,
    recompute_milestone_rollup,
    snapshot_committed_metrics,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def membership(user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)


@pytest.fixture
def client(user: object, membership: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _make_milestone(
    project: Project, name: str = "MVP launch", early_finish: date = date(2026, 4, 30)
) -> Task:
    """Create a milestone task with a CPM early_finish for variance computation."""
    return Task.objects.create(
        project=project,
        name=name,
        duration=0,
        is_milestone=True,
        early_finish=early_finish,
        early_start=early_finish,
    )


def _make_sprint(
    project: Project,
    *,
    target_milestone: Task | None = None,
    state: SprintState = SprintState.PLANNED,
    start_date: date = date(2026, 4, 1),
    finish_date: date = date(2026, 4, 14),
    committed_points: int | None = None,
    committed_task_count: int | None = None,
    completed_points: int | None = None,
    completed_task_count: int | None = None,
    name: str = "Sprint",
) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=start_date,
        finish_date=finish_date,
        state=state,
        target_milestone=target_milestone,
        committed_points=committed_points,
        committed_task_count=committed_task_count,
        completed_points=completed_points,
        completed_task_count=completed_task_count,
    )


# ---------------------------------------------------------------------------
# compute_milestone_rollup_payload — pure unit tests
# ---------------------------------------------------------------------------


def test_no_targeting_sprints_returns_none(project: Project) -> None:
    milestone = _make_milestone(project)
    assert compute_milestone_rollup_payload(milestone) is None


def test_single_completed_sprint_rolls_up_by_points(project: Project) -> None:
    milestone = _make_milestone(project)
    _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.COMPLETED,
        committed_points=24,
        completed_points=18,
        committed_task_count=10,
        completed_task_count=8,
    )
    payload = compute_milestone_rollup_payload(milestone)
    assert payload is not None
    assert payload["percent_complete"] == 75.0  # 18/24 = 0.75
    assert payload["rollup_basis"] == "points"
    assert payload["sprint_count"] == 1
    assert payload["sprint_scope_changed"] is False


def test_throughput_fallback_when_points_unset(project: Project) -> None:
    """Teams that don't size in points (NoEstimates / Scrumban) fall back to task counts."""
    milestone = _make_milestone(project)
    _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.COMPLETED,
        committed_points=0,
        completed_points=0,
        committed_task_count=10,
        completed_task_count=7,
    )
    payload = compute_milestone_rollup_payload(milestone)
    assert payload is not None
    assert payload["percent_complete"] == 70.0
    assert payload["rollup_basis"] == "tasks"


def test_zero_committed_returns_basis_none(project: Project) -> None:
    """A sprint with no committed points AND no committed tasks gives a None percent."""
    milestone = _make_milestone(project)
    _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.COMPLETED,
        committed_points=0,
        committed_task_count=0,
    )
    payload = compute_milestone_rollup_payload(milestone)
    assert payload is not None
    assert payload["percent_complete"] is None
    assert payload["rollup_basis"] == "none"


def test_percent_capped_at_100_when_over_delivered(project: Project) -> None:
    """If completed > committed (scope removed mid-sprint, team finished extra), cap at 100."""
    milestone = _make_milestone(project)
    _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.COMPLETED,
        committed_points=10,
        completed_points=15,
    )
    payload = compute_milestone_rollup_payload(milestone)
    assert payload is not None
    assert payload["percent_complete"] == 100.0


def test_active_sprint_counts_live_complete_tasks(project: Project) -> None:
    """ACTIVE sprints don't have completed_* snapshotted; live COMPLETE tasks count."""
    milestone = _make_milestone(project)
    sprint = _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.ACTIVE,
        committed_points=20,
        committed_task_count=4,
    )
    Task.objects.create(
        project=project,
        name="T1",
        duration=1,
        sprint=sprint,
        story_points=5,
        status=TaskStatus.COMPLETE,
    )
    Task.objects.create(
        project=project,
        name="T2",
        duration=1,
        sprint=sprint,
        story_points=5,
        status=TaskStatus.COMPLETE,
    )
    Task.objects.create(
        project=project,
        name="T3",
        duration=1,
        sprint=sprint,
        story_points=5,
        status=TaskStatus.IN_PROGRESS,
    )
    Task.objects.create(
        project=project,
        name="T4",
        duration=1,
        sprint=sprint,
        story_points=5,
    )
    payload = compute_milestone_rollup_payload(milestone)
    assert payload is not None
    assert payload["percent_complete"] == 50.0  # 10/20


def test_multi_sprint_milestone_sums_cumulatively(project: Project) -> None:
    """A milestone targeted by 3 sprints (one closed, one active, one planned) sums all."""
    milestone = _make_milestone(project)
    # Closed sprint with 100% complete
    _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.COMPLETED,
        committed_points=10,
        completed_points=10,
        name="S1",
        start_date=date(2026, 3, 17),
        finish_date=date(2026, 3, 30),
    )
    # Active sprint with 1 of 2 tasks done
    active = _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.ACTIVE,
        committed_points=10,
        committed_task_count=2,
        name="S2",
    )
    Task.objects.create(
        project=project,
        name="A1",
        duration=1,
        sprint=active,
        story_points=5,
        status=TaskStatus.COMPLETE,
    )
    Task.objects.create(
        project=project,
        name="A2",
        duration=1,
        sprint=active,
        story_points=5,
        status=TaskStatus.IN_PROGRESS,
    )
    # Planned sprint contributes only to denominator
    _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.PLANNED,
        committed_points=10,
        committed_task_count=2,
        name="S3",
        start_date=date(2026, 4, 15),
        finish_date=date(2026, 4, 28),
    )
    payload = compute_milestone_rollup_payload(milestone)
    assert payload is not None
    assert payload["percent_complete"] == 50.0  # (10 + 5) / (10 + 10 + 10)
    assert payload["rollup_basis"] == "points"
    assert payload["sprint_count"] == 3


def test_variance_uses_latest_active_or_planned_sprint(project: Project) -> None:
    """Variance = max(ACTIVE/PLANNED finish_date) - milestone.early_finish. COMPLETED ignored."""
    milestone = _make_milestone(project, early_finish=date(2026, 4, 28))
    # Closed sprint ends before — must NOT contribute to variance
    _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.COMPLETED,
        finish_date=date(2026, 4, 7),
        committed_points=10,
        completed_points=10,
        name="S1",
    )
    # Active sprint ends 3 days after the milestone — variance = +3
    _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.ACTIVE,
        finish_date=date(2026, 5, 1),
        committed_points=10,
        committed_task_count=2,
        name="S2",
    )
    payload = compute_milestone_rollup_payload(milestone)
    assert payload is not None
    assert payload["variance_days"] == 3


def test_variance_negative_when_sprint_finishes_before_milestone(project: Project) -> None:
    milestone = _make_milestone(project, early_finish=date(2026, 4, 30))
    _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.PLANNED,
        finish_date=date(2026, 4, 28),  # 2 days ahead
        committed_points=10,
    )
    payload = compute_milestone_rollup_payload(milestone)
    assert payload is not None
    assert payload["variance_days"] == -2


def test_cancelled_sprint_contributes_nothing(project: Project) -> None:
    """A CANCELLED sprint must not show up in the denominator or numerator."""
    milestone = _make_milestone(project)
    cancelled = _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.CANCELLED,
        committed_points=10,
        committed_task_count=5,
    )
    # Plus an active that should be the only contributor
    active = _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.ACTIVE,
        committed_points=20,
        committed_task_count=4,
        name="S2",
    )
    Task.objects.create(
        project=project,
        name="t",
        duration=1,
        sprint=active,
        story_points=10,
        status=TaskStatus.COMPLETE,
    )
    payload = compute_milestone_rollup_payload(milestone)
    assert payload is not None
    assert payload["percent_complete"] == 50.0  # 10 / 20 — cancelled doesn't add 10 to denom
    # sprint_count still reflects all targeting rows (including cancelled, for ops insight)
    assert payload["sprint_count"] == 2
    _ = cancelled  # silence unused-binding lint


def test_scope_changed_flag_when_active_backlog_diverges(project: Project) -> None:
    milestone = _make_milestone(project)
    active = _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.ACTIVE,
        committed_points=20,
        committed_task_count=2,
    )
    Task.objects.create(
        project=project,
        name="T1",
        duration=1,
        sprint=active,
        story_points=10,
    )
    Task.objects.create(
        project=project,
        name="T2",
        duration=1,
        sprint=active,
        story_points=10,
    )
    # No scope change yet
    payload = compute_milestone_rollup_payload(milestone)
    assert payload is not None
    assert payload["sprint_scope_changed"] is False
    # Add a task mid-sprint → current points sum != committed_points
    Task.objects.create(
        project=project,
        name="T3",
        duration=1,
        sprint=active,
        story_points=5,
    )
    payload = compute_milestone_rollup_payload(milestone)
    assert payload is not None
    assert payload["sprint_scope_changed"] is True


# ---------------------------------------------------------------------------
# recompute_milestone_rollup — broadcast wiring
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_recompute_emits_broadcast_with_aggregated_payload_only(project: Project) -> None:
    """Morgan VoC guardrail: broadcast must contain only rolled-up aggregates."""
    milestone = _make_milestone(project)
    sprint = _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.COMPLETED,
        committed_points=10,
        completed_points=7,
    )
    _ = sprint
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast:
        recompute_milestone_rollup(milestone.pk)
    broadcast.assert_called_once()
    args, kwargs = broadcast.call_args
    event_type = args[1] if len(args) > 1 else kwargs.get("event_type")
    payload = args[2] if len(args) > 2 else kwargs.get("payload")
    assert event_type == "milestone_rollup_updated"
    # Aggregated only: must NOT carry per-task lists or raw counts.
    assert set(payload.keys()) == {
        "milestone_id",
        "percent_complete",
        "rollup_basis",
        "variance_days",
        "sprint_scope_changed",
        "scope_change_sprint_id",
        "binding_drifted",
        "sprint_count",
    }
    assert payload["percent_complete"] == 70.0
    assert payload["milestone_id"] == str(milestone.pk)


@pytest.mark.django_db(transaction=True)
def test_recompute_for_milestone_with_no_targeting_sprints_broadcasts_clear_state(
    project: Project,
) -> None:
    """Unlinking the last sprint should broadcast basis=none so UI drops chrome."""
    milestone = _make_milestone(project)
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast:
        recompute_milestone_rollup(milestone.pk)
    broadcast.assert_called_once()
    payload = broadcast.call_args.args[2]
    assert payload["rollup_basis"] == "none"
    assert payload["percent_complete"] is None
    assert payload["sprint_count"] == 0


def test_recompute_missing_milestone_returns_none(project: Project) -> None:
    """Idempotency: dispatch racing a delete should be a no-op, not a crash."""
    import uuid as _uuid

    assert recompute_milestone_rollup(_uuid.uuid4()) is None


# ---------------------------------------------------------------------------
# Read-only enforcement (TaskSerializer)
# ---------------------------------------------------------------------------


def test_patch_percent_complete_rejected_when_milestone_has_live_sprint(
    client: APIClient, project: Project
) -> None:
    """ADR-0074 read-only lock: server rejects with structured 400."""
    milestone = _make_milestone(project)
    _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.ACTIVE,
        committed_points=10,
    )
    resp = client.patch(
        f"/api/v1/tasks/{milestone.pk}/",
        {"percent_complete": 50},
        format="json",
    )
    assert resp.status_code == 400, resp.content
    assert resp.json()["code"] == "milestone_rollup_locked"


def test_patch_percent_complete_allowed_when_no_targeting_sprint(
    client: APIClient, project: Project
) -> None:
    milestone = _make_milestone(project)
    resp = client.patch(
        f"/api/v1/tasks/{milestone.pk}/",
        {"percent_complete": 50, "planned_start": "2026-04-01"},
        format="json",
    )
    assert resp.status_code == 200, resp.content


def test_patch_percent_complete_allowed_after_sprint_unlinked(
    client: APIClient, project: Project
) -> None:
    """Unlinking the sprint releases the lock immediately."""
    milestone = _make_milestone(project)
    sprint = _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.ACTIVE,
        committed_points=10,
    )
    # First write — locked
    resp = client.patch(
        f"/api/v1/tasks/{milestone.pk}/",
        {"percent_complete": 50},
        format="json",
    )
    assert resp.status_code == 400
    # Unlink and retry
    sprint.target_milestone = None
    sprint.save(update_fields=["target_milestone"])
    resp = client.patch(
        f"/api/v1/tasks/{milestone.pk}/",
        {"percent_complete": 50, "planned_start": "2026-04-01"},
        format="json",
    )
    assert resp.status_code == 200, resp.content


# ---------------------------------------------------------------------------
# Serializer surface: milestone_rollup + target_milestone_detail.rollup
# ---------------------------------------------------------------------------


def test_task_serializer_includes_milestone_rollup(client: APIClient, project: Project) -> None:
    milestone = _make_milestone(project)
    sprint = _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.COMPLETED,
        committed_points=20,
        completed_points=15,
    )
    _ = sprint
    resp = client.get(f"/api/v1/tasks/{milestone.pk}/")
    assert resp.status_code == 200, resp.content
    assert resp.json()["milestone_rollup"]["percent_complete"] == 75.0
    # Single source of truth: percent_complete reflects the rollup, not the stored 0.
    assert resp.json()["percent_complete"] == 75.0


def test_task_serializer_milestone_rollup_null_for_non_milestone(
    client: APIClient, project: Project
) -> None:
    leaf = Task.objects.create(project=project, name="leaf", duration=1)
    resp = client.get(f"/api/v1/tasks/{leaf.pk}/")
    assert resp.status_code == 200
    assert resp.json()["milestone_rollup"] is None


def test_sprint_serializer_target_milestone_detail_includes_rollup(
    client: APIClient, project: Project
) -> None:
    """AdvancingToMilestoneCard reads detail.rollup — same source as the Gantt."""
    milestone = _make_milestone(project)
    sprint = _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.COMPLETED,
        committed_points=24,
        completed_points=18,
    )
    resp = client.get(f"/api/v1/sprints/{sprint.pk}/")
    assert resp.status_code == 200
    rollup = resp.data["target_milestone_detail"]["rollup"]
    assert rollup is not None
    assert rollup["percent_complete"] == 75.0
    assert rollup["rollup_basis"] == "points"


# ---------------------------------------------------------------------------
# Sprint state transitions trigger rollup
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_sprint_activate_recomputes_milestone_rollup(client: APIClient, project: Project) -> None:
    milestone = _make_milestone(project)
    sprint = _make_sprint(project, target_milestone=milestone, state=SprintState.PLANNED)
    Task.objects.create(
        project=project,
        name="T",
        duration=1,
        sprint=sprint,
        story_points=8,
    )
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast:
        resp = client.post(f"/api/v1/sprints/{sprint.pk}/activate/")
    assert resp.status_code == 200, resp.content
    # Activation snapshots committed_points=8 → milestone rollup recomputes.
    events = [c.args[1] for c in broadcast.call_args_list]
    assert "milestone_rollup_updated" in events


@pytest.mark.django_db(transaction=True)
def test_sprint_cancel_recomputes_milestone_rollup(client: APIClient, project: Project) -> None:
    milestone = _make_milestone(project)
    sprint = _make_sprint(project, target_milestone=milestone, state=SprintState.PLANNED)
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast:
        resp = client.post(f"/api/v1/sprints/{sprint.pk}/cancel/")
    assert resp.status_code == 200, resp.content
    events = [c.args[1] for c in broadcast.call_args_list]
    assert "milestone_rollup_updated" in events


@pytest.mark.django_db(transaction=True)
def test_sprint_create_with_target_milestone_recomputes_rollup(
    client: APIClient, project: Project
) -> None:
    """A PLANNED sprint contributes denominator — milestone reflects it immediately."""
    milestone = _make_milestone(project)
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast:
        resp = client.post(
            f"/api/v1/projects/{project.pk}/sprints/",
            {
                "name": "S",
                "start_date": "2026-04-01",
                "finish_date": "2026-04-14",
                "target_milestone": str(milestone.pk),
            },
            format="json",
        )
    assert resp.status_code == 201, resp.content
    events = [c.args[1] for c in broadcast.call_args_list]
    assert "milestone_rollup_updated" in events


@pytest.mark.django_db(transaction=True)
def test_sprint_update_relinking_target_milestone_recomputes_both(
    client: APIClient, project: Project
) -> None:
    """Re-linking from milestone A to milestone B must recompute both."""
    milestone_a = _make_milestone(project, name="A")
    milestone_b = _make_milestone(project, name="B")
    sprint = _make_sprint(
        project,
        target_milestone=milestone_a,
        state=SprintState.PLANNED,
    )
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast:
        resp = client.patch(
            f"/api/v1/sprints/{sprint.pk}/",
            {"target_milestone": str(milestone_b.pk)},
            format="json",
        )
    assert resp.status_code == 200, resp.content
    # Both milestones broadcast — A loses the sprint, B gains it.
    rollup_events = [c for c in broadcast.call_args_list if c.args[1] == "milestone_rollup_updated"]
    milestone_ids = {c.args[2]["milestone_id"] for c in rollup_events}
    assert str(milestone_a.pk) in milestone_ids
    assert str(milestone_b.pk) in milestone_ids


# ---------------------------------------------------------------------------
# Task signal (live recompute when a sprint-tracked task changes)
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
def test_task_status_change_in_sprint_with_milestone_recomputes_rollup(
    project: Project,
) -> None:
    """The post_save receiver fires the live recompute when a task moves to COMPLETE."""
    milestone = _make_milestone(project)
    sprint = _make_sprint(
        project,
        target_milestone=milestone,
        state=SprintState.ACTIVE,
    )
    snapshot_committed_metrics(sprint)
    sprint.save(update_fields=["committed_points", "committed_task_count"])
    task = Task.objects.create(
        project=project,
        name="T",
        duration=1,
        sprint=sprint,
        story_points=10,
    )
    snapshot_committed_metrics(sprint)
    sprint.save(update_fields=["committed_points", "committed_task_count"])
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast:
        task.status = TaskStatus.COMPLETE
        task.save()
    events = [c.args[1] for c in broadcast.call_args_list]
    assert "milestone_rollup_updated" in events


@pytest.mark.django_db(transaction=True)
def test_task_save_outside_sprint_does_not_recompute(project: Project) -> None:
    """Receiver early-out: tasks not in a sprint must not trigger any broadcast."""
    Task.objects.create(project=project, name="lone", duration=1, story_points=3)
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast:
        task = Task.objects.get(project=project, name="lone")
        task.name = "lone-renamed"
        task.save(update_fields=["name"])
    rollup_events = [c for c in broadcast.call_args_list if c.args[1] == "milestone_rollup_updated"]
    assert rollup_events == []
