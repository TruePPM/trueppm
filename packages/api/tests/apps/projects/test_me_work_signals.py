"""Tests for the cross-program focus-card signals on ``GET /api/v1/me/work/``.

Covers #1236 / ADR-0221: the additive ``signals`` block that rolls up per-user
cross-program aggregates for the My Work focus cards. The governing rule is 120 —
a signal is surfaced ONLY where a real server-side computation backs it, and is
honestly omitted otherwise. These tests assert:

  - schedule_health is a worst-first SPI-proxy band, scoped to the caller's own
    member projects (no cross-boundary leak);
  - forecast is the latest (max) Monte-Carlo P80 across forecasted member
    projects, and is absent when no run exists;
  - sprint_burndown is the real snapshot series for the soonest-ending active
    sprint, and is absent when there are no snapshots;
  - utilization (#1912) is the caller's OWN load vs OWN capacity for the lead
    sprint — computed from the resource-allocation source of truth, scoped to the
    caller's own resource, and honestly omitted when no such data backs it;
  - signals are computed on the first page only, and stay bounded (no N+1).
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintBurnSnapshot,
    SprintState,
    Task,
    TaskStatus,
)
from trueppm_api.apps.resources.models import Resource, TaskResource
from trueppm_api.apps.scheduling.models import MonteCarloRun

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def alice(db: object) -> object:
    return User.objects.create_user(username="alice", password="pw")


@pytest.fixture
def bob(db: object) -> object:
    return User.objects.create_user(username="bob", password="pw")


def _project(calendar: Calendar, name: str) -> Project:
    return Project.objects.create(name=name, start_date=date(2026, 4, 1), calendar=calendar)


def _member(project: Project, user: object, role: int = Role.MEMBER) -> ProjectMembership:
    return ProjectMembership.objects.create(project=project, user=user, role=role)


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _task(project: Project, name: str, **kwargs: object) -> Task:
    defaults: dict[str, object] = {"duration": 1}
    defaults.update(kwargs)
    return Task.objects.create(project=project, name=name, **defaults)


# ---------------------------------------------------------------------------
# Schedule health (SPI-proxy)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_schedule_health_worst_first_and_scoped_to_own_projects(
    calendar: Calendar, alice: object, bob: object
) -> None:
    """Worst-first band across the caller's member projects; other users' projects
    (even worse ones) must not enter the reduce or the project count."""
    today = timezone.localdate()
    past = today - timedelta(days=1)

    # P1 (alice): 2 planned-by-today, both COMPLETE -> SPI 1.0 -> on_track.
    p1 = _project(calendar, "P1")
    _member(p1, alice)
    for i in range(2):
        _task(p1, f"p1-{i}", early_finish=past, status=TaskStatus.COMPLETE)

    # P2 (alice): 4 planned-by-today, 1 COMPLETE -> SPI 0.25 -> critical.
    p2 = _project(calendar, "P2")
    _member(p2, alice)
    _task(p2, "p2-done", early_finish=past, status=TaskStatus.COMPLETE)
    for i in range(3):
        _task(p2, f"p2-open-{i}", early_finish=past, status=TaskStatus.IN_PROGRESS)

    # P3 (bob only): also critical, but alice is NOT a member -> excluded.
    p3 = _project(calendar, "P3")
    _member(p3, bob)
    for i in range(4):
        _task(p3, f"p3-{i}", early_finish=past, status=TaskStatus.IN_PROGRESS)

    signals = _client(alice).get("/api/v1/me/work/").data["signals"]
    assert signals["schedule_health"] == {"band": "critical", "project_count": 2}


@pytest.mark.django_db
def test_schedule_health_omitted_when_all_unknown(calendar: Calendar, alice: object) -> None:
    """A project with no planned-by-today work is 'unknown' and yields no band."""
    p1 = _project(calendar, "P1")
    _member(p1, alice)
    # A future-dated task: nothing is due-by-today, so SPI is undefined (unknown).
    _task(p1, "future", early_finish=timezone.localdate() + timedelta(days=30))

    signals = _client(alice).get("/api/v1/me/work/").data["signals"]
    assert "schedule_health" not in signals


# ---------------------------------------------------------------------------
# Monte-Carlo P80 forecast
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_forecast_is_latest_max_p80_across_member_projects(
    calendar: Calendar, alice: object, bob: object
) -> None:
    """The forecast is the latest run per project, reduced to the MAX P80 finish —
    the caller's honest 'everything done at 80% confidence' date. Non-member
    projects never contribute."""
    p1 = _project(calendar, "P1")
    _member(p1, alice)
    p2 = _project(calendar, "P2")
    _member(p2, alice)
    p3 = _project(calendar, "P3")
    _member(p3, bob)

    # P1's latest run is superseded by a newer one (auto_now_add -> later is newer).
    MonteCarloRun.objects.create(project=p1, p80=date(2026, 6, 1), n_simulations=1000)
    MonteCarloRun.objects.create(project=p1, p80=date(2026, 8, 1), n_simulations=1000)
    # P2 ships later -> it should drive the aggregate.
    MonteCarloRun.objects.create(project=p2, p80=date(2026, 9, 15), n_simulations=1000)
    # Bob's project ships latest of all, but must not leak to alice.
    MonteCarloRun.objects.create(project=p3, p80=date(2027, 1, 1), n_simulations=1000)

    forecast = _client(alice).get("/api/v1/me/work/").data["signals"]["forecast"]
    assert forecast["p80_finish"] == "2026-09-15"
    assert forecast["project_id"] == str(p2.id)
    assert forecast["project_name"] == "P2"
    assert "as_of" in forecast


@pytest.mark.django_db
def test_forecast_omitted_when_no_run(calendar: Calendar, alice: object) -> None:
    p1 = _project(calendar, "P1")
    _member(p1, alice)
    signals = _client(alice).get("/api/v1/me/work/").data["signals"]
    assert "forecast" not in signals


# ---------------------------------------------------------------------------
# Sprint burndown
# ---------------------------------------------------------------------------


def _active_sprint(project: Project, name: str, finish: date, committed: int = 40) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name=name,
        start_date=finish - timedelta(days=13),
        finish_date=finish,
        state=SprintState.ACTIVE,
        committed_points=committed,
    )


@pytest.mark.django_db
def test_sprint_burndown_uses_soonest_ending_sprint(calendar: Calendar, alice: object) -> None:
    """The lead (soonest-ending) active sprint drives the burndown; the series is
    the real persisted snapshots."""
    today = timezone.localdate()
    p1 = _project(calendar, "P1")
    _member(p1, alice)

    lead = _active_sprint(p1, "Lead", finish=today + timedelta(days=2))
    later = _active_sprint(p1, "Later", finish=today + timedelta(days=9))
    # Alice must own a non-BACKLOG task in each to make them "active" for her.
    # Creating an IN_PROGRESS task fires task_status_changed (receivers.py),
    # which real-time upserts *today's* burn snapshot for the lead sprint —
    # remaining_points is 0 because this fixture task carries no story_points.
    # That live point lands after the three historical snapshots seeded below.
    _task(p1, "lead-task", sprint=lead, assignee=alice, status=TaskStatus.IN_PROGRESS)
    _task(p1, "later-task", sprint=later, assignee=alice, status=TaskStatus.IN_PROGRESS)

    # Real burn series for the lead sprint only (historical days before today).
    for i, remaining in enumerate((40, 34, 28)):
        SprintBurnSnapshot.objects.create(
            sprint=lead,
            snapshot_date=lead.start_date + timedelta(days=i),
            remaining_points=remaining,
            remaining_task_count=3 - i,
            completed_points=40 - remaining,
            completed_task_count=i,
        )

    burndown = _client(alice).get("/api/v1/me/work/").data["signals"]["sprint_burndown"]
    assert burndown["sprint_id"] == str(lead.id)
    assert burndown["sprint_name"] == "Lead"
    assert burndown["committed_points"] == 40
    assert [p["remaining_points"] for p in burndown["series"]] == [40, 34, 28, 0]
    # burn_status is a real server verdict (not no_data — we have a baseline + snaps).
    assert burndown["burn_status"] in {"ahead", "on_track", "behind"}


@pytest.mark.django_db
def test_sprint_burndown_omitted_without_snapshots(calendar: Calendar, alice: object) -> None:
    today = timezone.localdate()
    p1 = _project(calendar, "P1")
    _member(p1, alice)
    sprint = _active_sprint(p1, "S", finish=today + timedelta(days=3))
    _task(p1, "t", sprint=sprint, assignee=alice, status=TaskStatus.IN_PROGRESS)
    # The task creation above fires task_status_changed, which real-time upserts
    # today's snapshot (receivers.py) — clear it so the sprint genuinely has none,
    # exercising the omission path itself rather than an unreachable precondition.
    SprintBurnSnapshot.objects.filter(sprint=sprint).delete()

    signals = _client(alice).get("/api/v1/me/work/").data["signals"]
    assert "sprint_burndown" not in signals


# ---------------------------------------------------------------------------
# Honest omission + contract
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Utilization (personal load vs capacity, #1912)
# ---------------------------------------------------------------------------


# A Mon–Fri sprint window: 5 working days under the default (mask 31) calendar,
# so available_hours = max_units × 5 × 8 and the arithmetic is checkable by hand.
_SPRINT_START = date(2026, 6, 1)  # Monday
_SPRINT_FINISH = date(2026, 6, 5)  # Friday


def _util_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="Cadence",
        start_date=_SPRINT_START,
        finish_date=_SPRINT_FINISH,
        state=SprintState.ACTIVE,
        committed_points=40,
    )


def _allocated_task(
    project: Project,
    sprint: Sprint,
    user: object,
    resource: Resource,
    *,
    start: date,
    finish: date,
    units: str,
) -> None:
    """Assign ``user`` a sprint task (so the sprint is active for them) AND book
    ``resource`` on it at ``units`` (so it contributes to the capacity load)."""
    t = _task(
        project,
        "alloc",
        sprint=sprint,
        assignee=user,
        status=TaskStatus.NOT_STARTED,
        early_start=start,
        early_finish=finish,
    )
    TaskResource.objects.create(task=t, resource=resource, units=Decimal(units))


@pytest.mark.django_db
def test_utilization_load_vs_target(calendar: Calendar, alice: object) -> None:
    """Load = Σ units × task_working_days × hours/day; target = max_units ×
    sprint_working_days × hours/day. One 2-working-day full-unit assignment in a
    5-working-day sprint at 1.0 capacity => 16h of 40h => ratio 0.4, under."""
    p1 = _project(calendar, "P1")
    _member(p1, alice)
    sprint = _util_sprint(p1)
    r = Resource.objects.create(name="Alice R", user=alice, max_units=Decimal("1.0"))
    # Mon–Tue task = 2 working days.
    _allocated_task(
        p1, sprint, alice, r, start=date(2026, 6, 1), finish=date(2026, 6, 2), units="1.0"
    )

    util = _client(alice).get("/api/v1/me/work/").data["signals"]["utilization"]
    assert util["sprint_id"] == str(sprint.id)
    assert util["sprint_name"] == "Cadence"
    assert util["committed_hours"] == pytest.approx(16.0)
    assert util["available_hours"] == pytest.approx(40.0)
    assert util["ratio"] == pytest.approx(0.4)
    assert util["is_over"] is False
    assert util["label"] == "on_track"


@pytest.mark.django_db
def test_utilization_over_capacity(calendar: Calendar, alice: object) -> None:
    """Two full-week full-unit assignments (80h) against 40h capacity => 2.0,
    flagged over_capacity."""
    p1 = _project(calendar, "P1")
    _member(p1, alice)
    sprint = _util_sprint(p1)
    r = Resource.objects.create(name="Alice R", user=alice, max_units=Decimal("1.0"))
    for _ in range(2):
        _allocated_task(
            p1, sprint, alice, r, start=_SPRINT_START, finish=_SPRINT_FINISH, units="1.0"
        )

    util = _client(alice).get("/api/v1/me/work/").data["signals"]["utilization"]
    assert util["committed_hours"] == pytest.approx(80.0)
    assert util["available_hours"] == pytest.approx(40.0)
    assert util["ratio"] == pytest.approx(2.0)
    assert util["is_over"] is True
    assert util["label"] == "over_capacity"


@pytest.mark.django_db
def test_utilization_only_requesting_users_own_load(
    calendar: Calendar, alice: object, bob: object
) -> None:
    """Alice's utilization reflects ONLY the resource linked to Alice — Bob's
    allocation on the same sprint must not inflate her load or capacity."""
    p1 = _project(calendar, "P1")
    _member(p1, alice)
    _member(p1, bob)
    sprint = _util_sprint(p1)
    ar = Resource.objects.create(name="Alice R", user=alice, max_units=Decimal("1.0"))
    br = Resource.objects.create(name="Bob R", user=bob, max_units=Decimal("1.0"))
    # Alice: Mon–Tue (2 days) at 1.0 => 16h. Bob: full week => 40h, must not leak.
    _allocated_task(
        p1, sprint, alice, ar, start=date(2026, 6, 1), finish=date(2026, 6, 2), units="1.0"
    )
    _allocated_task(p1, sprint, bob, br, start=_SPRINT_START, finish=_SPRINT_FINISH, units="1.0")

    util = _client(alice).get("/api/v1/me/work/").data["signals"]["utilization"]
    assert util["committed_hours"] == pytest.approx(16.0)
    assert util["available_hours"] == pytest.approx(40.0)


@pytest.mark.django_db
def test_utilization_omitted_without_linked_resource(calendar: Calendar, alice: object) -> None:
    """No ``Resource.user`` bridge => no personal capacity concept => omitted
    (rule 120), even with an active sprint and assigned work."""
    p1 = _project(calendar, "P1")
    _member(p1, alice)
    sprint = _util_sprint(p1)
    _task(p1, "t", sprint=sprint, assignee=alice, status=TaskStatus.NOT_STARTED)

    signals = _client(alice).get("/api/v1/me/work/").data["signals"]
    assert "utilization" not in signals


@pytest.mark.django_db
def test_utilization_omitted_when_not_allocated_on_sprint(
    calendar: Calendar, alice: object
) -> None:
    """A linked resource with no ``TaskResource`` booking on the lead sprint has
    no measurable load, so the signal is omitted rather than shown as 0%."""
    p1 = _project(calendar, "P1")
    _member(p1, alice)
    sprint = _util_sprint(p1)
    Resource.objects.create(name="Alice R", user=alice, max_units=Decimal("1.0"))
    _task(p1, "t", sprint=sprint, assignee=alice, status=TaskStatus.NOT_STARTED)

    signals = _client(alice).get("/api/v1/me/work/").data["signals"]
    assert "utilization" not in signals


@pytest.mark.django_db
def test_utilization_zero_capacity_no_divide_by_zero(calendar: Calendar, alice: object) -> None:
    """A window with zero working days (a weekend-only sprint under the Mon–Fri
    calendar) yields zero available capacity — the signal is omitted rather than
    dividing by zero."""
    p1 = _project(calendar, "P1")
    _member(p1, alice)
    # Sat–Sun under mask 31 (Mon–Fri) = 0 working days => 0 available hours.
    sprint = Sprint.objects.create(
        project=p1,
        name="Weekend",
        start_date=date(2026, 6, 6),  # Saturday
        finish_date=date(2026, 6, 7),  # Sunday
        state=SprintState.ACTIVE,
        committed_points=40,
    )
    r = Resource.objects.create(name="Alice R", user=alice, max_units=Decimal("1.0"))
    _allocated_task(
        p1, sprint, alice, r, start=date(2026, 6, 6), finish=date(2026, 6, 7), units="1.0"
    )

    resp = _client(alice).get("/api/v1/me/work/")
    assert resp.status_code == 200
    assert "utilization" not in resp.data["signals"]


@pytest.mark.django_db
def test_signals_empty_for_user_with_no_projects(alice: object) -> None:
    resp = _client(alice).get("/api/v1/me/work/")
    assert resp.status_code == 200
    assert resp.data["signals"] == {}


@pytest.mark.django_db
def test_signals_only_on_first_page(calendar: Calendar, alice: object) -> None:
    """The aggregate is bounded but non-trivial, so it is computed on page 1 only;
    later pages omit the key (the web reads it from page 1)."""
    p1 = _project(calendar, "P1")
    _member(p1, alice)
    for i in range(3):
        _task(p1, f"t{i}", assignee=alice, status=TaskStatus.IN_PROGRESS)
    MonteCarloRun.objects.create(project=p1, p80=date(2026, 8, 1), n_simulations=1000)

    first = _client(alice).get("/api/v1/me/work/?limit=1").data
    assert "signals" in first and "forecast" in first["signals"]

    second = _client(alice).get("/api/v1/me/work/?limit=1&offset=1").data
    assert "signals" not in second


@pytest.mark.django_db
def test_signals_query_count_is_bounded(calendar: Calendar, alice: object) -> None:
    """No per-project / per-sprint loop: adding more member projects must not
    scale the query count. Two runs with different project counts, same ceiling."""

    def _hit(n_projects: int) -> int:
        alice_local = User.objects.create_user(username=f"u{n_projects}", password="pw")
        today = timezone.localdate()
        for i in range(n_projects):
            proj = _project(calendar, f"proj-{n_projects}-{i}")
            _member(proj, alice_local)
            _task(
                proj,
                f"done-{i}",
                early_finish=today - timedelta(days=1),
                status=TaskStatus.COMPLETE,
            )
            MonteCarloRun.objects.create(project=proj, p80=date(2026, 8, 1), n_simulations=1000)
        client = _client(alice_local)
        with CaptureQueriesContext(connection) as ctx:
            client.get("/api/v1/me/work/")
        return len(ctx.captured_queries)

    small = _hit(2)
    large = _hit(8)
    # A per-project loop would make `large` grow by ~4x the projects added; a
    # bounded grouped-query plan keeps the delta small. Allow modest slack.
    assert large <= small + 5
