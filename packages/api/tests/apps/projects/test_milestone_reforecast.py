"""ADR-0106 §3/§5 reforecast-on-close + forecast read (#860 — the bridge WOW).

Covers the headline 0.3 differentiator: closing a sprint reforecasts its bound
milestone's finish as a *range* (CPM spine + p50/p80 + a confidence band),
persists one ``ForecastSnapshot``, and emits the band — never the per-sprint
velocity series — to the board and the Enterprise-seam signal.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    ForecastSnapshot,
    Project,
    Sprint,
    SprintCloseRequest,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.services import (
    project_forecast,
    reforecast_bound_milestone,
)
from trueppm_api.apps.projects.signals import milestone_forecast_recomputed

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def scheduler_user(db: object) -> object:
    return User.objects.create_user(username="sched", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="Alpha", start_date=date(2026, 4, 1), calendar=calendar)


@pytest.fixture
def member(scheduler_user: object, project: Project) -> ProjectMembership:
    return ProjectMembership.objects.create(
        project=project, user=scheduler_user, role=Role.SCHEDULER
    )


@pytest.fixture
def client(scheduler_user: object, member: ProjectMembership) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=scheduler_user)
    return c


def _milestone(
    project: Project, *, name: str = "Phase 1 Gate", early_finish: date | None = None
) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        duration=0,
        is_milestone=True,
        early_finish=early_finish,
        wbs_path="9",
    )


def _closed_sprint(project: Project, *, name: str, completed_points: int, days_ago: int) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=date(2026, 1, 1),
        finish_date=date(2026, 1, 14),
        state=SprintState.COMPLETED,
        completed_points=completed_points,
        completed_task_count=completed_points,
        closed_at=timezone.now() - timedelta(days=days_ago),
    )


def _seed_velocity(project: Project) -> None:
    """Two closed sprints (20 & 30 pts) → avg 25, band 18–32 (a real spread)."""
    _closed_sprint(project, name="Past A", completed_points=20, days_ago=30)
    _closed_sprint(project, name="Past B", completed_points=30, days_ago=15)


def _bound_sprint_with_work(
    project: Project, milestone: Task, *, state: str = SprintState.PLANNED, remaining: int = 40
) -> Sprint:
    """A sprint bound to ``milestone`` carrying ``remaining`` incomplete committed points."""
    sprint = Sprint.objects.create(
        project=project,
        name="Bound",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=state,
        target_milestone=milestone,
    )
    Task.objects.create(
        project=project,
        name="Remaining work",
        sprint=sprint,
        story_points=remaining,
        status=TaskStatus.IN_PROGRESS,
        wbs_path="1",
    )
    return sprint


# ---------------------------------------------------------------------------
# reforecast_bound_milestone — the persisted range
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_reforecast_writes_snapshot_with_range_and_band() -> None:
    project = Project.objects.create(
        name="P", start_date=date(2026, 4, 1), calendar=Calendar.objects.create(name="C")
    )
    _seed_velocity(project)
    milestone = _milestone(project, early_finish=date(2026, 5, 1))
    _bound_sprint_with_work(project, milestone, remaining=40)

    snapshot = reforecast_bound_milestone(milestone.pk, broadcast=False)

    assert snapshot is not None
    assert snapshot.basis == "velocity_band"
    assert snapshot.cpm_finish == date(2026, 5, 1)
    # Band applied → a real spread anchored on the CPM finish, monotonic.
    assert snapshot.p50 == date(2026, 5, 1)
    assert snapshot.p80 > snapshot.p50
    assert snapshot.velocity_low == 18
    assert snapshot.velocity_high == 32
    # cv ≈ 0.28 (7.07/25), no unmodeled/drift → medium confidence.
    assert snapshot.confidence == "medium"
    assert snapshot.unmodeled_dependency is False
    assert ForecastSnapshot.objects.filter(milestone=milestone).count() == 1


@pytest.mark.django_db
def test_reforecast_no_velocity_history_collapses_range() -> None:
    project = Project.objects.create(
        name="P", start_date=date(2026, 4, 1), calendar=Calendar.objects.create(name="C")
    )
    milestone = _milestone(project, early_finish=date(2026, 5, 1))
    _bound_sprint_with_work(project, milestone, remaining=40)

    snapshot = reforecast_bound_milestone(milestone.pk, broadcast=False)

    assert snapshot is not None
    # Below the 2-closed-sprint floor → no defensible spread; band absent, low.
    assert snapshot.p50 == snapshot.p80 == date(2026, 5, 1)
    assert snapshot.velocity_low is None
    assert snapshot.velocity_high is None
    assert snapshot.confidence == "low"


@pytest.mark.django_db
def test_reforecast_returns_none_without_live_binding() -> None:
    project = Project.objects.create(
        name="P", start_date=date(2026, 4, 1), calendar=Calendar.objects.create(name="C")
    )
    milestone = _milestone(project, early_finish=date(2026, 5, 1))
    # No sprint targets this milestone → nothing to forecast.
    assert reforecast_bound_milestone(milestone.pk, broadcast=False) is None
    assert not ForecastSnapshot.objects.filter(milestone=milestone).exists()


@pytest.mark.django_db
def test_reforecast_unmodeled_dependency_caps_confidence_low() -> None:
    project = Project.objects.create(
        name="P", start_date=date(2026, 4, 1), calendar=Calendar.objects.create(name="C")
    )
    _seed_velocity(project)
    milestone = _milestone(project, early_finish=date(2026, 5, 1))
    _bound_sprint_with_work(project, milestone, remaining=40)
    # A predecessor with no sprint commitment → invisible to the velocity forecast.
    upstream = Task.objects.create(project=project, name="Upstream", wbs_path="3")
    Dependency.objects.create(predecessor=upstream, successor=milestone)

    snapshot = reforecast_bound_milestone(milestone.pk, broadcast=False)

    assert snapshot is not None
    assert snapshot.unmodeled_dependency is True
    # No false confidence over work the forecast can't see (ADR-0106 §4/§5).
    assert snapshot.confidence == "low"


# ---------------------------------------------------------------------------
# Privacy — the band crosses, never the series (§3/§6)
# ---------------------------------------------------------------------------


class ReforecastPrivacyTests(TestCase):
    """on_commit broadcast + signal must carry band + dates only."""

    def setUp(self) -> None:
        self.project = Project.objects.create(
            name="P", start_date=date(2026, 4, 1), calendar=Calendar.objects.create(name="C")
        )
        _seed_velocity(self.project)
        self.milestone = _milestone(self.project, early_finish=date(2026, 5, 1))
        _bound_sprint_with_work(self.project, self.milestone, remaining=40)

    def test_broadcast_and_signal_carry_band_only_no_series(self) -> None:
        received: list[dict[str, object]] = []

        def _receiver(sender: object, **kwargs: object) -> None:
            received.append(kwargs)

        milestone_forecast_recomputed.connect(_receiver, weak=False)
        try:
            from unittest.mock import patch

            with (
                patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as mock_broadcast,
                self.captureOnCommitCallbacks(execute=True),
            ):
                reforecast_bound_milestone(self.milestone.pk)
        finally:
            milestone_forecast_recomputed.disconnect(_receiver)

        # Broadcast: §3.4 payload — includes binding_drifted for the banner caveat.
        assert mock_broadcast.call_count == 1
        _project_id, event, payload = mock_broadcast.call_args.args
        assert event == "milestone_forecast_updated"
        assert set(payload.keys()) == {
            "milestone_id",
            "cpm_finish",
            "p50",
            "p80",
            "confidence",
            "unmodeled_dependency",
            "binding_drifted",
        }
        # Signal: §6 seam — band + dates only, NO binding_drifted, NO series.
        assert len(received) == 1
        sig = {k: v for k, v in received[0].items() if k != "signal"}
        assert set(sig.keys()) == {
            "project_id",
            "milestone_id",
            "cpm_finish",
            "p50",
            "p80",
            "confidence",
            "unmodeled_dependency",
        }
        # No throughput series leaks through either channel.
        for blob in (payload, sig):
            assert "sprints" not in blob
            assert "completed_points" not in blob
            assert "velocity_low" not in blob


# ---------------------------------------------------------------------------
# close_sprint integration — THE GATE: close → milestone reforecasts as a range
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_close_sprint_writes_forecast_snapshot_as_range() -> None:
    """The 0.3 WOW: closing a bound sprint reforecasts the milestone live, as a range."""
    from trueppm_api.apps.projects.tasks import close_sprint

    project = Project.objects.create(
        name="P", start_date=date(2026, 4, 1), calendar=Calendar.objects.create(name="C")
    )
    _seed_velocity(project)
    milestone = _milestone(project, early_finish=date(2026, 6, 1))
    # The sprint being closed is bound to the milestone; a second PLANNED bound
    # sprint still holds remaining work so the post-close range is non-degenerate.
    active = Sprint.objects.create(
        project=project,
        name="Active",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
        committed_points=10,
        committed_task_count=1,
        target_milestone=milestone,
    )
    Task.objects.create(
        project=project,
        name="Done",
        sprint=active,
        story_points=10,
        status=TaskStatus.COMPLETE,
        wbs_path="1",
    )
    _bound_sprint_with_work(project, milestone, remaining=40)  # future remaining work

    from unittest.mock import patch

    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event"):
        req = SprintCloseRequest.objects.create(sprint=active, carry_over_to="backlog")
        close_sprint.run(str(req.id))

    snap = ForecastSnapshot.objects.filter(milestone=milestone).order_by("-taken_at").first()
    assert snap is not None
    assert snap.basis == "velocity_band"
    assert snap.cpm_finish == date(2026, 6, 1)
    # A real range — the headline behavior.
    assert snap.p80 >= snap.p50
    assert snap.velocity_low is not None


# ---------------------------------------------------------------------------
# project_forecast read (§5)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_forecast_read_returns_velocity_and_milestone_snapshots(
    client: APIClient, project: Project
) -> None:
    _seed_velocity(project)
    milestone = _milestone(project, early_finish=date(2026, 5, 1))
    _bound_sprint_with_work(project, milestone, remaining=40)
    reforecast_bound_milestone(milestone.pk, broadcast=False)

    resp = client.get(f"/api/v1/projects/{project.id}/forecast/")

    assert resp.status_code == 200
    body = resp.data
    assert body["velocity"]["rolling_avg_points"] == 25.0
    assert body["remaining_committed_points"] == 40
    assert len(body["milestones"]) == 1
    ms = body["milestones"][0]
    assert ms["milestone_id"] == str(milestone.id)
    assert ms["milestone_name"] == "Phase 1 Gate"
    assert ms["basis"] == "velocity_band"
    assert ms["cpm_finish"] == "2026-05-01"


@pytest.mark.django_db
def test_forecast_sprints_to_complete_range(project: Project) -> None:
    _seed_velocity(project)  # band 18–32
    milestone = _milestone(project, early_finish=date(2026, 5, 1))
    _bound_sprint_with_work(project, milestone, remaining=40)

    data = project_forecast(project.pk)

    # 40 remaining ÷ band → ceil(40/32)=2 fastest, ceil(40/18)=3 slowest.
    assert data["sprints_to_complete_low"] == 2
    assert data["sprints_to_complete_high"] == 3


@pytest.mark.django_db
def test_forecast_returns_latest_snapshot_per_milestone(project: Project) -> None:
    _seed_velocity(project)
    milestone = _milestone(project, early_finish=date(2026, 5, 1))
    _bound_sprint_with_work(project, milestone, remaining=40)
    reforecast_bound_milestone(milestone.pk, broadcast=False)
    reforecast_bound_milestone(milestone.pk, broadcast=False)

    data = project_forecast(project.pk)
    # Two snapshots written, but the read returns the latest one per milestone.
    assert ForecastSnapshot.objects.filter(milestone=milestone).count() == 2
    assert len(data["milestones"]) == 1


@pytest.mark.django_db
def test_forecast_no_cross_project_fan_in(
    client: APIClient, project: Project, calendar: Calendar
) -> None:
    other = Project.objects.create(name="Beta", start_date=date(2026, 4, 1), calendar=calendar)
    other_ms = _milestone(other, name="Other gate", early_finish=date(2026, 7, 1))
    _bound_sprint_with_work(other, other_ms, remaining=10)
    reforecast_bound_milestone(other_ms.pk, broadcast=False)

    resp = client.get(f"/api/v1/projects/{project.id}/forecast/")
    assert resp.status_code == 200
    # The other project's milestone forecast must not leak into this read.
    assert resp.data["milestones"] == []


@pytest.mark.django_db
def test_forecast_readable_by_viewer(project: Project) -> None:
    viewer = User.objects.create_user(username="viewer", password="pw")
    ProjectMembership.objects.create(project=project, user=viewer, role=Role.VIEWER)
    c = APIClient()
    c.force_authenticate(user=viewer)

    resp = c.get(f"/api/v1/projects/{project.id}/forecast/")
    assert resp.status_code == 200


@pytest.mark.django_db
def test_forecast_forbidden_for_non_member(project: Project) -> None:
    outsider = User.objects.create_user(username="outsider", password="pw")
    c = APIClient()
    c.force_authenticate(user=outsider)

    resp = c.get(f"/api/v1/projects/{project.id}/forecast/")
    assert resp.status_code in (403, 404)
