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
from trueppm_api.apps.projects.cost import project_cost_facts
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


def _leaf(p: Project, path: str, duration: int, percent: float, **kw: Any) -> Task:
    return Task.objects.create(
        project=p,
        name=f"T{path}",
        wbs_path=path,
        duration=duration,
        percent_complete=percent,
        **kw,
    )


def test_ev_weights_percent_complete_by_duration(db: object) -> None:
    """ADR-1447: a 100-day task counts 100x a 1-day task.

    1 day at 100 % + 100 days at 0 %: Σ(p×d) = 100, Σd = 101 → 0.990099 % → 0.99 %.
    BAC 10,000 × 0.99 / 100 = 99.00. The unweighted mean would say 50 % → 5,000.
    Flip the percents: Σ(p×d) = 10,000 → 99.0099 % → 99.01 % → EV 9,901.00.
    """
    p = h.project("Weighted", budget="10000.00")
    short, long_ = _leaf(p, "1", 1, 100), _leaf(p, "2", 100, 0)
    cost = project_cost_facts([p.pk])[p.pk]
    assert cost.percent_complete == Decimal("0.99")
    assert cost.earned_value == Decimal("99.00")
    Task.objects.filter(pk=short.pk).update(percent_complete=0)
    Task.objects.filter(pk=long_.pk).update(percent_complete=100)
    cost = project_cost_facts([p.pk])[p.pk]
    assert cost.percent_complete == Decimal("99.01")
    assert cost.earned_value == Decimal("9901.00")


def test_ev_excludes_phases_subtasks_and_non_committed_work(db: object) -> None:
    """Only leaf work counts. Each excluded row would move EV if it were counted.

    Leaves 1.1 (10 d, stored 50 %, read as its 100 % subtask rollup) and 6 (10 d at
    0 %) → Σ(p×d) = 1,000, Σd = 20 → 50 %, EV = 1,000 × 0.5 = 500.00. Left out: the
    phase (1, 40 d at 0 % → would read 16.67 %), the subtask as a row of its own
    (1.1.1, 5 d at 100 % → 60 %), a backlog task, a recurring task, an epic and a
    soft-deleted task (each 10 d at 100 % → 66.67 %). The epic and the deleted row
    prove the filter is ``Task.committed``, not just ``is_deleted``.
    """
    from trueppm_api.apps.projects.models import TaskStatus, TaskType

    p = h.project("Leaves", budget="1000.00")
    _leaf(p, "1", 40, 0)  # phase: has a structural child
    _leaf(p, "1.1", 10, 50)
    _leaf(p, "1.1.1", 5, 100, is_subtask=True)
    _leaf(p, "2", 10, 100, status=TaskStatus.BACKLOG)
    _leaf(p, "3", 10, 100, is_recurring=True)
    _leaf(p, "4", 10, 100, type=TaskType.EPIC)
    _leaf(p, "5", 10, 100, is_deleted=True)
    _leaf(p, "6", 10, 0)
    cost = project_cost_facts([p.pk])[p.pk]
    assert cost.percent_complete == Decimal("50.00")
    assert cost.earned_value == Decimal("500.00")


def test_ev_reads_a_parents_subtask_rollup_not_its_stored_percent(db: object) -> None:
    """A leaf with subtasks earns what the task API shows for it, not the stored column.

    Parent 1 is stored at 0 % (nothing writes the rollup back) with two 100 % subtasks;
    the task API serves it at 100 %, so EV must be BAC × 100 % = 1,000.00, not 0.
    """
    p = h.project("Subtask rollup", budget="1000.00")
    parent = _leaf(p, "1", 10, 0)
    _leaf(p, "1.1", 3, 100, is_subtask=True)
    _leaf(p, "1.2", 7, 100, is_subtask=True)
    cost = project_cost_facts([p.pk])[p.pk]
    assert cost.percent_complete == Decimal("100.00")
    assert cost.earned_value == Decimal("1000.00")

    # Same number the task API shows on the parent row.
    owner = h.user("rollup-owner")
    h.member(p, owner, Role.OWNER)
    shown = h.client(owner).get(f"/api/v1/tasks/{parent.pk}/").json()["percent_complete"]
    assert shown == 100.0


def test_a_task_whose_only_children_are_uncommitted_is_still_leaf_work(db: object) -> None:
    """A BACKLOG child does not make its parent a phase for EV (ADR-1447).

    Leaf 1 (10 d at 50 %) with a BACKLOG child 1.1 (10 d at 100 %): 1 is the only
    committed row, so it is leaf work → 50 %. Treating 1 as a phase would leave no
    leaf work at all (no_planned_duration); counting the backlog child would read 100 %.
    """
    from trueppm_api.apps.projects.models import TaskStatus

    p = h.project("Backlog child", budget="1000.00")
    _leaf(p, "1", 10, 50)
    _leaf(p, "1.1", 10, 100, status=TaskStatus.BACKLOG)
    cost = project_cost_facts([p.pk])[p.pk]
    assert cost.percent_complete == Decimal("50.00")
    assert cost.earned_value == Decimal("500.00")


def test_zero_duration_tasks_add_nothing_to_either_sum(db: object) -> None:
    """A milestone plans no work, so it carries no share of the budget (ADR-1447).

    Leaf 5 d at 20 % + milestone 0 d at 100 % → Σ(p×d) = 100, Σd = 5 → 20 %. Were the
    milestone counted as a row (the old unweighted mean) it would read 60 %.
    """
    p = h.project("Milestones", budget="1000.00")
    _leaf(p, "1", 5, 20)
    _leaf(p, "2", 0, 100, is_milestone=True)
    cost = project_cost_facts([p.pk])[p.pk]
    assert cost.percent_complete == Decimal("20.00")
    assert cost.earned_value == Decimal("200.00")


def test_no_planned_duration_makes_ev_not_computable(db: object) -> None:
    """Σ duration = 0 → EV, CV and the forecasts carry no_planned_duration, never 0.

    Utilization (AC / BAC) does not need EV, so it still computes: 2 h × 50 = 100.00
    of 1,000 → 0.1.
    """
    from trueppm_api.apps.projects.cost import cost_provenance, program_cost_kpis

    pm = h.user("ms-pm")
    h.resource("MS PM", pm, "50.00")
    p = h.project("Only milestones", budget="1000.00")
    m = _leaf(p, "1", 0, 100, is_milestone=True)
    h.log(m, pm, 120)
    cost = project_cost_facts([p.pk])[p.pk]
    assert cost.percent_complete is None
    assert cost.earned_value is None
    assert cost.earned_value_reason() == "no_planned_duration"
    assert cost.unavailable_reason() == "no_planned_duration"
    assert cost.cost_variance is None
    assert cost.budget_utilization == 0.1
    for result in (cost.cpi_result(), cost.eac_result(), cost.etc_result(), cost.tcpi_result()):
        assert result == (None, "no_planned_duration")
    figures = cost_provenance(cost)["figures"]
    assert figures["earned_value"] == {"status": "restricted", "reason": "no_planned_duration"}
    assert figures["budget_utilization"] == {"status": "computed"}

    # No budget outranks the missing basis: EV needs a budget first.
    Project.objects.filter(pk=p.pk).update(budget=None)
    assert project_cost_facts([p.pk])[p.pk].earned_value_reason() == "no_budget"
    Project.objects.filter(pk=p.pk).update(budget=Decimal("1000.00"))

    # Program, only this project: a sum over no scheduled project is no total.
    kpis = program_cost_kpis(project_cost_facts([p.pk]).values(), "USD")
    assert kpis["cost_variance"]["available"] is False
    assert kpis["cost_variance"]["reason"] == "no_planned_duration"
    assert kpis["cost_variance"]["projects_without_planned_duration"] == 1
    assert kpis["budget_utilization"]["value"] == 0.1

    # Program with a scheduled project too: the unscheduled one is left out of Σ CV and
    # counted; utilization is still a real total over both. ok: EV = 1,000 × 50 % =
    # 500.00, AC = 0 → CV 500.00 (p's CV is not computable, so it adds nothing).
    ok = h.project("Fine", budget="1000.00")
    _leaf(ok, "1", 4, 50)
    kpis = program_cost_kpis(project_cost_facts([p.pk, ok.pk]).values(), "USD")
    assert kpis["cost_variance"]["available"] is True
    assert kpis["cost_variance"]["value"] == "500.00"
    assert kpis["cost_variance"]["projects_without_planned_duration"] == 1
    assert kpis["budget_utilization"]["value"] == 0.05  # 100 / 2,000


def test_cost_endpoint_serves_null_percent_without_planned_duration(db: object) -> None:
    p = h.project("Empty", budget="500.00")
    owner = h.user("empty-owner")
    h.member(p, owner, Role.OWNER)
    d = h.client(owner).get(f"/api/v1/projects/{p.pk}/cost/").json()
    assert d["percent_complete"] is None
    assert d["earned_value"] is None
    assert d["cost_variance"]["available"] is False
    assert d["cost_variance"]["reason"] == "no_planned_duration"
    assert d["budget_utilization"]["available"] is True
    assert d["budget_utilization"]["value"] == 0.0
    assert "duration" in d["definitions"]["earned_value"]
    assert "not the project list" in d["definitions"]["percent_complete"]


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


def test_forecast_measures_match_hand_computation(scenario: dict[str, Any]) -> None:
    """BAC 10,000, EV 5,000, AC 1,210.38 (scenario docstring), computed by hand:

    CPI  = 5,000 / 1,210.38           = 4.130934 -> 4.1309
    EAC  = BAC / CPI = 10,000 x 1,210.38 / 5,000 = 2,420.76
    ETC  = EAC - AC = 2,420.76 - 1,210.38        = 1,210.38
    VAC  = BAC - EAC = 10,000 - 2,420.76         = 7,579.24
    TCPI = (10,000 - 5,000) / (10,000 - 1,210.38) = 5,000 / 8,789.62 = 0.5689
    """
    cost = project_cost_facts([scenario["p"].pk])[scenario["p"].pk]
    assert cost.cpi_result() == (4.1309, None)
    assert cost.eac_result() == (Decimal("2420.76"), None)
    assert cost.etc_result() == (Decimal("1210.38"), None)
    assert cost.vac_result() == (Decimal("7579.24"), None)
    assert cost.tcpi_result() == (0.5689, None)


def test_forecasts_are_null_with_a_reason_never_zero_or_infinite(db: object) -> None:
    """Every undefined denominator yields ``available: false`` + a reason."""
    alice = h.user("alice")
    h.resource("Alice", alice, "100.00")

    # No time logged: AC = 0, so CPI (and EAC, ETC, VAC) is undefined. TCPI is fine:
    # (1,000 - 500) / (1,000 - 0) = 0.5.
    p = h.project("NoSpend", budget="1000.00")
    h.task(p, "T", 50)
    c = project_cost_facts([p.pk])[p.pk]
    assert c.cpi_result() == (None, "no_actual_cost")
    assert c.eac_result() == (None, "no_actual_cost")
    assert c.etc_result() == (None, "no_actual_cost")
    assert c.vac_result() == (None, "no_actual_cost")
    assert c.tcpi_result() == (0.5, None)

    # Money spent, nothing earned: CPI is a real 0.0, but EAC = BAC / 0 is infinite.
    q = h.project("NoProgress", budget="1000.00")
    h.log(h.task(q, "T", 0), alice, 60)
    c = project_cost_facts([q.pk])[q.pk]
    assert c.cpi_result() == (0.0, None)
    assert c.eac_result() == (None, "no_earned_value")
    assert c.vac_result() == (None, "no_earned_value")

    # AC (1,000) has reached BAC (1,000): TCPI's denominator is 0.
    r = h.project("Spent", budget="1000.00")
    h.log(h.task(r, "T", 50), alice, 600)
    c = project_cost_facts([r.pk])[r.pk]
    assert c.actual == Decimal("1000.00")
    assert c.tcpi_result() == (None, "budget_exhausted")
    assert c.cpi_result() == (0.5, None)  # EV 500 / AC 1,000
    assert c.eac_result() == (Decimal("2000.00"), None)  # 1,000 x 1,000 / 500


def test_forecasts_inherit_no_budget_and_missing_rates(scenario: dict[str, Any]) -> None:
    p = scenario["p"]
    h.log(scenario["t3"], h.user("dave"), 60)  # no resource -> unpriced
    c = project_cost_facts([p.pk])[p.pk]
    for result in (c.cpi_result, c.eac_result, c.etc_result, c.vac_result, c.tcpi_result):
        assert result() == (None, "missing_rates")
    Project.objects.filter(pk=p.pk).update(budget=None)
    c = project_cost_facts([p.pk])[p.pk]
    assert c.eac_result() == (None, "no_budget")


def test_cost_endpoint_forecasts_and_provenance(scenario: dict[str, Any]) -> None:
    p = scenario["p"]
    owner = h.user("owner")
    h.member(p, owner, Role.OWNER)
    d = h.client(owner).get(f"/api/v1/projects/{p.pk}/cost/").json()
    assert d["cpi"] == {"available": True, "value": 4.1309}
    assert d["eac"] == {"available": True, "value": "2420.76"}
    assert d["etc"] == {"available": True, "value": "1210.38"}
    assert d["vac"] == {"available": True, "value": "7579.24"}
    assert d["tcpi"] == {"available": True, "value": 0.5689}
    for key in ("cpi", "eac", "etc", "vac", "tcpi", "provenance"):
        assert key in d["definitions"] or key == "provenance"
    assert "typical" in d["definitions"]["eac"]
    assert "not the cost performance index" in d["definitions"]["budget_utilization"]
    prov = d["provenance"]
    assert prov["computed_by"].endswith("project_cost_facts")
    assert prov["contract_version"] == "1"
    assert prov["as_of"] == d["as_of"]
    assert (
        prov["inputs"]["percent_complete_source"] == "duration_weighted_leaf_task_percent_complete"
    )
    assert prov["inputs"]["rate_source"] == "current_resource_rate"
    assert prov["inputs"]["eac_method"] == "typical_variance"
    assert set(prov["figures"]) == {
        "earned_value",
        "cost_variance",
        "budget_utilization",
        "cpi",
        "eac",
        "etc",
        "vac",
        "tcpi",
    }
    assert all(f == {"status": "computed"} for f in prov["figures"].values())


def test_provenance_marks_a_restricted_figure_not_zero(scenario: dict[str, Any]) -> None:
    p = scenario["p"]
    Project.objects.filter(pk=p.pk).update(budget=None)
    owner = h.user("owner")
    h.member(p, owner, Role.OWNER)
    d = h.client(owner).get(f"/api/v1/projects/{p.pk}/cost/").json()
    assert (d["eac"]["available"], d["eac"]["reason"]) == (False, "no_budget")
    assert d["eac"]["value"] is None
    assert d["provenance"]["figures"]["eac"] == {"status": "restricted", "reason": "no_budget"}
    assert d["provenance"]["figures"]["earned_value"]["status"] == "restricted"


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
    h.task(h.project("A", budget="1.00", program=prog))  # a task: EV has a basis (ADR-1447)
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
    h.task(a), h.task(b)  # EV needs leaf work with a duration (ADR-1447)
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


def test_spent_project_with_no_live_tasks_reports_no_basis_not_zero(db: object) -> None:
    """ADR-1447 supersedes round-2 gap 1: with no leaf work left, EV has no basis.

    The spend is still visible as utilization (1,000 / 1,000 = 1.0); CV, which needs
    EV, says no_planned_duration instead of a CV = −AC computed from an assumed 0 %.
    """
    from trueppm_api.apps.projects.cost import program_cost_kpis

    worker = h.user("abandoner")
    h.resource("Abandoner", worker, "100.00")
    p = h.project("Abandoned", budget="1000.00")
    t = h.task(p, percent=40)
    h.log(t, worker, 600)  # 10 h × 100 = 1,000.00
    t.soft_delete()

    cost = project_cost_facts([p.pk])[p.pk]
    assert cost.actual == Decimal("1000.00")
    assert cost.percent_complete is None
    assert cost.earned_value is None
    assert cost.cost_variance is None
    assert cost.unavailable_reason() == "no_planned_duration"
    assert cost.budget_utilization == 1.0
    kpis = program_cost_kpis([cost], "USD")
    # The only project, so no total: unavailable, never a silent 0.
    assert kpis["cost_variance"]["reason"] == "no_planned_duration"
    assert kpis["budget_utilization"]["value"] == 1.0


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

    A: one overdue open task → critical (ordinal 0). B: one task done on time →
    on_track (ordinal 2). Average = round(1) → at_risk. Weighted by budgets 100 and
    9,900 = round(1.98) → on_track. The digest must report the average (at risk),
    while a PM of every project sees the weighted band on the overview.
    """
    from trueppm_api.apps.notifications.digests import build_program_health_digest
    from trueppm_api.apps.projects.models import TaskStatus

    prog, owner = program
    yesterday = TODAY - datetime.timedelta(days=1)
    a = h.project("Alpha", budget="100.00", program=prog)
    b = h.project("Beta", budget="9900.00", program=prog)
    Task.objects.create(project=a, name="late", duration=1, early_finish=yesterday)
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
