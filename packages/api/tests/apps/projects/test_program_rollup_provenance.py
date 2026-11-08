"""Metric provenance for the program rollup (ADR-1314 amendment, #4779).

``GET /programs/{id}/rollup/`` owns the program-level figures. These tests pin:

- every payload carries ``as_of`` and a ``definitions`` map (``program_health``
  always, each KPI only while enabled), with the sentences from
  ``METRIC_DEFINITIONS``;
- ``program_health`` is the project health band rolled up — the band each
  project's status-summary prints — or the program manager's own report;
- a configured figure that cannot be computed keeps its value (null / unknown)
  and carries a rule-119 ``reason``;
- ``p80_completion`` is the latest project P80 from the same latest result
  ``monte-carlo/latest/`` serves, dated by its oldest input;
- the read stays gated by program membership and its query count does not grow
  with the number of projects.
"""

from __future__ import annotations

import datetime
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.metric_provenance import METRIC_DEFINITIONS
from trueppm_api.apps.projects.models import (
    AggregationPolicy,
    Baseline,
    BaselineTask,
    Calendar,
    Health,
    Methodology,
    Program,
    Project,
    RollupKpi,
    Task,
)
from trueppm_api.apps.projects.program_rollup import (
    ROLLUP_DEFINITION_KEY,
    compute_program_rollup,
    top_contributing_project,
)
from trueppm_api.apps.scheduling.models import MonteCarloRun
from trueppm_api.apps.scheduling.views import mc_latest_cache_key

User = get_user_model()

TODAY = datetime.date.today()
ALL_KPIS = [k.value for k in RollupKpi]


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def owner(db: object) -> Any:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def member(db: object) -> Any:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def program(owner: Any, member: Any) -> Program:
    program = create_program(
        name="Phase 2", description="", methodology=Methodology.HYBRID, created_by=owner
    )
    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    return program


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _get(user: Any, program: Program) -> dict[str, Any]:
    resp = _client(user).get(f"/api/v1/programs/{program.pk}/rollup/")
    assert resp.status_code == 200
    data: dict[str, Any] = resp.data
    return data


def _configure(program: Program, kpis: list[str], policy: str = "worst") -> None:
    program.rollup_enabled_kpis = kpis
    program.rollup_aggregation_policy = policy
    program.save(update_fields=["rollup_enabled_kpis", "rollup_aggregation_policy"])


def _project(program: Program, calendar: Calendar, name: str, **kwargs: Any) -> Project:
    return Project.objects.create(
        name=name,
        start_date=datetime.date(2026, 1, 1),
        calendar=calendar,
        program=program,
        **kwargs,
    )


def _critical(project: Project) -> Task:
    return Task.objects.create(project=project, name="crit", duration=1, is_critical=True)


def _run(project: Project, p80: datetime.date | None, taken_at: datetime.datetime) -> None:
    run = MonteCarloRun.objects.create(project=project, n_simulations=100, p80=p80)
    MonteCarloRun.objects.filter(pk=run.pk).update(taken_at=taken_at)


# ---------------------------------------------------------------------------
# as_of + definitions
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_carries_as_of_and_a_definition_per_figure(member: Any, program: Program) -> None:
    _configure(program, [RollupKpi.CRITICAL_TASKS.value, RollupKpi.P80_COMPLETION.value])
    before = timezone.now()
    data = _get(member, program)
    as_of = datetime.datetime.fromisoformat(str(data["as_of"]))
    assert before <= as_of <= timezone.now()
    # program_health always; each KPI only while enabled; the sentences verbatim.
    assert data["definitions"] == {
        "program_health": METRIC_DEFINITIONS["program_health"],
        "critical_tasks": METRIC_DEFINITIONS["rollup.critical_tasks"],
        "p80_completion": METRIC_DEFINITIONS["rollup.p80_completion"],
    }


@pytest.mark.django_db
def test_every_kpi_has_a_definition(member: Any, program: Program) -> None:
    _configure(program, ALL_KPIS)
    defs = _get(member, program)["definitions"]
    assert set(defs) == {"program_health", *ALL_KPIS}
    assert all(defs[k] == METRIC_DEFINITIONS[ROLLUP_DEFINITION_KEY[k]] for k in ALL_KPIS)


# ---------------------------------------------------------------------------
# program_health — the project health band, rolled up
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_program_health_matches_each_projects_status_summary_band(
    owner: Any, program: Program, calendar: Calendar
) -> None:
    """One project: the program band IS that project's band, from its own owner."""
    p = _project(program, calendar, "Solo")
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    Task.objects.create(project=p, name="tight", duration=1, total_float=2)

    project_band = (
        _client(owner).get(f"/api/v1/projects/{p.pk}/status-summary/").data["health_band"]
    )
    data = _get(owner, program)
    assert project_band == "at_risk"
    assert data["program_health"] == project_band
    assert data["program_health_source"] == "derived"
    assert data["program_health_reason"] is None


@pytest.mark.django_db
def test_program_health_honors_a_project_managers_report(
    member: Any, program: Program, calendar: Calendar
) -> None:
    """A clean plan whose PM reported Critical rolls up as critical (#3501 one level up)."""
    _project(program, calendar, "Reported", health=Health.CRITICAL)
    _project(program, calendar, "Clean")
    assert _get(member, program)["program_health"] == "critical"


@pytest.mark.django_db
def test_program_health_is_not_the_schedule_performance_rollup(
    member: Any, program: Program, calendar: Calendar
) -> None:
    """A project late on SPI but with no critical or low-float work is on track."""
    p = _project(program, calendar, "Late on SPI")
    t = Task.objects.create(project=p, name="due", duration=1, early_finish=TODAY)
    b = Baseline.objects.create(project=p, name="B", is_active=True, has_cpm_dates=True)
    BaselineTask.objects.create(baseline=b, task_id=t.pk, task_name="due", finish=TODAY, duration=1)
    _configure(program, [RollupKpi.SCHEDULE_HEALTH.value])
    data = _get(member, program)
    assert data["kpis"]["schedule_health"]["value"] == "critical"
    assert data["program_health"] == "on_track"


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("policy", "expected"),
    [(AggregationPolicy.WORST.value, "critical"), (AggregationPolicy.AVERAGE.value, "at_risk")],
)
def test_program_health_follows_the_policy(
    member: Any, program: Program, calendar: Calendar, policy: str, expected: str
) -> None:
    _critical(_project(program, calendar, "A"))  # critical, ordinal 0
    _project(program, calendar, "B")  # on track, ordinal 2
    _configure(program, [], policy)
    assert _get(member, program)["program_health"] == expected


@pytest.mark.django_db
def test_program_managers_report_wins_over_the_rollup(
    member: Any, program: Program, calendar: Calendar
) -> None:
    _critical(_project(program, calendar, "A"))
    program.health = Health.ON_TRACK
    program.save(update_fields=["health"])
    data = _get(member, program)
    assert data["program_health"] == "on_track"
    assert data["program_health_source"] == "reported"


@pytest.mark.django_db
def test_empty_program_health_is_unknown_with_a_reason(member: Any, program: Program) -> None:
    data = _get(member, program)
    assert data["program_health"] == "unknown"
    assert data["program_health_reason"] == "no_projects"
    # A filed report is a band even with no projects.
    program.health = Health.AT_RISK
    program.save(update_fields=["health"])
    data = _get(member, program)
    assert (data["program_health"], data["program_health_reason"]) == ("at_risk", None)


@pytest.mark.django_db
def test_top_contributing_project_ranks_by_the_project_band(
    program: Program, calendar: Calendar
) -> None:
    _project(program, calendar, "Fine")
    _project(program, calendar, "Reported", health=Health.AT_RISK)
    worst = top_contributing_project(program)
    assert worst is not None
    assert (worst["name"], worst["health"]) == ("Reported", "at_risk")

    Project.objects.filter(name="Reported").update(health=Health.AUTO)
    assert top_contributing_project(program) is None  # nothing drags it down


# ---------------------------------------------------------------------------
# Rule 119 — not computable is a value plus a reason, never an omission
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_not_computable_kpis_carry_a_reason(
    member: Any, program: Program, calendar: Calendar
) -> None:
    p = _project(program, calendar, "Bare")
    # A future task with no planned-by-today work, no milestone, no baseline.
    Task.objects.create(
        project=p, name="later", duration=1, early_finish=TODAY + datetime.timedelta(days=30)
    )
    _configure(
        program,
        [
            RollupKpi.SCHEDULE_HEALTH.value,
            RollupKpi.MILESTONE_HEALTH.value,
            RollupKpi.BASELINE_VARIANCE.value,
            RollupKpi.SCHEDULE_VARIANCE.value,
            RollupKpi.P80_COMPLETION.value,
        ],
    )
    kpis = _get(member, program)["kpis"]
    assert kpis["schedule_health"] == {
        "available": True,
        "value": "unknown",
        "reason": "no_planned_work",
    }
    assert kpis["milestone_health"]["reason"] == "no_milestones"
    assert (kpis["baseline_variance"]["value"], kpis["baseline_variance"]["reason"]) == (
        None,
        "no_baseline",
    )
    assert kpis["schedule_variance"]["reason"] == "no_baseline"
    assert (kpis["p80_completion"]["value"], kpis["p80_completion"]["reason"]) == (
        None,
        "no_forecast",
    )
    assert kpis["p80_completion"]["projects_without_forecast"] == 1


@pytest.mark.django_db
def test_schedule_variance_with_a_baseline_but_nothing_done(
    member: Any, program: Program, calendar: Calendar
) -> None:
    p = _project(program, calendar, "Baselined")
    t = Task.objects.create(project=p, name="open", duration=1, early_finish=TODAY)
    b = Baseline.objects.create(project=p, name="B", is_active=True, has_cpm_dates=True)
    BaselineTask.objects.create(
        baseline=b, task_id=t.pk, task_name="open", finish=TODAY, duration=1
    )
    _configure(program, [RollupKpi.SCHEDULE_VARIANCE.value])
    entry = _get(member, program)["kpis"]["schedule_variance"]
    assert (entry["value"], entry["reason"]) == (None, "no_completed_work")


@pytest.mark.django_db
def test_a_computable_kpi_carries_no_reason(
    member: Any, program: Program, calendar: Calendar
) -> None:
    _critical(_project(program, calendar, "A"))
    _configure(program, [RollupKpi.CRITICAL_TASKS.value])
    assert _get(member, program)["kpis"]["critical_tasks"] == {"available": True, "value": 1}


# ---------------------------------------------------------------------------
# p80_completion
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_p80_completion_is_the_latest_project_p80_dated_by_its_oldest_input(
    member: Any, program: Program, calendar: Calendar
) -> None:
    a = _project(program, calendar, "A")
    b = _project(program, calendar, "B")
    _project(program, calendar, "No forecast")
    old_run = timezone.now() - datetime.timedelta(days=3)
    new_run = timezone.now() - datetime.timedelta(hours=1)
    # A's older run is superseded by its newer one; only the newest counts.
    _run(a, datetime.date(2027, 9, 1), old_run - datetime.timedelta(days=1))
    _run(a, datetime.date(2027, 3, 1), new_run)
    _run(b, datetime.date(2027, 5, 1), old_run)
    _configure(program, [RollupKpi.P80_COMPLETION.value])

    entry = _get(member, program)["kpis"]["p80_completion"]
    assert entry["available"] is True
    assert entry["unit"] == "date"
    assert entry["value"] == "2027-05-01"
    assert entry["driver_project_id"] == str(b.pk)
    assert datetime.datetime.fromisoformat(str(entry["as_of"])) == old_run
    assert entry["projects_without_forecast"] == 1
    assert "reason" not in entry


@pytest.mark.django_db
def test_p80_completion_reads_the_cache_first_like_monte_carlo_latest(
    member: Any, program: Program, calendar: Calendar
) -> None:
    """A Member-triggered run refreshes only the cache (#1502); the rollup sees it."""
    a = _project(program, calendar, "A")
    _run(a, datetime.date(2027, 1, 1), timezone.now() - datetime.timedelta(days=2))
    run_at = timezone.now()
    cache.set(
        mc_latest_cache_key(a.pk),
        {"p80": "2027-02-15", "last_run_at": run_at.isoformat()},
        timeout=60,
    )
    _configure(program, [RollupKpi.P80_COMPLETION.value])
    entry = _get(member, program)["kpis"]["p80_completion"]
    assert entry["value"] == "2027-02-15"
    assert datetime.datetime.fromisoformat(str(entry["as_of"])) == run_at


@pytest.mark.django_db
def test_p80_completion_ignores_a_policy(member: Any, program: Program, calendar: Calendar) -> None:
    a = _project(program, calendar, "A")
    b = _project(program, calendar, "B")
    _run(a, datetime.date(2027, 1, 1), timezone.now())
    _run(b, datetime.date(2027, 12, 1), timezone.now())
    _configure(program, [RollupKpi.P80_COMPLETION.value], AggregationPolicy.AVERAGE.value)
    assert _get(member, program)["kpis"]["p80_completion"]["value"] == "2027-12-01"


@pytest.mark.django_db
def test_p80_completion_skips_a_draft_project(
    member: Any, program: Program, calendar: Calendar
) -> None:
    from trueppm_api.apps.projects.models import ProjectLifecycle

    draft = _project(program, calendar, "Draft", lifecycle=ProjectLifecycle.DRAFT)
    _run(draft, datetime.date(2030, 1, 1), timezone.now())
    _configure(program, [RollupKpi.P80_COMPLETION.value])
    entry = _get(member, program)["kpis"]["p80_completion"]
    assert entry["value"] is None
    assert entry["reason"] == "no_projects"


# ---------------------------------------------------------------------------
# Permissions + query budget
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_program_member_without_project_membership_reads_the_rollup(
    member: Any, program: Program, calendar: Calendar
) -> None:
    """Program membership is the gate (ADR-0088), as for every other rollup KPI."""
    a = _project(program, calendar, "A")
    _run(a, datetime.date(2027, 1, 1), timezone.now())
    _configure(program, [RollupKpi.P80_COMPLETION.value])
    assert not ProjectMembership.objects.filter(user=member).exists()
    assert _get(member, program)["kpis"]["p80_completion"]["value"] == "2027-01-01"


@pytest.mark.django_db
def test_project_member_who_is_not_a_program_member_is_refused(
    program: Program, calendar: Calendar
) -> None:
    outsider = User.objects.create_user(username="outsider", password="pw")
    a = _project(program, calendar, "A")
    ProjectMembership.objects.create(project=a, user=outsider, role=Role.OWNER)
    resp = _client(outsider).get(f"/api/v1/programs/{program.pk}/rollup/")
    assert resp.status_code == 404


@pytest.mark.django_db
def test_query_count_does_not_grow_with_projects(program: Program, calendar: Calendar) -> None:
    _configure(program, ALL_KPIS)

    def count() -> int:
        with CaptureQueriesContext(connection) as ctx:
            compute_program_rollup(program)
        return len(ctx.captured_queries)

    for i in range(2):
        p = _project(program, calendar, f"P{i}")
        _critical(p)
        _run(p, datetime.date(2027, 1, 1 + i), timezone.now())
    two = count()
    for i in range(2, 6):
        p = _project(program, calendar, f"P{i}")
        _critical(p)
        _run(p, datetime.date(2027, 1, 1 + i), timezone.now())
    assert count() == two
