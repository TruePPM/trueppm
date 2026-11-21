"""The weekly program-health digest's cost line (ADR-1324 digest addendum, #4850).

The digest is pushed: it lands in an inbox, is retained there after the recipient's
access is revoked, and can be forwarded. So the cost line is gated on the recipient
(program Admin+ and project Admin+ on every contributing project, the rollup's own
floor) and, even then, carries only a band or a reason from a closed vocabulary.

The disclosure tests are non-interference tests: change the budget, and therefore the
budget ratio, and the rendered digest must not change unless the band does — and for
a recipient below the floor it must not change at all.
"""

from __future__ import annotations

import datetime
import re
from typing import Any

import pytest
from django.utils import timezone

from tests.apps.projects import cost_helpers as h
from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.notifications.digests import (
    COST_LINE_VOCABULARY,
    build_program_health_digest,
)
from trueppm_api.apps.projects.models import (
    AggregationPolicy,
    Methodology,
    Program,
    Project,
    RollupKpi,
    Task,
    TaskStatus,
)
from trueppm_api.apps.projects.program_rollup import cost_health_band

pytestmark = pytest.mark.django_db

_COST = [RollupKpi.COST_VARIANCE.value, RollupKpi.BUDGET_UTILIZATION.value]
_COST_SEGMENT = re.compile(r"· Cost: (?P<text>[^\n]*)")


def _program(*, kpis: list[str] | None = None) -> tuple[Program, Any]:
    owner = h.user("digest-powner")
    prog = create_program(
        name="Apollo", description="", methodology=Methodology.HYBRID, created_by=owner
    )
    prog.rollup_enabled_kpis = _COST if kpis is None else kpis
    prog.rollup_aggregation_policy = AggregationPolicy.WORST.value
    prog.save(update_fields=["rollup_enabled_kpis", "rollup_aggregation_policy"])
    return prog, owner


def _spend(prog: Program, *, budget: str | None, percent: float, minutes: int) -> Project:
    """One project: one task at ``percent``, ``minutes`` logged at 100.00/h."""
    worker = h.user(f"worker-{Project.objects.count()}")
    h.resource(f"Worker {Project.objects.count()}", worker, "100.00")
    p = h.project("Lander", budget=budget, program=prog)
    h.log(h.task(p, percent=percent), worker, minutes)
    return p


def _make_late(p: Project) -> None:
    """Push the project's schedule health to ``critical`` (an overdue open task)."""
    Task.objects.create(
        project=p,
        name="Overdue",
        duration=1,
        early_finish=datetime.date(2026, 2, 1),
        status=TaskStatus.IN_PROGRESS,
        percent_complete=0,
    )


def _project_admin(prog: Program, who: Any) -> Any:
    for p in Project.objects.filter(program=prog):
        ProjectMembership.objects.update_or_create(
            project=p, user=who, defaults={"role": Role.ADMIN}
        )
    return who


def _set_budget(p: Project, budget: str | None) -> None:
    from decimal import Decimal

    Project.objects.filter(pk=p.pk).update(budget=Decimal(budget) if budget else None)


def _body(user: Any) -> str:
    return build_program_health_digest(user, timezone.now())[1]


def _cost_texts(body: str) -> list[str]:
    return [m.group("text") for m in _COST_SEGMENT.finditer(body)]


# ---------------------------------------------------------------------------
# What an entitled recipient sees
# ---------------------------------------------------------------------------


def test_over_budget_program_is_listed_even_when_its_schedule_is_fine() -> None:
    """20 h × 100 = AC 2,000 against BAC 1,000 → utilization 2.0 → over budget.

    The schedule band is ``unknown`` (no task is planned by a date), so before #4850
    this program never reached the digest at all.
    """
    prog, owner = _program()
    _spend(prog, budget="1000.00", percent=0, minutes=1200)
    _project_admin(prog, owner)

    body = _body(owner)
    assert "Apollo: Schedule health unknown · Cost: over budget" in body


def test_negative_variance_within_budget_is_spending_ahead_of_progress() -> None:
    """BAC 10,000, 10 % → EV 1,000; AC 2,000 → CV −1,000, utilization 0.2."""
    prog, owner = _program()
    _spend(prog, budget="10000.00", percent=10, minutes=1200)
    _project_admin(prog, owner)

    assert _cost_texts(_body(owner)) == ["spending ahead of progress"]


def test_healthy_cost_rides_along_on_a_schedule_at_risk_line_only() -> None:
    """Within budget alone earns no line; on a late program it is stated."""
    prog, owner = _program()
    # BAC 10,000; one task at 100 % → EV 10,000, AC 2,000 → CV +8,000.
    p = _spend(prog, budget="10000.00", percent=100, minutes=1200)
    _project_admin(prog, owner)
    assert "nothing at risk" in build_program_health_digest(owner, timezone.now())[0].lower()

    _make_late(p)  # mean percent 50 → EV 5,000, CV +3,000: still within budget
    body = _body(owner)
    assert "Apollo: Critical — driven by Lander · Cost: within budget" in body


def test_missing_budget_is_named_to_an_entitled_recipient() -> None:
    prog, owner = _program()
    p = _spend(prog, budget=None, percent=0, minutes=60)
    _make_late(p)
    _project_admin(prog, owner)

    assert _cost_texts(_body(owner)) == ["unavailable, a project has no budget"]


# ---------------------------------------------------------------------------
# The program policy, and the reason when it withholds
# ---------------------------------------------------------------------------


def test_program_without_cost_kpis_states_that_cost_is_not_tracked() -> None:
    """The policy is the existing ``rollup_enabled_kpis``: no cost KPI, no cost band."""
    prog, owner = _program(kpis=[RollupKpi.SCHEDULE_HEALTH.value])
    p = _spend(prog, budget="1000.00", percent=0, minutes=1200)  # over budget
    _make_late(p)
    _project_admin(prog, owner)

    assert _cost_texts(_body(owner)) == ["not tracked in this program's rollup"]


def test_one_enabled_cost_kpi_is_enough_to_carry_the_line() -> None:
    prog, owner = _program(kpis=[RollupKpi.BUDGET_UTILIZATION.value])
    _spend(prog, budget="1000.00", percent=0, minutes=1200)
    _project_admin(prog, owner)

    assert _cost_texts(_body(owner)) == ["over budget"]


@pytest.mark.parametrize("program_role", [Role.VIEWER, Role.MEMBER, Role.SCHEDULER])
def test_recipient_below_program_admin_is_told_cost_is_restricted(program_role: int) -> None:
    prog, _ = _program()
    p = _spend(prog, budget="1000.00", percent=0, minutes=1200)
    _make_late(p)
    sponsor = h.user("sponsor")
    ProgramMembership.objects.create(program=prog, user=sponsor, role=program_role)
    _project_admin(prog, sponsor)  # project Admin does not cascade up to the program

    assert _cost_texts(_body(sponsor)) == ["restricted to managers of every project"]


def test_program_admin_who_is_not_admin_of_every_project_is_restricted() -> None:
    """Program roles do not cascade to projects (ADR-1324 L14b).

    Negative control: with the project half of the gate removed from
    ``program_cost_health`` this recipient is told "over budget".
    """
    prog, _ = _program()
    p = _spend(prog, budget="1000.00", percent=0, minutes=1200)
    _make_late(p)
    pm = h.user("program-pm")
    ProgramMembership.objects.create(program=prog, user=pm, role=Role.ADMIN)
    h.member(p, pm, Role.SCHEDULER)

    assert _cost_texts(_body(pm)) == ["restricted to managers of every project"]


def test_an_over_budget_program_is_not_listed_for_a_restricted_recipient() -> None:
    """Listing on cost grounds would itself disclose the band."""
    prog, owner = _program()
    _spend(prog, budget="1000.00", percent=0, minutes=1200)  # over budget, schedule unknown
    _project_admin(prog, owner)
    viewer = h.user("pviewer")
    ProgramMembership.objects.create(program=prog, user=viewer, role=Role.VIEWER)

    assert "Apollo" in _body(owner)
    assert "Apollo" not in _body(viewer)


# ---------------------------------------------------------------------------
# The digest cannot reveal the budget ratio
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "budgets",
    [
        # AC 2,000 at 0 % → CV −2,000. Utilization 0.4 vs 0.8: same band (at risk).
        ("5000.00", "2500.00"),
        # Utilization 2.0 vs 4.0: same band (over budget).
        ("1000.00", "500.00"),
    ],
)
def test_entitled_digest_is_identical_for_any_budget_within_a_band(
    budgets: tuple[str, str],
) -> None:
    """Halving the budget doubles AC/BAC; the rendered digest must not move.

    If any budget-derived figure reached the text, the two bodies would differ.
    """
    prog, owner = _program()
    p = _spend(prog, budget=budgets[0], percent=0, minutes=1200)
    _make_late(p)
    _project_admin(prog, owner)

    first = _body(owner)
    _set_budget(p, budgets[1])
    assert _body(owner) == first


def _viewer(prog: Program, p: Project) -> Any:
    who = h.user("pviewer")
    ProgramMembership.objects.create(program=prog, user=who, role=Role.VIEWER)
    return who


def _admin_without_project_admin(prog: Program, p: Project) -> Any:
    """Passes the program half of the gate, fails the project half."""
    who = h.user("program-pm-restricted")
    ProgramMembership.objects.create(program=prog, user=who, role=Role.ADMIN)
    h.member(p, who, Role.SCHEDULER)
    return who


@pytest.mark.parametrize("recipient", [_viewer, _admin_without_project_admin])
@pytest.mark.parametrize("budget", ["100000.00", "1000.00", "500.00", None])
def test_restricted_digest_is_identical_whatever_the_budget(
    budget: str | None, recipient: Any
) -> None:
    """Within budget, over budget, far over, or no budget: one and the same body.

    ``no_budget`` is in the set on purpose — it is a cost reason too, and a recipient
    below the floor must not learn whether a budget is set (ADR-1324 §3). Both halves
    of the gate are exercised: a program Viewer fails the program half; a program
    Admin who is only Scheduler on the project fails the project half
    (``_sees_cost_of_every_project``).
    """
    prog, _ = _program()
    p = _spend(prog, budget="10000.00", percent=100, minutes=1200)
    _make_late(p)
    who = recipient(prog, p)

    baseline = _body(who)
    assert _cost_texts(baseline) == ["restricted to managers of every project"]
    _set_budget(p, budget)
    assert _body(who) == baseline


@pytest.mark.parametrize(
    ("budget", "percent", "minutes"),
    [
        ("1000.00", 0, 1200),
        ("10000.00", 10, 1200),
        ("10000.00", 100, 1200),
        (None, 0, 60),
        ("1234.56", 33, 777),
    ],
)
def test_cost_segment_is_always_a_vocabulary_word_and_never_a_number(
    budget: str | None, percent: float, minutes: int
) -> None:
    prog, owner = _program()
    p = _spend(prog, budget=budget, percent=percent, minutes=minutes)
    _make_late(p)
    _project_admin(prog, owner)

    texts = _cost_texts(_body(owner))
    assert texts, "the late program must carry a cost line"
    for text in texts:
        assert text in COST_LINE_VOCABULARY
        assert not re.search(r"\d", text)


def test_missing_rates_is_named_to_an_entitled_recipient() -> None:
    prog, owner = _program()
    worker = h.user("unrated-worker")
    h.resource("Unrated", worker)  # no cost rate
    p = h.project("Lander", budget="1000.00", program=prog)
    h.log(h.task(p, percent=0), worker, 60)
    _make_late(p)
    _project_admin(prog, owner)

    assert _cost_texts(_body(owner)) == ["unavailable, someone has no rate"]


# ---------------------------------------------------------------------------
# The band itself
# ---------------------------------------------------------------------------


def _kpis(cv: str | None, util: float | None, *, available: bool = True) -> dict[str, Any]:
    if not available:
        entry = {"available": False, "reason": "missing_rates"}
        return {"cost_variance": entry, "budget_utilization": entry}
    return {
        "cost_variance": {"available": True, "value": cv},
        "budget_utilization": {"available": True, "value": util},
    }


@pytest.mark.parametrize(
    ("cv", "util", "band"),
    [
        ("-1.00", 1.0001, "critical"),
        ("-1.00", 1.0, "at_risk"),  # budget exactly spent is not over it
        ("-0.01", 0.5, "at_risk"),
        ("0.00", 0.5, "on_track"),
        ("10.00", 0.1, "on_track"),
        (None, None, "unknown"),  # a program with no contributing project
    ],
)
def test_cost_health_band_thresholds(cv: str | None, util: float | None, band: str) -> None:
    assert cost_health_band(_kpis(cv, util)) == band


def test_cost_health_band_is_unknown_when_a_kpi_is_unavailable() -> None:
    assert cost_health_band(_kpis(None, None, available=False)) == "unknown"
