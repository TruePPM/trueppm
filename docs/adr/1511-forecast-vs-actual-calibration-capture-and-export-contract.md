# ADR-1511: Forecast-vs-actual calibration capture and its export contract

## Status

Accepted (2026-11-26), #4747

## Context

Saying that TruePPM's P50/P80/P95 are "statistically calibrated" requires
evidence: over many forecasts, about 80% of forecast items should finish on or
before their P80. Nothing recorded that evidence. A baseline froze each task's
deterministic finish (`BaselineTask`), but the Monte Carlo distribution behind
it was not kept. `MonteCarloRun` keeps project percentiles, but it is capped to
the newest N runs and purged. `ForecastSnapshot` (ADR-0106) is milestone-grain
and read latest-per-milestone, and #952 purges it after 90 days. An actual
finish usually arrives months after the forecast it tests, which is longer than
either of those lifetimes.

#4747 asks for the instrumentation and a data contract only. The calibration
analysis and report are #2299. Per-task percentiles depend on #4135: the engine
already computes them (`monte_carlo(targets=...)`), but the API cannot call it
until a `trueppm-scheduler` release that contains it is published.

## Decision

### What is captured, and when

One capture is written at **every baseline snapshot** of an opted-in project.
It hooks `baselines.snapshot_tasks`, the single function that the commit moment
(ADR-0845), a named REST capture, and a taken baseline decision (ADR-1477) all
call. A capture is therefore taken once per baseline, on every path.

- `kind` is `replan` for a taken decision's v(n+1), and `baseline` for every
  other path.
- A capture is one **project-scope** row plus one **task-scope** row for each
  task in `Task.committed`, the CPM domain. Backlog, epic and recurring rows
  carry no forecast and are skipped.
- Every row stores `capture_id`, `captured_at` (the forecast timestamp),
  `kind`, `deterministic_finish` and `deterministic_finish_at_day_start` (the
  CPM finish and its day edge, #4178), and `p50`/`p80`/`p95`.
- Project scope: the percentiles, `distribution_computed_at` and
  `mc_iterations` are **copied** from the project's latest `MonteCarloRun`.
  They are null when Monte Carlo has never run. `distribution_computed_at` can
  be earlier than `captured_at`, and an analysis should decide how stale a
  distribution it will accept.
- Task scope: the percentiles stay null until #4135 lands. The columns already
  exist, so filling them changes no schema.
- Writing a capture is best-effort. It runs in a savepoint, and a failure is
  logged and never raised, because instrumentation must not be able to block a
  baseline.

### When the actual finish is joined

**At export, from `Task.actual_finish`. It is never copied onto the row.**
`Task.actual_finish` is the system of record, and a PM can correct it. A copy
taken at completion would then contradict the corrected value. A copy would
also need a hook on every completion path: REST PATCH, sync push, import,
agent writes and bulk edits. Missing one hook would bias the sample without any
visible sign. A read-time join covers every path at once.

- Task outcome: `finished` (an actual finish is present), `open`, or `deleted`
  (the task is soft- or hard-deleted; its forecast is kept, with no actual).
- Project outcome: `finished` only once every committed task has an actual
  finish. The project's actual finish is then the latest of those dates.

### Consent (ADR-0104)

- The opt-in is a per-project flag, `Project.forecast_calibration_capture`. It
  is off by default. It is **not inherited** from a program or workspace and
  **not copied** by a settings template: it is the team's own opt-in, and a
  project that changed nothing shares nothing (ADR-0104 §3).
- Writing the flag requires Admin+ (the serializer's allowlist default; it is
  not in `_SCHEDULER_WRITABLE_FIELDS`). It is not excluded from history, so
  every change of consent is audited (ADR-0104 §4).
- Withdrawing consent stops capture and removes the project from **every later
  export**. The rows themselves are kept, so the project can opt back in
  without losing history. The rows are deleted when the project is deleted
  (CASCADE).
- Aggregate only. A row holds dates, UUIDs and a milestone bit, never a user,
  an assignee, a task or project name, or free text. Calibration measures the
  forecast, not the people doing the work.

### Retention, and #952

Calibration rows live in their own table, `projects_forecast_calibration_record`.
No purge touches that table: not #952 (`ForecastSnapshot`), not the
`ProjectForecastSnapshot` tiered prune (ADR-0154), and not the `MonteCarloRun`
cap (ADR-0175). This is deliberate, because a row is useless until its actual
arrives. The Monte Carlo percentiles are copied rather than referenced for the
same reason. A deleted baseline sets `baseline` to null and keeps the row,
because deleting a baseline does not undo the forecast it carried. Growth is
bounded by baseline frequency: about one row per committed task per baseline.

### Export: a management command, schema `trueppm.forecast-calibration` v1

The export is `manage.py export_forecast_calibration [--project <uuid>]...
[--output <file>]`. It writes JSON Lines: a header line `{"record": "header",
"schema": "trueppm.forecast-calibration", "version": 1, "exported_at",
"project_count"}`, then one line for each record:

| Field | Type | Meaning |
|---|---|---|
| `record` | `"forecast"` | Line type |
| `project_id`, `capture_id` | UUID string | Project; capture group |
| `captured_at` | ISO datetime | When the forecast was made |
| `forecast_kind` | `baseline` \| `replan` | Which plan event |
| `scope` | `project` \| `task` | Grain |
| `task_id` | UUID string \| null | Null on project scope |
| `is_milestone` | bool | Task is a milestone |
| `deterministic_finish` | ISO date \| null | CPM finish at capture |
| `deterministic_finish_at_day_start` | bool \| null | Day edge of that finish |
| `p50`, `p80`, `p95` | ISO date \| null | Forecast percentiles |
| `distribution_computed_at` | ISO datetime \| null | When the copied distribution ran |
| `mc_iterations` | int \| null | Runs behind it |
| `actual_finish` | ISO date \| null | Joined at export |
| `outcome` | `finished` \| `open` \| `deleted` | Join result |

Adding a field is a minor change and keeps version 1. Renaming, removing or
retyping a field bumps `version`. `test_forecast_calibration.py` pins the key
set.

**Why a command and not an HTTP endpoint.** The export crosses every opted-in
project, which makes it an exfiltration surface. Running a command requires
shell access to an API pod, which is above any role an API token, an MCP agent
or a self-granted workspace role can hold. That keeps agents governed: no token
can pull the data. Dogfooding on TruePPM's own instance and receiving a file
from a design partner are both operator actions, so a command fits both. The
opt-in setting itself is in the API, as API-first requires.

## Alternatives considered

- **Extend `ForecastSnapshot`** (add `p95`, `kind`, `task`, and a calibration
  scope). Rejected for the same reasons ADR-0175 rejected its Alternative A.
  The calibration rows would have to be exempted from #952's 90-day purge and
  filtered out of the latest-per-milestone read, and they would dilute that
  model's velocity-privacy invariant.
- **Join from `BaselineTask` at export, with no new table.** Rejected because
  `BaselineTask` cascades when its baseline is deleted, and it holds no
  distribution.
- **Stamp the actual on completion.** Rejected; see *When the actual finish is
  joined*.
- **An HTTP export behind `IsWorkspaceAdminStrict`.** Possible later, if design
  partners need an export without shell access. Not needed for the dogfooding
  this issue asks for.
- **Workspace-level opt-in.** Rejected, because a workspace admin would be
  consenting on a team's behalf (ADR-0104).

## Consequences

- Calibration can be measured from the day a project opts in. It cannot be
  backfilled, because past distributions were never kept.
- The acceptance item "one month of TruePPM's own data captured" is operational
  and cannot be met by the MR that ships this. It stays open on #4747.
- Task-scope percentiles stay null until #4135. Until then, the project scope
  is the only grain where calibration can be measured.
- OSS. A single project's own forecast record is not cross-program governance.
