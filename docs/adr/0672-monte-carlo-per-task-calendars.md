# ADR-0672: Monte Carlo Over Per-Task Calendars — the Reference Working-Day Space

## Status
Accepted — implemented in #1385. Completes the Monte Carlo half of
[ADR-0120](0120-cross-project-dependencies-within-program.md) D3, whose
deterministic half shipped in #1117.

**Tracking:** [#1385](https://gitlab.com/trueppm/trueppm/-/issues/1385).

## Context

ADR-0120 D3 gave the engine per-task calendars so a program-scoped pass can merge
member projects that each keep their own working week. `schedule()` got that
support essentially for free: its forward/backward passes stay in scalar `date`
arithmetic per node, so each node simply resolves its own calendar.

`monte_carlo()` did not. The vectorised pass does not work in dates at all — it
works in **integer working-day offsets** against one project-wide index, because
that is what lets 10 000 runs × N tasks be a handful of numpy operations instead
of a Python loop over dates. One index means one calendar. Rather than silently
simulate a multi-calendar project on the wrong calendar — producing P50/P80/P95
that disagree with `schedule()` on the same input, with no error — the pass
rejected a non-empty `Project.calendars` registry outright (#1566).

That left a real hole. `program_schedule.py` builds exactly such a merged project
and runs deterministic CPM on it, so a program had a critical path and a finish
date but **no probabilistic band** — the one number a program manager is most
often asked for. It also undercuts the 0.4 MCP story, whose headline is a
non-mutating Monte Carlo what-if.

## Decision

Make the vectorised pass calendar-aware in three places, and leave the hot loop
alone.

### 1. Each task's column lives in its own calendar's offset space

One working-day index is built per *distinct* calendar (keyed by object identity;
`Calendar` holds a mutable exceptions list and is not hashable). A task's ES/EF
column is expressed in the space of the calendar it resolves to, so duration
expansion stays a plain vector add — exactly as before.

### 2. Each edge's delta array carries the cross-calendar hop

The existing per-`(dep_type, lag)` delta array is keyed on
`(dep_type, lag, pred_calendar, succ_calendar)`. The anchor is read in the
predecessor's space and the snap lands in the successor's, which is correct
precisely because **lag is consumed on the successor's calendar** — the same rule
`_forward_pass` applies, where the node being computed owns the snap of every
incoming constraint.

The consequence is that `_mc_forward_pass` needs no calendar argument at all: it
still evaluates `anchor + delta[round(anchor)]` and lands in successor space. The
hot loop is untouched.

One short-circuit had to be narrowed: within a single calendar a lag-free FS/SS/FF
edge needs "no adjustment" and stores `None`. Across two calendars there is no
such thing as no adjustment even at zero lag — the delta *is* the conversion — so
the `None` case is now gated on the two calendars being the same.

### 3. The project maximum is taken against a union reference index

This is the non-obvious part, and the reason for this ADR.

The per-run project completion is `max(EF)` across tasks. Offsets are only
comparable within the calendar that produced them: offset 20 on a Mon–Fri week and
offset 20 on a seven-day week are different dates, and **the larger offset is
frequently the earlier date**. The maximum must therefore be taken on a shared
ruler, and the finish *date* is the only thing the spaces agree on.

That ruler is **not the project calendar**. A task on a seven-day week can finish
on a Sunday, which has no offset at all in a Mon–Fri space; mapping into it
silently reports the previous Friday. (This was caught by the cross-calendar
parity tests during implementation, not in review.)

Nor is it `Calendar.compose()`. That helper unions *non-working* time — it
intersects working days — because it exists to overlay constraints onto one
resource. Here the requirement is the opposite: **representability**. Every date
any task can finish on must have an offset.

The reference is therefore the **union of every calendar's working days**, built
directly as the sorted unique ordinals of the per-calendar indices. Each column is
re-expressed against it before the maximum; the existing percentile and
offset→date machinery then applies unchanged.

## Consequences

- **Single-calendar projects are byte-identical.** The reference path is entered
  only when more than one distinct calendar is resolved, so a project with no
  registry — or one whose registry no task opts into — takes the original code
  path and its seeded P50/P80/P95 are unchanged. This is asserted directly, and
  the ~1 050-test suite passing unmodified is the broader evidence.
- **`schedule()` is the oracle.** A fully deterministic project simulates to
  precisely the CPM finish date, so the parity tests assert `monte_carlo()`
  against `schedule()` across all four dependency types at zero, positive, and
  negative lag, in both calendar directions. Any wrong-calendar snap breaks it.
  *(Amended by #2833: exact equality holds except for an in-progress task whose
  `actual_start` falls on a non-working day. The working-day index has no offset
  for that date, so its early-start floor snaps forward and the finish can land
  up to one working day late — deliberately, since the only other stand-in
  reports* earlier *than CPM. The oracle relation there is `monte_carlo() >=
  schedule()`; see the `_mc_es_floors` docstring.)*
- **Cost.** One index and one ordinal array per distinct calendar, plus one
  column-wise conversion before the maximum — all only on the multi-calendar
  path. The `MAX_LAG_DELTA_CELLS` cap now also bounds cross-calendar fan-out,
  since the key space is multiplied by the calendar pairs an edge actually joins.
- **The engine is no longer the blocker; the API surface is.** Nothing calls
  `monte_carlo()` at program scope yet — `program_schedule.py` is a deterministic
  read surface with no probabilistic sibling, and there is no program-scoped
  Monte Carlo endpoint or MCP tool. That work is tracked separately and is what
  actually delivers the program-scope what-if to users.
- **The Rust engine still refuses per-task calendars** (`validate.rs`), and has no
  Monte Carlo at all. The conformance suite therefore cannot yet prove the two
  engines agree on this arithmetic; closing that is #1504/#1497.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep the rejection, document it | Leaves the program-scope band permanently missing; the case per-task calendars were built for is the case that cannot be simulated |
| Rewrite the pass in absolute date-ordinal space | Removes the working-day-offset representation the vectorisation depends on, and changes percentile interpolation for every existing single-calendar consumer |
| Use the project calendar as the shared ruler | Lossy — a finish on a day the project calendar treats as non-working collapses to the previous working day |
| Use `Calendar.compose()` as the shared ruler | Intersects working days; strictly worse than the project calendar for representability |
| Simulate each calendar's sub-project separately and combine | Cross-calendar edges are exactly what a program pass is for; independent runs cannot express them |
