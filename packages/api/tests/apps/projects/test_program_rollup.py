"""Tests for the program rollup-KPI consumer (#713, ADR-0088).

Covers:
- RBAC: any program member can GET the rollup; non-members 404; anon 401.
- Empty program → project_count 0, program_health "unknown", zero/None KPIs.
- Only enabled KPIs appear; deferred KPIs (cost_variance, budget_utilization,
  p80_completion) return {available: false, reason}.
- Count/score KPIs (critical_tasks, at_risk_tasks, risk_score) roll up as
  program totals regardless of policy.
- Health/variance KPIs honor the policy: worst vs average reduce differently.
- weighted_by_budget falls back to average and flags policy_available: false.
"""

from __future__ import annotations

import datetime

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.models import (
    AggregationPolicy,
    Baseline,
    BaselineTask,
    Calendar,
    Methodology,
    Program,
    Project,
    Risk,
    RiskStatus,
    RollupKpi,
    Task,
    TaskStatus,
)

User = get_user_model()

TODAY = datetime.date.today()


# ---------------------------------------------------------------------------
# Fixtures + helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def owner(db: object) -> object:
    return User.objects.create_user(username="owner", password="pw")


@pytest.fixture
def member(db: object) -> object:
    return User.objects.create_user(username="member", password="pw")


@pytest.fixture
def stranger(db: object) -> object:
    return User.objects.create_user(username="stranger", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def program(owner: object, member: object) -> Program:
    program = create_program(
        name="Phase 2", description="", methodology=Methodology.HYBRID, created_by=owner
    )
    ProgramMembership.objects.create(program=program, user=member, role=Role.MEMBER)
    return program


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _url(program: Program) -> str:
    return f"/api/v1/programs/{program.pk}/rollup/"


def _configure(program: Program, kpis: list[str], policy: str) -> None:
    program.rollup_enabled_kpis = kpis
    program.rollup_aggregation_policy = policy
    program.save(update_fields=["rollup_enabled_kpis", "rollup_aggregation_policy"])


def _project(program: Program, calendar: Calendar, name: str) -> Project:
    return Project.objects.create(
        name=name, start_date=datetime.date(2026, 1, 1), calendar=calendar, program=program
    )


def _task(project: Project, **kwargs: object) -> Task:
    defaults: dict[str, object] = {"name": "T", "duration": 1}
    defaults.update(kwargs)
    return Task.objects.create(project=project, **defaults)


def _baseline(project: Project, finishes: dict[Task, datetime.date]) -> Baseline:
    """Active baseline snapshotting the given {task: baseline_finish} dates."""
    baseline = Baseline.objects.create(
        project=project, name="B1", is_active=True, has_cpm_dates=True
    )
    for task, finish in finishes.items():
        BaselineTask.objects.create(
            baseline=baseline, task_id=task.pk, task_name=task.name, finish=finish, duration=1
        )
    return baseline


def _risk(project: Project, probability: int, impact: int, status: str = RiskStatus.OPEN) -> Risk:
    return Risk.objects.create(
        project=project, title="R", probability=probability, impact=impact, status=status
    )


# ---------------------------------------------------------------------------
# RBAC
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_member_can_read_rollup(member: object, program: Program) -> None:
    resp = _client(member).get(_url(program))
    assert resp.status_code == 200
    assert "kpis" in resp.data
    assert "program_health" in resp.data


@pytest.mark.django_db
def test_non_member_gets_404(stranger: object, program: Program) -> None:
    assert _client(stranger).get(_url(program)).status_code == 404


@pytest.mark.django_db
def test_anonymous_gets_401(program: Program) -> None:
    assert APIClient().get(_url(program)).status_code == 401


# ---------------------------------------------------------------------------
# Empty program + envelope
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_empty_program_is_unknown_with_zero_kpis(member: object, program: Program) -> None:
    _configure(
        program,
        [
            RollupKpi.SCHEDULE_HEALTH.value,
            RollupKpi.CRITICAL_TASKS.value,
            RollupKpi.BASELINE_VARIANCE.value,
        ],
        AggregationPolicy.WORST.value,
    )
    data = _client(member).get(_url(program)).data
    assert data["project_count"] == 0
    assert data["program_health"] == "unknown"
    assert data["kpis"]["schedule_health"] == {"available": True, "value": "unknown"}
    assert data["kpis"]["critical_tasks"] == {"available": True, "value": 0}
    # Variance with no baselines is built-but-no-data → value None.
    assert data["kpis"]["baseline_variance"]["available"] is True
    assert data["kpis"]["baseline_variance"]["value"] is None


@pytest.mark.django_db
def test_only_enabled_kpis_appear(member: object, program: Program) -> None:
    _configure(program, [RollupKpi.CRITICAL_TASKS.value], AggregationPolicy.WORST.value)
    data = _client(member).get(_url(program)).data
    assert list(data["kpis"].keys()) == ["critical_tasks"]


@pytest.mark.django_db
def test_deferred_kpis_are_unavailable_with_reason(member: object, program: Program) -> None:
    _configure(
        program,
        [
            RollupKpi.COST_VARIANCE.value,
            RollupKpi.BUDGET_UTILIZATION.value,
            RollupKpi.P80_COMPLETION.value,
        ],
        AggregationPolicy.WORST.value,
    )
    kpis = _client(member).get(_url(program)).data["kpis"]
    assert kpis["cost_variance"] == {"available": False, "reason": "no_cost_data"}
    assert kpis["budget_utilization"] == {"available": False, "reason": "no_cost_data"}
    assert kpis["p80_completion"] == {"available": False, "reason": "no_montecarlo_store"}


# ---------------------------------------------------------------------------
# Count / score KPIs — program totals, policy-independent
# ---------------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("policy", [AggregationPolicy.WORST.value, AggregationPolicy.AVERAGE.value])
def test_counts_and_risk_sum_across_projects(
    member: object, program: Program, calendar: Calendar, policy: str
) -> None:
    a = _project(program, calendar, "A")
    b = _project(program, calendar, "B")
    # critical: 2 in A, 1 in B = 3 program total (COMPLETE ones excluded).
    _task(a, is_critical=True)
    _task(a, is_critical=True)
    _task(a, is_critical=True, status=TaskStatus.COMPLETE)  # excluded
    _task(b, is_critical=True)
    # at_risk: float <= 5 and not complete — 1 in A, 1 in B = 2.
    _task(a, total_float=3)
    _task(b, total_float=0)
    _task(a, total_float=20)  # not at risk
    # risk_score: A 12+4=16, B 25, resolved excluded = 41.
    _risk(a, 3, 4)
    _risk(a, 2, 2)
    _risk(b, 5, 5)
    _risk(b, 9, 9, status=RiskStatus.RESOLVED)  # excluded

    _configure(
        program,
        [
            RollupKpi.CRITICAL_TASKS.value,
            RollupKpi.AT_RISK_TASKS.value,
            RollupKpi.RISK_SCORE.value,
        ],
        policy,
    )
    kpis = _client(member).get(_url(program)).data["kpis"]
    assert kpis["critical_tasks"]["value"] == 3
    assert kpis["at_risk_tasks"]["value"] == 2
    assert kpis["risk_score"]["value"] == 41


# ---------------------------------------------------------------------------
# Health KPI — policy-governed
# ---------------------------------------------------------------------------


def _make_critical_project(program: Program, calendar: Calendar, name: str) -> Project:
    """A project whose SPI proxy is 0.0 → schedule_health 'critical'.

    4 tasks due-by-today per baseline, none complete → SPI 0.
    """
    p = _project(program, calendar, name)
    tasks = [_task(p, early_finish=TODAY) for _ in range(4)]
    _baseline(p, {t: TODAY for t in tasks})
    return p


def _make_on_track_project(program: Program, calendar: Calendar, name: str) -> Project:
    """A project whose SPI proxy is 1.0 → schedule_health 'on_track'.

    2 tasks due-by-today per baseline, both complete → SPI 1.0.
    """
    p = _project(program, calendar, name)
    tasks = [
        _task(p, early_finish=TODAY, status=TaskStatus.COMPLETE, actual_finish=TODAY)
        for _ in range(2)
    ]
    _baseline(p, {t: TODAY for t in tasks})
    return p


@pytest.mark.django_db
def test_schedule_health_worst_takes_the_critical_project(
    member: object, program: Program, calendar: Calendar
) -> None:
    _make_critical_project(program, calendar, "A")
    _make_on_track_project(program, calendar, "B")
    _configure(program, [RollupKpi.SCHEDULE_HEALTH.value], AggregationPolicy.WORST.value)
    data = _client(member).get(_url(program)).data
    assert data["kpis"]["schedule_health"]["value"] == "critical"
    assert data["program_health"] == "critical"


@pytest.mark.django_db
def test_schedule_health_average_blends_to_at_risk(
    member: object, program: Program, calendar: Calendar
) -> None:
    _make_critical_project(program, calendar, "A")  # ordinal 0
    _make_on_track_project(program, calendar, "B")  # ordinal 2
    _configure(program, [RollupKpi.SCHEDULE_HEALTH.value], AggregationPolicy.AVERAGE.value)
    data = _client(member).get(_url(program)).data
    # round((0 + 2) / 2) = 1 → at_risk
    assert data["kpis"]["schedule_health"]["value"] == "at_risk"


@pytest.mark.django_db
def test_milestone_health_critical_when_milestone_overdue(
    member: object, program: Program, calendar: Calendar
) -> None:
    p = _project(program, calendar, "A")
    _task(
        p,
        is_milestone=True,
        early_finish=TODAY - datetime.timedelta(days=3),
        status=TaskStatus.IN_PROGRESS,
    )
    _configure(program, [RollupKpi.MILESTONE_HEALTH.value], AggregationPolicy.WORST.value)
    data = _client(member).get(_url(program)).data
    assert data["kpis"]["milestone_health"]["value"] == "critical"


# ---------------------------------------------------------------------------
# Variance KPI — policy-governed
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_baseline_variance_worst_vs_average(
    member: object, program: Program, calendar: Calendar
) -> None:
    a = _project(program, calendar, "A")
    ta = _task(a, early_finish=TODAY + datetime.timedelta(days=10))
    _baseline(a, {ta: TODAY})  # +10 days drift
    b = _project(program, calendar, "B")
    tb = _task(b, early_finish=TODAY + datetime.timedelta(days=2))
    _baseline(b, {tb: TODAY})  # +2 days drift

    _configure(program, [RollupKpi.BASELINE_VARIANCE.value], AggregationPolicy.WORST.value)
    worst = _client(member).get(_url(program)).data["kpis"]["baseline_variance"]
    assert worst["value"] == 10.0
    assert worst["unit"] == "calendar_days"

    _configure(program, [RollupKpi.BASELINE_VARIANCE.value], AggregationPolicy.AVERAGE.value)
    avg = _client(member).get(_url(program)).data["kpis"]["baseline_variance"]
    assert avg["value"] == 6.0  # (10 + 2) / 2


@pytest.mark.django_db
def test_schedule_variance_from_completed_work(
    member: object, program: Program, calendar: Calendar
) -> None:
    p = _project(program, calendar, "A")
    # Two completed tasks, finished 4 and 6 days after baseline → mean +5.
    t1 = _task(p, status=TaskStatus.COMPLETE, actual_finish=TODAY + datetime.timedelta(days=4))
    t2 = _task(p, status=TaskStatus.COMPLETE, actual_finish=TODAY + datetime.timedelta(days=6))
    _baseline(p, {t1: TODAY, t2: TODAY})
    _configure(program, [RollupKpi.SCHEDULE_VARIANCE.value], AggregationPolicy.AVERAGE.value)
    data = _client(member).get(_url(program)).data
    assert data["kpis"]["schedule_variance"]["value"] == 5.0


# ---------------------------------------------------------------------------
# weighted_by_budget fallback
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_weighted_by_budget_falls_back_to_average(
    member: object, program: Program, calendar: Calendar
) -> None:
    a = _project(program, calendar, "A")
    ta = _task(a, early_finish=TODAY + datetime.timedelta(days=10))
    _baseline(a, {ta: TODAY})
    b = _project(program, calendar, "B")
    tb = _task(b, early_finish=TODAY + datetime.timedelta(days=2))
    _baseline(b, {tb: TODAY})

    _configure(
        program, [RollupKpi.BASELINE_VARIANCE.value], AggregationPolicy.WEIGHTED_BY_BUDGET.value
    )
    data = _client(member).get(_url(program)).data
    # Policy can't be honored (no budget) → reported as-is but flagged, value
    # computed via the AVERAGE fallback.
    assert data["aggregation_policy"] == AggregationPolicy.WEIGHTED_BY_BUDGET.value
    assert data["policy_available"] is False
    assert data["kpis"]["baseline_variance"]["value"] == 6.0  # average fallback
