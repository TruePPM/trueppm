"""Cost model: actual cost, EVM derivations, rollup wiring (ADR-1324, #754, #3426).

Every expected number below is computed by hand in the comment beside it, not by
calling the code under test — the point is to pin the formula, not echo it.
"""

from __future__ import annotations

import datetime
import uuid
from decimal import Decimal
from typing import Any

import pytest
from django.utils import timezone

from tests.apps.projects import cost_helpers as h
from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.cost import project_cost_facts, project_percent_complete
from trueppm_api.apps.projects.models import (
    AggregationPolicy,
    Baseline,
    BaselineTask,
    Methodology,
    Program,
    Project,
    RollupKpi,
    Task,
)
from trueppm_api.apps.projects.program_rollup import compute_program_rollup
from trueppm_api.apps.timetracking.models import ActiveTimer
from trueppm_api.apps.workspace.models import AuditEvent, AuditEventType

TODAY = datetime.date.today()


@pytest.fixture
def scenario(db: object) -> dict[str, Any]:
    """BAC 10,000; tasks at 50/100/0 % → mean 50 % → EV 5,000.

    Alice @ 100.00/h logs 600 + 90 min = 11.5 h → 1,150.00.
    Bob   @  80.50/h logs 45 min = 0.75 h → 60.375 → 60.38 (half-up).
    AC = 1,210.38. CV = 5,000 − 1,210.38 = 3,789.62. Utilization = 0.121038 → 0.121.
    """
    alice, bob = h.user("alice"), h.user("bob")
    p = h.project("Alpha", budget="10000.00")
    t1, t2, t3 = h.task(p, "T1", 50), h.task(p, "T2", 100), h.task(p, "T3", 0)
    ra = h.resource("Alice", alice, "100.00")
    rb = h.resource("Bob", bob, "80.50")
    h.log(t1, alice, 600)
    h.log(t2, alice, 90)
    h.log(t3, bob, 45)
    return {"p": p, "alice": alice, "bob": bob, "ra": ra, "rb": rb, "t1": t1, "t3": t3}


# ---------------------------------------------------------------------------
# Actual cost (time × rate)
# ---------------------------------------------------------------------------


def test_actual_cost_is_hours_times_current_rate(scenario: dict[str, Any]) -> None:
    cost = project_cost_facts([scenario["p"].pk])[scenario["p"].pk]
    assert cost.actual == Decimal("1210.38")
    assert {ln.name: ln.cost for ln in cost.lines} == {
        "Alice": Decimal("1150.00"),
        "Bob": Decimal("60.38"),
    }
    # Lines add up to the total exactly (each is rounded once, then summed).
    assert sum(ln.cost for ln in cost.lines if ln.cost is not None) == cost.actual
    assert cost.cost_computable is True
    assert cost.missing_rate_count == 0


def test_pto_other_project_deleted_and_running_time_are_excluded(
    scenario: dict[str, Any],
) -> None:
    """Only non-deleted entries on THIS project's tasks are cost (ADR-1324 §2).

    OSS has no PTO time code: time off is a calendar exception and never a time
    entry, and time booked anywhere else (another project) is that project's cost.
    """
    alice = scenario["alice"]
    other = h.project("Other")
    h.log(h.task(other, "Elsewhere"), alice, 480)  # non-project time for Alpha
    deleted = h.log(scenario["t1"], alice, 300)
    deleted.soft_delete(actor=alice)
    ActiveTimer.objects.create(user=alice, task=scenario["t1"], started_at=timezone.now())

    cost = project_cost_facts([scenario["p"].pk])[scenario["p"].pk]
    assert cost.actual == Decimal("1210.38")  # unchanged
    assert cost.logged_minutes == 600 + 90 + 45


def test_time_on_a_soft_deleted_task_still_counts(scenario: dict[str, Any]) -> None:
    """The money was spent; EV already drops the abandoned task's value."""
    scenario["t1"].soft_delete()
    cost = project_cost_facts([scenario["p"].pk])[scenario["p"].pk]
    assert cost.actual == Decimal("1210.38")


def test_unrated_resource_and_unlinked_user_block_cost_computable(
    scenario: dict[str, Any],
) -> None:
    carol = h.user("carol")
    h.resource("Carol", carol, None)  # rated? no
    dave = h.user("dave")  # has no Resource at all
    p = scenario["p"]
    h.member(p, carol)
    h.log(scenario["t3"], carol, 60)
    h.log(scenario["t3"], dave, 120)

    cost = project_cost_facts([p.pk])[p.pk]
    # Priced part unchanged; Carol's and Dave's hours are unpriced.
    assert cost.actual == Decimal("1210.38")
    assert cost.unavailable_reason() == "missing_rates"
    assert cost.cost_computable is False
    assert cost.missing_rate_count == 2
    assert cost.logged_minutes - cost.priced_minutes == 180
    assert cost.cost_variance is None
    assert cost.budget_utilization is None


def test_assigned_person_without_rate_counts_but_non_human_does_not(
    scenario: dict[str, Any],
) -> None:
    p = scenario["p"]
    erin = h.user("erin")
    h.assign(scenario["t3"], h.resource("Erin", erin, None))  # a person, unrated
    h.assign(scenario["t3"], h.resource("Crane", None, None))  # equipment, unrated
    cost = project_cost_facts([p.pk])[p.pk]
    assert cost.missing_rate_count == 1
    assert [m.name for m in cost.missing] == ["Erin"]


def test_user_with_two_resources_prefers_the_rostered_one(scenario: dict[str, Any]) -> None:
    from trueppm_api.apps.resources.models import ProjectResource

    p, alice = scenario["p"], scenario["alice"]
    contractor = h.resource("Alice (contract)", alice, "200.00")
    ProjectResource.objects.create(project=p, resource=contractor)
    cost = project_cost_facts([p.pk])[p.pk]
    # 690 min × 200 / 60 = 2,300.00; Bob 60.38 → 2,360.38.
    assert cost.actual == Decimal("2360.38")


def test_deactivated_resource_still_prices_its_history(scenario: dict[str, Any]) -> None:
    scenario["rb"].soft_delete()
    cost = project_cost_facts([scenario["p"].pk])[scenario["p"].pk]
    assert cost.actual == Decimal("1210.38")


def test_zero_rate_is_a_real_rate(db: object) -> None:
    vol = h.user("vol")
    p = h.project("Charity", budget="100.00")
    h.resource("Volunteer", vol, "0.00")
    h.log(h.task(p), vol, 600)
    cost = project_cost_facts([p.pk])[p.pk]
    assert cost.cost_computable is True
    assert cost.actual == Decimal("0.00")


# ---------------------------------------------------------------------------
# EVM derivations
# ---------------------------------------------------------------------------


def test_evm_derivations_match_hand_computation(scenario: dict[str, Any]) -> None:
    cost = project_cost_facts([scenario["p"].pk])[scenario["p"].pk]
    assert cost.percent_complete == Decimal("50.00")
    assert cost.earned_value == Decimal("5000.00")
    assert cost.cost_variance == Decimal("3789.62")
    assert cost.budget_utilization == 0.121


def test_percent_complete_is_the_project_lists_definition(scenario: dict[str, Any]) -> None:
    """EV reuses the existing project % complete verbatim (#754 decision 2026-11-05)."""
    from django.db.models import Avg, Q

    p = scenario["p"]
    listed = (
        Project.objects.filter(pk=p.pk)
        .annotate(pc=Avg("tasks__percent_complete", filter=Q(tasks__is_deleted=False)))
        .get()
        .pc
    )
    assert project_percent_complete([p.pk])[p.pk] == listed


def test_no_budget_reports_no_budget(scenario: dict[str, Any]) -> None:
    p = scenario["p"]
    Project.objects.filter(pk=p.pk).update(budget=None)
    cost = project_cost_facts([p.pk])[p.pk]
    assert cost.unavailable_reason() == "no_budget"
    assert cost.earned_value is None
    assert cost.actual == Decimal("1210.38")  # AC is computable without a budget
    Project.objects.filter(pk=p.pk).update(budget=Decimal("0"))
    assert project_cost_facts([p.pk])[p.pk].unavailable_reason() == "no_budget"


def test_overrun_gives_negative_cv(db: object) -> None:
    pm = h.user("pm")
    p = h.project("Over", budget="1000.00")
    t = h.task(p, percent=10)  # EV = 100.00
    h.resource("PM", pm, "150.00")
    h.log(t, pm, 240)  # 4 h × 150 = 600.00
    cost = project_cost_facts([p.pk])[p.pk]
    assert cost.cost_variance == Decimal("-500.00")
    assert cost.budget_utilization == 0.6


def test_cost_facts_query_count_is_independent_of_project_count(
    scenario: dict[str, Any], django_assert_max_num_queries: Any
) -> None:
    """Fixed six queries for any N — no per-project loop (perf-check)."""
    pids = [scenario["p"].pk]
    for i in range(4):
        p = h.project(f"Extra{i}", budget="10.00")
        u = h.user(f"x{i}")
        h.resource(f"X{i}", u, "1.00")
        h.log(h.task(p), u, 60)
        pids.append(p.pk)
    with django_assert_max_num_queries(6):
        out = project_cost_facts(pids)
    assert len(out) == 5


# ---------------------------------------------------------------------------
# Project cost endpoint
# ---------------------------------------------------------------------------


def test_cost_endpoint_payload(scenario: dict[str, Any]) -> None:
    p = scenario["p"]
    owner = h.user("owner")
    h.member(p, owner, Role.OWNER)
    resp = h.client(owner).get(f"/api/v1/projects/{p.pk}/cost/")
    assert resp.status_code == 200, resp.data
    d = resp.json()
    assert d["currency"] == "USD"
    assert d["budget"] == "10000.00"
    assert d["actual"] == "1210.38"
    assert d["earned_value"] == "5000.00"
    assert d["cost_variance"] == {"available": True, "value": "3789.62"}
    assert d["budget_utilization"] == {"available": True, "value": 0.121}
    assert d["cost_computable"] is True
    assert {ln["name"]: (ln["rate"], ln["cost"]) for ln in d["lines"]} == {
        "Alice": ("100.00", "1150.00"),
        "Bob": ("80.50", "60.38"),
    }
    assert "cost_variance" in d["definitions"]


# ---------------------------------------------------------------------------
# Rate re-cost: preview equals save
# ---------------------------------------------------------------------------


def _rate(u: Any, rid: Any, rate: str | None, dry_run: bool) -> Any:
    return h.client(u).post(
        f"/api/v1/resources/{rid}/rate/",
        {"cost_rate": rate, "dry_run": dry_run},
        format="json",
    )


def test_rate_preview_equals_saved_recost(scenario: dict[str, Any]) -> None:
    admin = h.workspace_admin()
    ra = scenario["ra"]
    preview = _rate(admin, ra.pk, "120.00", True)
    assert preview.status_code == 200, preview.data
    ra.refresh_from_db()
    assert ra.cost_rate == Decimal("100.00")  # dry run wrote nothing
    assert not AuditEvent.objects.filter(event_type=AuditEventType.RESOURCE_RATE_CHANGED).exists()

    saved = _rate(admin, ra.pk, "120.00", False)
    assert saved.status_code == 200, saved.data
    ra.refresh_from_db()
    assert ra.cost_rate == Decimal("120.00")

    def comparable(r: Any) -> dict[str, Any]:
        d = dict(r.json())
        d.pop("as_of")
        d.pop("dry_run")
        return d

    assert comparable(preview) == comparable(saved)
    # Hand check: 11.5 h × (120 − 100) = +230.00 on Alpha.
    (row,) = saved.json()["projects"]
    assert row["actual_before"] == "1210.38"
    assert row["actual_after"] == "1440.38"
    assert row["delta"] == "230.00"
    assert row["hours"] == "11.50"
    # The saved rate is what every other surface now reads.
    assert project_cost_facts([scenario["p"].pk])[scenario["p"].pk].actual == Decimal("1440.38")
    event = AuditEvent.objects.get(event_type=AuditEventType.RESOURCE_RATE_CHANGED)
    assert event.metadata["cost_rate_before"] == "100.00"
    assert event.metadata["cost_rate_after"] == "120.00"


def test_clearing_a_rate_flips_cost_computable(scenario: dict[str, Any]) -> None:
    admin = h.workspace_admin()
    resp = _rate(admin, scenario["rb"].pk, None, True)
    (row,) = resp.json()["projects"]
    assert row["cost_computable_before"] is True
    assert row["cost_computable_after"] is False


def test_unchanged_rate_writes_no_audit_row(scenario: dict[str, Any]) -> None:
    admin = h.workspace_admin()
    assert _rate(admin, scenario["ra"].pk, "100.00", False).status_code == 200
    assert not AuditEvent.objects.filter(event_type=AuditEventType.RESOURCE_RATE_CHANGED).exists()


# ---------------------------------------------------------------------------
# Program rollup: availability flips, totals, weighted_by_budget (#3426)
# ---------------------------------------------------------------------------


@pytest.fixture
def program(db: object) -> tuple[Program, Any]:
    owner = h.user("powner")
    prog = create_program(
        name="Prog", description="", methodology=Methodology.HYBRID, created_by=owner
    )
    return prog, owner


def _configure(prog: Program, kpis: list[str], policy: str) -> None:
    prog.rollup_enabled_kpis = kpis
    prog.rollup_aggregation_policy = policy
    prog.save(update_fields=["rollup_enabled_kpis", "rollup_aggregation_policy"])


_COST = [RollupKpi.COST_VARIANCE.value, RollupKpi.BUDGET_UTILIZATION.value]


def _pm_of_all(prog: Program, who: Any = None) -> Any:
    """A user who is project Admin on every project in ``prog`` (the cost gate's floor)."""
    who = who or h.user(f"pm-{uuid.uuid4().hex[:12]}")
    for p in Project.objects.filter(program=prog):
        ProjectMembership.objects.update_or_create(
            project=p, user=who, defaults={"role": Role.ADMIN}
        )
    return who


def test_rollup_cost_kpis_flip_from_no_budget_to_missing_rates_to_available(
    program: tuple[Program, Any],
) -> None:
    prog, _ = program
    _configure(prog, _COST, AggregationPolicy.WORST.value)
    u = h.user("worker")
    p = h.project("A", program=prog)
    r = h.resource("Worker", u, None)
    h.log(h.task(p, percent=50), u, 120)

    kpis = compute_program_rollup(prog, cost_viewer=_pm_of_all(prog))["kpis"]
    assert kpis["cost_variance"]["reason"] == "no_budget"
    assert kpis["cost_variance"]["projects_without_budget"] == 1
    assert kpis["budget_utilization"]["reason"] == "no_budget"

    Project.objects.filter(pk=p.pk).update(budget=Decimal("1000.00"))
    kpis = compute_program_rollup(prog, cost_viewer=_pm_of_all(prog))["kpis"]
    assert kpis["cost_variance"]["reason"] == "missing_rates"
    assert kpis["cost_variance"]["missing_rate_count"] == 1
    assert kpis["budget_utilization"]["reason"] == "missing_rates"

    r.cost_rate = Decimal("50.00")
    r.save()
    kpis = compute_program_rollup(prog, cost_viewer=_pm_of_all(prog))["kpis"]
    # EV = 1000 × 50 % = 500; AC = 2 h × 50 = 100 → CV 400; util 0.1.
    assert kpis["cost_variance"]["available"] is True
    assert kpis["cost_variance"]["value"] == "400.00"
    assert kpis["cost_variance"]["unit"] == "USD"
    assert kpis["budget_utilization"]["value"] == 0.1


def test_rollup_cost_is_program_total_not_mean(program: tuple[Program, Any]) -> None:
    prog, _ = program
    _configure(prog, _COST, AggregationPolicy.AVERAGE.value)
    for name, budget, minutes in (("Small", "100.00", 60), ("Big", "10000.00", 60)):
        u = h.user(f"u{name}")
        h.resource(name, u, "50.00")
        p = h.project(name, budget=budget, program=prog)
        h.log(h.task(p, percent=0), u, minutes)
    kpis = compute_program_rollup(prog, cost_viewer=_pm_of_all(prog))["kpis"]
    # ΣAC = 100, ΣBAC = 10,100 → 0.0099 (a mean of 0.5 and 0.005 would be 0.2525).
    assert kpis["budget_utilization"]["value"] == 0.0099
    # Σ CV = (0 − 50) + (0 − 50) = −100.
    assert kpis["cost_variance"]["value"] == "-100.00"


def test_rollup_cost_restricted_below_program_admin(program: tuple[Program, Any]) -> None:
    prog, owner = program
    viewer = h.user("pviewer")
    ProgramMembership.objects.create(program=prog, user=viewer, role=Role.VIEWER)
    _configure(prog, _COST, AggregationPolicy.WORST.value)
    h.project("A", budget="1.00", program=prog)
    _pm_of_all(prog, owner)
    url = f"/api/v1/programs/{prog.pk}/rollup/"
    restricted = h.client(viewer).get(url).json()["kpis"]
    assert restricted["cost_variance"] == {"available": False, "reason": "cost_restricted"}
    assert h.client(owner).get(url).json()["kpis"]["cost_variance"]["available"] is True


def _variance_projects(prog: Program, budgets: tuple[str | None, str | None]) -> None:
    """Two projects with baseline_variance 10 and 2 days (see test_program_rollup)."""
    for name, slip, budget in (("A", 10, budgets[0]), ("B", 2, budgets[1])):
        p = h.project(name, budget=budget, program=prog)
        t = Task.objects.create(
            project=p, name="T", duration=1, early_finish=TODAY + datetime.timedelta(days=slip)
        )
        b = Baseline.objects.create(project=p, name="B1", is_active=True, has_cpm_dates=True)
        BaselineTask.objects.create(
            baseline=b, task_id=t.pk, task_name=t.name, finish=TODAY, duration=1
        )


def test_weighted_by_budget_weights_by_project_budget(program: tuple[Program, Any]) -> None:
    prog, _ = program
    _variance_projects(prog, ("1000.00", "3000.00"))
    _configure(
        prog, [RollupKpi.BASELINE_VARIANCE.value], AggregationPolicy.WEIGHTED_BY_BUDGET.value
    )
    data = compute_program_rollup(prog, cost_viewer=_pm_of_all(prog))
    assert data["policy_available"] is True
    assert data["policy_unavailable_reason"] is None
    a = data["kpis"]["baseline_variance"]["value"]
    _configure(prog, [RollupKpi.BASELINE_VARIANCE.value], AggregationPolicy.AVERAGE.value)
    avg = compute_program_rollup(prog, cost_viewer=_pm_of_all(prog))["kpis"]["baseline_variance"][
        "value"
    ]
    # Hand: average = (10 + 2) / 2; weighted = (10·1000 + 2·3000) / 4000.
    assert avg == pytest.approx((10 + 2) / 2, abs=0.1)
    assert a == pytest.approx((10 * 1000 + 2 * 3000) / 4000, abs=0.1)
    assert a != avg


def test_weighted_by_budget_falls_back_when_any_project_lacks_budget(
    program: tuple[Program, Any],
) -> None:
    prog, _ = program
    _variance_projects(prog, ("1000.00", None))
    _configure(
        prog, [RollupKpi.BASELINE_VARIANCE.value], AggregationPolicy.WEIGHTED_BY_BUDGET.value
    )
    data = compute_program_rollup(prog, cost_viewer=_pm_of_all(prog))
    assert data["policy_available"] is False
    assert data["policy_unavailable_reason"] == "no_budget"


def test_no_rollup_control_is_a_dead_control(program: tuple[Program, Any]) -> None:
    """#3426: each of the three controls, when enabled, changes what the rollup says.

    A dead control is one a PM can enable and that can never compute. With budgets
    and rates in place, both cost KPIs must yield a value and the budget policy must
    be honored and move the result away from the plain average.
    """
    from trueppm_api.apps.projects.models import Program as ProgramModel
    from trueppm_api.apps.projects.program_rollup import DEFERRED_KPI_REASONS
    from trueppm_api.apps.projects.serializers import ProgramRollupConfigSerializer

    prog, _ = program
    _variance_projects(prog, ("1000.00", "3000.00"))
    u = h.user("logger")
    h.resource("Logger", u, "10.00")
    h.log(Task.objects.filter(project__program=prog).first(), u, 60)  # type: ignore[arg-type]

    assert RollupKpi.COST_VARIANCE.value not in DEFERRED_KPI_REASONS
    assert RollupKpi.BUDGET_UTILIZATION.value not in DEFERRED_KPI_REASONS
    advertised = ProgramRollupConfigSerializer(ProgramModel.objects.get(pk=prog.pk)).data
    assert set(advertised["unavailable_kpis"]).isdisjoint(_COST)

    _configure(prog, _COST, AggregationPolicy.WORST.value)
    kpis = compute_program_rollup(prog, cost_viewer=_pm_of_all(prog))["kpis"]
    for kpi in _COST:
        assert kpis[kpi]["available"] is True, kpis[kpi]
        assert kpis[kpi]["value"] is not None

    _configure(
        prog, [RollupKpi.BASELINE_VARIANCE.value], AggregationPolicy.WEIGHTED_BY_BUDGET.value
    )
    weighted = compute_program_rollup(prog, cost_viewer=_pm_of_all(prog))
    _configure(prog, [RollupKpi.BASELINE_VARIANCE.value], AggregationPolicy.AVERAGE.value)
    plain = compute_program_rollup(prog, cost_viewer=_pm_of_all(prog))
    assert weighted["policy_available"] is True
    assert weighted["kpis"] != plain["kpis"]


def test_program_admin_needs_project_admin_on_every_project(
    program: tuple[Program, Any],
) -> None:
    """Program roles do not cascade to projects (ADR-1324 §4, completeness gap 1).

    A program Admin who is only a Viewer on one contributing project would otherwise
    receive that project's CV and utilization — and for a one-project program,
    BAC = CV / (pc − util) recovers the budget the Viewer role is denied.
    """
    prog, owner = program
    _configure(prog, _COST, AggregationPolicy.WORST.value)
    a = h.project("A", budget="1000.00", program=prog)
    b = h.project("B", budget="2000.00", program=prog)
    ProjectMembership.objects.create(project=a, user=owner, role=Role.ADMIN)
    ProjectMembership.objects.create(project=b, user=owner, role=Role.VIEWER)
    url = f"/api/v1/programs/{prog.pk}/rollup/"

    kpis = h.client(owner).get(url).json()["kpis"]
    assert kpis["cost_variance"] == {"available": False, "reason": "cost_restricted"}
    assert kpis["budget_utilization"] == {"available": False, "reason": "cost_restricted"}

    ProjectMembership.objects.filter(project=b, user=owner).update(role=Role.ADMIN)
    assert h.client(owner).get(url).json()["kpis"]["cost_variance"]["available"] is True


def test_unlinked_logger_is_priced_by_a_resource_with_their_email(db: object) -> None:
    """The remedy for "has no resource": create one with their email and rate it.

    ``Resource.user`` has no API write path, so the cost model falls back to an
    unlinked resource whose email matches the logger (ADR-1324 §2).
    """
    from trueppm_api.apps.projects.cost import project_cost_facts

    pat = h.user("pat")
    pat.email = "Pat@Example.com"
    pat.save()
    p = h.project("Email", budget="100.00")
    h.log(h.task(p), pat, 120)
    before = project_cost_facts([p.pk])[p.pk]
    assert before.missing_rate_count == 1
    assert before.missing[0].resource_id is None

    from trueppm_api.apps.resources.models import Resource

    Resource.objects.create(name="Pat", email="pat@example.com", cost_rate=Decimal("30.00"))
    after = project_cost_facts([p.pk])[p.pk]
    assert after.cost_computable is True
    assert after.actual == Decimal("60.00")  # 2 h × 30
    # A resource already bound to someone else is never borrowed.
    other = h.user("other")
    Resource.objects.filter(email="pat@example.com").update(user=other)
    assert project_cost_facts([p.pk])[p.pk].cost_computable is False


def test_budget_weighting_is_not_an_oracle_for_a_caller_below_the_cost_floor(
    program: tuple[Program, Any],
) -> None:
    """Round-2 blocker: a budget-weighted mean leaks the ratio of budgets.

    v = (v1·b1 + v2·b2)/(b1 + b2) gives b1/b2 = (v − v2)/(v1 − v). A program Admin who
    is PM of A (so knows b1) and only a Viewer of B (so sees B's variance) would
    recover b2. Below the cost floor the policy must fall back to the plain average,
    with a reason that is the same whether or not any budget is set.
    """
    prog, owner = program
    _variance_projects(prog, ("1000.00", "3000.00"))
    a, b = Project.objects.filter(program=prog).order_by("name")
    ProjectMembership.objects.create(project=a, user=owner, role=Role.ADMIN)
    ProjectMembership.objects.create(project=b, user=owner, role=Role.VIEWER)
    _configure(
        prog, [RollupKpi.BASELINE_VARIANCE.value], AggregationPolicy.WEIGHTED_BY_BUDGET.value
    )
    url = f"/api/v1/programs/{prog.pk}/rollup/"

    data = h.client(owner).get(url).json()
    assert data["kpis"]["baseline_variance"]["value"] == pytest.approx((10 + 2) / 2, abs=0.1)
    assert data["policy_available"] is False
    assert data["policy_unavailable_reason"] == "cost_restricted"
    assert "budget" not in data["policy_unavailable_reason"]

    # Same answer when a budget is missing — the reason does not reveal it either.
    Project.objects.filter(pk=b.pk).update(budget=None)
    again = h.client(owner).get(url).json()
    assert again["policy_unavailable_reason"] == "cost_restricted"


def test_spent_project_with_no_live_tasks_shows_its_overrun(db: object) -> None:
    """Round-2 gap 1: no live tasks earns 0, so CV = −AC rather than a null value."""
    from trueppm_api.apps.projects.cost import program_cost_kpis

    worker = h.user("abandoner")
    h.resource("Abandoner", worker, "100.00")
    p = h.project("Abandoned", budget="1000.00")
    t = h.task(p, percent=40)
    h.log(t, worker, 600)  # 10 h × 100 = 1,000.00
    t.soft_delete()

    cost = project_cost_facts([p.pk])[p.pk]
    assert cost.actual == Decimal("1000.00")
    assert cost.percent_complete == Decimal("0.00")
    assert cost.earned_value == Decimal("0.00")
    assert cost.cost_variance == Decimal("-1000.00")
    assert cost.budget_utilization == 1.0
    kpis = program_cost_kpis([cost], "USD")
    assert kpis["cost_variance"]["value"] == "-1000.00"  # not dropped as 0


def test_ambiguous_email_matches_nobody(db: object) -> None:
    """Round-2 gap 2: two accounts sharing an email make the fallback ambiguous."""
    from trueppm_api.apps.resources.models import Resource

    logger, twin = h.user("logger1"), h.user("twin1")
    for u in (logger, twin):
        u.email = "shared@example.com"
        u.save()
    p = h.project("Shared", budget="100.00")
    h.log(h.task(p), logger, 60)
    shared = Resource.objects.create(
        name="Shared", email="shared@example.com", cost_rate=Decimal("9.00")
    )

    cost = project_cost_facts([p.pk])[p.pk]
    assert cost.cost_computable is False  # stays visible as missing
    assert cost.missing[0].resource_id is None
    # The rate preview applies the same rule, so preview and save agree.
    from trueppm_api.apps.resources.services import _rate_scope_project_ids

    assert _rate_scope_project_ids(shared) == []
    twin.email = "other@example.com"
    twin.save()
    assert project_cost_facts([p.pk])[p.pk].cost_computable is True
    assert _rate_scope_project_ids(shared) == [p.pk]


def test_digest_uses_the_plain_average_for_a_budget_weighted_program(
    program: tuple[Program, Any],
) -> None:
    """The weekly digest has no cost viewer, so budget weighting never applies to it.

    A: one overdue open critical-path task → critical project health band (ordinal
    0). B: one task done on time → on_track (ordinal 2). Average = round(1) →
    at_risk. Weighted by budgets 100 and 9,900 = round(1.98) → on_track. The
    digest must report the average (at risk), while a PM of every project sees the
    weighted band on the overview.
    """
    from trueppm_api.apps.notifications.digests import build_program_health_digest
    from trueppm_api.apps.projects.models import TaskStatus

    prog, owner = program
    yesterday = TODAY - datetime.timedelta(days=1)
    a = h.project("Alpha", budget="100.00", program=prog)
    b = h.project("Beta", budget="9900.00", program=prog)
    Task.objects.create(
        project=a, name="late", duration=1, early_finish=yesterday, is_critical=True
    )
    Task.objects.create(
        project=b,
        name="done",
        duration=1,
        early_finish=yesterday,
        status=TaskStatus.COMPLETE,
        actual_finish=yesterday,
    )
    _configure(prog, [RollupKpi.SCHEDULE_HEALTH.value], AggregationPolicy.WEIGHTED_BY_BUDGET.value)

    assert (
        compute_program_rollup(prog, cost_viewer=_pm_of_all(prog))["program_health"] == "on_track"
    )
    assert compute_program_rollup(prog)["program_health"] == "at_risk"
    _, body = build_program_health_digest(owner, timezone.now())
    assert "Prog: At risk" in body
