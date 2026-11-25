"""Monte Carlo duration sampling, sensitivity and :func:`perturb_task_duration`."""

from __future__ import annotations

from collections.abc import (
    Callable,
    Iterator,
    Mapping,
    Sequence,
)
from dataclasses import (
    replace,
)
from datetime import (
    date,
    timedelta,
)
from typing import (
    overload,
)

import numpy as np

from trueppm_scheduler.engine.calendar_math import (
    _MAX_ORDINAL,
    _effective_duration_days,
    _elapsed_working_days,
    _is_complete,
    _next_working_day,
    _safe_offset,
)
from trueppm_scheduler.engine.cpm import (
    _require_project,
)
from trueppm_scheduler.engine.errors import (
    InvalidScheduleInput,
    SimulationCapExceeded,
)
from trueppm_scheduler.engine.graph import (
    _resolve_task_calendars,
)
from trueppm_scheduler.engine.limits import (
    MAX_CALENDAR_SCAN_DAYS,
    MAX_DURATION_DAYS,
    MAX_INDEX_CELLS,
    MAX_LAG_DELTA_CELLS,
    MAX_PROJECT_SPAN_DAYS,
    MAX_VELOCITY_SPRINTS,
    MC_SENSITIVITY_CAP,
)
from trueppm_scheduler.engine.milestones import (
    _ONE_DAY,
)
from trueppm_scheduler.engine.montecarlo.capacity import (
    _capacity_block_runs,
)
from trueppm_scheduler.engine.results import (
    TaskSensitivity,
)
from trueppm_scheduler.engine.validate import (
    _validate_project_shape,
    _velocity_days_on_calendar,
    _velocity_mean,
    _velocity_observations,
)
from trueppm_scheduler.models import (
    Calendar,
    DeliveryMode,
    Project,
    Task,
    _short_repr,
)

# ---------------------------------------------------------------------------
# Monte Carlo simulation
# ---------------------------------------------------------------------------


def _sample_pert(
    opt: float,
    ml: float,
    pess: float,
    n: int,
    rng: np.random.Generator,
) -> np.ndarray:
    """Sample n durations from a PERT-Beta distribution.

    The convention is a Beta scaled to [opt, pess] and **fitted by method of
    moments to the classic PERT mean ``(opt + 4*ml + pess) / 6`` and standard
    deviation ``(pess - opt) / 6``** — not the lambda=4 Beta-PERT of Vose / @RISK
    (``alpha = 1 + 4(ml - opt)/(pess - opt)``). Both share the mean; the spread
    differs. On a symmetric triple this fit is ~12% tighter than lambda=4 (so its
    P80/P95 land slightly earlier); on a triple whose mode sits at an end it is
    wider (#4133). Switching conventions would move every seeded percentile, so it
    is a semantics change with a migration, not a bugfix (ADR-1245).

    When opt == pess (degenerate task), returns the constant ``ml``.
    """
    if pess - opt < 1e-9:
        return np.full(n, ml)

    # PERT mean and variance via the standard formulas.
    mu = (opt + 4.0 * ml + pess) / 6.0
    sigma = (pess - opt) / 6.0
    sigma2 = sigma**2

    # Normalize mu to [0, 1] for the Beta parameterisation. For an ordered triple
    # (opt <= ml <= pess) mu_norm lies in [1/6, 5/6] and kappa >= 4, so alpha and
    # beta are both >= 2/3: no clip and no non-positive-parameter fallback is needed.
    # (alpha or beta < 1 is reachable when ml == opt or ml == pess; ADR-1245.)
    range_ = pess - opt
    mu_norm = (mu - opt) / range_
    var_norm = sigma2 / (range_**2)

    # Method-of-moments Beta parameters.
    kappa = mu_norm * (1.0 - mu_norm) / var_norm - 1.0
    alpha = mu_norm * kappa
    beta_param = (1.0 - mu_norm) * kappa

    samples = rng.beta(alpha, beta_param, size=n)
    return opt + samples * range_


# Cells (runs x sprints) drawn per chunk in _sample_velocity_durations; ~17 bytes per
# cell transient (draw + cumsum + mask), so ~1M cells keeps the peak near 20 MB.
_VELOCITY_CHUNK_CELLS = 1 << 20


# Float-accumulation slack for "cumulative velocity reached the backlog" (#4699).
_VELOCITY_REACH_RTOL = 1.0 - 1e-12


def _sample_velocity_durations(
    story_points: float,
    velocity_samples: list[float],
    sprint_length_days: int,
    n: int,
    rng: np.random.Generator,
    saturated: np.ndarray | None = None,
) -> np.ndarray | None:
    """Sample n durations (in working days) for a scrum task from team velocity (#411).

    This is throughput Monte Carlo, not three-point estimation: instead of perturbing
    a duration estimate, it asks "how many sprints to burn down ``story_points`` given
    the team's historical per-sprint throughput?" For each run it bootstrap-samples
    completed-points-per-sprint observations (``velocity_samples``) with replacement,
    accumulates them, and counts the sprints needed to reach ``story_points``; the
    duration is that sprint count times ``sprint_length_days`` working days. A faster team
    (high-throughput draws) finishes in fewer sprints; the slow tail finishes later —
    so the spread reflects velocity variability, the real driver of agile uncertainty.

    Returns ``None`` (caller falls back to the deterministic duration) when there is no
    usable signal: no velocity observation, an all-zero history (no pace to project,
    so the sprints-to-completion is unbounded), non-positive ``story_points``, or a
    non-positive sprint length. Zero-point sprints are bootstrapped like any other
    observation (#4535) — see :func:`_velocity_observations`. With a single sample the
    result is a constant (degenerate distribution) — honest: one data point cannot
    express variance. A run that draws zeros long enough to reach the horizon clamps
    to it, so the draw stays bounded whatever the zero share. The draw is chunked by run, so
    peak memory is about 20 MB regardless of ``n`` and the sprint horizon, and the
    seeded stream is consumed in the same order as one full matrix.

    ``saturated``, when given, is a boolean vector of length ``n``: every run that
    reached the horizon without burning down is set in it (#2469). Such a run's
    duration is the horizon, a lower bound on the time it would have taken, so a
    caller reports the result's slow tail as truncated rather than as an estimate.
    """
    observations = np.asarray(_velocity_observations(velocity_samples), dtype=float)
    if story_points <= 0 or observations.size == 0 or sprint_length_days <= 0:
        return None

    mean = float(observations.mean())
    if mean <= 0:
        return None
    # Bound the per-run sprint horizon so a pathologically slow bootstrap path can't
    # spin: 4x the mean-pace sprint count plus a floor. Runs that still haven't burned
    # down by then clamp to the cap (a deep-tail outlier), keeping the sim finite.
    # The absolute MAX_VELOCITY_SPRINTS ceiling bounds the per-run draw (``max_sprints``
    # floats) independently of ``sprint_length_days`` (#1202): without
    # it, ``sprint_length_days=1`` lets the span guard pass a ~360k horizon and a
    # single scrum task allocates multi-GB. _velocity_worst_case_days applies the
    # identical clamp so the MC index stays correctly sized (#1067).
    max_sprints = min(int(np.ceil(story_points / mean)) * 4 + 10, MAX_VELOCITY_SPRINTS)
    # ``rng.choice(..., size=(n, max_sprints))`` fills row-major from one sequential
    # integer stream, so run i owns the contiguous slice [i*max_sprints, (i+1)*max_sprints).
    # Drawing whole-row chunks therefore consumes the stream in the identical order: the
    # seeded result and the generator's final state are bit-identical to the one-shot
    # (n, max_sprints) matrix, while peak memory is O(chunk * max_sprints) instead of
    # O(n * max_sprints).
    sprints_needed = np.empty(n, dtype=np.int64)
    chunk_rows = max(1, _VELOCITY_CHUNK_CELLS // max_sprints)
    for lo in range(0, n, chunk_rows):
        rows = min(chunk_rows, n - lo)
        draws = rng.choice(observations, size=(rows, max_sprints), replace=True)
        # Relative tolerance: summing k float draws can land an ulp short of a
        # target that is exactly k*v on paper (0.1 ten times is 0.9999999999999999),
        # which would count a whole extra sprint (#4699).
        reached = np.cumsum(draws, axis=1) >= story_points * _VELOCITY_REACH_RTOL
        burned_down = reached.any(axis=1)
        sprints_needed[lo : lo + rows] = np.where(
            burned_down,
            reached.argmax(axis=1) + 1,  # first sprint index that meets the target (+1 = count)
            max_sprints,
        )
        if saturated is not None:
            saturated[lo : lo + rows] |= ~burned_down
    return sprints_needed.astype(np.float64) * float(sprint_length_days)


#: :attr:`MonteCarloResult.velocity_fallback_reasons` value: the project carries
#: ``velocity_samples`` but no ``sprint_length_days``, so no sprint has a length (#5013).
VELOCITY_FALLBACK_NO_SPRINT_LENGTH = "sprint_length_days_missing"
#: The history holds no usable observation or its mean is not positive (an all-zero
#: history): there is no pace to project (#5013).
VELOCITY_FALLBACK_UNUSABLE_HISTORY = "velocity_history_unusable"


def _velocity_candidates(project: Project) -> list[Task]:
    """SCRUM tasks with positive committed story points: what the velocity path claims."""
    return [
        t
        for t in project.tasks
        if t.delivery_mode == DeliveryMode.SCRUM
        and t.story_points is not None
        and t.story_points > 0
    ]


def _remaining_story_points(task: Task) -> float:
    """Story points still to deliver: ``story_points * (1 - percent_complete / 100)``.

    Progress on a velocity task is measured in its own unit, points (#5012). The
    elapsed days :func:`_effective_duration_days` reads off ``duration`` have no
    relation to how many sprints the points take, so they are not used here.
    """
    assert task.story_points is not None
    pct = min(max(task.percent_complete or 0.0, 0.0), 100.0)
    return float(task.story_points) * (1.0 - pct / 100.0)


def _velocity_points(project: Project) -> dict[str, float]:
    """Remaining points of every live task the shared-capacity model forecasts (ADR-1412).

    Empty when the project cannot run the velocity path (no history, no sprint length,
    or no positive mean velocity); those tasks then take PERT or their deterministic
    duration and :func:`_velocity_fallback_reasons` says why.
    """
    if (
        not project.velocity_samples
        or project.sprint_length_days is None
        or _velocity_mean(project) is None
    ):
        return {}
    points: dict[str, float] = {}
    for t in _velocity_candidates(project):
        if _is_complete(t):
            continue
        remaining = _remaining_story_points(t)
        if remaining > 0:
            points[t.id] = remaining
    return points


def _velocity_fallback_reasons(project: Project) -> tuple[str, ...]:
    """Why a project that supplied a velocity history did not use it (#5013).

    Empty when the history was used or none was supplied, or when no SCRUM task
    carries story points (nothing would have read the history).
    """
    if not project.velocity_samples or not _velocity_candidates(project):
        return ()
    reasons: list[str] = []
    if project.sprint_length_days is None:
        reasons.append(VELOCITY_FALLBACK_NO_SPRINT_LENGTH)
    if _velocity_mean(project) is None:
        reasons.append(VELOCITY_FALLBACK_UNUSABLE_HISTORY)
    return tuple(reasons)


def _velocity_capacity_horizon(
    project: Project, points: Mapping[str, float], ready_days: int
) -> int:
    """Sprints of team capacity each run draws for the shared-capacity model.

    The old per-task horizon, ``ceil(points / mean) * 4 + 10``, applied to the whole
    remaining backlog, plus the sprints that can pass before the last story is ready
    (``ready_days`` project-calendar working days from the sprint origin to where the
    walk with no velocity term ends). Clamped at :data:`MAX_VELOCITY_SPRINTS` and so
    that the capacity span stays inside :data:`MAX_PROJECT_SPAN_DAYS`. A run that runs
    out of drawn capacity clamps and is counted as saturated (#2469).
    """
    mean = _velocity_mean(project)
    sprint_days = project.sprint_length_days
    assert mean is not None and sprint_days is not None and sprint_days > 0
    backlog = float(sum(points.values()))
    sprints = int(np.ceil(backlog / mean)) * 4 + 10 + -(-ready_days // sprint_days)
    return max(1, min(sprints, MAX_VELOCITY_SPRINTS, MAX_PROJECT_SPAN_DAYS // sprint_days))


def _draw_velocity_capacity_seeds(runs: int, sprints: int, rng: np.random.Generator) -> np.ndarray:
    """One seed per block of runs for the shared-capacity draws (ADR-1412).

    The velocity vectors themselves are drawn per forward-pass chunk from these
    (:meth:`_VelocityCapacity.rows`), so the ``(runs, sprints)`` matrix never exists
    whole: at a 10,000-sprint horizon it would be 800 MB for 10,000 runs (#4694). The
    seeds come from the seeded stream, after every per-task column, so a fixed seed
    gives identical results and a project without velocity consumes the stream
    exactly as before.
    """
    blocks = -(-runs // _capacity_block_runs(sprints))
    return rng.integers(0, np.iinfo(np.int64).max, size=blocks, dtype=np.int64)


class _WorkingDayIndex(Sequence[date]):
    """A calendar's working days as a sorted int64 ordinal array (#4692).

    Monte Carlo needs two lookups per calendar: offset -> date (``index[k]``) and
    date -> offset (:meth:`get`). They used to be a ``list[date]`` and a
    ``dict[date, int]`` beside an ordinal array, i.e. three structures as long as the
    project span per calendar (~55 MB each at the maximum span). The sorted ordinal
    array answers both — ``ords[k]`` and a binary search — in 8 bytes per cell, so
    the list and the dict are never built. It stays a ``Sequence[date]`` with a
    ``dict``-style ``get`` so every consumer written against the list and the dict
    reads it unchanged.
    """

    __slots__ = ("ords",)

    def __init__(self, ords: np.ndarray) -> None:
        self.ords = ords

    def __len__(self) -> int:
        return int(self.ords.shape[0])

    @overload
    def __getitem__(self, i: int) -> date: ...
    @overload
    def __getitem__(self, i: slice) -> list[date]: ...
    def __getitem__(self, i: int | slice) -> date | list[date]:
        if isinstance(i, slice):
            return [date.fromordinal(o) for o in self.ords[i].tolist()]
        n = len(self)
        if i < 0:
            i += n
        if not 0 <= i < n:
            raise IndexError("working-day index out of range")
        return date.fromordinal(int(self.ords[i]))

    def __iter__(self) -> Iterator[date]:
        return (date.fromordinal(o) for o in self.ords.tolist())

    def __contains__(self, d: object) -> bool:
        return isinstance(d, date) and self.get(d) is not None

    def get(self, d: date, default: int | None = None) -> int | None:
        """Offset of working day ``d``, or ``default`` when ``d`` is not on the index."""
        o = d.toordinal()
        pos = int(np.searchsorted(self.ords, o, side="left"))
        if pos < self.ords.shape[0] and int(self.ords[pos]) == o:
            return pos
        return default


# What the Monte Carlo helpers accept for the date -> offset lookup and the
# offset -> date sequence: the ordinal-backed index in production, a plain dict /
# list in the unit tests that drive a helper directly.
_OffsetLookup = Mapping[date, int] | _WorkingDayIndex


def _build_working_day_index(
    start: date, calendar: Calendar, n_working_days: int
) -> _WorkingDayIndex:
    """Build a lookup: ``index[k]`` = the k-th working day from start.

    Used to convert integer working-day offsets (from MC simulation) back to dates.

    Both the initial snap and the walk off it are guarded against a degenerate
    calendar, so a Monte Carlo run on a project whose ``exceptions`` blanket the
    schedule raises a documented :class:`InvalidScheduleInput` rather than spinning
    to an ``OverflowError``: the first day goes through :func:`_next_working_day`,
    and a gap of more than :data:`MAX_CALENDAR_SCAN_DAYS` between consecutive working
    days, or running out of representable dates, raises the same errors
    :func:`_scan_for_working_day` does. This is the Monte Carlo counterpart to the
    snap that guards :func:`schedule`'s forward pass.

    The days are generated in vectorized chunks (weekday mask, then a binary search
    over the calendar's merged exception runs) rather than by a Python day walk, so
    building the index costs milliseconds, not the ~0.17 s per calendar the day loop
    cost at the maximum span (#4692).

    ``n_working_days`` counts working days of *this* calendar, so the calendar-day
    span the index reaches depends on how sparse the calendar is. ``monte_carlo``
    passes :func:`_mc_index_size`, the most working days any of its calendars has up
    to :func:`_mc_horizon`'s date bound, so every calendar's index reaches that date
    (#4429). A working-day count summed over task durations does not: on a denser
    calendar it ends before a sparse predecessor's work does.
    """
    if n_working_days <= 0:
        return _WorkingDayIndex(np.empty(0, dtype=np.int64))
    cur = _next_working_day(start, calendar).toordinal()
    mask = calendar.working_days
    weekday_ok = np.array([(mask >> w) & 1 for w in range(7)], dtype=bool)
    density = max(1, bin(mask & 0x7F).count("1"))
    exc_starts: np.ndarray | None = None
    exc_ends: np.ndarray | None = None
    if calendar.exceptions:
        starts_l, ends_l, _ = calendar._exception_intervals()
        exc_starts = np.asarray(starts_l, dtype=np.int64)
        exc_ends = np.asarray(ends_l, dtype=np.int64)
    chunks: list[np.ndarray] = []
    have = 0
    prev: int | None = None  # ordinal of the last working day found
    while have < n_working_days:
        remaining = n_working_days - have
        hi = min(cur + min(remaining * 7 // density + 64, 2_000_000), _MAX_ORDINAL + 1)
        if cur >= hi:
            # Ran off the end of the representable dates: raise the overflow error.
            _safe_offset(date.max, _ONE_DAY)
        cand = np.arange(cur, hi, dtype=np.int64)
        ok = weekday_ok[(cand - 1) % 7]
        if exc_starts is not None and exc_ends is not None:
            run = np.searchsorted(exc_starts, cand, side="right") - 1
            in_exc = (run >= 0) & (cand <= exc_ends[np.maximum(run, 0)])
            ok &= ~in_exc
        found = cand[ok]
        degenerate = (prev is None or hi - 1 - prev > MAX_CALENDAR_SCAN_DAYS) and not found.size
        if found.size:
            gaps = np.diff(found, prepend=found[0] if prev is None else prev)
            degenerate = int(gaps.max()) > MAX_CALENDAR_SCAN_DAYS
        if degenerate:
            raise InvalidScheduleInput(
                f"Calendar has no working day within {MAX_CALENDAR_SCAN_DAYS} days "
                "of the requested date; check the working_days bitmask and exceptions."
            )
        take = found[:remaining]
        chunks.append(take)
        have += int(take.size)
        if take.size:
            prev = int(take[-1])
        cur = hi
    return _WorkingDayIndex(np.concatenate(chunks))


def _average_ranks(a: np.ndarray) -> np.ndarray:
    """Return the average (tie-corrected) ranks of a 1-D array.

    This is the ranking convention `scipy.stats.rankdata(method="average")` uses,
    reimplemented with numpy so the scheduler keeps its numpy-only
    dependency footprint. Ties share the mean of the ranks they span — required
    for a correct Spearman correlation when the data has repeated values (common
    here: completion offsets and sampled durations are discrete working-day
    counts, so ties are the rule, not the exception).
    """
    # The default introsort (unstable) is correct here even with ties: the
    # average-rank convention below groups purely by exact value equality, so the
    # dense rank and the averaged rank are identical no matter how the sort permutes
    # equal elements. The result is therefore tie-order-invariant and deterministic
    # for fixed input — a stable sort would only add cost (#1525).
    sorter = np.argsort(a)
    inv = np.empty(a.shape[0], dtype=np.intp)
    inv[sorter] = np.arange(a.shape[0])
    a_sorted = a[sorter]
    # `obs[i]` marks the start of a new value-group in the sorted array.
    obs = np.r_[True, a_sorted[1:] != a_sorted[:-1]]
    dense = obs.cumsum()[inv]  # 1-based dense rank of each element
    # Cumulative counts at each group boundary; the average rank of a group is the
    # mean of its first and last 1-based positions.
    counts = np.r_[np.nonzero(obs)[0], a.shape[0]]
    ranks: np.ndarray = 0.5 * (counts[dense] + counts[dense - 1] + 1)
    return ranks


def _duration_sensitivity(
    dur_matrix: np.ndarray | Callable[[int], np.ndarray],
    completion_offsets: np.ndarray,
    topo_order: list[str],
    cap: int,
) -> list[TaskSensitivity]:
    """Rank tasks by how strongly their sampled duration moves the project finish.

    The sensitivity index of a task is ``|spearman(duration, finish)|`` across all
    runs — the @RISK-style duration tornado (ADR-0140). Returns the top ``cap``
    tasks by index, descending. Tasks whose sampled duration has zero variance
    (deterministic, completed, or milestone) cannot move the finish and are
    omitted; if the finish itself has zero variance (fully deterministic project)
    the result is empty.

    ``dur_matrix`` is the ``(runs, n_tasks)`` matrix, or a ``col -> column`` getter
    when the matrix is replayed rather than held (:class:`_SampledDurations`, #3824).

    ``cap`` bounds the **output**, not the compute (#4530). Each task's index needs
    its own rank pass over the sampled duration column, and no cheaper exact
    pre-filter says which columns can reach the top ``cap`` without computing them,
    so every non-constant task is scored before the list is cut. Selecting the top
    ``cap`` with ``heapq.nlargest`` instead of sorting would not help: the final
    sort is a negligible share of the cost, the per-column ranking is the rest. The
    cost is bounded by ``MC_SENSITIVITY_SUBSAMPLE`` runs per task, not by ``cap``.
    """
    runs = completion_offsets.shape[0]
    if runs < 2:
        return []
    # Rank the finish once; if every run finished on the same offset there is no
    # variance to attribute and the whole tornado is empty.
    if np.ptp(completion_offsets) == 0:
        return []
    y = _average_ranks(completion_offsets)
    yc = y - y.mean()
    y_norm = float(np.sqrt(np.dot(yc, yc)))
    # Div-by-zero guard: a norm is sqrt(dot(v, v)) so it is always >= 0; `<= 0.0`
    # is equivalent to `== 0.0` here but avoids a float-equality comparison (S1244).
    if y_norm <= 0.0:
        return []

    scored: list[TaskSensitivity] = []
    for col, tid in enumerate(topo_order):
        x = dur_matrix(col) if callable(dur_matrix) else dur_matrix[:, col]
        # Fast-path: a constant-duration column (completed task, deterministic
        # duration, zero-duration milestone) cannot correlate with the finish.
        # Skip it before paying for the rank sort.
        if np.ptp(x) == 0:
            continue
        xr = _average_ranks(x)
        xc = xr - xr.mean()
        x_norm = float(np.sqrt(np.dot(xc, xc)))
        # Same div-by-zero guard as y_norm above: a norm is always >= 0, so `<= 0.0`
        # matches `== 0.0` without a float-equality comparison (S1244).
        if x_norm <= 0.0:
            continue
        # Clamped to [-1, 1] before abs() (#3765). A Spearman correlation cannot
        # mathematically leave that interval, but this computes it as a raw
        # dot-product ratio, and when the two centred rank vectors are collinear the
        # division rounds to 1.0000000000000002 — an index ABOVE the 0..1 the public
        # contract and ADR-0140 both promise, which the API serializes through a bare
        # FloatField with no max_value straight to the client.
        #
        # The overshoot is latent without the duration floor and reachable with it:
        # flooring collapses a sampled column onto a single tied value, and a
        # tie-dense column ranks to a near-constant vector whose correlation with the
        # finish is exactly ±1 in exact arithmetic — precisely the collinear case that
        # rounds out of range. Measured over 800 sensitivity entries on the same
        # projects and seeds: 0 above 1.0 with the floor off, 105 with it on.
        corr = float(np.clip(np.dot(xc, yc) / (x_norm * y_norm), -1.0, 1.0))
        scored.append(TaskSensitivity(task_id=tid, index=abs(corr)))

    # Sort by index desc; tie-break on task_id so the order is deterministic under
    # a fixed seed regardless of topological insertion order.
    scored.sort(key=lambda s: (-s.index, s.task_id))
    return scored[: max(0, cap)]


_MAX_RUNS_ABSOLUTE = 100_000_000  # hard ceiling on ``runs`` independent of the caller's max_runs
# Hard ceiling on the sampled-duration matrix, ``runs x tasks`` float64 cells (2 GB).
# Up to the replay threshold (``_MC_SAMPLED_MATRIX_CELLS`` in ``run.py``) the matrix is
# allocated in full; above it it is replayed a row block at a time (#3824), except when
# the forward pass reads across runs or the generator is not PCG64, where it is still
# allocated in full. Either way the sampler draws ``runs x tasks`` values, column by
# column, and the ceiling bounds that. The runs ceiling alone does not bound it, so 5M
# runs on a 200-task project reached ``np.empty`` and died with a bare MemoryError
# outside the SchedulerError contract (#1829).
_MAX_SAMPLE_CELLS = 250_000_000


def _validate_monte_carlo_args(
    project: Project,
    runs: int,
    seed: int | None,
    max_runs: int | None,
    max_tasks: int | None,
    sensitivity_cap: int = MC_SENSITIVITY_CAP,
    max_lag_delta_cells: int = MAX_LAG_DELTA_CELLS,
    max_index_cells: int = MAX_INDEX_CELLS,
) -> None:
    """Validate ``monte_carlo()``'s own parameters before any network work.

    Covers the run count, the seed, the embedding-layer caps, and the non-empty
    requirement. The schedule payload itself is validated separately by
    :func:`_validate_project`.
    """
    _require_project(project)
    # ``runs`` is a documented public int param that sizes ``np.empty((runs, ...))``.
    # A non-int leaked a bare TypeError (a str from ``runs < 1``, a float from
    # ``np.empty``) past the SchedulerError contract — the same gap the ``seed``
    # guard below already closes (#1453). bool is an int subclass but never a
    # meaningful run count, so reject it explicitly (#1825).
    if isinstance(runs, bool) or not isinstance(runs, int):
        raise InvalidScheduleInput(f"runs must be a positive integer (got {_short_repr(runs)}).")
    if runs < 1:
        raise InvalidScheduleInput(f"runs must be a positive integer (got {runs}).")
    # An absurd count otherwise reaches ``np.empty((runs, ...))`` and surfaces as a
    # bare numpy ValueError/MemoryError (#4518).
    if runs > _MAX_RUNS_ABSOLUTE and not (isinstance(max_runs, int) and runs > max_runs):
        raise InvalidScheduleInput(
            f"runs exceeds the maximum of {_MAX_RUNS_ABSOLUTE} (got {runs})."
        )
    for name, cap in (("max_runs", max_runs), ("max_tasks", max_tasks)):
        if cap is not None and (isinstance(cap, bool) or not isinstance(cap, int)):
            raise InvalidScheduleInput(
                f"{name} must be an integer or None (got {_short_repr(cap)})."
            )
    # seed is passed straight to np.random.default_rng(seed); a negative int raises
    # a bare numpy ValueError and a float/non-int a bare TypeError, both escaping the
    # documented SchedulerError contract for a documented public parameter (#1453).
    # Accept None (non-deterministic) or a non-negative int; bool is an int subclass
    # but never a meaningful seed, so reject it like the other numeric guards.
    if seed is not None and (isinstance(seed, bool) or not isinstance(seed, int) or seed < 0):
        raise InvalidScheduleInput(
            f"seed must be a non-negative integer or None (got {_short_repr(seed)})."
        )
    # The three always-int knobs have no "unset" spelling (the default is the
    # unset value), so None is rejected here rather than compared later. Checked
    # before the simulation: ``sensitivity_cap`` is first read after every run has
    # finished, so a bad value used to cost the whole simulation before failing.
    for name, knob in (
        ("sensitivity_cap", sensitivity_cap),
        ("max_lag_delta_cells", max_lag_delta_cells),
        ("max_index_cells", max_index_cells),
    ):
        if isinstance(knob, bool) or not isinstance(knob, int) or knob < 0:
            raise InvalidScheduleInput(
                f"{name} must be a non-negative integer (got {_short_repr(knob)})."
            )
    # ``len(project.tasks)`` below needs the container to be a list; a direct-object
    # Project(tasks=7) would otherwise leak a bare TypeError from len().
    _validate_project_shape(project)
    if max_tasks is not None and len(project.tasks) > max_tasks:
        raise SimulationCapExceeded(
            f"Project task count ({len(project.tasks)}) exceeds the configured "
            f"maximum (max_tasks={max_tasks}); raise max_tasks (or pass None to "
            "disable the cap) to simulate larger projects."
        )
    if max_runs is not None and runs > max_runs:
        raise SimulationCapExceeded(
            f"Requested runs ({runs}) exceeds the configured maximum "
            f"(max_runs={max_runs}); raise max_runs (or pass None to disable the "
            "cap) to allow more iterations."
        )
    if not project.tasks:
        raise InvalidScheduleInput("Project must have at least one task.")


def _floor_sampled_at_duration(column: np.ndarray, base: float) -> None:
    """Clamp one task's sampled durations, in place, up to its deterministic ``duration``.

    ``schedule()`` lays every task out at ``Task.duration``; ``monte_carlo()``
    replaces that with a sampled column whenever the task carries a velocity signal
    or a complete three-point estimate. Nothing bound the two inputs together, so a
    task whose estimates simply sit *below* its planned duration produced a forecast
    earlier than the earliest date the deterministic pass considers feasible — a risk
    tool under-reporting risk, which fails silently and plausibly (#3765, same
    invariant class as #2833).

    Ordering the triple is not enough, and that is the whole reason the floor lives
    here rather than in ``_validate_task_durations``. Requiring
    ``optimistic <= duration <= pessimistic`` still admits ``duration=20`` against
    ``(1, 1, 20)``: the PERT-Beta mass piles onto ``most_likely``, and P95 lands ~13
    working days before the CPM finish. A differential sweep over 600 random projects
    measured *more* violations under bracketing triples (152 p95, 319 p50) than
    without them (83 / 129), because bracketing forces a wide, left-skewed window
    rather than a narrow one. No ordering rule over the triple alone can bind the
    two passes; only a comparison against ``duration`` itself can.

    Rejecting the state instead was the other candidate and was refused on evidence:
    three shipped ingress paths write the triple and the duration independently and
    legitimately — the MS Project importer (PERT Analysis fields are independent of
    ``Duration`` in the source file), ``EstimatesTab`` (each estimate PATCHes on its
    own and never touches ``duration``), and the velocity-suggestion accept, which
    writes ``most_likely_duration`` alone straight through the model. Rejecting would
    have turned all three into hard failures and detonated the next CPM recompute on
    every legacy row, the failure class #1981/#2002/#2005 already paid for.

    What this costs, stated plainly: the optimistic tail below ``duration`` is
    truncated, so a plan deliberately padded above its own estimates reports no
    upside. That is the trade — the simulation answers "how much later than the plan,
    and how likely", and the deterministic pass keeps the last word on the earliest
    feasible date. Reading the smaller of the two answers as the forecast is the one
    outcome that is not defensible.

    Applied by :func:`_sample_column` after sampling and to every path (velocity,
    PERT, deterministic), on the held matrix and on every replayed row block alike,
    so the seeded RNG stream is byte-for-byte unchanged and no source of uncertainty
    is exempt. The deterministic path is already ``base``, so the clamp is a no-op
    there. The clamp is elementwise, which is what lets a replayed row block apply it
    to its rows alone.
    The elapsed portion of an in-progress task is subtracted from the *sampled* value
    downstream (:func:`_mc_effective_duration`) using the same integer rule
    :func:`_effective_duration_days` applies to ``duration``, so flooring the full
    sampled duration here floors the remaining work by exactly the same amount.
    """
    np.maximum(column, base, out=column)


def _sample_duration_matrix(
    project: Project,
    topo_order: list[str],
    task_map: dict[str, Task],
    runs: int,
    rng: np.random.Generator,
) -> np.ndarray:
    """Sample each task's per-run duration column into a ``(runs, n_tasks)`` matrix.

    Durations are sampled column-by-column in ``topo_order`` from the single seeded
    ``rng`` so the stream — and therefore seeded P50/P80/P95 — is independent of
    task insertion order. Each task takes one of three paths in priority order
    (velocity → three-point PERT → deterministic); a completed task's column is
    collapsed to its base duration *after* sampling so the RNG stream is unchanged.

    Every sampled column is then floored at the task's deterministic
    ``duration`` — see :func:`_floor_sampled_at_duration` for why.

    The priority order below is a contract, not an implementation detail: anything
    that wants to *move* a task's sampled duration has to shift whichever input the
    branch that claims it will read. :func:`perturb_task_duration` is the one place
    that encodes it — add a fourth branch here and teach it there, or a what-if on a
    task taking the new branch silently reports a zero risk delta (#3533).

    A velocity task (:func:`_velocity_points`) draws nothing here. Its duration
    depends on the team capacity every other velocity task in the same run is also
    claiming (ADR-1412), so the forward pass computes it and writes it back. Its
    column holds the mean-pace span of its remaining points meanwhile: a positive
    value, so a zero-duration story is not mistaken for a milestone (#4079).
    """
    dur_matrix = np.empty((runs, len(topo_order)), dtype=np.float64)
    velocity_points = _velocity_points(project)
    mean = _velocity_mean(project)
    for col, tid in enumerate(topo_order):
        dur_matrix[:, col] = _sample_column(
            project, task_map[tid], velocity_points, mean, runs, rng
        )
    return dur_matrix


def _sample_column(
    project: Project,
    t: Task,
    velocity_points: dict[str, float],
    mean: float | None,
    n: int,
    rng: np.random.Generator,
) -> np.ndarray:
    """One task's ``n`` sampled durations, floored and (if completed) collapsed.

    The single per-column rule both :func:`_sample_duration_matrix` and
    :class:`_SampledDurations` apply, so the whole-matrix and replayed paths cannot
    drift apart. Every operation after the draw is elementwise, which is what lets a
    column be redrawn a row block at a time from a saved generator state.
    """
    base = float(t.duration.days)
    # No remaining work (ADR-1474): the column is sampled as a total, floored at the
    # elapsed days rather than the duration, and handed on as remaining work, since
    # the forward pass subtracts no elapsed days from such a task (forward.py).
    # The velocity branch reads remaining points and subtracts no elapsed days
    # (#5012), so it is floored at nothing at all.
    no_remaining = t.zero_remaining and not _is_complete(t)
    elapsed_only = no_remaining and t.duration.days > 0 and t.id not in velocity_points
    if elapsed_only:
        base = float(_elapsed_working_days(t.duration.days, t.percent_complete or 0.0))
    elif no_remaining:
        base = 0.0
    if t.id in velocity_points:
        # Agile-aware path (#411, ADR-1412): takes precedence over PERT, since the
        # delivery mode declares that uncertainty comes from throughput.
        assert mean is not None and project.sprint_length_days is not None
        span = velocity_points[t.id] / mean * float(project.sprint_length_days)
        column = np.full(n, span)
    elif (
        t.optimistic_duration is not None
        and t.most_likely_duration is not None
        and t.pessimistic_duration is not None
    ):
        opt = float(t.optimistic_duration.days)
        ml = float(t.most_likely_duration.days)
        pess = float(t.pessimistic_duration.days)
        column = _sample_pert(opt, ml, pess, n, rng)
    else:
        column = np.full(n, base)
    _floor_sampled_at_duration(column, base)
    # A completed task is pinned to a constant offset pair in the forward pass
    # (its sampled column is never read there), so its sampled duration cannot
    # move the finish — a varying column would surface in the sensitivity tornado
    # as pure bootstrap noise, contradicting the documented contract that
    # completed tasks are omitted (#1827). Collapse the column to a constant so
    # ``np.ptp == 0`` excludes it from the tornado. Done *after* sampling (not by
    # skipping it) so the seeded RNG stream — and therefore every other task's
    # samples and P50/P80/P95 — is byte-for-byte unchanged.
    if _is_complete(t):
        column[:] = base
    elif elapsed_only:
        column -= base
    return column


def _pack_pcg64_state(bit_generator: np.random.BitGenerator) -> tuple[int, int, int]:
    """A PCG64 position as ``(state, has_uint32, uinteger)``; the increment is shared."""
    s = bit_generator.state
    return (s["state"]["state"], s["has_uint32"], s["uinteger"])


class _SampledDurations:
    """The ``(runs, n_tasks)`` sampled durations, held whole or replayed per column (#3824).

    Whole, this is the matrix :func:`_sample_duration_matrix` returns. Replayed, it is
    the same matrix without ever holding it: the seeded stream is consumed column by
    column (each task's ``runs`` draws in a row, in ``topo_order``), so a row block of
    the matrix cannot be drawn on its own without changing the stream. Instead the
    sampler runs once in full, one column at a time, and keeps for each column that
    actually varies only the generator position its draws start from. A row block is
    then rebuilt by restoring each such column's position into a second generator,
    drawing that block's rows, and saving where the column's draws reached. Numpy's
    ``beta`` fills ``size=n`` with ``n`` sequential scalar draws, so ``k`` draws
    followed by ``n - k`` from where they stopped are the ``n`` draws bit for bit;
    everything after the draw is elementwise (:func:`_sample_column`). The seeded
    output is therefore byte-identical to the whole matrix, and the main generator
    ends where the full sampler leaves it, so the velocity capacity seeds drawn after
    it (ADR-1412) are unchanged.

    The price is drawing each varying column three times (the recording pass, the
    forward pass's row blocks, and the sensitivity subsample) for O(chunk x tasks)
    memory instead of O(runs x tasks): the caller replays only past a cell budget
    (``_MC_SAMPLED_MATRIX_CELLS`` in ``run.py``), so smaller projects pay nothing.

    The forward pass writes each velocity task's realized duration back into its
    column of the block it is given (ADR-1412). Whole, the block is a view and the
    write lands in the matrix; replayed, :meth:`keep_written` copies those columns'
    first ``keep_rows`` rows aside so the sensitivity tornado reads the same values.
    """

    def __init__(
        self,
        project: Project,
        topo_order: list[str],
        task_map: dict[str, Task],
        runs: int,
        rng: np.random.Generator,
        *,
        replay: bool,
        keep_rows: int,
        sample_matrix: Callable[
            [Project, list[str], dict[str, Task], int, np.random.Generator], np.ndarray
        ] = _sample_duration_matrix,
    ) -> None:
        self.runs = runs
        self._tasks = [task_map[tid] for tid in topo_order]
        self._project = project
        self._velocity_points = _velocity_points(project)
        self._mean = _velocity_mean(project)
        # Replaying restores positions by value, which is only defined here for PCG64
        # (what ``default_rng`` builds); any other generator keeps the whole matrix.
        replay = replay and isinstance(rng.bit_generator, np.random.PCG64)
        self._matrix: np.ndarray | None = None
        if not replay:
            self._matrix = sample_matrix(project, topo_order, task_map, runs, rng)
            return
        n_tasks = len(topo_order)
        self._any = np.zeros(n_tasks, dtype=bool)
        const_cols: list[int] = []
        const_vals: list[float] = []
        self._start: dict[int, tuple[int, int, int]] = {}
        for col, t in enumerate(self._tasks):
            position = _pack_pcg64_state(rng.bit_generator)
            column = _sample_column(project, t, self._velocity_points, self._mean, runs, rng)
            self._any[col] = bool(column.any())
            if column.min() == column.max():
                const_cols.append(col)
                const_vals.append(float(column[0]))
            else:
                self._start[col] = position
        self._const_cols = np.asarray(const_cols, dtype=np.intp)
        self._const_vals = np.asarray(const_vals, dtype=np.float64)
        self._cursor = dict(self._start)
        self._next_row = 0
        self._template = rng.bit_generator.state
        self._replay = np.random.Generator(np.random.PCG64(0))
        self._keep_rows = min(keep_rows, runs)
        self._written = np.asarray(
            [col for col, t in enumerate(self._tasks) if t.id in self._velocity_points],
            dtype=np.intp,
        )
        # Seeded with the sampled (constant, mean-pace) value, so a column the forward
        # pass leaves unwritten reads exactly what the whole matrix would hold.
        const = dict(zip(const_cols, const_vals, strict=True))
        self._kept = np.empty((self._keep_rows, len(self._written)), dtype=np.float64)
        for i, col in enumerate(self._written.tolist()):
            self._kept[:, i] = const[col]

    @property
    def replayed(self) -> bool:
        """Whether the matrix is rebuilt per row block rather than held whole."""
        return self._matrix is None

    def hold_whole_if(self, cross_run: bool) -> None:
        """Hold the whole matrix from here on when the forward pass reads across runs."""
        if cross_run and self._matrix is None:
            self._matrix = self.rows(0, self.runs)

    def column_any(self, col: int) -> bool:
        """Whether any run samples a non-zero duration for ``col``."""
        if self._matrix is not None:
            return bool(self._matrix[:, col].any())
        return bool(self._any[col])

    def _draw(self, col: int, position: tuple[int, int, int], n: int) -> np.ndarray:
        value, has_uint32, uinteger = position
        self._replay.bit_generator.state = {
            **self._template,
            "state": {**self._template["state"], "state": value},
            "has_uint32": has_uint32,
            "uinteger": uinteger,
        }
        return _sample_column(
            self._project, self._tasks[col], self._velocity_points, self._mean, n, self._replay
        )

    def rows(self, lo: int, hi: int) -> np.ndarray:
        """Runs ``[lo, hi)`` of the matrix; replayed blocks must come in order from 0."""
        if self._matrix is not None:
            return self._matrix[lo:hi]
        if lo != self._next_row:
            raise AssertionError(f"replayed rows requested out of order: {lo} != {self._next_row}")
        block = np.empty((hi - lo, len(self._tasks)), dtype=np.float64)
        block[:, self._const_cols] = self._const_vals
        for col, position in self._cursor.items():
            block[:, col] = self._draw(col, position, hi - lo)
            self._cursor[col] = _pack_pcg64_state(self._replay.bit_generator)
        self._next_row = hi
        return block

    def keep_written(self, lo: int, block: np.ndarray) -> None:
        """Copy the forward pass's write-backs in ``block`` (runs from ``lo``) aside."""
        if self._matrix is not None or lo >= self._keep_rows or not len(self._written):
            return
        hi = min(self._keep_rows, lo + block.shape[0])
        self._kept[lo:hi] = block[: hi - lo][:, self._written]

    def leading_column(self, n: int) -> Callable[[int], np.ndarray]:
        """``col -> first n runs of that column``, as the forward pass left them."""
        if self._matrix is not None:
            matrix = self._matrix
            return lambda col: matrix[:n, col]
        if n > self._keep_rows:
            raise AssertionError(f"only {self._keep_rows} leading rows were kept, not {n}")
        written = {int(col): i for i, col in enumerate(self._written)}
        const = dict(zip(self._const_cols.tolist(), self._const_vals.tolist(), strict=True))

        def column(col: int) -> np.ndarray:
            if col in written:
                return self._kept[:n, written[col]]
            if col in const:
                return np.full(n, const[col])
            return self._draw(col, self._start[col], n)

        return column


def _shift_duration(td: timedelta | None, delta_days: int) -> timedelta | None:
    """Shift a duration by ``delta_days``, flooring at zero; ``None`` passes through.

    A negative delta that would drive a duration below zero clamps to zero rather
    than producing a nonsensical negative duration.
    """
    if td is None:
        return None
    shifted = td + timedelta(days=delta_days)
    return shifted if shifted > timedelta(0) else timedelta(0)


def _shift_remaining_work(task: Task, delta_days: int) -> Task:
    """Shift the remaining work of a task carrying a percentage, elapsed days held.

    Returns ``task`` with a new ``duration`` and ``percent_complete``. Elapsed working
    days are the exact ``floor(duration * pct / 100)`` of
    :func:`_elapsed_working_days` — the rule :func:`_effective_duration_days` and Monte
    Carlo both apply — and work already done
    cannot be undone by a what-if, so while any work remains the new duration is
    ``elapsed + remaining + delta_days``.

    The new percentage is placed at the *midpoint* of the band that floors to
    ``elapsed`` — ``(elapsed + 0.5) / new_duration`` — rather than at its lower
    edge, so float rounding in ``elapsed / new_duration * 100`` can never truncate
    one day short. With at least one remaining day that value is strictly below
    100, so the task stays in progress. The original percentage is kept whenever it
    already yields the same elapsed count.

    A pull-in that leaves no remaining work returns the task with
    ``zero_remaining`` set (ADR-1474), which is how the engine expresses an open task
    with nothing left to do. No duration above zero can say it, because the integer
    rule always leaves a day below 100%. Everything else stays as recorded: the
    duration, percentage and ``actual_start`` describe work the what-if did not
    change, so start-to-start and start-to-finish links out of the task keep reading
    its start. ``actual_start`` still floors the task, which can limit how far the
    finish moves.

    The task stays open rather than becoming complete because a completed task is
    pinned at its actuals and stops reading its predecessors. That would be a statement
    about history the what-if has no evidence for, and it would cut the task's
    predecessors off from its successors: they would leave the critical path and their
    risk would drop out of the Monte Carlo bands, moving the forecast far more than the
    pull-in asked for. Open, the task still sits behind its predecessors, so with no
    lag and no other floor, finish-to-start and finish-to-finish links out of it move
    the finish by the remaining days. A velocity-sampled task needs its points capped
    as well, which :func:`perturb_task_duration` does.
    """
    duration_days = task.duration.days
    pct = min(task.percent_complete or 0.0, 100.0)
    elapsed = _elapsed_working_days(duration_days, pct) if pct > 0 else 0
    remaining = _effective_duration_days(task) + delta_days
    if remaining <= 0:
        if duration_days == 0:
            return task  # a milestone has no work to consume
        # Open work with nothing left (ADR-1474): duration, percentage and actuals
        # keep describing the work done, so SS/SF links still read its start.
        return replace(task, zero_remaining=True)
    if pct <= 0 and not task.zero_remaining:
        # Unstarted: the whole-duration shift this task got before ADR-1474, kept
        # exactly (sub-day seconds and an unset percentage included), so a network
        # that never sets ``zero_remaining`` perturbs byte-identically.
        return replace(task, duration=task.duration + timedelta(days=delta_days))
    new_days = elapsed + remaining
    if pct > 0 and _elapsed_working_days(new_days, pct) != elapsed:
        pct = (elapsed + 0.5) * 100.0 / new_days
    return replace(
        task, duration=timedelta(days=new_days), percent_complete=pct, zero_remaining=False
    )


def perturb_task_duration(project: Project, task_id: str, delta_days: int) -> Project:
    """Return a copy of ``project`` with one task's duration shifted by ``delta_days``.

    The single entry point for a what-if duration perturbation, and the reason it
    lives in the engine rather than in its callers: a task's duration reaches the
    forecast through **three different inputs**, and which one Monte Carlo actually
    reads depends on the sampling priority documented in
    :func:`_sample_duration_matrix` (velocity → three-point PERT → deterministic).
    A caller that shifts only the fields it happens to know about moves the
    deterministic CPM finish while the P50/P80/P95 bands stay exactly where they
    were, and then reports both — a what-if that answers "this change carries no
    schedule risk" about a change it never applied (#3533, the same mirror-drift
    class as #3527). Encapsulating the priority here means a fourth sampling branch
    is a one-file change rather than a silent divergence in every caller.

    All three inputs are shifted, so the target is covered whichever branch claims
    it — a branch that does not claim it never reads the input, so the extra shifts
    are inert rather than compounding:

    * ``duration`` — what :func:`schedule` lays the task out at, and the floor every
      sampled column is clamped up to (see :func:`_floor_sampled_at_duration`).
    * the three-point PERT triple, when complete. Shifting all three legs by the
      same offset translates the sampled Beta **exactly**: the PERT sample is
      ``optimistic + s * (pessimistic - optimistic)`` and neither the range nor the
      normalized mean that sets the Beta's shape parameters changes under a common
      shift, so the band moves by ``delta_days`` and keeps its shape.
    * ``story_points``, when the task will take the velocity branch. That branch
      never reads a duration at all — it asks how many sprints burn down the
      committed points — so a day offset has to be converted into the unit it does
      read, at the team's mean pace: ``mean(velocity_samples)`` points per sprint,
      over the working days one sprint spans **on the task's own calendar**.
      ``delta_days`` counts that calendar's days, while ``sprint_length_days`` counts
      the project calendar the sprints run on, and Monte Carlo lays a sampled sprint
      count out on the task calendar (see :func:`_velocity_days_on_calendar`). Pacing
      against ``sprint_length_days`` instead moved a Mon/Wed/Fri story by well under
      ``delta_days`` (#4529). The task then needs ``delta_days`` task-calendar
      working days more (or fewer) of team capacity at the mean pace (ADR-1412). On
      a single-calendar project a sprint spans ``sprint_length_days`` task days. The
      branch reads the *remaining* points, ``story_points * (1 - pct / 100)``
      (#5012), so the points are set to make that remainder move by the whole
      ``delta_days`` at whatever percentage the shift leaves the task on.

    On an **in-progress** task the offset applies to the *remaining* work only
    (#4432). The engine reads ``percent_complete`` against ``duration`` to split a
    task into elapsed and remaining working days (:func:`_effective_duration_days`,
    and the same integer rule in Monte Carlo's elapsed subtraction), so shifting
    ``duration`` with ``percent_complete`` held would grow the elapsed share along
    with it and swallow part of the delta — a +1-day slip on a critical 50%-complete
    task moved the finish by zero. ``percent_complete`` is therefore rescaled so the
    elapsed working days stay exactly constant; see :func:`_shift_remaining_work`.
    The PERT legs need no extra handling: Monte Carlo subtracts that same constant
    elapsed count from every sampled value, so shifting each leg by ``delta_days``
    shifts the sampled remaining work by ``delta_days``.

    A shift never records completion, because a what-if has no evidence about history.
    A pull-in that consumes all remaining work, on any task, leaves it open at zero
    duration with its percentage and actuals as they were, so its predecessors still
    drive its successors (see :func:`_shift_remaining_work`). A task's elapsed days stop
    being subtracted from its sampled duration at that point, because they are read off
    ``duration``, so the sampled inputs are lowered by those days as well: the sampled
    remaining work still moves by ``delta_days``. The velocity branch subtracts no
    elapsed days, so it needs no such correction: a pull-in that consumes the
    remaining points sets them to zero and the task leaves the velocity branch. A
    milestone has no work to consume, so a negative delta leaves its duration,
    percentage and actuals alone, and a positive delta turns it into an open task of
    ``delta_days`` days. A zero delta is an exact identity on every task.

    Sampling semantics are untouched: this only changes what the engine is asked
    about, never how it answers.

    Args:
        project: The baseline project. Read only — neither it nor any task on it is
            mutated; a new :class:`Project` with a new task list is returned.
        task_id: Id of the task to perturb.
        delta_days: Signed day offset. Positive slips the task later, negative pulls
            it in. Durations floor at zero, which is where a pull-in of all remaining
            work lands whatever the elapsed days, and so do story points — a shift
            that would zero the remaining points drops the task to its deterministic
            duration, the honest reading of "this work no longer takes a sprint".
            Zero returns a project equal to ``project``.

    Returns:
        A new :class:`Project`, identical to ``project`` except for the target
        task's shifted duration inputs. On a task carrying a ``percent_complete``
        that includes a rescaled percentage while work remains. ``actual_start`` and
        ``actual_finish`` are never changed, so a shift never completes a task (see
        :func:`_shift_remaining_work`).

    Raises:
        InvalidScheduleInput: If ``task_id`` names no task in ``project``. A silent
            no-op is the failure this function exists to prevent, so an unknown id
            is refused rather than returning an unperturbed project that the caller
            would report as a zero-impact what-if. A non-:class:`Project` ``project``,
            a ``delta_days`` that is not an ``int`` (``bool`` included, as for
            ``runs``/``seed``), or one whose magnitude exceeds
            :data:`MAX_DURATION_DAYS` is refused too (#4518). A **completed** task (an
            ``actual_finish`` recorded or ``percent_complete`` at 100, the
            :func:`_is_complete` predicate) is refused for the same reason: its dates
            are actuals, so a duration shift would leave both :func:`schedule` and
            :func:`monte_carlo` exactly where they were (#4515).
    """
    _require_project(project)
    # bool is an int subclass but never a meaningful day offset; the magnitude bound
    # keeps ``timedelta`` from raising a bare OverflowError on a huge int (#4518).
    if isinstance(delta_days, bool) or not isinstance(delta_days, int):
        raise InvalidScheduleInput(
            f"delta_days must be an integer (got {_short_repr(delta_days)})."
        )
    if abs(delta_days) > MAX_DURATION_DAYS:
        raise InvalidScheduleInput(
            f"delta_days exceeds the maximum magnitude of {MAX_DURATION_DAYS} days "
            f"(got {delta_days})."
        )
    target = next((t for t in project.tasks if t.id == task_id), None)
    if target is None:
        raise InvalidScheduleInput(
            f"Task {_short_repr(task_id)} is not in project {_short_repr(project.id)}."
        )
    if _is_complete(target):
        # Completed work is pinned by its actuals and laid out at full duration
        # regardless of what ``duration`` says, so any offset is a silent zero-impact
        # what-if — refuse it like the unknown id above.
        raise InvalidScheduleInput(
            f"Task {_short_repr(task_id)} is complete; its dates are actuals and a duration "
            "change cannot move the forecast."
        )
    if delta_days == 0:
        # After the refusals, so an invalid request fails the same way at any delta.
        # The shift path rebuilds a duration from whole days and floors each estimate,
        # so returning here is what makes "nothing changed" true of any input.
        return replace(project, tasks=list(project.tasks))

    if target.duration.days > 0 or (target.percent_complete or 0.0) > 0:
        shifted = _shift_remaining_work(target, delta_days)
    else:
        # A milestone: a pull-in has no work to consume, a slip gives it some.
        # ``duration`` is non-optional on Task, so the shift is never None here.
        new_duration = _shift_duration(target.duration, delta_days) or timedelta(0)
        shifted = replace(target, duration=new_duration)
    # The elapsed days Monte Carlo sets aside are held constant by the shift, even at
    # no remaining work (ADR-1474), so every sampled input moves by the whole delta.
    sampled_delta = delta_days

    story_points = target.story_points
    # Gate the points conversion on the same predicate the sampler uses, so a task
    # that will NOT take the velocity branch keeps its points untouched.
    if target.id in _velocity_points(project):
        mean = _velocity_mean(project)
        assert mean is not None and project.sprint_length_days is not None
        # Pace in the unit ``delta_days`` counts: working days of the task's
        # calendar per sprint, as the sprint span lands on it (#4529).
        task_calendars = _resolve_task_calendars(project)
        task_calendar = (
            None if task_calendars is None else task_calendars.get(target.id, project.calendar)
        )
        task_days_per_sprint = project.sprint_length_days
        if task_calendar is not None:
            task_days_per_sprint = _velocity_days_on_calendar(
                project, task_calendar, project.sprint_length_days
            )
        points_per_working_day = mean / task_days_per_sprint
        # The velocity branch reads the remaining points, not elapsed days (#5012), so
        # the whole delta moves them. ``percent_complete`` may have been rescaled to
        # hold the elapsed days of ``duration``; the points are set so that
        # ``story_points * (1 - pct / 100)`` is the shifted remainder at the new pct.
        remaining = max(0.0, _remaining_story_points(target) + delta_days * points_per_working_day)
        keep = 1.0 - min(shifted.percent_complete or 0.0, 100.0) / 100.0
        story_points = remaining / keep if keep > 0 else 0.0

    perturbed = replace(
        shifted,
        optimistic_duration=_shift_duration(target.optimistic_duration, sampled_delta),
        most_likely_duration=_shift_duration(target.most_likely_duration, sampled_delta),
        pessimistic_duration=_shift_duration(target.pessimistic_duration, sampled_delta),
        story_points=story_points,
    )
    return replace(
        project,
        tasks=[perturbed if t.id == task_id else t for t in project.tasks],
    )
