# ADR-1474: Open work with no remaining work — an explicit engine input

## Status

Accepted (2026-11-23) — the maintainer chose option 1 on #5070; implemented with #4819.

> **Implementation status (2026-11-23):** implemented with #4819 in both engines
> (`packages/scheduler`, `packages/wasm-scheduler`), the reference CPM oracle, Monte Carlo
> and `derive_value`. The decision itself was taken on #5070 (option 1).

## Context

Layer: **Scheduling engine**. `perturb_task_duration` (the what-if endpoint and the MCP
`whatif` tool) applies a duration delta to the *remaining* work of a started task (#4432).
Since #4536 a pull-in that uses up all remaining work leaves the task open rather than
completing it. Until this ADR the only way to say "open, nothing left" was `duration = 0`.

At zero duration a task is a milestone to every pass. `_start_is_recorded` requires
`duration > 0`, and `_elapsed_link_days` reads the elapsed days off `duration`. So an SS or
SF link out of the task stopped measuring from its recorded `actual_start` (ADR-0132 §2a,
#4523) and measured from the instant instead, behind the start that had actually happened.
On `P -FS-> M -SS+2d-> S`, with `M` 5 days at 40% started 2027-03-05 and a 2027-03-08 data
date, a pull-in of 2 finished on 03-15 and a pull-in of 3 on 03-17 (#4819): removing more
work finished later. A task with progress and no recorded start lost its elapsed days too,
so its derived span start (ADR-0752) could not be computed at all.

Dropping the `duration > 0` test was not an option. It would also change real milestones
that carry an `actual_start` and are not complete, a state the oracle's progress generator
produces, and a milestone's SS/SF links go through its instant, not its link start.

## Decision

1. **A new input, `Task.zero_remaining: bool = False`**, in both engines' task contracts
   (Python dataclass, appended last; Rust `Task`, `#[serde(default)]` under
   `deny_unknown_fields`). `True` says the task is open work with **no remaining work**,
   while `duration` and `percent_complete` keep describing the work done. It is inert on a
   completed task and on a zero-duration milestone, which already have no remaining work.
2. **Placement.** The remaining work is zero (`_effective_duration_days`), so the task is
   placed as an instant exactly as a milestone is (#4079): the same floors, the same
   incoming-link proposals, the same reading. FS and FF links out of it measure from that
   instant. This is the behavior #4536 shipped for those links, unchanged.
3. **Start links.** SS and SF links out of it measure from its link start, as they did while
   work remained:
   - a recorded `actual_start` (the link is start-fixed, #4523: it bounds neither the
     task's late dates nor its free float);
   - with progress and no recorded start, the derived span start: the elapsed working days
     (`floor(duration × pct / 100)`, ADR-0132) backed off from the instant. That start slips
     with the instant, so the link keeps its backward bound, moved onto the instant with
     `_window_start_bound`;
   - with neither, the instant itself, and nothing differs from a milestone.

   One predicate decides it in every pass, `_reads_instant(task, dep_type)` /
   `Task::reads_instant`: false only for SS/SF out of such a task with a recorded or derived
   start. `scheduled_start` is that derived start (or the recorded one).
4. **Monte Carlo.** Such a task is a zero-base column (#4698): its sampled total is floored at
   the elapsed days and handed on as remaining work, so it is an instant in the runs that draw
   no work. Its SS/SF links read the span start in every run, before the instant branch. The
   velocity branch, which reads remaining points (#5012), is floored at nothing.
5. **`perturb_task_duration`** sets `zero_remaining` instead of zeroing `duration`, keeps the
   percentage and actuals, and shifts every sampled input by the whole delta, since the
   elapsed days are no longer lost. A later positive delta clears the flag and restores
   `elapsed + remaining`, so `-3` then `+3` is an exact round trip. The API's
   `applied.new_duration_days` still reports 0 for an exhausted task.

## Consequences

- A bigger pull-in never finishes later than a smaller one, on any link type, lag, start
  reading or calendar, in `schedule()` and in Monte Carlo. The limitation #4536 disclosed is
  removed from the docs.
- `Task.to_dict()` emits `zero_remaining` only when it is `True`, as the Rust engine does
  (`skip_serializing_if`). A network that does not set it serializes exactly as before, so
  the Monte Carlo seed and answer-stamp `input_hash` the API derives from that document do
  not move on upgrade, and only a document that sets the flag needs an engine that knows
  the key.
- `wasm:test` and `scheduler:snapshot-regression` prove only that the two engines agree. The
  correctness check is the reference CPM in `tests/oracle/reference_cpm.py`, which models the
  input independently (`RefProgress.zero_remaining`) and is compared against both engines on
  generated networks covering every link type, recorded and derived starts, the data date,
  SNETs and per-task calendars (`*_matches_reference_with_no_remaining_work`). A mutation that
  measures the start links from the instant again fails it. Its generator keeps per-task
  calendars to FS/SS networks, so per-task calendars on SF/FF networks are checked only for
  monotonicity, engine agreement and `derive_value` agreement, not against the reference;
  extending the oracle there is tracked in #5115.
- No API request field changes. The API never sets the input from stored data; only the
  engine's own perturbation does.

## Alternatives considered

- **Drop `duration > 0` from `_start_is_recorded`.** Rejected: changes real milestones with
  an `actual_start` (above), and still loses the derived-start case.
- **Keep `duration = elapsed` with `percent_complete = 100`-like encodings.** Rejected: any
  percentage below 100 leaves at least one day of remaining work under the integer rule, and
  100% completes the task, which #4536 exists to prevent.
