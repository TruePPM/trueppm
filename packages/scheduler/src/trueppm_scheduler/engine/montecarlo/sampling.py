"""Monte Carlo duration sampling, sensitivity and :func:`perturb_task_duration`."""

from __future__ import annotations

from collections.abc import (
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
from trueppm_scheduler.engine.limits import (
    MAX_CALENDAR_SCAN_DAYS,
    MAX_DURATION_DAYS,
    MAX_INDEX_CELLS,
    MAX_LAG_DELTA_CELLS,
    MAX_VELOCITY_SPRINTS,
    MC_SENSITIVITY_CAP,
)
from trueppm_scheduler.engine.milestones import (
    _ONE_DAY,
)
from trueppm_scheduler.engine.results import (
    TaskSensitivity,
)
from trueppm_scheduler.engine.validate import (
    _validate_project_shape,
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
        sprints_needed[lo : lo + rows] = np.where(
            reached.any(axis=1),
            reached.argmax(axis=1) + 1,  # first sprint index that meets the target (+1 = count)
            max_sprints,
        )
    return sprints_needed.astype(np.float64) * float(sprint_length_days)


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
    reimplemented with numpy so the scheduler keeps its networkx+numpy-only
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
    dur_matrix: np.ndarray,
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
        x = dur_matrix[:, col]
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


def _floor_sampled_at_duration(dur_matrix: np.ndarray, col: int, base: float) -> None:
    """Clamp one sampled duration column up to the task's deterministic ``duration``.

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

    Applied after sampling and to every path (velocity, PERT, deterministic) so the
    seeded RNG stream is byte-for-byte unchanged and no source of uncertainty is
    exempt. The deterministic path is already ``base``, so the clamp is a no-op there.
    The elapsed portion of an in-progress task is subtracted from the *sampled* value
    downstream (:func:`_mc_effective_duration`) using the same integer rule
    :func:`_effective_duration_days` applies to ``duration``, so flooring the full
    sampled duration here floors the remaining work by exactly the same amount.
    """
    np.maximum(dur_matrix[:, col], base, out=dur_matrix[:, col])


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
    """
    dur_matrix = np.empty((runs, len(topo_order)), dtype=np.float64)
    for col, tid in enumerate(topo_order):
        t = task_map[tid]
        base = float(t.duration.days)
        velocity_durations: np.ndarray | None = None
        # Agile-aware path (#411): a SCRUM task with committed story points samples
        # from the team's velocity distribution, not its duration estimate. Takes
        # precedence over PERT — the delivery mode is an explicit declaration that
        # uncertainty comes from throughput, not a three-point guess. Falls through
        # to PERT / deterministic when the project carries no velocity signal.
        if (
            t.delivery_mode == DeliveryMode.SCRUM
            and t.story_points is not None
            and project.velocity_samples
            and project.sprint_length_days is not None
        ):
            velocity_durations = _sample_velocity_durations(
                float(t.story_points),
                project.velocity_samples,
                project.sprint_length_days,
                runs,
                rng,
            )
        if velocity_durations is not None:
            dur_matrix[:, col] = velocity_durations
        elif (
            t.optimistic_duration is not None
            and t.most_likely_duration is not None
            and t.pessimistic_duration is not None
        ):
            opt = float(t.optimistic_duration.days)
            ml = float(t.most_likely_duration.days)
            pess = float(t.pessimistic_duration.days)
            dur_matrix[:, col] = _sample_pert(opt, ml, pess, runs, rng)
        else:
            dur_matrix[:, col] = base
        _floor_sampled_at_duration(dur_matrix, col, base)
        # A completed task is pinned to a constant offset pair in the forward pass
        # (its sampled column is never read there), so its sampled duration cannot
        # move the finish — a varying column would surface in the sensitivity tornado
        # as pure bootstrap noise, contradicting the documented contract that
        # completed tasks are omitted (#1827). Collapse the column to a constant so
        # ``np.ptp == 0`` excludes it from the tornado. Done *after* sampling (not by
        # skipping it) so the seeded RNG stream — and therefore every other task's
        # samples and P50/P80/P95 — is byte-for-byte unchanged.
        if _is_complete(t):
            dur_matrix[:, col] = base
    return dur_matrix


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
    days are ``floor(duration * pct / 100)`` — the rule
    :func:`_effective_duration_days` and Monte Carlo both apply — and work already done
    cannot be undone by a what-if, so while any work remains the new duration is
    ``elapsed + remaining + delta_days``.

    The new percentage is placed at the *midpoint* of the band that floors to
    ``elapsed`` — ``(elapsed + 0.5) / new_duration`` — rather than at its lower
    edge, so float rounding in ``elapsed / new_duration * 100`` can never truncate
    one day short. With at least one remaining day that value is strictly below
    100, so the task stays in progress. The original percentage is kept whenever it
    already yields the same elapsed count.

    A pull-in that leaves no remaining work returns a zero-duration task, which is how
    the engine expresses an open task with nothing left to do. No duration above zero
    can say it, because the integer rule always leaves a day below 100%. Everything
    else stays as recorded: the percentage and ``actual_start`` describe work the
    what-if did not change. Layout no longer reads the percentage at zero duration, but
    ``actual_start`` still floors the task, which can limit how far the finish moves.

    The task stays open rather than becoming complete because a completed task is
    pinned at its actuals and stops reading its predecessors. That would be a statement
    about history the what-if has no evidence for, and it would cut the task's
    predecessors off from its successors: they would leave the critical path and their
    risk would drop out of the Monte Carlo bands, moving the forecast far more than the
    pull-in asked for. Open, the task still sits behind its predecessors, so with no
    lag and no other floor, finish-to-start and finish-to-finish links out of it move
    the finish by the remaining days. Two shapes do not get that result yet; see the
    comments on the return below.
    """
    duration_days = task.duration.days
    pct = min(task.percent_complete or 0.0, 100.0)
    elapsed = int(duration_days * pct / 100.0)
    remaining = duration_days - elapsed + delta_days
    if remaining <= 0:
        # TODO(#4819): SS and SF links out of a zero-duration task stop reading the
        # recorded start, so a bigger pull-in can finish later than a smaller one.
        # TODO(#4820): on a velocity-sampled task the caller converts the elapsed days to
        # points, and whole-sprint rounding can then move a band backward as the pull-in
        # grows, or later than the unperturbed forecast.
        return replace(task, duration=timedelta(0))
    new_days = elapsed + remaining
    if int(new_days * pct / 100.0) != elapsed:
        pct = (elapsed + 0.5) * 100.0 / new_days
    return replace(task, duration=timedelta(days=new_days), percent_complete=pct)


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
      read, at the team's mean pace (``mean(velocity_samples) / sprint_length_days``
      points per working day). The band then moves by ``delta_days`` in expectation,
      quantized to whole sprints, which is what a sprint-delivered task's schedule
      genuinely does.

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
    remaining work still moves by ``delta_days``. A milestone has no work to consume, so
    a negative delta leaves its duration, percentage and actuals alone, and a positive
    delta turns it into an open task of ``delta_days`` days. A zero delta is an exact
    identity on every task.

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

    if target.percent_complete and target.percent_complete > 0:
        shifted = _shift_remaining_work(target, delta_days)
    else:
        # ``duration`` is non-optional on Task, so the shift is never None here.
        new_duration = _shift_duration(target.duration, delta_days) or timedelta(0)
        shifted = replace(target, duration=new_duration)
    # Monte Carlo subtracts elapsed days, read off ``duration``, from every sampled value.
    # A pull-in to zero duration ends that subtraction, so the sampled inputs must absorb
    # those days or the task's remaining work would grow by them.
    sampled_delta = delta_days - (
        (target.duration.days - _effective_duration_days(target))
        - (shifted.duration.days - _effective_duration_days(shifted))
    )

    story_points = target.story_points
    # Gate the points conversion on the same predicate the sampler uses, so a task
    # that will NOT take the velocity branch keeps its points untouched.
    if (
        target.delivery_mode == DeliveryMode.SCRUM
        and story_points is not None
        and story_points > 0
        and project.sprint_length_days is not None
        and project.sprint_length_days > 0
    ):
        mean = _velocity_mean(project)
        if mean is not None:
            points_per_working_day = mean / project.sprint_length_days
            story_points = max(0.0, story_points + sampled_delta * points_per_working_day)

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
