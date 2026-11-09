"""Monte Carlo percentiles and the public :func:`monte_carlo` entry point."""

from __future__ import annotations

import math
from collections.abc import (
    Sequence,
)
from datetime import (
    date,
    timedelta,
)

import networkx as nx
import numpy as np

from trueppm_scheduler.engine.calendar_math import (
    _is_complete,
    _prev_working_day,
    _safe_offset,
)
from trueppm_scheduler.engine.errors import (
    SimulationCapExceeded,
)
from trueppm_scheduler.engine.graph import (
    _build_graph,
    _raise_cycle_error,
    _resolve_task_calendars,
)
from trueppm_scheduler.engine.limits import (
    MAX_INDEX_CELLS,
    MAX_LAG_DELTA_CELLS,
    MC_SENSITIVITY_CAP,
    MC_SENSITIVITY_SUBSAMPLE,
)
from trueppm_scheduler.engine.milestones import (
    _ONE_DAY,
)
from trueppm_scheduler.engine.montecarlo.forward import (
    _completed_edge_constraints,
    _mc_forward_pass,
    _mc_milestone_floors,
    _mc_progress_state,
    _mc_verbatim_actuals,
    _McIndex,
)
from trueppm_scheduler.engine.montecarlo.index import (
    _MC_DAY_EPS,
    _build_lag_delta_table,
    _finish_day_key,
    _mc_horizon,
    _mc_index_size,
    _mc_pre_start_pad_days,
    _raise_mc_index_overrun,
)
from trueppm_scheduler.engine.montecarlo.sampling import (
    _build_working_day_index,
    _duration_sensitivity,
    _OffsetLookup,
    _sample_duration_matrix,
    _validate_monte_carlo_args,
    _WorkingDayIndex,
)
from trueppm_scheduler.engine.results import (
    MonteCarloResult,
)
from trueppm_scheduler.engine.validate import (
    _validate_project,
)
from trueppm_scheduler.models import (
    Calendar,
    DateRange,
    Project,
)

# Cells per row block when gathering a calendar's columns onto the reference ruler.
_MC_REFERENCE_BLOCK_CELLS = 65_536


# Kept as the per-column reference oracle for _to_reference_columns_inplace; the parity
# test in test_mc_reference_conversion.py compares the two. Not called in production.
def _to_reference_offset(ef: np.ndarray, wd_ord_own: np.ndarray, ref_ord: np.ndarray) -> np.ndarray:
    """Re-express exclusive-EF offsets from one calendar's space in the reference space.

    Working-day offsets are only comparable within the calendar that produced
    them: offset 20 on a Mon-Fri week and offset 20 on a seven-day week are
    different dates. Taking ``max`` across tasks on mixed calendars therefore has
    to happen against a shared ruler, and the finish *date* is the only thing the
    spaces agree on.

    That ruler cannot be the project calendar. A task on a seven-day week can
    finish on a Sunday, which has no offset at all in a Mon-Fri space — mapping
    into it would silently report the previous Friday. The reference is instead the
    **union** of every calendar's working days (see :func:`_build_reference_index`),
    so every reachable finish date has an offset and the conversion is lossless.

    The fractional part of the offset is carried through untouched: sampled PERT
    durations are continuous, and dropping the fraction would quantise the
    distribution the percentiles interpolate over. It is carried relative to the
    day the finish falls in (:func:`_finish_day_key`, #4697), so the converted
    offset falls in the same date's day on the reference ruler.
    """
    k = _finish_day_key(ef)
    ki = k.astype(np.int64)
    # An exclusive EF past the index end is an undersized index; refuse it rather
    # than clamp it onto the last indexed day (#4429).
    if ki.size and int(ki.max()) > len(wd_ord_own):
        _raise_mc_index_overrun()
    ki = np.maximum(ki, 0)
    # Inclusive last working day of the task, mirroring _offset_to_date's key - 1.
    own_ord = wd_ord_own[np.clip(ki - 1, 0, len(wd_ord_own) - 1)]
    # side="right" counts the reference working days at or before that date, which
    # IS the exclusive-EF offset in the reference space.
    ref = np.searchsorted(ref_ord, own_ord, side="right").astype(np.float64) + (ef - k)
    # A zero offset is a degenerate pin (a completed zero-duration milestone at the
    # project start); it has no "previous working day" to map through, and the
    # generic path would round it up to 1. Keep it where it is.
    return np.where(k <= 0, ef, ref)


def _to_reference_columns_inplace(
    mats: tuple[np.ndarray, np.ndarray | None],
    cols: np.ndarray,
    wd_ord_own: np.ndarray,
    ref_ord: np.ndarray,
) -> None:
    """Apply :func:`_to_reference_offset` to ``cols`` of each matrix, in place (#4710).

    The conversion is a fixed function of the calendar, so the reference offset of
    every own-calendar working day is tabulated once (``table``) and each cell is a
    gather from it, rather than a ``searchsorted`` per cell. The arithmetic matches
    :func:`_to_reference_offset` step for step, so the result is bit-identical.
    Rows are processed in blocks so the gather temporaries stay a bounded size
    instead of a second copy of the column group.
    """
    table = np.searchsorted(ref_ord, wd_ord_own, side="right").astype(np.float64)
    last = len(wd_ord_own) - 1
    step = max(1, _MC_REFERENCE_BLOCK_CELLS // max(1, len(cols)))
    for mat in mats:
        if mat is None:
            continue
        for r0 in range(0, mat.shape[0], step):
            rows = slice(r0, r0 + step)
            ef = mat[rows][:, cols]
            k = _finish_day_key(ef)
            ki = k.astype(np.int64)
            if ki.size and int(ki.max()) > len(wd_ord_own):
                _raise_mc_index_overrun()
            ki = np.maximum(ki, 0)
            ref = table[np.clip(ki - 1, 0, last)] + (ef - k)
            mat[rows, cols] = np.where(k <= 0, ef, ref)


def _build_reference_index(
    wd_ord_by_cal: dict[int, np.ndarray],
) -> tuple[np.ndarray, _WorkingDayIndex]:
    """Union every calendar's working days into one ruler for the project maximum.

    A day is a reference working day iff *some* task's calendar treats it as one,
    which is the opposite of :meth:`Calendar.compose` (that unions non-working
    time, for overlaying constraints onto one resource). Here the requirement is
    representability, not constraint: every date any task can finish on must have
    an offset, or converting into the space would move the date.
    """
    # A presence mask over the calendar-day range instead of ``np.unique`` on the
    # concatenation: that sorted a (calendars x index_size) copy, which peaked at
    # ~70 MB for 8 calendars at the maximum span (#4692). The result is the same
    # sorted unique ordinal array.
    arrays = list(wd_ord_by_cal.values())
    lo = min(int(a[0]) for a in arrays)
    hi = max(int(a[-1]) for a in arrays)
    present = np.zeros(hi - lo + 1, dtype=bool)
    for a in arrays:
        present[a - lo] = True
    ref_ord = np.flatnonzero(present).astype(np.int64) + lo
    return ref_ord, _WorkingDayIndex(ref_ord)


def _offset_to_date(
    offset: float, wd_index: Sequence[date], completed_finish_floor: date | None
) -> date:
    """Map a working-day completion offset back to a calendar date.

    An offset past the final index entry raises rather than clamping to it (#4429):
    the index is sized to hold every reachable offset, and a clamp there reported an
    undersized index as a plausible, silently early finish date.

    ``completed_finish_floor`` is the latest verbatim ``early_finish`` across the
    project's completed tasks, which ``schedule()`` keeps unsnapped even on a
    non-working day (ADR-0136 "actuals are truth"). ``schedule().project_finish`` is
    a ``max`` over *every* task's early finish, so the project can never finish
    before that date — flooring here reproduces it exactly, and the working-day
    index (which can only return a working day) cannot (#1929/#1830).

    This replaces the earlier per-offset override map, which keyed the verbatim date
    by its rounded exclusive-EF offset: a *live* task whose completion offset rounded
    to the same key would then be reported on the completed task's weekend date. A
    floor has no such collision — it is a property of the project, not of whichever
    task happened to land on an offset (#2461).
    """
    # EF offsets are exclusive (EF=5 means working days 0..4). Subtract 1 to get the
    # last working day of the task, matching CPM's inclusive EF. A fractional offset
    # is shown on the day it falls in, the ceiling, never the nearest day (#4697):
    # work ending 0.3 into a day has not finished by the day before.
    idx = math.ceil(offset - _MC_DAY_EPS) - 1
    if idx > len(wd_index) - 1:
        _raise_mc_index_overrun()
    idx = max(0, idx)
    resolved = wd_index[idx]
    if completed_finish_floor is not None and completed_finish_floor > resolved:
        return completed_finish_floor
    return resolved


def _mc_percentiles(
    completion_offsets: np.ndarray,
    shown_offsets: np.ndarray,
    wd_index: Sequence[date],
    finish_floor: date | None,
    floor_at_day_start: bool,
) -> list[tuple[date, bool]]:
    """P50/P80/P95 as ``(shown day, at_day_start)`` from per-run finish offsets (#4204).

    ``completion_offsets`` is each run's **working-time** finish position and
    ``shown_offsets`` the exclusive offset of the day that finish is shown on; they
    differ only where a start-of-day milestone sets the run's shown offset. That is
    either the run's finish, shown one working day past its position, or a milestone
    outranked by work ending later on its shown day, which lifts the offset to the
    whole day without moving the shown day (#4786).

    Percentile convention (documented for the public surface, #826): numpy.percentile
    — linear interpolation between the two nearest ranks — over the FULL run set,
    mapped to a working-day date. The position ``k`` is taken over working-time
    positions, not shown days: ordering by shown day ranked the start of a Monday
    after the end of the Friday before it, although neither is later in working time.

    Runs at one position can still be shown on different days — some at the end of a
    Friday, some at the start of the Monday. The percentile is shown on the day its
    rank lands on when runs are ordered by ``(position, shown day)``: the earliest
    shown day of a run at ``k`` on or before which at least that share of ALL runs is
    shown. So it is a two-sided quantile of ``distribution`` — at least PXX% of runs
    on or before it, and fewer than PXX% (plus one run) strictly before it — rather
    than following either the earliest or the latest reading at ``k``. It reads as the
    start of its day when that day lies past ``k``. Every candidate day is the same
    working-time position, so a delta measured in working time does not depend on
    the choice, and with no start-of-day milestone in any run's shown offset it is
    exactly the day the pre-#4204 shown-day ranking reported. An outranked one can
    still differ by a day: the old ranking interpolated over its whole-day offset,
    so a milestone that does not finish the run could pick the day. With no run at
    ``k`` (interpolation between two positions) it is the end of the working day
    before ``k`` — unless a run at an earlier position is shown on a later day, in
    which case it is that run's day.

    That exception exists for mixed calendars (#4691). The reference ruler is the
    union of every calendar's working days, so it can hold a day no run can finish
    on — a Friday when every task works Monday-Thursday — and interpolation can land
    ``k`` on it. A run at a lower position can then be shown *after* ``k``: a
    start-of-day milestone at the end of Thursday is shown at the start of Monday,
    and reporting the end of the Friday in between put the percentile before P50,
    before every date in ``distribution`` and before the CPM finish. Lifting the
    gap reading to the latest day shown by any run below ``k`` keeps it at or after
    every run it ranks above. With one calendar a run is shown at most one working
    day past its position, so that day is never past ``k`` and the reading is
    unchanged. Each percentile is then clamped to at least the one before it, so
    ``p50 <= p80 <= p95`` holds as an invariant of this function rather than of its
    inputs.

    Limit: on mixed calendars the reference ruler can hold days a milestone's own
    calendar skips, so a start-of-day run may be shown more than one reference day
    past its position; the reading is still start-of-day, and the API reads it
    against the project calendar. A gap reading with no such run below it can still
    be a ruler day no task works (the end of that Friday): it lies between the runs
    either side of it, so it stays inside the distribution's range.
    """
    n = len(completion_offsets)
    # Every position is keyed by the day it falls in (#4697, :func:`_finish_day_key`).
    shown_rounded = _finish_day_key(shown_offsets)
    rounded_positions = _finish_day_key(completion_offsets)
    out: list[tuple[date, bool]] = []
    for q, pct in zip(
        (50, 80, 95), np.percentile(completion_offsets, [50, 80, 95]).tolist(), strict=True
    ):
        k = math.ceil(pct - _MC_DAY_EPS)
        at_k = rounded_positions == k
        if at_k.any():
            candidates = np.unique(shown_rounded[at_k])  # ascending
            shown = float(candidates[-1])
            for d in candidates.tolist():
                # Integer arithmetic: at least q% of ALL runs are shown on or before d.
                if int(np.count_nonzero(shown_rounded <= d)) * 100 >= q * n:
                    shown = float(d)
                    break
        else:
            # No run at k. Every run below k ranks before the percentile, so it must
            # not be shown on a later day than the percentile is (#4691).
            below = shown_rounded[rounded_positions < k]
            shown = max(float(k), float(below.max())) if below.size else float(k)
        at_start = shown > k
        resolved = _offset_to_date(shown, wd_index, None)
        reading = (
            (finish_floor, floor_at_day_start)
            if finish_floor is not None and finish_floor > resolved
            else (resolved, at_start)
        )
        # The start of a day precedes its end: order by (date, not at_day_start).
        if out and (reading[0], not reading[1]) < (out[-1][0], not out[-1][1]):
            reading = out[-1]
        out.append(reading)
    return out


def monte_carlo(
    project: Project,
    *,
    runs: int = 1_000,
    seed: int | None = None,
    max_runs: int | None = None,
    max_tasks: int | None = None,
    sensitivity_cap: int = MC_SENSITIVITY_CAP,
    max_lag_delta_cells: int = MAX_LAG_DELTA_CELLS,
    max_index_cells: int = MAX_INDEX_CELLS,
) -> MonteCarloResult:
    """Run Monte Carlo probabilistic scheduling on a project.

    Where :func:`schedule` answers "when can this finish?" with one deterministic
    date, this answers "how confident are we in that date?" with a distribution.
    The percentiles are read as: **P50** — half the runs finished by here, close to
    the CPM finish, a midpoint and never a commitment; **P80** — the conventional
    commitment date for internal and stakeholder plans; **P95** — for contractual
    or externally-visible deadlines. A P80 later than the CPM finish is not a
    disagreement between the two passes: it is the risk premium the deterministic
    pass cannot express.

    Each task's per-run duration is sampled by one of three paths, in priority order:

    1. **Agile / velocity** — a task with ``delivery_mode=SCRUM`` and
       ``story_points``, on a project carrying ``velocity_samples`` +
       ``sprint_length_days``, samples sprints-to-completion from the team's
       throughput distribution (see :func:`_sample_velocity_durations`). This is how
       sprint-delivered work contributes real velocity-driven risk to a mixed-mode
       schedule rather than being invisible to the simulation.
    2. **Three-point PERT** — a task with all of (optimistic, most_likely,
       pessimistic) set samples from a PERT-Beta distribution: a Beta fitted by
       method of moments to the classic PERT mean ``(o + 4m + p) / 6`` and
       standard deviation ``(p - o) / 6``, **not** the lambda=4 Beta-PERT of
       @RISK / Vose (ADR-1245, #4133). On a symmetric estimate its band is slightly
       narrower than lambda=4's (see :func:`_sample_pert`).
    3. **Deterministic** — any other task uses its fixed ``duration`` every run.

    A mixed project (scrum subtree + waterfall tasks) therefore produces a single
    finish-date distribution combining both sources of uncertainty.

    .. note::
       Every sampled duration is **floored at the task's own ``duration``** (#3765).
       ``Task.duration`` is the plan; a three-point estimate or a velocity signal is
       the risk band read *upward* from it. Without the floor a task whose estimates
       sat below its planned duration made P50/P80/P95 land before the earliest date
       the deterministic pass considers feasible — the simulation reporting less risk
       than the plan it is meant to stress. The consequence is that the optimistic
       tail below ``duration`` is not expressed: to model finishing ahead of plan,
       lower ``duration``. Ordering the triple does not substitute for this — a
       bracketing but left-skewed triple such as ``(1, 1, 20)`` against
       ``duration=20`` violated the binding just as hard.

    .. note::
       The per-run sprint horizon of the velocity path is capped at
       ``ceil(story_points / mean_velocity) * 4 + 10`` sprints; any run that has
       not burned down by that horizon is clamped to it rather than sampled
       further. This truncates the slow right tail, so for a team with extreme
       throughput variance the velocity-driven P80/P95 is a (very loose) *lower*
       bound on completion, not an unbiased estimate. The cap exists to keep a
       pathological bootstrap path from spinning; it is far beyond any realistic
       sprint count and does not affect typical teams.

    The CPM network is evaluated `runs` times with sampled durations.
    All 4 dependency types are handled, ``planned_start`` is honored as the
    same start-no-earlier-than floor the deterministic pass applies,
    in-progress work is floored at its recorded ``actual_start`` as
    :func:`schedule` floors it (ADR-0132 §2, #2833), and zero-duration
    milestones are instants exactly as in :func:`schedule` (#4079) — a fully
    deterministic project (no estimates, no velocity signal) simulates to
    precisely the CPM finish date. A zero-duration task with an estimate is that
    instant in the runs whose draw rounds away, and ordinary work otherwise
    (:func:`_mc_zero_base_column`, #4698). **Never before is the invariant on an FS/SS
    network**, and it holds for an uncertain one too: the early-start floors bind
    the start dates (see :func:`_mc_es_floors`) and the duration floor above binds
    the durations, so every percentile is at or after the deterministic finish for
    any input built only from Finish-to-Start and Start-to-Start dependencies. An
    ``actual_start`` recorded on a *non-working* day is equality too, not an
    exception (#4175): the working-day index cannot represent the date, but the two
    readers of it that could move the finish — a live milestone floored at it and an
    SS successor of the work it starts — resolve from the verbatim date, as
    :func:`schedule` does. (Before #4175 the bound stated here was "at most one
    working day after", and it was false: a calendar-day lag measured from the
    snapped Monday instead of Sunday re-landed across a weekend and the gap reached
    2-3 working days.) The one remaining rounding is on an *uncertain* project, where
    a milestone shown on its non-working actual day in only some runs is reported on
    the next working day in all of them — later, never earlier.

    .. note::
       **The invariant above does not hold on a network carrying a
       Finish-to-Finish or Start-to-Finish edge.** Those pin a task's *finish*, so
       the forward pass places its start back from that finish — a **longer**
       duration therefore starts the task **earlier**, and any SS successor keyed
       on that start inherits the earlier start. CPM itself is non-monotone in
       duration on such a network (the five-task shape in #3806: raising every
       duration to its pessimistic value moves the deterministic finish *back*,
       from 2026-07-09 to 2026-06-05), so no duration floor can bind a simulation
       to a finish that is not a lower bound in the first place. A percentile can
       therefore land before :func:`schedule`'s finish on an FF/SF network while
       ``monte_carlo()`` reproduces :func:`schedule` faithfully on every sampled
       scenario — measured at ~0.5% of random projects, all FF-carrying.
       ``test_monte_carlo_never_precedes_cpm`` in ``tests/test_contract_fuzz.py``
       scopes its finish-level assertion to FS/SS-only networks for exactly this
       reason. This is a **decided convention**, not an open defect (#3806): an
       FF/SF-driven task stays contiguous and right-aligned on its pinned finish,
       as MS Project renders it, in both this engine and the Rust/WASM engine.
       The alternative — start the task early and let the link push only its
       finish — would restore monotonicity at the cost of a start-to-finish span
       longer than the task's duration, which every downstream consumer (bar
       rendering, float, Monte Carlo's offset space) reads as the duration.

    Per-task calendars (ADR-0120 D3) are honored, on the same rule
    :func:`schedule` applies: a task's duration expands on its own calendar, and
    lag is consumed on the **successor's**. Each task's offsets live in its own
    calendar's working-day space; every edge carries the conversion between two
    spaces, and the per-run project maximum is taken after off-calendar columns are
    re-expressed against the project calendar — offsets from different working
    weeks are not otherwise comparable. A program-scoped project whose member
    projects each keep their own working week therefore gets a probabilistic band
    that agrees with its deterministic finish, rather than being refused (#1385).
    Computation is vectorised with numpy: 10 000 runs on a 200-task project
    takes about 60-100 ms on a current laptop CPU (measured on Apple Silicon,
    numpy 2.4, 2026-09: 63 ms for a PERT chain, 88 ms for a network mixing all
    four link types with lag) and more on a shared CI runner or an older server
    — ``tests/test_bench.py`` holds it under a 2 s regression tripwire, not the
    laptop figure (#3859). So the library imposes no task cap and no run cap by
    default beyond an absolute ceiling of 100 000 000 runs (``InvalidScheduleInput``
    above it) — ``monte_carlo(project, runs=10_000)`` simulates as written (the velocity
    sampler draws in bounded chunks, so memory does not grow with ``runs``). The
    ``max_runs`` / ``max_tasks`` knobs exist for an *embedding* layer that needs
    to bound work on a synchronous request path (the TruePPM API passes its own caps and returns
    ``SimulationCapExceeded`` as a 402); a standalone caller leaves them ``None``.

    Args:
        project:   The project to simulate. Must have at least one task and
                   no cyclic dependencies.
        runs:      Number of Monte Carlo iterations. Default 1 000.
        seed:      Optional RNG seed for reproducibility. With a fixed seed the
                   sampled durations — and therefore P50/P80/P95 — are
                   deterministic and independent of task insertion order, **for
                   the same numpy version and the same trueppm-scheduler
                   version**. numpy only guarantees a ``Generator``'s stream
                   (``Generator.beta`` included) within one release (NEP 19), so
                   upgrading numpy can move seeded percentiles (#4099).
        max_runs:  Maximum allowed value for ``runs``, or ``None`` for no cap.
                   Default ``None`` — the library does not cap by itself; an
                   embedding layer (e.g. the TruePPM API) passes its own value.
        max_tasks: Maximum number of tasks allowed, or ``None`` for no cap.
                   Default ``None`` (see ``max_runs``).
        sensitivity_cap: Maximum number of tasks returned in the duration
                   sensitivity tornado. Default ``MC_SENSITIVITY_CAP``. The tornado
                   is ranked over the first ``MC_SENSITIVITY_SUBSAMPLE`` runs, so
                   its cost stays flat as ``runs`` grows; P50/P80/P95 always use
                   every run.
        max_lag_delta_cells: Ceiling on the lag-delta precompute, counted as
                   (distinct dependency type/lag/calendar-pair keys) x (working-day
                   index span) cells, each stored as a 4-byte int32. Default
                   ``MAX_LAG_DELTA_CELLS`` (50M cells, ~200 MB), sized for a batch
                   caller that owns the machine. An embedder serving concurrent
                   requests should pass a smaller value; a table above it raises
                   :class:`InvalidScheduleInput` before the offending array is
                   allocated. It does not change any computed value.
        max_index_cells: Ceiling on the per-calendar working-day indices, counted as
                   (distinct calendars, by ``working_days`` and ``exceptions``) x
                   (index length) cells, each an 8-byte int64. Default
                   ``MAX_INDEX_CELLS`` (25M cells, ~200 MB), sized for a batch caller
                   that owns the machine. An embedder serving concurrent requests, or
                   accepting a ``calendars`` registry from untrusted callers, should
                   pass a smaller value; a project above it raises
                   :class:`SimulationCapExceeded` before any index is allocated. It
                   does not change any computed value.

    Returns:
        MonteCarloResult with P50, P80, P95 completion dates — each an order
        statistic over working-time finish positions, with its edge-of-day reading
        in ``p50_at_day_start`` etc. (#4204) — the full sorted distribution of shown
        finish days, and the duration-sensitivity tornado (``sensitivity``).

    Raises:
        SimulationCapExceeded: If ``runs`` exceeds ``max_runs``, the project
            has more tasks than ``max_tasks``, or its distinct calendars' working-day
            indices would exceed ``max_index_cells``.
        CyclicDependencyError: If the dependency graph contains a cycle.
        InvalidScheduleInput: If a calendar has no working day, a duration
            or lag is negative/out of range, the project has no tasks,
            ``runs`` is less than 1 or above the absolute ceiling, ``seed`` is
            not a non-negative int or ``None``, ``max_runs``/``max_tasks`` is
            not an int or ``None``, ``sensitivity_cap`` / ``max_lag_delta_cells`` /
            ``max_index_cells`` is not a non-negative int, or ``project`` is not a
            :class:`Project` or has a malformed ``tasks``/``dependencies``/``calendar``
            container.
    """
    _validate_monte_carlo_args(
        project,
        runs,
        seed,
        max_runs,
        max_tasks,
        sensitivity_cap,
        max_lag_delta_cells,
        max_index_cells,
    )
    _validate_project(project)

    g = _build_graph(project)
    # Detect cycles via the topological sort itself (#1526), the same happy-path
    # optimization as schedule(): the lexicographic sort raises NetworkXUnfeasible
    # on a cycle in ~3ms, so the eager cycle search (~148ms) is replaced by the
    # SCC + BFS in _canonical_cycle, which runs only on the error path, in
    # _raise_cycle_error.
    #
    # Use a lexicographically-keyed topological sort so the RNG is consumed in a
    # deterministic, version-independent order. Plain ``nx.topological_sort`` only
    # guarantees *a* valid topological order; its tie-breaking is an implementation
    # detail that can shift between networkx versions (dep cap is wide:
    # networkx>=3.0,<4) and with task insertion order. Because durations are sampled
    # column-by-column in this order from a single seeded RNG, any reordering would
    # silently change seeded P50/P80/P95. Keying on the stable task id pins the order.
    try:
        topo_order: list[str] = list(nx.lexicographical_topological_sort(g, key=str))
    except nx.NetworkXUnfeasible:
        _raise_cycle_error(g)
    n_tasks = len(topo_order)
    task_idx = {tid: i for i, tid in enumerate(topo_order)}

    rng = np.random.default_rng(seed)
    calendar = project.calendar

    # --- Sample durations: shape (runs, n_tasks) ---
    task_map = {t.id: t for t in project.tasks}
    dur_matrix = _sample_duration_matrix(project, topo_order, task_map, runs, rng)

    # Pre-compute a working-day index covering the whole simulation so a lag can
    # be converted to working-day offsets against the predecessor's *actual* date
    # in each run — matching deterministic CPM, which snaps ``predecessor date +
    # lag`` to the next working day per task rather than against a single
    # reference date (issue #824). The same index is reused for the offset→date
    # conversion below. It is sized further down, once each task's calendar is known.

    # Per-task calendars (ADR-0120 D3, #1385): one working-day index per *distinct*
    # calendar. "Distinct" is by CONTENT (``working_days`` plus the exceptions tuple),
    # not object identity (#4692): a registry of K calendars that are all Mon-Fri
    # needs one index, not K, and an index is the one structure whose size scales with
    # the project span. Calendar holds a mutable-looking exceptions field and is not
    # hashable itself, so the content key is a tuple; its hash is memoized per object
    # so a 100k-exception calendar shared by many tasks is hashed once. The key every
    # downstream lookup uses is the id() of the first calendar object with that
    # content. A project with no registry resolves every task to the pass-level
    # calendar, so exactly one index is built and every lookup is what it was before.
    task_calendars = _resolve_task_calendars(project)
    cal_of: dict[str, Calendar] = {
        tid: (calendar if task_calendars is None else task_calendars.get(tid, calendar))
        for tid in topo_order
    }
    canonical_of_obj: dict[int, int] = {}
    canonical_of_content: dict[tuple[int, tuple[DateRange, ...]], int] = {}
    distinct_cals: dict[int, Calendar] = {}

    def canonical_key(cal: Calendar) -> int:
        key = canonical_of_obj.get(id(cal))
        if key is None:
            content = (cal.working_days, tuple(cal.exceptions))
            key = canonical_of_content.setdefault(content, id(cal))
            canonical_of_obj[id(cal)] = key
            distinct_cals.setdefault(key, cal)
        return key

    canonical_key(calendar)
    cal_key_of = {tid: canonical_key(cal) for tid, cal in cal_of.items()}
    # An SF-linked task can be placed before the project start (#4218); the index then
    # opens early enough to hold it. ``pad_days`` is 0 for a project with no SF-linked
    # task, leaving every index — and so every offset — exactly as before.
    pad_days, sf_linked_ids = _mc_pre_start_pad_days(project, task_map, topo_order, g, cal_of)
    index_origin = _safe_offset(project.start_date, timedelta(days=-pad_days))
    # Every index has the same length: the most working days ANY calendar has between
    # the index origin and a calendar date no run finishes after (#4429). The bound is
    # a date, not a working-day count, because working days are not comparable across
    # calendars — D days on a four-day week span more than D days of a five-day one,
    # so a count summed over task durations undersized every denser calendar's index.
    # Sized by its densest calendar, each index therefore reaches that date.
    index_size = _mc_index_size(
        _mc_horizon(project, task_map, g, topo_order, cal_of),
        index_origin,
        distinct_cals.values(),
        n_tasks,
    )
    # The index is the one structure that scales with (calendar count x span), and
    # neither max_runs, max_tasks nor the span guard reads the calendar count (#4692).
    # Refused here, from sizes alone, before any index is allocated.
    if len(distinct_cals) * index_size > max_index_cells:
        raise SimulationCapExceeded(
            f"Monte Carlo working-day indices would exceed {max_index_cells:,} cells: "
            f"{len(distinct_cals):,} distinct calendars x a {index_size:,}-day index. "
            "Reduce the number of distinct calendars or the project span."
        )
    wd_index_by_cal = {
        key: _build_working_day_index(index_origin, cal, index_size)
        for key, cal in distinct_cals.items()
    }
    # One ordinal array per calendar answers offset->date, date->offset and the
    # vectorised delta-table searchsorted alike; the offset map is the same object.
    offset_of_by_cal: dict[int, _OffsetLookup] = dict(wd_index_by_cal)
    wd_ord_by_cal = {key: idx.ords for key, idx in wd_index_by_cal.items()}
    proj_cal_key = canonical_key(calendar)
    wd_index = wd_index_by_cal[proj_cal_key]

    # The working day *before* a calendar's first indexed day — the SF anchor for a
    # predecessor that starts on it (#4145). Resolved lazily and memoized: it walks
    # the calendar backwards off the index, which a project with no SF edge should
    # neither pay for nor be able to fail on.
    _prev_ord_cache: dict[int, int] = {}

    def prev_ord_of(cal_key: int) -> int:
        if cal_key not in _prev_ord_cache:
            first = wd_index_by_cal[cal_key][0]
            _prev_ord_cache[cal_key] = _prev_working_day(
                _safe_offset(first, -_ONE_DAY), distinct_cals[cal_key]
            ).toordinal()
        return _prev_ord_cache[cal_key]

    # One shared lag-delta array per distinct (dep_type, lag, pred_cal, succ_cal)
    # key, then a per-edge lookup mapping each edge to its (possibly shared,
    # possibly None) array.
    # Live zero-duration tasks whose every run samples zero are milestone instants
    # (#4079); completed ones are pinned like any completed task, and a zero-base
    # task carrying a positive estimate is decided run by run (#4698).
    live_zero_cols = [
        (col, tid)
        for col, tid in enumerate(topo_order)
        if task_map[tid].duration.days == 0 and not _is_complete(task_map[tid])
    ]
    milestone_ids = frozenset(tid for col, tid in live_zero_cols if not dur_matrix[:, col].any())
    zero_base_ids = frozenset(tid for _, tid in live_zero_cols) - milestone_ids
    delta_by_key = _build_lag_delta_table(
        g, wd_ord_by_cal, index_size, cal_key_of, prev_ord_of, milestone_ids, max_lag_delta_cells
    )
    edge_lag_delta: dict[tuple[str, str], np.ndarray | None] = {
        (u, v): delta_by_key[(data["dep"].dep_type, data["dep"].lag, cal_key_of[u], cal_key_of[v])]
        for u, v, data in g.edges(data=True)
        if u not in milestone_ids
    }

    # Per-run-invariant floors and progress pins (SNET, data date, completed pins,
    # in-progress elapsed) — computed once, since none of them vary across runs.
    (
        es_floor,
        completed_offsets,
        completed_dates,
        completed_instants,
        elapsed_days,
    ) = _mc_progress_state(
        project,
        task_map,
        topo_order,
        g,
        task_calendars,
        cal_of,
        cal_key_of,
        offset_of_by_cal,
        wd_index_by_cal,
        sf_linked_ids,
    )

    # A completed task's dates are run-invariant, so both the constraints it imposes
    # on live successors and its own contribution to the project finish are resolved
    # once, in scalar date space, from the verbatim dates schedule() would give it
    # (#2460/#2461). Scalar dates are also what makes this survive mixed calendars:
    # each constraint is snapped into its own successor's space, and the floor below
    # is a date, so neither depends on the offsets being mutually comparable.
    completed_edge = _completed_edge_constraints(
        g,
        completed_dates,
        completed_instants,
        cal_of,
        cal_key_of,
        offset_of_by_cal,
        wd_index_by_cal,
        task_map,
    )
    completed_finish_floor = (
        max(ef_date for _es_date, ef_date in completed_dates.values()) if completed_dates else None
    )

    verbatim_actuals = _mc_verbatim_actuals(
        project, task_map, cal_of, cal_key_of, offset_of_by_cal, wd_index_by_cal, sf_linked_ids
    )
    es_mat, ef_mat, milestone_finish_floor, instant_runs = _mc_forward_pass(
        topo_order,
        runs,
        g,
        task_idx,
        edge_lag_delta,
        dur_matrix,
        es_floor,
        completed_offsets,
        completed_edge,
        elapsed_days,
        milestone_ids,
        _McIndex(
            [wd_ord_by_cal[cal_key_of[tid]] for tid in topo_order],
            [cal_of[tid] for tid in topo_order],
        ),
        verbatim_actuals,
        _mc_milestone_floors(
            project, task_map, milestone_ids | zero_base_ids, cal_of, sf_linked_ids
        ),
        zero_base_ids,
    )
    # Working-time finish of each column (#4204). Work ends at its EF. A live
    # milestone's EF is the exclusive offset of the day it is *shown* on, one past its
    # instant for a start-of-day reading, so its working-time position is its ES —
    # the end of a Friday and the start of the next Monday are the same position.
    # A zero-base column is that instant in the runs that placed it (#4698).
    wt_mat = ef_mat
    milestone_cols = [task_idx[tid] for tid in milestone_ids]
    has_instants = bool(milestone_cols or instant_runs)
    if has_instants:
        wt_mat = ef_mat.copy()
        wt_mat[:, milestone_cols] = es_mat[:, milestone_cols]
        for tid, is_instant in instant_runs.items():
            col = task_idx[tid]
            wt_mat[is_instant, col] = es_mat[is_instant, col]
    # The floor wins over the index only when it is later; it is a start-of-day
    # reading exactly when it comes from a milestone shown at the start of its
    # non-working actual day and no completed work finishes that day or later.
    floor_at_day_start = milestone_finish_floor is not None and (
        completed_finish_floor is None or milestone_finish_floor > completed_finish_floor
    )
    if milestone_finish_floor is not None:
        # A live milestone shown on its non-working actual day is a finish date the
        # working-day index cannot hold; floor at it as at completed work (#4175).
        completed_finish_floor = (
            milestone_finish_floor
            if completed_finish_floor is None
            else max(completed_finish_floor, milestone_finish_floor)
        )

    # --- Project completion offset = max EF across all tasks per run ---
    # With one calendar every column is already on the same ruler and the maximum
    # is taken exactly as it always was. With several, each column is re-expressed
    # against the union-of-working-days reference index first — raw offsets from
    # different working weeks are not comparable, and the larger offset is often
    # the earlier date.
    if len(wd_index_by_cal) > 1:
        ref_ord, wd_index = _build_reference_index(wd_ord_by_cal)

        # One lookup table per calendar, then one gather per calendar's column group,
        # written back in place: no second runs x tasks matrix (#4710).
        cols_by_cal: dict[int, list[int]] = {}
        for col, tid in enumerate(topo_order):
            cols_by_cal.setdefault(cal_key_of[tid], []).append(col)
        for cal_key, cal_cols in cols_by_cal.items():
            _to_reference_columns_inplace(
                (ef_mat, wt_mat if has_instants else None),
                np.asarray(cal_cols, dtype=np.intp),
                wd_ord_by_cal[cal_key],
                ref_ord,
            )
        if not has_instants:
            wt_mat = ef_mat
    shown_offsets = ef_mat.max(axis=1)  # shape (runs,): the day each run is shown on
    completion_offsets = wt_mat.max(axis=1)  # shape (runs,): its working-time position
    # Convert offsets back to dates via the working-day index (reused from above).
    all_dates = sorted(
        _offset_to_date(o, wd_index, completed_finish_floor) for o in shown_offsets.tolist()
    )
    percentiles = _mc_percentiles(
        completion_offsets, shown_offsets, wd_index, completed_finish_floor, floor_at_day_start
    )
    (p50, p50_start), (p80, p80_start), (p95, p95_start) = percentiles

    # Duration-sensitivity tornado (ADR-0140) — which tasks' sampled durations
    # most move the finish, from the same sampled matrix (no second pass). Computed
    # over a fixed subsample of the runs (#1525): the tornado ranks tasks by
    # |spearman(duration, finish)|, which converges long before the full run count,
    # so ranking every column over all runs is wasted work at scale. The first
    # ``MC_SENSITIVITY_SUBSAMPLE`` rows are a valid subsample — each run is an
    # i.i.d. iteration with no ordering — and a contiguous slice keeps the choice
    # deterministic and task-order-independent (no RNG, no copy). Slicing past the
    # end returns every row, so runs <= the cap needs no special case. Percentiles
    # above use the FULL distribution; only the ranking is subsampled.
    sensitivity = _duration_sensitivity(
        dur_matrix[:MC_SENSITIVITY_SUBSAMPLE],
        completion_offsets[:MC_SENSITIVITY_SUBSAMPLE],
        topo_order,
        sensitivity_cap,
    )

    return MonteCarloResult(
        project_id=project.id,
        runs=runs,
        p50=p50,
        p80=p80,
        p95=p95,
        distribution=all_dates,
        sensitivity=sensitivity,
        p50_at_day_start=p50_start,
        p80_at_day_start=p80_start,
        p95_at_day_start=p95_start,
    )
