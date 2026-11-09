"""Input bounds the engine enforces, exported so callers can enforce the same limits."""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Input bounds
# ---------------------------------------------------------------------------
#
# The CPM engine walks the calendar one day at a time, so every loop's cost is
# linear in the day span it covers. Python's ``date`` ceiling (year 9999) is
# the only thing that bounds an unguarded walk today — a ~2.9M-iteration spin
# that ends in an uncaught ``OverflowError``. These caps reject the pathological
# inputs up front instead. They are deliberately generous (no real project task
# runs for a century) and exported so downstream validators (e.g. the TruePPM
# API) can enforce the *same* limit rather than drift from it.

MAX_DURATION_DAYS = 36_525  # ~100 years — a single task longer than this is degenerate


MAX_LAG_DAYS = 36_525  # ~100 years of lead/lag in either direction


# Largest run of consecutive non-working days to scan before declaring a
# calendar degenerate. A working calendar always has a working day within a
# week; 100 years of uninterrupted holidays means working_days/exceptions are
# broken, not that the project is real.
MAX_CALENDAR_SCAN_DAYS = 366 * 100


# Upper bound on the cumulative project span: the sum of every task's (worst-case)
# duration plus the magnitude of every lag. Per-task/-lag caps alone don't bound
# this — a long dependency chain still accumulates dates one working day at a
# time, so without this an 80+ task max-duration chain would spin
# _build_working_day_index / the forward pass and could walk a date past the
# representable range (an uncaught OverflowError). 1000 years is far beyond any
# real program and keeps every walk bounded regardless of task count.
MAX_PROJECT_SPAN_DAYS = 366 * 1000


# Ceiling on the number of leaf-level edges produced when expanding summary↔summary
# dependencies for cycle detection (#357). A summary→summary edge fans out to the
# full cross product of the two summaries' leaves — len(L(pred)) * len(L(succ))
# tuples — so a single top-of-WBS edge on a 5,000-leaf project can demand 6.25M
# tuples before networkx ever runs, stalling every subsequent dep-create. Typical
# projects never approach this (a 100k ceiling allows e.g. a 300-leaf → 300-leaf
# edge); a graph that exceeds it is pathological or hostile and is rejected with an
# actionable error rather than allowed to spin. The cost is checked from leaf
# *counts* before any cross product is materialised, so the guard itself is cheap.
MAX_EXPANDED_EDGES = 100_000


# Ceiling on the raw dependency-edge count on the project as submitted, before any
# summary expansion (#1203). This is the most fundamental of the edge caps: it is
# the root enabler of every per-edge derived guard — MAX_EXPANDED_EDGES bounds the
# post-expansion cross product and MAX_LAG_DELTA_CELLS bounds the distinct-lag delta
# arrays, but both are only reachable after the engine has already iterated the raw
# edge list at least once (validation, graph build). A caller submitting tens of
# millions of edges makes even those O(E) pre-passes — and the list's own memory —
# pathological. 100k raw edges is generous for any real network (a 5,000-task project
# with a dense-but-sane 20 predecessors each) and is checked from the list length
# before any per-edge work runs, so the guard is O(1). Applies uniformly to schedule()
# and monte_carlo() because both route through _validate_project.
MAX_DEPENDENCIES = 100_000


# Ceiling on the number of calendar exception ranges (#1206). ``is_working_day`` is
# called once per day stepped by every calendar walk, and the old linear ``any()``
# scan over ``exceptions`` made a schedule O(span x E) — a few thousand exceptions on
# a long span tied up a worker for minutes. The lookup is now O(log E) via a cached
# merged-interval bisect, but building that index is still O(E log E), and a real
# calendar has at most a few hundred holidays/closures, so a multi-million-entry list
# is pathological or hostile. Generous (no real calendar approaches it) and bounds the
# one-time index build and its memory.
MAX_CALENDAR_EXCEPTIONS = 100_000


# Ceiling on the Monte Carlo lag-delta precompute: (distinct dependency
# type/lag combinations) x (working-day index span) cells (#1201). The vectorised
# MC forward pass builds one delta array of length ``index_size`` per *distinct*
# ``(dep_type, lag)`` key; this product is the cost the span guard does NOT bound.
# ``MAX_PROJECT_SPAN_DAYS`` caps Σlag and the total span, but an SF dependency with
# zero lag contributes 0 to Σlag while still needing a full delta array, so a wide
# fan-out of such edges slips the span guard entirely. 50M cells is ~400 MB of
# float64 (200 MB now that the arrays are stored as int32, #4129) — generous for
# any real network (a handful of distinct lags over a span of tens of thousands of
# days) and far below the multi-GB blowup a hostile graph would otherwise force.
# Checked incrementally as keys are discovered, before the offending array is
# materialised. This is the *library* default: it protects a batch caller that
# owns the whole machine. A request-scoped embedder (a synchronous web endpoint
# sharing a pod with other requests) should pass a much smaller
# ``max_lag_delta_cells`` to :func:`monte_carlo`.
MAX_LAG_DELTA_CELLS = 50_000_000


# Ceiling on Monte Carlo's per-calendar working-day indices, counted as (distinct
# calendars by content) x (index length) cells, each an 8-byte int64 ordinal (#4692).
# Every distinct calendar a task references gets one index as long as the project
# span, and the span guards bound neither the calendar count nor that product: 32
# one-day tasks on 32 distinct calendars at the maximum span once drove a 27 KB
# project to ~1.9 GB. 25M cells is ~200 MB — about 65 calendars at the maximum span,
# and effectively unlimited for any real project, which has a handful of calendars
# over a span of thousands of days. This is the *library* default for a batch caller
# that owns the machine; a request-scoped embedder should pass a smaller
# ``max_index_cells`` to :func:`monte_carlo`.
MAX_INDEX_CELLS = 25_000_000


# Ceiling on the per-run sprint horizon of the velocity sampler (#1202). The
# bootstrap draw matrix is ``runs x max_sprints`` floats, and ``max_sprints`` scales
# with ``story_points / mean_velocity`` — unbounded by ``MAX_PROJECT_SPAN_DAYS``,
# which only caps ``max_sprints x sprint_length_days``. With ``sprint_length_days=1``
# the span guard permits a ~360k sprint horizon, so a single scrum task could demand
# ``runs x 360k`` floats (multi-GB). 10,000 sprints is ~380 years of fortnightly
# cadence — no real task approaches it — and bounds the matrix to ``runs x 10k``
# regardless of ``sprint_length_days``. A run past this horizon clamps to it (the
# same deep-tail truncation the sampler already documents).
MAX_VELOCITY_SPRINTS = 10_000


# Ceiling on the uncapped sprint horizon summed over every scrum task (#4695). The span
# guard charges a story's velocity worst case along its dependency chain only, so it no
# longer bounds the sampler's total draw count, which sums over parallel stories as
# well: ``runs x max_sprints`` draws per task. Equal to the old implicit ceiling, which
# was ``sum(max_sprints * sprint_length_days) <= MAX_PROJECT_SPAN_DAYS`` and so at most
# this many sprints at ``sprint_length_days=1``. A real story needs a few dozen sprints
# of horizon, so this admits tens of thousands of stories.
_MAX_VELOCITY_SPRINT_TOTAL = MAX_PROJECT_SPAN_DAYS


# Default ceiling on the number of tasks returned in a Monte Carlo sensitivity
# tornado (ADR-0140). The ranking is "the tasks that move the finish most", so a
# top-N is the point — and it bounds the response payload regardless of project
# size. Callers can override via the ``sensitivity_cap`` parameter of
# :func:`monte_carlo`.
MC_SENSITIVITY_CAP = 20


# Number of runs the sensitivity tornado is computed over (#1525). The full Monte
# Carlo distribution still uses every run for P50/P80/P95; only the duration
# tornado — an O(n · runs · log runs) all-columns rank sort — is capped, at this
# many runs. Spearman rank correlation converges quickly, so a few thousand runs
# fix the top-N ranking to within ~0.02 of the full-run correlation, far tighter
# than the ranking needs. This makes the tornado cost independent of ``runs``.
MC_SENSITIVITY_SUBSAMPLE = 2_000
