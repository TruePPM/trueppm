"""Project cost facts: budget, actual cost, earned value (ADR-1324, #754).

The single implementation behind every cost number the API serves — the project cost
summary (``GET /projects/{id}/cost/``), the program rollup's ``cost_variance`` /
``budget_utilization`` KPIs and ``weighted_by_budget`` policy, and the rate re-cost
preview (``POST /resources/{id}/rate/``). One function, so the preview a PM is shown
before a rate change is the same arithmetic the saved rate then produces: the preview
passes ``rate_overrides``, the save recomputes from the database, and nothing else
differs (ADR-1324 §5).

Definitions (ADR-1324 §2–§3):

- **Actual cost (AC)** = Σ hours × the *current* rate of the resource the hours'
  logger resolves to. Hours are non-deleted ``TimeEntry`` rows on the project's own
  tasks — PTO and non-project time are therefore excluded by construction (time off is
  a calendar exception, never a time entry; time on another project's task belongs to
  that project). Entries on soft-deleted tasks still count: the money was spent.
- **Earned value (EV)** = BAC × the project's existing percent complete (the same
  ``Avg(percent_complete)`` over non-deleted tasks the project list annotates, ADR-0171)
  / 100. Reused verbatim; not a new progress measure. A project with no live tasks
  has percent complete 0 (nothing left has been earned), never null.
- **CV** = EV − AC; **budget utilization** = AC / BAC (spend as a share of budget; it
  is *not* the cost performance index).
- **CPI** = EV / AC; **EAC** = BAC / CPI (the "typical variance" forecast: the cost
  efficiency so far continues for the rest of the work); **ETC** = EAC − AC;
  **VAC** = BAC − EAC; **TCPI** = (BAC − EV) / (BAC − AC) (the efficiency needed on the
  remaining work to finish on BAC). These are the commonly published definitions, taken
  from secondary sources and NOT yet confirmed against the PMBOK / PMI Practice Standard
  for EVM (ADR-1324 addendum, #4852); EV keeps the unweighted-mean
  percent-complete basis (the basis decision is #4853, not made here).

Performance: a fixed number of queries for any number of projects (no per-project
loop). The heavy aggregation — summing minutes — is a grouped SQL ``Sum``; the
user→resource resolution then runs in Python over the small grouped result.
"""

from __future__ import annotations

import datetime
from collections.abc import Collection, Mapping
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from django.db.models import Avg, Q, Sum
from django.utils import timezone

CENT = Decimal("0.01")
_MINUTES_PER_HOUR = Decimal(60)

# Stable machine reasons a cost value cannot be computed (ADR-1324 §3). The web layer
# and MCP clients branch on these strings; they are part of the public contract.
REASON_COST_RESTRICTED = "cost_restricted"
REASON_NO_BUDGET = "no_budget"
REASON_MISSING_RATES = "missing_rates"
# Forecast-only reasons: the inputs exist but the ratio's denominator is zero (or the
# result would be infinite), so no number is the honest answer.
REASON_NO_ACTUAL_COST = "no_actual_cost"  # AC = 0: CPI = EV / AC is undefined
REASON_NO_EARNED_VALUE = "no_earned_value"  # EV = 0: CPI = 0, so EAC = BAC / CPI is infinite
REASON_BUDGET_EXHAUSTED = "budget_exhausted"  # AC >= BAC: TCPI's denominator is <= 0

#: The computing function and response contract named in the ``provenance`` block, so a
#: figure someone quotes can be traced to the code and shape that produced it.
COST_COMPUTED_BY = "trueppm_api.apps.projects.cost.project_cost_facts"
COST_CONTRACT_VERSION = "1"

#: One-sentence derivation per published cost field, served on the cost summary so an
#: agent (or a PM) can say *why* a number is what it is rather than restate it.
COST_DEFINITIONS: dict[str, str] = {
    "budget": (
        "Budget at completion (BAC) set on the project, in the workspace currency. This is "
        "the total planned cost, not the money remaining."
    ),
    "actual": (
        "Sum over everyone who logged time on this project's tasks of hours x the "
        "current hourly rate of their resource. PTO and time on other projects are "
        "not included. Changing a rate re-costs past hours."
    ),
    "percent_complete": (
        "The project's percent complete: the mean percent_complete of its non-deleted "
        "tasks, or 0 when it has none."
    ),
    "earned_value": (
        "budget x percent_complete / 100. percent_complete is the unweighted mean of "
        "task percent complete, so every task counts equally regardless of its size."
    ),
    "cost_variance": "earned_value - actual. Negative means over budget.",
    "budget_utilization": (
        "actual / budget (AC / BAC): the share of the budget spent so far. 1.0 means the "
        "whole budget has been spent. It is not the cost performance index: it ignores "
        "how much work the money bought (see cpi). At program level it is total actual "
        "cost / total budget, a ratio of sums, not an average of project ratios."
    ),
    "cpi": (
        "Cost performance index: earned_value / actual. Above 1.0 the work done cost "
        "less than budgeted; below 1.0 it cost more. Unavailable when actual is 0."
    ),
    "eac": (
        "Estimate at completion, typical-variance variant: budget / cpi, i.e. the cost "
        "efficiency so far is assumed to continue for the rest of the work. Unavailable "
        "when cpi is unavailable or earned_value is 0 (the forecast would be infinite)."
    ),
    "etc": "Estimate to complete: eac - actual. The forecast cost of the remaining work.",
    "vac": "Variance at completion: budget - eac. Negative means a forecast overrun.",
    "tcpi": (
        "To-complete performance index: (budget - earned_value) / (budget - actual), the "
        "cost efficiency the remaining work must achieve to finish exactly on budget. "
        "Above 1.0 means the rest must be done more cheaply than so far. Unavailable "
        "when actual is at or above budget."
    ),
    "cost_computable": (
        "True when every person in scope (anyone who logged time here or is assigned "
        "to a live task) has a rate."
    ),
    "missing_rate_count": "How many people in scope have no rate.",
}


def money(value: Decimal) -> Decimal:
    """Round an amount to cents, half-up — the one rounding rule for every amount."""
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


@dataclass
class CostLine:
    """One person's contribution to a project's actual cost."""

    resource_id: Any | None
    user_id: Any
    name: str
    minutes: int
    rate: Decimal | None

    @property
    def hours(self) -> Decimal:
        return money(Decimal(self.minutes) / _MINUTES_PER_HOUR)

    @property
    def cost(self) -> Decimal | None:
        if self.rate is None:
            return None
        return money(Decimal(self.minutes) * self.rate / _MINUTES_PER_HOUR)


@dataclass
class MissingRate:
    """A person in scope whose hours or assignment cannot be priced."""

    resource_id: Any | None
    user_id: Any | None
    name: str


@dataclass
class ProjectCost:
    """Every cost fact for one project. See the module docstring for definitions."""

    project_id: Any
    budget: Decimal | None
    percent_complete: Decimal | None
    lines: list[CostLine] = field(default_factory=list)
    missing: list[MissingRate] = field(default_factory=list)
    as_of: datetime.datetime = field(default_factory=timezone.now)

    @property
    def has_budget(self) -> bool:
        return self.budget is not None and self.budget > 0

    @property
    def actual(self) -> Decimal:
        """Priced AC — the sum of each line's already-rounded cost, so lines add up."""
        return sum((c for c in (ln.cost for ln in self.lines) if c is not None), Decimal("0.00"))

    @property
    def logged_minutes(self) -> int:
        return sum(ln.minutes for ln in self.lines)

    @property
    def priced_minutes(self) -> int:
        return sum(ln.minutes for ln in self.lines if ln.rate is not None)

    @property
    def missing_rate_count(self) -> int:
        return len(self.missing)

    @property
    def cost_computable(self) -> bool:
        """#4809's fact: every person in scope has a rate. Independent of the budget."""
        return not self.missing

    @property
    def earned_value(self) -> Decimal | None:
        if not self.has_budget or self.percent_complete is None:
            return None
        assert self.budget is not None
        return money(self.budget * self.percent_complete / 100)

    def unavailable_reason(self) -> str | None:
        """First failing precondition for CV / utilization, in ADR-1324 §3 table order."""
        if not self.has_budget:
            return REASON_NO_BUDGET
        if not self.cost_computable:
            return REASON_MISSING_RATES
        return None

    @property
    def cost_variance(self) -> Decimal | None:
        ev = self.earned_value
        if self.unavailable_reason() is not None or ev is None:
            return None
        return ev - self.actual

    @property
    def budget_utilization(self) -> float | None:
        if self.unavailable_reason() is not None:
            return None
        assert self.budget is not None
        return round(float(self.actual / self.budget), 4)

    # -- Forecast measures (#4852). Each returns (value, reason); exactly one is None.

    def _forecast_gate(self) -> str | None:
        return self.unavailable_reason()

    def cpi_result(self) -> tuple[float | None, str | None]:
        """CPI = EV / AC, or why it cannot be given (never 0 or infinity as a stand-in)."""
        reason = self._forecast_gate()
        if reason is not None:
            return None, reason
        ev = self.earned_value
        if ev is None:  # unreachable once has_budget; keeps the type honest
            return None, REASON_NO_BUDGET
        if self.actual <= 0:
            return None, REASON_NO_ACTUAL_COST
        return round(float(ev / self.actual), 4), None

    def eac_result(self) -> tuple[Decimal | None, str | None]:
        """EAC = BAC / CPI = BAC x AC / EV, computed in Decimal (no float round-trip)."""
        _, reason = self.cpi_result()
        if reason is not None:
            return None, reason
        ev = self.earned_value
        assert ev is not None and self.budget is not None
        if ev <= 0:
            return None, REASON_NO_EARNED_VALUE
        return money(self.budget * self.actual / ev), None

    def etc_result(self) -> tuple[Decimal | None, str | None]:
        eac, reason = self.eac_result()
        return (None, reason) if eac is None else (eac - self.actual, None)

    def vac_result(self) -> tuple[Decimal | None, str | None]:
        eac, reason = self.eac_result()
        if eac is None:
            return None, reason
        assert self.budget is not None
        return money(self.budget) - eac, None

    def tcpi_result(self) -> tuple[float | None, str | None]:
        """TCPI = (BAC - EV) / (BAC - AC); unavailable once AC has reached BAC."""
        reason = self._forecast_gate()
        if reason is not None:
            return None, reason
        ev = self.earned_value
        assert ev is not None and self.budget is not None
        remaining_budget = money(self.budget) - self.actual
        if remaining_budget <= 0:
            return None, REASON_BUDGET_EXHAUSTED
        return round(float((money(self.budget) - ev) / remaining_budget), 4), None


def _hours(minutes: int) -> Decimal:
    return money(Decimal(minutes) / _MINUTES_PER_HOUR)


def project_percent_complete(project_ids: Collection[Any]) -> dict[Any, float]:
    """project_id → the project's existing percent complete (0–100).

    The same aggregate ``ProjectViewSet`` annotates on the project list (ADR-0171):
    the mean ``percent_complete`` of non-deleted tasks. Projects with no tasks are
    absent. Reused for EV per the 2026-11-05 decision on #754 — do not substitute a
    weighted measure here without a new ADR.
    """
    from trueppm_api.apps.projects.models import Task

    if not project_ids:
        return {}
    return {
        r["project_id"]: r["pc"]
        for r in Task.objects.filter(project_id__in=list(project_ids), is_deleted=False)
        .order_by()
        .values("project_id")
        .annotate(pc=Avg("percent_complete"))
        if r["pc"] is not None
    }


@dataclass
class _CostInputs:
    """The grouped rows one :func:`project_cost_facts` call reads (six queries)."""

    budgets: dict[Any, Decimal | None]
    pct: dict[Any, float]
    time_rows: list[dict[str, Any]]
    assigned_rows: list[tuple[Any, Any]]
    resources: dict[Any, dict[str, Any]]
    roster: set[tuple[Any, Any]]
    by_user: dict[Any, list[dict[str, Any]]] = field(default_factory=dict)
    unlinked_names: dict[Any, str] = field(default_factory=dict)


def _load_inputs(pids: list[Any]) -> _CostInputs:
    from trueppm_api.apps.projects.models import Project
    from trueppm_api.apps.resources.models import ProjectResource, Resource, TaskResource
    from trueppm_api.apps.timetracking.models import TimeEntry

    budgets = dict(Project.objects.filter(id__in=pids).values_list("id", "budget"))
    pct = project_percent_complete(pids)
    # Logged minutes per (project, user) — the aggregate is in SQL.
    time_rows: list[dict[str, Any]] = [
        dict(r)
        for r in TimeEntry.objects.filter(task__project_id__in=pids, is_deleted=False)
        .order_by()
        .values("task__project_id", "user_id")
        .annotate(m=Sum("minutes"))
    ]
    # Assigned people per project (live tasks, live resources, linked to a user).
    assigned_rows = list(
        TaskResource.objects.active()
        .filter(task__project_id__in=pids, task__is_deleted=False, resource__user__isnull=False)
        .order_by()
        .values_list("task__project_id", "resource_id")
        .distinct()
    )
    user_ids = {r["user_id"] for r in time_rows}
    assigned_rids = {rid for _, rid in assigned_rows}
    resources: dict[Any, dict[str, Any]] = {
        r["id"]: dict(r)
        for r in Resource.objects.filter(Q(user_id__in=user_ids) | Q(id__in=assigned_rids))
        .order_by()
        .values("id", "user_id", "name", "cost_rate", "is_deleted")
    }
    inputs = _CostInputs(budgets, pct, time_rows, assigned_rows, resources, set())
    for r in resources.values():
        if r["user_id"] is not None:
            inputs.by_user.setdefault(r["user_id"], []).append(r)
    unlinked = user_ids - set(inputs.by_user)
    if unlinked:
        _link_by_email(inputs, unlinked)
    inputs.roster = set(
        ProjectResource.objects.filter(
            project_id__in=pids, resource_id__in=list(resources), is_deleted=False
        ).values_list("project_id", "resource_id")
    )
    return inputs


def unambiguous_emails(emails: Collection[str]) -> set[str]:
    """The lower-cased emails in ``emails`` held by exactly ONE account (one query).

    The rule the email fallback and the rate-preview scope share, so preview and save
    agree on who an unlinked resource prices (ADR-1324 §2).
    """
    from django.contrib.auth import get_user_model
    from django.db.models import Count
    from django.db.models.functions import Lower

    if not emails:
        return set()
    return {
        row["_e"]
        for row in get_user_model()
        .objects.annotate(_e=Lower("email"))
        .filter(_e__in=[e.lower() for e in emails])
        .order_by()
        .values("_e")
        .annotate(n=Count("id"))
        if row["n"] == 1
    }


def _link_by_email(inputs: _CostInputs, unlinked: set[Any]) -> None:
    """Resolve loggers with no linked resource by email (one or two extra queries).

    ``Resource.user`` has no write path in the API, so a person who logs time
    without a linked resource would otherwise be permanently unpriceable. The
    remedy a workspace admin has is to create a resource with that person's email
    (``POST /resources/``, email is workspace-Admin-writable) and rate it — the same
    legacy email fallback ``ResourceSerializer.get_is_me`` already applies to a
    resource whose user FK was never set. Only resources with NO user link match, so
    a resource already bound to someone else is never borrowed. A logger still
    unmatched keeps unpriced hours and their account name on the missing list.
    """
    from django.contrib.auth import get_user_model
    from django.db.models.functions import Lower

    from trueppm_api.apps.resources.models import Resource

    users = list(
        get_user_model()
        .objects.filter(pk__in=unlinked)
        .only("username", "first_name", "last_name", "email")
    )
    candidates: dict[str, Any] = {}
    for u in users:
        inputs.unlinked_names[u.pk] = u.get_full_name() or u.get_username()
        email = (u.email or "").strip().lower()
        if email:
            candidates[email] = u.pk
    if not candidates:
        return
    # ``auth.User.email`` is not unique. An email held by more than one account is
    # ambiguous, so it matches nobody — the person stays visible as missing a rate
    # rather than being priced at whichever account the queryset returned first.
    email_to_uid = {e: candidates[e] for e in unambiguous_emails(candidates) if e in candidates}
    if not email_to_uid:
        return
    for row in (
        Resource.objects.annotate(_email=Lower("email"))
        .filter(user__isnull=True, _email__in=list(email_to_uid))
        .order_by()
        .values("id", "user_id", "name", "cost_rate", "is_deleted", "_email")
    ):
        r: dict[str, Any] = dict(row)
        uid = email_to_uid[str(r.pop("_email"))]
        inputs.resources[r["id"]] = r
        inputs.by_user.setdefault(uid, []).append(r)


class _Pricer:
    """Applies the resolution and rate rules to loaded rows for one call."""

    def __init__(self, inputs: _CostInputs, overrides: Mapping[Any, Decimal | None]) -> None:
        self.inputs = inputs
        self.overrides = overrides
        self.seen: dict[Any, set[Any]] = {}

    def rate_of(self, rid: Any) -> Decimal | None:
        if rid in self.overrides:
            return self.overrides[rid]
        rate: Decimal | None = self.inputs.resources[rid]["cost_rate"]
        return rate

    def resolve(self, user_id: Any, pid: Any) -> dict[str, Any] | None:
        candidates = self.inputs.by_user.get(user_id)
        if not candidates:
            return None
        return min(
            candidates,
            key=lambda r: (
                (pid, r["id"]) not in self.inputs.roster,
                bool(r["is_deleted"]),
                r["name"],
                str(r["id"]),
            ),
        )

    def mark_missing(self, cost: ProjectCost, rid: Any, uid: Any, name: str) -> None:
        # Keyed by person (user id) so one person with two resources counts once.
        seen = self.seen.setdefault(cost.project_id, set())
        if uid not in seen:
            seen.add(uid)
            cost.missing.append(MissingRate(resource_id=rid, user_id=uid, name=name))

    def add_time(self, cost: ProjectCost, uid: Any, minutes: int) -> None:
        chosen = self.resolve(uid, cost.project_id)
        if chosen is None:
            name = self.inputs.unlinked_names.get(uid, "")
            cost.lines.append(CostLine(None, uid, name, minutes, None))
            self.mark_missing(cost, None, uid, name)
            return
        rate = self.rate_of(chosen["id"])
        cost.lines.append(CostLine(chosen["id"], uid, chosen["name"], minutes, rate))
        if rate is None:
            self.mark_missing(cost, chosen["id"], uid, chosen["name"])

    def add_assignment(self, cost: ProjectCost, rid: Any) -> None:
        res = self.inputs.resources.get(rid)
        if res is not None and self.rate_of(rid) is None:
            self.mark_missing(cost, rid, res["user_id"], res["name"])


def project_cost_facts(
    project_ids: Collection[Any],
    *,
    rate_overrides: Mapping[Any, Decimal | None] | None = None,
) -> dict[Any, ProjectCost]:
    """Compute :class:`ProjectCost` for each project id (ADR-1324).

    ``rate_overrides`` maps a resource id to a proposed rate (``None`` = unrated) and
    is how the re-cost preview asks "what would this be if the rate were X" without a
    second implementation. Six queries regardless of ``len(project_ids)`` (a seventh
    only when someone logged time with no resource).

    Resolution of a time-logging user to a resource (``Resource.user`` is not unique):
    prefer a resource on the project's live roster, then a live resource over a
    deactivated one (a deactivated person's past hours still cost what they cost),
    then by name, then id. A user with no resource contributes unpriced hours and
    counts once toward ``missing_rate_count``.

    "In scope" for ``missing_rate_count`` = anyone who logged time on the project, plus
    any *person* (a resource linked to a user) assigned to one of its live tasks. An
    unrated non-human resource does not block computation: in 0.5 it carries no cost
    (non-labor cost is #2557).
    """
    pids = list(project_ids)
    if not pids:
        return {}
    inputs = _load_inputs(pids)
    pricer = _Pricer(inputs, dict(rate_overrides or {}))
    now = timezone.now()
    out = {
        pid: ProjectCost(
            project_id=pid,
            budget=inputs.budgets.get(pid),
            # A project with no live tasks has earned nothing: 0, not "unknown".
            # Otherwise EV is None, CV reads {available, value: null} while AC > 0,
            # and the program total silently drops the overrun (ADR-1324 §2: spent-
            # but-abandoned work must show as negative CV). Where the project list's
            # Avg annotation is defined (≥1 live task) the two still agree.
            percent_complete=(
                Decimal(str(inputs.pct[pid])).quantize(CENT, rounding=ROUND_HALF_UP)
                if pid in inputs.pct
                else Decimal("0.00")
            ),
            as_of=now,
        )
        for pid in pids
        if pid in inputs.budgets
    }
    for row in sorted(
        inputs.time_rows, key=lambda r: (str(r["task__project_id"]), str(r["user_id"]))
    ):
        cost = out.get(row["task__project_id"])
        if cost is not None:
            pricer.add_time(cost, row["user_id"], int(row["m"] or 0))
    for pid, rid in sorted(inputs.assigned_rows, key=lambda r: (str(r[0]), str(r[1]))):
        cost = out.get(pid)
        if cost is not None:
            pricer.add_assignment(cost, rid)
    for cost in out.values():
        cost.lines.sort(key=lambda ln: (ln.name, str(ln.resource_id), str(ln.user_id)))
        cost.missing.sort(key=lambda m: (m.name, str(m.resource_id), str(m.user_id)))
    return out


def kpi_entry(value: Any, reason: str | None, **extra: Any) -> dict[str, Any]:
    """The ``{available, value | reason}`` shape the rollup and summary share."""
    if reason is not None:
        return {"available": False, "reason": reason, **extra}
    return {"available": True, "value": value, **extra}


def _money_result(result: tuple[Decimal | None, str | None]) -> tuple[str | None, str | None]:
    value, reason = result
    return (str(value) if value is not None else None), reason


def _forecast_entry(value: Any, reason: str | None) -> dict[str, Any]:
    """``{available, value | reason}`` for a forecast measure (same shape as the KPIs)."""
    return kpi_entry(value, reason)


def cost_provenance(cost: ProjectCost) -> dict[str, Any]:
    """The ``provenance`` block: what computed each figure, from which inputs (#4848).

    Follows the metric-provenance pattern (ADR-1314): the sentence that defines a figure
    stays in ``definitions``. The shape is bespoke rather than built from
    ``metric_provenance.py`` because that module only owns one-sentence definitions and the
    forecast-commitment facts; it has no per-figure computed/restricted status or input
    description to reuse, and bending it to carry them was not cheap. This block adds what a
    definition cannot: the computing function, a contract version, the inputs and their
    basis, and per figure whether it was ``computed`` or ``restricted`` (never silently
    zero). Rates carry no change
    history today (one current rate per resource, ADR-1324), so ``as_of`` is the only
    datum saying when a figure was true, and a rate change re-costs past hours.
    """
    reason = cost.unavailable_reason()

    def status(figure_reason: str | None) -> dict[str, Any]:
        return (
            {"status": "computed"}
            if figure_reason is None
            else {"status": "restricted", "reason": figure_reason}
        )

    return {
        "computed_by": COST_COMPUTED_BY,
        "contract_version": COST_CONTRACT_VERSION,
        "as_of": cost.as_of,
        "inputs": {
            "rate_source": "current_resource_rate",
            "rate_history": "none",
            "rate_note": (
                "Each person's hours are priced at the resource's current rate, so a "
                "rate change re-costs past hours; as_of is when this figure was true."
            ),
            "percent_complete_source": "unweighted_mean_task_percent_complete",
            "percent_complete_note": (
                "Earned value uses the unweighted mean of non-deleted task percent "
                "complete, not duration- or cost-weighted."
            ),
            "eac_method": "typical_variance",
            "eac_formula": "budget / cpi",
        },
        "figures": {
            "earned_value": status(None if cost.earned_value is not None else REASON_NO_BUDGET),
            "cost_variance": status(reason),
            "budget_utilization": status(reason),
            "cpi": status(cost.cpi_result()[1]),
            "eac": status(cost.eac_result()[1]),
            "etc": status(cost.etc_result()[1]),
            "vac": status(cost.vac_result()[1]),
            "tcpi": status(cost.tcpi_result()[1]),
        },
    }


def project_cost_payload(cost: ProjectCost, currency: str) -> dict[str, Any]:
    """Serialize one :class:`ProjectCost` for ``GET /projects/{id}/cost/`` (ADR-1324 §6)."""
    reason = cost.unavailable_reason()
    cv = cost.cost_variance
    return {
        "project_id": str(cost.project_id),
        "currency": currency,
        "as_of": cost.as_of,
        "budget": cost.budget,
        "actual": cost.actual,
        "percent_complete": cost.percent_complete,
        "earned_value": cost.earned_value,
        "cost_variance": kpi_entry(str(cv) if cv is not None else None, reason),
        "budget_utilization": kpi_entry(cost.budget_utilization, reason),
        "cpi": _forecast_entry(*cost.cpi_result()),
        "eac": _forecast_entry(*_money_result(cost.eac_result())),
        "etc": _forecast_entry(*_money_result(cost.etc_result())),
        "vac": _forecast_entry(*_money_result(cost.vac_result())),
        "tcpi": _forecast_entry(*cost.tcpi_result()),
        "provenance": cost_provenance(cost),
        "cost_computable": cost.cost_computable,
        "missing_rate_count": cost.missing_rate_count,
        "missing_rate_resources": [
            {
                "resource_id": str(m.resource_id) if m.resource_id is not None else None,
                "user_id": m.user_id,
                "name": m.name,
            }
            for m in cost.missing
        ],
        "logged_hours": _hours(cost.logged_minutes),
        "priced_hours": _hours(cost.priced_minutes),
        "unpriced_hours": _hours(cost.logged_minutes - cost.priced_minutes),
        "lines": [
            {
                "resource_id": str(ln.resource_id) if ln.resource_id is not None else None,
                "name": ln.name,
                "hours": ln.hours,
                "rate": ln.rate,
                "cost": ln.cost,
            }
            for ln in cost.lines
        ],
        "definitions": COST_DEFINITIONS,
    }


def program_cost_kpis(costs: Collection[ProjectCost], currency: str) -> dict[str, dict[str, Any]]:
    """Program-level ``cost_variance`` / ``budget_utilization`` entries (ADR-1324 §3).

    Both are policy-independent totals: Σ CV, and ΣAC / ΣBAC (a ratio of sums — a mean
    of per-project ratios would overweight a tiny project). Unavailable if ANY
    contributing project is: a partial sum would be a confident wrong number. The
    detail counts (``projects_without_budget``, program-distinct ``missing_rate_count``)
    ride along either way so the reason is actionable.
    """
    costs = list(costs)
    no_budget = sum(1 for c in costs if not c.has_budget)
    missing_people = {(m.user_id, m.resource_id) for c in costs for m in c.missing}
    detail = {"projects_without_budget": no_budget, "missing_rate_count": len(missing_people)}
    if not costs:
        return {
            "cost_variance": {"available": True, "value": None, "unit": currency, **detail},
            "budget_utilization": {"available": True, "value": None, "unit": "ratio", **detail},
        }
    reason = REASON_NO_BUDGET if no_budget else REASON_MISSING_RATES if missing_people else None
    if reason is not None:
        return {
            "cost_variance": kpi_entry(None, reason, **detail),
            "budget_utilization": kpi_entry(None, reason, **detail),
        }
    # Every cost here has a value: unavailable_reason() is None for all of them, and
    # a project with no live tasks earns 0 (see project_cost_facts), never None.
    total_cv = sum((c.cost_variance or Decimal("0") for c in costs), Decimal("0"))
    total_ac = sum((c.actual for c in costs), Decimal("0"))
    total_bac = sum((c.budget or Decimal("0") for c in costs), Decimal("0"))
    return {
        "cost_variance": kpi_entry(str(money(total_cv)), None, unit=currency, **detail),
        "budget_utilization": kpi_entry(
            round(float(total_ac / total_bac), 4), None, unit="ratio", **detail
        ),
    }
