"""Post-recompute invariant self-check for the authoritative CPM pass (#4689).

Real schedules running through the engine for months are the one confidence input no
test suite supplies. This module checks each authoritative CPM result against
invariants the engine must hold and **counts** every violation, on the OpenTelemetry
counter ``trueppm.scheduler.selfcheck.violations{check}`` and one structured log line.
It never blocks, never raises into the recompute, and never changes a stored date: a
violation is evidence for a bug report, not a reason to refuse a schedule.

The checks, cheapest first:

* ``negative_float``: ``total_float >= 0`` on every live task.
* ``critical_float_mismatch``: ``is_critical`` holds exactly when ``total_float == 0``
  on a live task.
* ``finish_not_critical_max``: the project finish equals the latest ``early_finish``
  among the critical tasks, unless a completed task sets it.

"Live" is the engine's own completion rule read backwards: a task is complete when it
has an ``actual_finish`` *or* ``percent_complete >= 100``, and the engine never marks a
complete task critical, whatever its float.
* ``recompute_not_idempotent``: scheduling the same input again yields the same
  result (a second ``schedule()`` call, so roughly one more CPM pass).
* ``zero_variance_mc_mismatch``: with every three-point estimate and velocity signal
  removed, Monte Carlo P50, P80 and P95 all equal the CPM finish (one small
  ``monte_carlo()`` run).

The last two were the oracles that found every new engine defect in the October
audits, and they are the expensive ones. They are **sampled by budget**, not by
chance. Each expensive check predicts its cost as its last measured cost, expressed
as a multiple of the CPM pass it followed, and then:

* a check predicted to cost under ``_FREE_CHECK_SECONDS`` (2 ms) runs on every pass.
  On a small project that is both checks: the absolute cost is too small to matter,
  and these are the passes most real schedules make;
* otherwise it runs only when its own credit covers the prediction. Every pass
  deposits ``SCHEDULER_SELFCHECK_BUDGET_SHARE`` of its CPM time, split evenly between
  the two checks, so one expensive check can never starve the other;
* credit is floored at zero. A check that costs more than predicted is charged down
  to zero, not into debt, and its prediction learns the new cost, so its next run
  waits for it. The first run of each check in a process is not learned from, because
  it carries one-time warm-up cost.

Long-run self-check time is therefore at most the budget share of the process's CPM
time, plus up to 2 ms per check on passes cheap enough to run free, plus the overrun
of a check whose cost rose (forgiven once, then predicted). On a 200-task project
that is roughly one idempotence run in eight passes. Deterministic sampling also keeps
``random`` out of the API (CLAUDE.md principle 5).

All math here is a comparison of engine output. Every scheduled value comes from
``trueppm_scheduler`` (``schedule`` / ``monte_carlo``); nothing is recomputed.
"""

from __future__ import annotations

import dataclasses
import logging
import threading
import time
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from django.conf import settings

logger = logging.getLogger(__name__)

NEGATIVE_FLOAT = "negative_float"
CRITICAL_FLOAT_MISMATCH = "critical_float_mismatch"
FINISH_NOT_CRITICAL_MAX = "finish_not_critical_max"
RECOMPUTE_NOT_IDEMPOTENT = "recompute_not_idempotent"
ZERO_VARIANCE_MC_MISMATCH = "zero_variance_mc_mismatch"
# Not an engine defect: the self-check itself raised. Counted so a broken check is
# visible rather than silently reading as "no violations".
SELFCHECK_ERROR = "selfcheck_error"

CHEAP_CHECKS = (NEGATIVE_FLOAT, CRITICAL_FLOAT_MISMATCH, FINISH_NOT_CRITICAL_MAX)
SAMPLED_CHECKS = (RECOMPUTE_NOT_IDEMPOTENT, ZERO_VARIANCE_MC_MISMATCH)
ALL_CHECKS = CHEAP_CHECKS + SAMPLED_CHECKS

# Runs for the zero-variance Monte Carlo. A fully deterministic input yields the same
# finish on every run, so a handful is enough to catch a disagreement.
ZERO_VARIANCE_MC_RUNS = 20
# The engine fields compared by the idempotence check.
_IDEMPOTENCE_FIELDS = (
    "early_start",
    "early_finish",
    "late_start",
    "late_finish",
    "total_float",
    "free_float",
    "is_critical",
)
# Caps each check's accrued credit so a long idle period cannot bank enough budget to
# run the expensive checks on many large passes in a row.
_MAX_CREDIT_SECONDS = 30.0
# A check predicted to cost less than this runs without spending credit: on a small
# project the budget share of a sub-millisecond CPM pass would otherwise starve a
# check whose real cost is a fraction of a millisecond.
_FREE_CHECK_SECONDS = 0.002

_ZERO = timedelta(0)


class _Budget:
    """Per-process, per-check time credit that samples the expensive checks.

    See the module docstring for the rules and the long-run bound they give.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.credit: dict[str, float] = dict.fromkeys(SAMPLED_CHECKS, 0.0)
        # Last measured cost of each expensive check, as a multiple of the CPM pass
        # time it followed. 1.0 (one CPM pass) is the first guess for both,
        # corrected from the second run on (the first carries warm-up cost).
        self.cost_ratio: dict[str, float] = dict.fromkeys(SAMPLED_CHECKS, 1.0)
        self._measured: set[str] = set()

    def deposit(self, seconds: float) -> None:
        """Split one pass's budget evenly between the expensive checks."""
        each = max(seconds, 0.0) / len(SAMPLED_CHECKS)
        with self._lock:
            for check in self.credit:
                self.credit[check] = min(self.credit[check] + each, _MAX_CREDIT_SECONDS)

    def try_spend(self, check: str, cpm_seconds: float) -> float | None:
        """Reserve the predicted cost of ``check``; ``None`` when it does not fit.

        A prediction under ``_FREE_CHECK_SECONDS`` reserves nothing and always runs.
        """
        predicted = self.cost_ratio[check] * max(cpm_seconds, 0.0)
        if predicted < _FREE_CHECK_SECONDS:
            return 0.0
        with self._lock:
            if predicted > self.credit[check]:
                return None
            self.credit[check] -= predicted
            return predicted

    def settle(self, check: str, cpm_seconds: float, predicted: float, actual: float) -> None:
        """Charge what a check cost against what was reserved, never below zero."""
        with self._lock:
            self.credit[check] = max(
                0.0, min(self.credit[check] + predicted - actual, _MAX_CREDIT_SECONDS)
            )
            if check not in self._measured:
                # The first run in a process pays lazy imports and allocator warm-up
                # (measured at over 100 CPM passes on a 10-task project); learning
                # from it would starve the check for a thousand passes.
                self._measured.add(check)
                return
            if cpm_seconds > 0:
                self.cost_ratio[check] = actual / cpm_seconds

    def reset(self) -> None:
        with self._lock:
            self.credit = dict.fromkeys(SAMPLED_CHECKS, 0.0)
            self.cost_ratio = dict.fromkeys(SAMPLED_CHECKS, 1.0)
            self._measured = set()


_budget = _Budget()


def reset_for_testing() -> None:
    """Drop the accrued credit and learned costs. Test-suite only."""
    _budget.reset()


def engine_version() -> str:
    """The installed ``trueppm-scheduler`` version that produced the result."""
    import trueppm_scheduler

    return str(trueppm_scheduler.__version__)


def _is_complete(task: Any) -> bool:
    """The engine's completion rule (``trueppm_scheduler`` ADR-0136), mirrored.

    The engine keeps its predicate private, so this restates it: an
    ``actual_finish`` *or* ``percent_complete >= 100``. The engine pins a complete
    task at its actuals and never marks it critical, so its float is no planning
    claim. Reading only ``actual_finish`` would flag every 100% task without one.
    """
    return (
        getattr(task, "actual_finish", None) is not None
        or (getattr(task, "percent_complete", 0) or 0) >= 100
    )


def _live(task: Any) -> bool:
    return not _is_complete(task)


def check_negative_float(result: Any) -> bool:
    """``True`` when every live task has ``total_float >= 0``."""
    return all(t.total_float >= _ZERO for t in result.tasks if _live(t))


def check_critical_float(result: Any) -> bool:
    """``True`` when ``is_critical`` holds exactly when ``total_float == 0`` (live tasks)."""
    return all(bool(t.is_critical) == (t.total_float == _ZERO) for t in result.tasks if _live(t))


def check_finish_is_critical_max(result: Any) -> bool:
    """``True`` when the project finish is the latest critical ``early_finish``.

    The engine takes the project finish over *every* task, completed ones included,
    but never marks a completed task critical. So when a completed task finishes
    last it sets the finish, and the critical tasks finishing earlier is not a
    defect. A result with no critical task has nothing to compare and passes.
    """
    critical = set(result.critical_path)
    finishes = [
        t.early_finish for t in result.tasks if t.id in critical and t.early_finish is not None
    ]
    if not finishes or max(finishes) == result.project_finish:
        return True
    return any(_is_complete(t) and t.early_finish == result.project_finish for t in result.tasks)


def check_idempotent(project: Any, result: Any) -> bool:
    """``True`` when a second ``schedule()`` of the same input reproduces ``result``."""
    from trueppm_scheduler import schedule

    again = schedule(project)
    if again.project_finish != result.project_finish:
        return False
    if set(again.critical_path) != set(result.critical_path):
        return False
    first = {t.id: t for t in result.tasks}
    if set(first) != {t.id for t in again.tasks}:
        return False
    return all(
        getattr(t, f) == getattr(first[t.id], f) for t in again.tasks for f in _IDEMPOTENCE_FIELDS
    )


def zero_variance_project(project: Any) -> Any:
    """``project`` with every three-point estimate and velocity signal removed.

    Monte Carlo then samples each task at its fixed duration (the engine's
    deterministic path), so its percentiles must equal the CPM finish.
    """
    tasks = [
        dataclasses.replace(
            t, optimistic_duration=None, most_likely_duration=None, pessimistic_duration=None
        )
        for t in project.tasks
    ]
    return dataclasses.replace(project, tasks=tasks, velocity_samples=None, sprint_length_days=None)


def check_zero_variance_mc(project: Any, result: Any) -> bool:
    """``True`` when a zero-variance Monte Carlo lands P50/P80/P95 on the CPM finish."""
    from trueppm_scheduler import monte_carlo

    mc = monte_carlo(zero_variance_project(project), runs=ZERO_VARIANCE_MC_RUNS, seed=0)
    return all(mc.percentiles[p].date == result.project_finish for p in (50, 80, 95))


def _within_envelope(task_count: int) -> bool:
    cap: int | None = getattr(settings, "SCHEDULER_SELFCHECK_MAX_TASKS", 2_000)
    return cap is None or task_count <= cap


def evaluate(
    project: Any,
    result: Any,
    *,
    run_sampled: Callable[[str], bool],
    after_sampled: Callable[[str, float], None] | None = None,
) -> dict[str, Any]:
    """Run the checks and return a verdict; never raises.

    Args:
        project: The ``trueppm_scheduler.Project`` the result was scheduled from.
        result: Its ``ScheduleResult``.
        run_sampled: Decides, per expensive check, whether to run it this time.
        after_sampled: Called with each expensive check's name and wall-clock
            seconds once it has run (pass, fail or error).

    Returns:
        ``{"engine_version", "task_count", "checks": {name: "pass"|"fail"|"skipped"|
        "error"}, "violations": [names]}``. ``violations`` lists failed checks and,
        as ``selfcheck_error``, any check that raised.
    """
    checks: dict[str, str] = {}
    cheap: dict[str, Callable[[], bool]] = {
        NEGATIVE_FLOAT: lambda: check_negative_float(result),
        CRITICAL_FLOAT_MISMATCH: lambda: check_critical_float(result),
        FINISH_NOT_CRITICAL_MAX: lambda: check_finish_is_critical_max(result),
    }
    sampled: dict[str, Callable[[], bool]] = {
        RECOMPUTE_NOT_IDEMPOTENT: lambda: check_idempotent(project, result),
        ZERO_VARIANCE_MC_MISMATCH: lambda: check_zero_variance_mc(project, result),
    }
    for name, fn in [*cheap.items(), *sampled.items()]:
        if name in sampled and not run_sampled(name):
            checks[name] = "skipped"
            continue
        started = time.perf_counter()
        try:
            checks[name] = "pass" if fn() else "fail"
        except Exception:
            # Telemetry must never destabilize the recompute it observes.
            logger.warning("scheduler self-check %s raised", name, exc_info=True)
            checks[name] = "error"
        if name in sampled and after_sampled is not None:
            after_sampled(name, time.perf_counter() - started)
    violations = [n for n, v in checks.items() if v == "fail"]
    if any(v == "error" for v in checks.values()):
        violations.append(SELFCHECK_ERROR)
    return {
        "engine_version": engine_version(),
        "task_count": len(result.tasks),
        "checks": checks,
        "violations": violations,
    }


def full_verdict(project: Any, result: Any) -> dict[str, Any]:
    """Every check, unsampled, for the bug-report export. Never raises.

    Above the sizing envelope the checks are skipped and the verdict says so.
    """
    if not _within_envelope(len(result.tasks)):
        return {
            "engine_version": engine_version(),
            "task_count": len(result.tasks),
            "checks": dict.fromkeys(ALL_CHECKS, "skipped"),
            "violations": [],
            "skipped_reason": "above_envelope",
        }
    return evaluate(project, result, run_sampled=lambda _name: True)


def run_post_recompute_selfcheck(
    project_id: str,
    project: Any,
    result: Any,
    *,
    cpm_seconds: float,
    scope: str = "project",
) -> dict[str, Any] | None:
    """Self-check one authoritative CPM result; count and log violations.

    Called once from each persisted CPM pass right after ``schedule()`` returns: the
    single-project recompute and the merged program pass. Returns the verdict, or
    ``None`` when the check is disabled or the input is above the envelope. Never
    raises. Both passes share one budget, since both spend this process's CPM time.

    Args:
        project_id: The project (or, with ``scope="program"``, the program) scheduled.
        project: The ``trueppm_scheduler.Project`` input.
        result: The ``ScheduleResult``.
        cpm_seconds: Wall-clock time of the ``schedule()`` call, which sets the
            budget for the expensive checks.
        scope: ``"project"`` or ``"program"``; names the id in the log line, which
            carries it as ``project_id`` or ``program_id`` accordingly.
    """
    try:
        if not getattr(settings, "SCHEDULER_SELFCHECK_ENABLED", True):
            return None
        if not _within_envelope(len(result.tasks)):
            return None
        # layering-ok: the OTel metric sink, a no-op unless telemetry is enabled
        from trueppm_api.apps.observability.otel.metrics import (
            record_selfcheck_run,
            record_selfcheck_violation,
        )

        share = float(getattr(settings, "SCHEDULER_SELFCHECK_BUDGET_SHARE", 0.25))
        _budget.deposit(share * cpm_seconds)

        reserved: dict[str, float] = {}

        def _run_sampled(name: str) -> bool:
            predicted = _budget.try_spend(name, cpm_seconds)
            if predicted is None:
                return False
            reserved[name] = predicted
            return True

        def _after_sampled(name: str, elapsed: float) -> None:
            _budget.settle(name, cpm_seconds, reserved.pop(name, 0.0), elapsed)

        verdict = evaluate(project, result, run_sampled=_run_sampled, after_sampled=_after_sampled)
        for name, outcome in verdict["checks"].items():
            if outcome != "skipped":
                record_selfcheck_run(name)
        for name in verdict["violations"]:
            record_selfcheck_violation(name)
            logger.warning(
                "scheduler self-check violation: %s on %s %s (%d tasks, engine %s)",
                name,
                scope,
                project_id,
                verdict["task_count"],
                verdict["engine_version"],
                extra={
                    "selfcheck_check": name,
                    f"{scope}_id": str(project_id),
                    "task_count": verdict["task_count"],
                    "engine_version": verdict["engine_version"],
                },
            )
        return verdict
    except Exception:
        logger.warning("scheduler self-check skipped for %s %s", scope, project_id, exc_info=True)
        return None
