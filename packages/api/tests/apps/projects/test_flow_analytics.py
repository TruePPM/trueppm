"""Methodology-neutral flow analytics — flow metrics, WIP breach, throughput forecast.

ADR-0130:
  D1 flow_metrics()         — cycle/lead time, CFD, weekly throughput, data_integrity
  D2 annotate_wip_breach()  — per-column live count + breach verdict (passive)
  D3 throughput_forecast()  — count-based Monte Carlo for sprintless teams
  D4 flow_metrics signal    — historical distributions gated TEAM/TEAM (suppress, not 403)

All flow analytics are computed-on-read from Task history; there is no created_at
(board entry = earliest history row) and no new model. Tests build history by saving
status changes and, where a window matters, backdating ``history_date`` directly.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    BoardColumnConfig,
    Calendar,
    DeliveryMode,
    Project,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.services import (
    annotate_wip_breach,
    flow_metrics,
    throughput_forecast,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="FlowProj", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def member(project: Project) -> Any:
    # TEAM band — reads flow_metrics by default (the team always reads its own).
    user = User.objects.create_user(username="flow_member", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.MEMBER)
    return user


@pytest.fixture
def pm(project: Project) -> Any:
    # ADMIN resolves to TEAM_SM_PM — does NOT read flow_metrics by default (Morgan).
    user = User.objects.create_user(username="flow_pm", password="pw")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    return user


@pytest.fixture
def client(member: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=member)
    return c


def _flow_url(project: Project) -> str:
    return f"/api/v1/projects/{project.pk}/flow-metrics/"


def _make_task(project: Project, name: str, status: str = TaskStatus.BACKLOG) -> Task:
    return Task.objects.create(project=project, name=name, duration=1, status=status)


def _backdate_latest_history(task: Task, when: Any) -> None:
    """Stamp the task's most recent history row at ``when`` (a datetime).

    django-simple-history defaults history_date to now(); the flow window math needs
    historical rows placed at specific instants, so the test rewrites the latest row.
    """
    record = task.history.latest()  # type: ignore[attr-defined]
    record.history_date = when
    record.save()


def _move(task: Task, status: str, when: Any) -> None:
    """Transition a task to ``status`` and backdate the resulting history row."""
    task.status = status
    task.save()
    _backdate_latest_history(task, when)


# ---------------------------------------------------------------------------
# D1 — flow_metrics() computation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_flow_metrics_empty_project(project: Project) -> None:
    result = flow_metrics(project.pk)
    assert result["cycle_time"] == {"p50": None, "p80": None, "p95": None}
    assert result["lead_time"] == {"p50": None, "p80": None, "p95": None}
    # CFD is dense across the window even with no tasks: every day present, all zero.
    assert len(result["cfd"]) == result["window_days"]
    assert all(sum(day["counts"].values()) == 0 for day in result["cfd"])
    assert all(c == 0 for day in result["cfd"] for c in day["counts"].values())
    assert all(row["completed_count"] == 0 for row in result["throughput"])
    assert result["data_integrity"] == {
        "bulk_moved_count": 0,
        "backdated_count": 0,
        "missing_transition_count": 0,
    }
    assert result["flow_metrics_suppressed"] is False


@pytest.mark.django_db
def test_flow_metrics_single_transition_task(project: Project) -> None:
    # A task that entered the board 10 days ago, started 6 days ago, completed today.
    now = timezone.now()
    t = _make_task(project, "T1", status=TaskStatus.NOT_STARTED)
    _backdate_latest_history(t, now - timedelta(days=10))  # board entry
    _move(t, TaskStatus.IN_PROGRESS, now - timedelta(days=6))
    _move(t, TaskStatus.COMPLETE, now)

    result = flow_metrics(project.pk)
    # Cycle time = IN_PROGRESS -> COMPLETE ~= 6 days; lead time = entry -> COMPLETE ~= 10.
    assert result["cycle_time"]["p50"] == 6
    assert result["lead_time"]["p50"] == 10
    # One completion this ISO week.
    assert sum(row["completed_count"] for row in result["throughput"]) == 1
    assert result["data_integrity"]["missing_transition_count"] == 0


@pytest.mark.django_db
def test_flow_metrics_bulk_moved_counts_via_actual_finish(project: Project) -> None:
    # A card jumped straight to COMPLETE without ever recording IN_PROGRESS (bulk move).
    # actual_finish stands in as the start-of-work proxy and bulk_moved_count ticks.
    now = timezone.now()
    t = _make_task(project, "Bulk", status=TaskStatus.NOT_STARTED)
    _backdate_latest_history(t, now - timedelta(days=8))
    t.status = TaskStatus.COMPLETE
    t.actual_finish = timezone.localdate() - timedelta(days=2)
    t.save()
    _backdate_latest_history(t, now)

    result = flow_metrics(project.pk)
    assert result["data_integrity"]["bulk_moved_count"] == 1
    # Cycle time derived from actual_finish (~2 days), not missing.
    assert result["cycle_time"]["p50"] is not None
    assert result["data_integrity"]["missing_transition_count"] == 0


@pytest.mark.django_db
def test_flow_metrics_missing_transition_counts(project: Project) -> None:
    # Completed with neither an IN_PROGRESS row nor actual_finish → missing transition.
    now = timezone.now()
    t = _make_task(project, "Missing", status=TaskStatus.NOT_STARTED)
    _backdate_latest_history(t, now - timedelta(days=5))
    _move(t, TaskStatus.COMPLETE, now)  # no actual_finish set

    result = flow_metrics(project.pk)
    assert result["data_integrity"]["missing_transition_count"] == 1
    # Lead time is still computable (entry -> complete); cycle time has no sample.
    assert result["lead_time"]["p50"] is not None
    assert result["cycle_time"]["p50"] is None


@pytest.mark.django_db
def test_flow_metrics_backdated_counts(project: Project) -> None:
    # A later history row stamped BEFORE its predecessor (clock skew / backfill).
    now = timezone.now()
    t = _make_task(project, "Backdated", status=TaskStatus.NOT_STARTED)
    _backdate_latest_history(t, now - timedelta(days=4))
    _move(t, TaskStatus.IN_PROGRESS, now - timedelta(days=10))  # earlier than prior row
    _move(t, TaskStatus.COMPLETE, now)

    result = flow_metrics(project.pk)
    assert result["data_integrity"]["backdated_count"] >= 1


@pytest.mark.django_db
def test_flow_metrics_cfd_folds_on_hold_into_backlog(project: Project) -> None:
    now = timezone.now()
    t = _make_task(project, "Legacy", status=TaskStatus.ON_HOLD)
    _backdate_latest_history(t, now - timedelta(days=1))
    result = flow_metrics(project.pk)
    # ON_HOLD must never appear as its own CFD bucket; it counts as BACKLOG.
    last_day = result["cfd"][-1]["counts"]
    assert "ON_HOLD" not in last_day
    assert last_day["BACKLOG"] == 1


@pytest.mark.django_db
def test_flow_metrics_window_cap(project: Project) -> None:
    result = flow_metrics(project.pk, window_days=10_000)
    assert result["window_days"] == 365  # capped


@pytest.mark.django_db
def test_flow_metrics_endpoint_shape(client: APIClient, project: Project) -> None:
    resp = client.get(_flow_url(project))
    assert resp.status_code == 200, resp.data
    body = resp.data
    for key in ("cycle_time", "lead_time", "cfd", "throughput", "data_integrity"):
        assert key in body
    assert body["flow_metrics_suppressed"] is False


@pytest.mark.django_db
def test_flow_metrics_endpoint_requires_membership(project: Project) -> None:
    outsider = User.objects.create_user(username="flow_outsider", password="pw")
    c = APIClient()
    c.force_authenticate(user=outsider)
    assert c.get(_flow_url(project)).status_code == 403


# ---------------------------------------------------------------------------
# D2 — WIP breach verdict
# ---------------------------------------------------------------------------

_COLUMNS = [
    {"status": "BACKLOG", "label": "Backlog", "visible": True, "color": None, "wip_limit": None},
    {"status": "NOT_STARTED", "label": "To Do", "visible": True, "color": None, "wip_limit": 2},
    {
        "status": "IN_PROGRESS",
        "label": "In Progress",
        "visible": True,
        "color": None,
        "wip_limit": 2,
    },
    {"status": "REVIEW", "label": "Review", "visible": True, "color": None, "wip_limit": 2},
    {"status": "COMPLETE", "label": "Done", "visible": True, "color": None, "wip_limit": None},
]


@pytest.mark.django_db
def test_wip_breach_ok_at_over_and_null(project: Project) -> None:
    # NOT_STARTED: 1 task, limit 2 -> ok
    _make_task(project, "n1", status=TaskStatus.NOT_STARTED)
    # IN_PROGRESS: 2 tasks, limit 2 -> at
    _make_task(project, "i1", status=TaskStatus.IN_PROGRESS)
    _make_task(project, "i2", status=TaskStatus.IN_PROGRESS)
    # REVIEW: 3 tasks, limit 2 -> over
    for i in range(3):
        _make_task(project, f"r{i}", status=TaskStatus.REVIEW)
    # BACKLOG: 1 task, no limit -> breach null
    _make_task(project, "b1", status=TaskStatus.BACKLOG)

    annotated = {c["status"]: c for c in annotate_wip_breach(project.pk, _COLUMNS)}
    assert annotated["NOT_STARTED"]["current_count"] == 1
    assert annotated["NOT_STARTED"]["breach"] == "ok"
    assert annotated["IN_PROGRESS"]["current_count"] == 2
    assert annotated["IN_PROGRESS"]["breach"] == "at"
    assert annotated["REVIEW"]["current_count"] == 3
    assert annotated["REVIEW"]["breach"] == "over"
    assert annotated["BACKLOG"]["current_count"] == 1
    assert annotated["BACKLOG"]["breach"] is None


@pytest.mark.django_db
def test_wip_breach_folds_on_hold_and_ignores_deleted(project: Project) -> None:
    _make_task(project, "legacy", status=TaskStatus.ON_HOLD)  # folds into BACKLOG
    deleted = _make_task(project, "gone", status=TaskStatus.IN_PROGRESS)
    deleted.is_deleted = True
    deleted.save()

    annotated = {c["status"]: c for c in annotate_wip_breach(project.pk, _COLUMNS)}
    assert annotated["BACKLOG"]["current_count"] == 1  # ON_HOLD folded in
    assert annotated["IN_PROGRESS"]["current_count"] == 0  # deleted excluded


@pytest.mark.django_db
def test_wip_breach_single_query(project: Project) -> None:
    for i in range(5):
        _make_task(project, f"t{i}", status=TaskStatus.IN_PROGRESS)
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    with CaptureQueriesContext(connection) as ctx:
        annotate_wip_breach(project.pk, _COLUMNS)
    # Exactly one grouped count query regardless of column or task count.
    assert len(ctx.captured_queries) == 1


@pytest.mark.django_db
def test_board_config_endpoint_includes_breach(project: Project, member: Any) -> None:
    BoardColumnConfig.objects.create(project=project, columns=_COLUMNS)
    _make_task(project, "i1", status=TaskStatus.IN_PROGRESS)
    _make_task(project, "i2", status=TaskStatus.IN_PROGRESS)
    c = APIClient()
    c.force_authenticate(user=member)
    resp = c.get(f"/api/v1/projects/{project.pk}/board-config/")
    assert resp.status_code == 200, resp.data
    cols = {col["status"]: col for col in resp.data["columns"]}
    assert cols["IN_PROGRESS"]["current_count"] == 2
    assert cols["IN_PROGRESS"]["breach"] == "at"


@pytest.mark.django_db
def test_board_config_breach_visible_to_pm(project: Project, pm: Any) -> None:
    # Current board state is NOT gated under flow_metrics — every member sees it.
    BoardColumnConfig.objects.create(project=project, columns=_COLUMNS)
    _make_task(project, "i1", status=TaskStatus.IN_PROGRESS)
    c = APIClient()
    c.force_authenticate(user=pm)
    resp = c.get(f"/api/v1/projects/{project.pk}/board-config/")
    assert resp.status_code == 200
    cols = {col["status"]: col for col in resp.data["columns"]}
    assert cols["IN_PROGRESS"]["current_count"] == 1


# ---------------------------------------------------------------------------
# D3 — throughput forecast
# ---------------------------------------------------------------------------


def _completed_in_week(
    project: Project, name: str, weeks_ago: int, delivery_mode: str = DeliveryMode.WATERFALL
) -> Task:
    """Create a task that reached COMPLETE ``weeks_ago`` weeks before now."""
    now = timezone.now()
    t = Task.objects.create(
        project=project,
        name=name,
        duration=1,
        status=TaskStatus.NOT_STARTED,
        delivery_mode=delivery_mode,
    )
    _backdate_latest_history(t, now - timedelta(weeks=weeks_ago, days=2))
    _move(t, TaskStatus.COMPLETE, now - timedelta(weeks=weeks_ago))
    return t


@pytest.mark.django_db
def test_throughput_forecast_insufficient_history(project: Project) -> None:
    # Only 2 non-zero throughput weeks (< MIN_THROUGHPUT_WEEKS=4) → honest status.
    _completed_in_week(project, "c1", 1)
    _completed_in_week(project, "c2", 2)
    # A remaining backlog so the gate is the week-count, not the backlog.
    _make_task(project, "rem1", status=TaskStatus.BACKLOG)
    result = throughput_forecast(project.pk)
    assert result is not None
    assert result["status"] == "insufficient_flow_history"
    assert result["forecast_basis"] == "throughput"
    assert result["p50_date"] is None


@pytest.mark.django_db
def test_throughput_forecast_no_history_returns_none(project: Project) -> None:
    _make_task(project, "rem1", status=TaskStatus.BACKLOG)
    assert throughput_forecast(project.pk) is None


@pytest.mark.django_db
def test_throughput_forecast_ready(project: Project) -> None:
    # 5 non-zero weeks of throughput (>= 4) + a remaining backlog → ready forecast.
    for week in range(1, 6):
        _completed_in_week(project, f"done-{week}", week)
    for i in range(4):
        _make_task(project, f"rem-{i}", status=TaskStatus.NOT_STARTED)
    result = throughput_forecast(project.pk)
    assert result is not None
    assert result["status"] == "ready"
    assert result["forecast_basis"] == "throughput"
    assert result["basis"] == "monte_carlo"
    assert result["remaining_count"] == 4
    assert result["remaining_points"] is None
    # P50/P80/P95 dates present and monotonically ordered.
    assert result["p50_date"] is not None
    assert result["p95_date"] is not None
    assert result["p50_date"] <= result["p80_date"] <= result["p95_date"]
    assert result["sample_count"] == 5


@pytest.mark.django_db
def test_throughput_forecast_deterministic(project: Project) -> None:
    for week in range(1, 6):
        _completed_in_week(project, f"done-{week}", week)
    for i in range(4):
        _make_task(project, f"rem-{i}", status=TaskStatus.NOT_STARTED)
    a = throughput_forecast(project.pk)
    b = throughput_forecast(project.pk)
    assert a == b  # seeded RNG → identical distribution within identical windows


@pytest.mark.django_db
def test_sprint_forecast_routes_flow_team_to_throughput(project: Project) -> None:
    from trueppm_api.apps.projects.services import sprint_forecast

    # No closed sprints at all, but real throughput → unified forecast picks throughput.
    for week in range(1, 6):
        _completed_in_week(project, f"done-{week}", week)
    for i in range(4):
        _make_task(project, f"rem-{i}", status=TaskStatus.NOT_STARTED)
    result = sprint_forecast(project.pk)
    assert result["forecast_basis"] == "throughput"
    assert result["status"] == "ready"
    assert result["remaining_count"] == 4


@pytest.mark.django_db
def test_sprint_forecast_kanban_mode_prefers_throughput(project: Project) -> None:
    from trueppm_api.apps.projects.models import Sprint, SprintState

    # Give the project velocity (2 closed sprints) AND a kanban-dominant board.
    for n, pts in [("S1", 18), ("S2", 22)]:
        Sprint.objects.create(
            project=project,
            name=n,
            start_date=date(2026, 1, 1),
            finish_date=date(2026, 1, 14),
            state=SprintState.COMPLETED,
            committed_points=pts,
            completed_points=pts,
            completed_task_count=pts,
            committed_task_count=pts,
            closed_at=timezone.now(),
        )
    # Throughput history to forecast from — on a kanban board the done cards are
    # kanban too, so the delivery-mode majority is kanban.
    for week in range(1, 6):
        _completed_in_week(project, f"done-{week}", week, delivery_mode=DeliveryMode.KANBAN)
    # Kanban-mode majority of moded tasks + a remaining backlog.
    for i in range(4):
        Task.objects.create(
            project=project,
            name=f"k{i}",
            duration=1,
            status=TaskStatus.NOT_STARTED,
            delivery_mode=DeliveryMode.KANBAN,
        )
    from trueppm_api.apps.projects.services import sprint_forecast

    result = sprint_forecast(project.pk)
    assert result["forecast_basis"] == "throughput"


@pytest.mark.django_db
def test_velocity_path_unchanged_and_has_p95(project: Project) -> None:
    from trueppm_api.apps.projects.models import Sprint, SprintState
    from trueppm_api.apps.projects.services import sprint_forecast

    for n, pts in [("S1", 18), ("S2", 20), ("S3", 22)]:
        Sprint.objects.create(
            project=project,
            name=n,
            start_date=date(2026, 1, 1),
            finish_date=date(2026, 1, 14),
            state=SprintState.COMPLETED,
            committed_points=pts,
            completed_points=pts,
            completed_task_count=pts,
            committed_task_count=pts,
            closed_at=timezone.now(),
        )
    active = Sprint.objects.create(
        project=project,
        name="Active",
        start_date=date(2026, 3, 1),
        finish_date=date(2026, 3, 14),
        state=SprintState.ACTIVE,
    )
    for i in range(3):
        Task.objects.create(
            project=project,
            name=f"backlog{i}",
            duration=1,
            sprint=active,
            story_points=20,
            status=TaskStatus.NOT_STARTED,
        )
    result = sprint_forecast(project.pk)
    # Velocity path: legacy basis constant intact (web consumers branch on it).
    assert result["basis"] == "monte_carlo"
    assert result["forecast_basis"] == "velocity"
    assert result["status"] == "ready"
    assert result["remaining_points"] == 60
    assert result["remaining_count"] is None
    # New p95_date is present and ordered after p80.
    assert result["p95_date"] is not None
    assert result["p80_date"] <= result["p95_date"]


# ---------------------------------------------------------------------------
# D4 — signal-privacy suppression of flow_metrics
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_flow_metrics_full_read_for_member(client: APIClient, project: Project) -> None:
    now = timezone.now()
    t = _make_task(project, "T1", status=TaskStatus.NOT_STARTED)
    _backdate_latest_history(t, now - timedelta(days=8))
    _move(t, TaskStatus.IN_PROGRESS, now - timedelta(days=5))
    _move(t, TaskStatus.COMPLETE, now)
    resp = client.get(_flow_url(project))
    assert resp.status_code == 200
    # A TEAM-band member reads the team's own flow metrics in full.
    assert resp.data["flow_metrics_suppressed"] is False
    assert resp.data["cycle_time"]["p50"] is not None
    assert len(resp.data["cfd"]) > 0
    assert any(row["completed_count"] > 0 for row in resp.data["throughput"])


@pytest.mark.django_db
def test_flow_metrics_suppressed_for_pm_by_default(project: Project, pm: Any) -> None:
    # ADR-0130 D4 default posture: flow_metrics is TEAM/TEAM. The PM/management band
    # (an ADMIN resolves to TEAM_SM_PM) does NOT read the historical distributions
    # until the team shares upward — the surveillance boundary (Morgan).
    now = timezone.now()
    t = _make_task(project, "T1", status=TaskStatus.NOT_STARTED)
    _backdate_latest_history(t, now - timedelta(days=8))
    _move(t, TaskStatus.IN_PROGRESS, now - timedelta(days=5))
    _move(t, TaskStatus.COMPLETE, now)

    c = APIClient()
    c.force_authenticate(user=pm)
    resp = c.get(_flow_url(project))
    assert resp.status_code == 200
    assert resp.data["flow_metrics_suppressed"] is True
    # Distributions emptied / nulled.
    assert resp.data["cycle_time"] == {"p50": None, "p80": None, "p95": None}
    assert resp.data["lead_time"] == {"p50": None, "p80": None, "p95": None}
    assert resp.data["cfd"] == []
    assert resp.data["throughput"] == []
    # data_integrity is zeroed too: bulk_moved/backdated counts are derived from the
    # same completion replay as throughput, so a non-zero count would leak a floor on
    # completions and partially reconstruct the suppressed signal (ADR-0104 precedent
    # for excluded_count). The block stays in the shape, zeroed — this task has a
    # backdated row, so an un-zeroed count would otherwise be > 0.
    assert resp.data["data_integrity"] == {
        "bulk_moved_count": 0,
        "backdated_count": 0,
        "missing_transition_count": 0,
    }
    assert resp.data["since"] is not None


@pytest.mark.django_db
def test_flow_metrics_suppressed_when_gate_false(client: APIClient, project: Project) -> None:
    now = timezone.now()
    t = _make_task(project, "T1", status=TaskStatus.NOT_STARTED)
    _backdate_latest_history(t, now - timedelta(days=4))
    _move(t, TaskStatus.COMPLETE, now)
    with patch(
        "trueppm_api.apps.projects.signal_privacy_services.can_read_signal",
        return_value=False,
    ):
        resp = client.get(_flow_url(project))
    assert resp.status_code == 200
    assert resp.data["flow_metrics_suppressed"] is True
    assert resp.data["throughput"] == []


@pytest.mark.django_db
def test_flow_metrics_signal_default_is_team_strict() -> None:
    # D4: the new key exists with the strict TEAM/TEAM posture (mirrors pulse).
    from trueppm_api.apps.projects.models import SIGNAL_DEFAULTS, SignalAudience

    assert "flow_metrics" in SIGNAL_DEFAULTS
    assert SIGNAL_DEFAULTS["flow_metrics"]["audience"] == SignalAudience.TEAM
    assert SIGNAL_DEFAULTS["flow_metrics"]["ceiling"] == SignalAudience.TEAM


@pytest.mark.django_db
def test_can_read_signal_handles_flow_metrics_key(project: Project, member: Any) -> None:
    # D4: can_read_signal resolves the new key via SIGNAL_DEFAULTS even with no policy
    # row — a TEAM-band member reads, a non-member does not.
    from rest_framework.test import APIRequestFactory

    from trueppm_api.apps.projects.signal_privacy_services import can_read_signal

    rf = APIRequestFactory()
    req = rf.get("/")
    req.user = member
    assert can_read_signal(req, project.pk, "flow_metrics") is True

    outsider = User.objects.create_user(username="fm_outsider", password="pw")
    req2 = rf.get("/")
    req2.user = outsider
    assert can_read_signal(req2, project.pk, "flow_metrics") is False
