"""Shared team capacity for velocity-sampled scrum tasks (ADR-1412).

A team's velocity is one capacity shared by every story in flight, so Monte Carlo
draws **one** per-sprint velocity vector per run and lets every velocity task
consume it, instead of giving each story its own bootstrap of the whole team's
throughput and rounding it up to whole sprints (#5011).

The model, run by run:

* Sprint ``k`` opens ``k * sprint_length_days`` working days of the project
  calendar after the sprint origin (the data date, snapped to a working day) and
  delivers ``draws[run, k]`` points, spread evenly over its working days.
* Velocity tasks claim capacity in the Monte Carlo forward pass's column order: a
  topological order with ties broken by task id. A task becomes ready at its early
  start, which its predecessors (scrum or not), its floors and the data date set,
  and then consumes its **remaining** points (``story_points * (1 - pct/100)``,
  #5012) from the capacity left at and after that instant. Its finish is the instant
  the last point is delivered, as a fractional working-day offset, so a story that
  needs a fifth of a sprint takes a fifth of a sprint.
* Capacity within a sprint is claimed front to back. A story that becomes ready
  mid-sprint cannot use the part of that sprint already behind it, and a story
  allocated later cannot back-fill a gap an earlier allocation skipped. Both only
  ever make a finish later, never earlier.
* A run that has not burned a story down when the drawn capacity ends clamps that
  story's finish at the capacity end and is counted as saturated (#2469), so the
  slow tail is reported as truncated rather than estimated.
"""

from __future__ import annotations

from dataclasses import (
    dataclass,
    replace,
)

import numpy as np

# Float-accumulation slack for "the remaining points are delivered" (#4699): summing
# k float draws can land an ulp short of a target that is exactly k*v on paper.
_REACH_RTOL = 1e-12

# Cells (runs x sprints) per capacity draw block, and the most runs in one. Each
# block's velocity vectors come from their own generator, seeded from the run's
# stream, so a forward-pass chunk draws only the blocks it covers and the values
# never depend on the chunk size (#5011). ~8 MB of draws per block.
_CAPACITY_BLOCK_CELLS = 1 << 20
_CAPACITY_BLOCK_MAX_RUNS = 1024


def _capacity_block_runs(sprints: int) -> int:
    """Runs per capacity draw block at a horizon of ``sprints``: a function of it alone."""
    return max(1, min(_CAPACITY_BLOCK_MAX_RUNS, _CAPACITY_BLOCK_CELLS // max(1, sprints)))


# Sprints the consumer examines per step, doubling up to the cap: a story that fits
# in one sprint costs one narrow step, a long one a few wide ones.
_FIRST_WINDOW = 4
_MAX_WINDOW = 256


@dataclass(frozen=True)
class _VelocityCapacity:
    """The team capacity of every run and what each velocity task needs from it.

    Attributes:
        observations: The usable velocity history, bootstrapped per sprint.
        sprints: Sprints of capacity each run draws (the horizon, #2469).
        block_seeds: One seed per :func:`_capacity_block_runs` runs, drawn from
            the seeded Monte Carlo stream.
        saturated: ``(runs,)`` boolean, set in place for every run in which some
            velocity task reached the end of the drawn capacity un-burned-down.
        sprint_days: Working days of the project calendar per sprint.
        origin: Project-calendar working-day offset at which sprint 0 opens.
        points: Remaining story points of each live velocity task, by id.
        floor_days: Each velocity task's deterministic remaining work in working
            days (``duration`` less its elapsed days), the floor its sampled
            duration is clamped up to so Monte Carlo never lands earlier than
            :func:`schedule` (#3765).
        proj_ords: Working-day ordinals of the project calendar's index.
        own_ords: For a velocity task on a calendar whose content differs from the
            project calendar, that calendar's working-day ordinals. Its column lives
            in its own working-day space, so its start is re-expressed on the sprint
            calendar and its finish mapped back, keeping the sprint span's calendar
            dates (#4529).
        draws: ``(chunk runs, sprints)`` points per sprint, set by :meth:`rows`.
        work: ``None``, or per velocity task a ``(runs,)`` array that
            :func:`_consume_capacity` fills with the working days of sprint capacity
            the task actually claimed (each sprint's claimed points over that
            sprint's velocity x ``sprint_days``). Its span also counts days spent
            waiting for capacity, so cost reads this, not the span (#4809). Never
            read by the forward pass.
    """

    observations: np.ndarray
    sprints: int
    block_seeds: np.ndarray
    saturated: np.ndarray
    sprint_days: float
    origin: float
    points: dict[str, float]
    floor_days: dict[str, float]
    proj_ords: np.ndarray
    own_ords: dict[str, np.ndarray]
    draws: np.ndarray | None = None
    work: dict[str, np.ndarray] | None = None

    def rows(self, lo: int, hi: int) -> _VelocityCapacity:
        """The capacity of runs ``[lo, hi)`` (a forward-pass chunk), drawn.

        ``saturated`` is a view, so saturation recorded on a chunk reaches the whole.
        """
        draws = np.empty((hi - lo, self.sprints), dtype=np.float64)
        b = _capacity_block_runs(self.sprints)
        for block in range(lo // b, -(-hi // b)):
            start = block * b
            gen = np.random.default_rng(int(self.block_seeds[block]))
            # The whole block is drawn even when the chunk covers part of it, so a
            # run's vector is the same whichever chunk asks for it.
            rows = min(b, self.saturated.shape[0] - start)
            values = gen.choice(self.observations, size=(rows, self.sprints), replace=True)
            a, z = max(lo, start), min(hi, start + rows)
            draws[a - lo : z - lo] = values[a - start : z - start]
        work = None if self.work is None else {t: w[lo:hi] for t, w in self.work.items()}
        return replace(self, draws=draws, saturated=self.saturated[lo:hi], work=work)


def _start_to_space(offsets: np.ndarray, src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Re-express start offsets on ``src``'s index as offsets on ``dst``'s.

    A start lies on the day it falls in: that day maps through its date to the first
    ``dst`` working day at or after it, and the fraction carries over when the day is
    a working day of both.
    """
    day = np.clip(np.floor(offsets).astype(np.int64), 0, src.shape[0] - 1)
    ords = src[day]
    mapped = np.minimum(np.searchsorted(dst, ords, side="left"), dst.shape[0] - 1)
    exact = dst[mapped] == ords
    out: np.ndarray = mapped.astype(np.float64) + np.where(exact, offsets - np.floor(offsets), 0.0)
    return out


def _finish_to_space(offsets: np.ndarray, src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Re-express exclusive finish offsets on ``src``'s index as offsets on ``dst``'s.

    An exclusive finish ``f`` ends on day ``ceil(f) - 1``: that day maps to the last
    ``dst`` working day at or before it, so a story that ends on a Friday of the
    sprint calendar ends that Friday, not after a Saturday the sprint never worked.
    """
    last = np.clip(np.ceil(offsets).astype(np.int64) - 1, 0, src.shape[0] - 1)
    ords = src[last]
    mapped = np.clip(np.searchsorted(dst, ords, side="right") - 1, 0, dst.shape[0] - 1)
    exact = dst[mapped] == ords
    worked = offsets - last.astype(np.float64)
    out: np.ndarray = mapped.astype(np.float64) + np.where(exact, worked, 1.0)
    return out


def _consume_capacity(
    cap: _VelocityCapacity, used: np.ndarray, tid: str, es: np.ndarray
) -> np.ndarray:
    """Claim ``tid``'s remaining points from each run's capacity; return its finish.

    ``es`` is the task's early start per run in its own column's working-day space;
    the return value is its early finish in the same space. ``used`` is the
    ``(runs, sprints)`` points already claimed in each sprint and is updated in place.
    When ``cap.work`` tracks ``tid``, the days of capacity it claimed are written there.
    Each step looks at a window of sprints per run still burning down, doubling the
    window, so the cost is a few vectorized steps per task rather than one per sprint.
    """
    draws = cap.draws
    assert draws is not None
    own = cap.own_ords.get(tid)
    es_proj = es if own is None else _start_to_space(es, own, cap.proj_ords)
    need = cap.points[tid]
    runs, horizon = draws.shape
    length = cap.sprint_days
    pos = np.maximum((es_proj - cap.origin) / length, 0.0)
    k = np.floor(pos).astype(np.int64)
    frac = pos - k
    remaining = np.full(runs, need, dtype=np.float64)
    finish = np.empty(runs, dtype=np.float64)
    active = np.arange(runs)
    tol = need * _REACH_RTOL
    window = _FIRST_WINDOW
    work = None if cap.work is None or tid not in cap.work else np.zeros(runs, dtype=np.float64)
    while active.size:
        over = k[active] >= horizon
        if over.any():
            # Out of drawn capacity: clamp at its end (or the start, if the task is
            # only ready after it) and report the run's tail as truncated (#2469).
            gone = active[over]
            finish[gone] = np.maximum(cap.origin + horizon * length, es_proj[gone])
            cap.saturated[gone] = True
            active = active[~over]
            if not active.size:
                break
        cols = k[active][:, None] + np.arange(window)[None, :]
        valid = cols < horizon
        cols = np.minimum(cols, horizon - 1)
        rows = active[:, None]
        v = np.where(valid, draws[rows, cols], 0.0)
        level = used[rows, cols]
        # Capacity is claimed front to back; in the first sprint not before the
        # instant the task becomes ready.
        level[:, 0] = np.maximum(level[:, 0], frac[active] * v[:, 0])
        avail = np.maximum(v - level, 0.0)
        cum = np.cumsum(avail, axis=1)
        rem = remaining[active]
        reached = (cum >= (rem - tol)[:, None]) & valid
        hit = reached.any(axis=1)
        j = np.where(hit, reached.argmax(axis=1), window)
        before = np.arange(window)[None, :] < j[:, None]
        new_level = np.where(before & valid, level + avail, used[rows, cols])
        if work is not None:  # a share of each sprint's capacity, in sprint days
            share = np.divide(avail, v, out=np.zeros_like(avail), where=before & valid & (v > 0))
            work[active] += share.sum(axis=1) * length
        hit_rows = np.flatnonzero(hit)
        if hit_rows.size:
            jj = j[hit_rows]
            prior = np.where(jj > 0, cum[hit_rows, np.maximum(jj - 1, 0)], 0.0)
            end_level = level[hit_rows, jj] + (rem[hit_rows] - prior)
            end_level = np.minimum(end_level, v[hit_rows, jj])
            if work is not None:
                taken = end_level - level[hit_rows, jj]
                work[active[hit_rows]] += taken / v[hit_rows, jj] * length
            new_level[hit_rows, jj] = end_level
            # A finishing run took points in sprint jj, so its velocity there is > 0.
            finish[active[hit_rows]] = (
                cap.origin + (k[active[hit_rows]] + jj + end_level / v[hit_rows, jj]) * length
            )
        # Write back only real sprints: a clamped column repeats the last one.
        r_idx, c_idx = np.nonzero(valid)
        used[active[r_idx], cols[r_idx, c_idx]] = new_level[r_idx, c_idx]
        miss = ~hit
        remaining[active[miss]] = rem[miss] - cum[miss, -1]
        k[active[miss]] += window
        frac[active[miss]] = 0.0
        active = active[miss]
        window = min(window * 2, _MAX_WINDOW)
    if work is not None:
        assert cap.work is not None
        cap.work[tid][:] = work
    return finish if own is None else _finish_to_space(finish, cap.proj_ords, own)
