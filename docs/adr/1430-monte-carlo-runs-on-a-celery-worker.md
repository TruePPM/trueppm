# ADR-1430: Monte Carlo runs on a Celery worker

- **Status:** Accepted
- **Date:** 2026-11-18
- **Issue:** #2273
- **Supersedes:** the synchronous-by-design decision recorded on `run_monte_carlo` (#1203)

## Context

`POST /projects/{id}/monte-carlo/` ran the simulation inline. #1203 justified that:
every multiplicative cost factor is capped, so one run's wall time and memory fit the
request budget. That argument is about **one** run. With `ATOMIC_REQUESTS=True` every
in-flight run also holds a web worker and an open database transaction for its whole
duration, so a handful of concurrent runs can pin the connection pool and starve
unrelated requests. The per-process slot (`MC_MAX_CONCURRENT`) bounds CPU, not the
connections the waiting requests hold.

## Decision

1. The request validates what is cheap and caller-specific — membership, the archived
   freeze, `n_simulations` (including an explicit count above the static
   `MC_SIMULATION_CAP`, one comparison, the same 402 body the engine produced), and
   the two COUNT size caps (402 / 400) — creates a `PENDING` `TaskRun`
   (`scheduling.monte_carlo`) and answers **202**
   `{queued: true, task_run_id, status: "pending", n_simulations}` (the `queued` marker
   is the api/stability.md `202` contract). The `monte_carlo` throttle still gates the
   `POST`.
2. `scheduling.run_monte_carlo_simulation` runs on a worker, adopting that `TaskRun`
   (`TaskRunTracker(task_run_id=...)`) so the id the client polls is the one that
   finishes. It runs the same body the view ran: admission, the engine, the
   `mc_latest` cache refresh, and the attributed `MonteCarloRun` row.
3. **The attributed-row decision is made in the request, and re-checked on the
   worker.** A Member's run refreshes the forecast but records no history row (#1502);
   the worker has no request to read a role from, so the view passes `persist`. A run
   can wait in the queue, and the worker is what writes, so before simulating it
   re-reads the archived flag (`assert_project_not_archived`) and the requester's live
   membership: an archived project or a lapsed membership fails the run with the
   request's 403 body, and a requester demoted below Scheduler since queueing has
   `persist` downgraded to false (never upgraded). The worker also checks the run's
   cancel flag once, before the engine starts.
4. **Refusals keep their bodies.** A refusal that used to be a 400/402/503 response is a
   `FAILED` run whose `result_summary` is that body plus `status_code`
   (`TaskRunRefused`). `result_summary` is readable by every member; `error_detail`
   stays Admin-only raw exception text. The web hook rebuilds the refusal as the axios
   error it used to receive, so `describeWriteRefusal` renders it unchanged. The busy
   refusal loses its `Retry-After` header — a task run has no headers.
   The static run cap is now checked first, in the request: an explicit `n_simulations`
   above `MC_SIMULATION_CAP` answers 402 even where the project is also over the task or
   dependency cap, or where runs x tasks exceeds `MC_CELL_CAP` (formerly 400).
5. **The result is read from `latest/`,** which already derives the per-response facts
   (risk premium, staleness, commitment). The task run's `result_summary` carries only
   `{run_id, n_simulations, last_run_at}`, so the forecast has one read path.

## Alternatives considered

- **Keep a synchronous path for small projects.** Rejected: two contracts for one
  endpoint, chosen by a size threshold the client cannot see, and every client still has
  to implement polling for the large case. One contract is simpler to document and test.
- **Additive opt-in (`?async=true`).** Rejected: the default would keep the defect the
  issue exists to remove.
- **Outbox + drain, like CPM recompute.** Rejected for now: a forecast is a re-runnable
  read, not a write that must eventually land. A broker that refuses the publish fails
  the run immediately (`simulation_queue_unavailable`, 503) and the user's next click is
  the recovery, instead of a durable retry of a stale request.
- **Return the result on the task run.** Rejected: it would duplicate the 30 KB
  distribution payload and freeze the per-response facts `latest/` derives at read time.

## Consequences

- **Breaking** for API clients that read the forecast from the `POST` body. The web app
  is updated in the same change; the MCP server only reads `latest/`. Recorded as
  `changed` in the changelog and in the API reference.
- Concurrency is bounded by worker concurrency, not web workers; the request holds a
  connection only for validation and one insert.
- `GET /monte-carlo/whatif/` still simulates inline (two runs per call, its own tighter
  throttle); it is non-mutating and out of this decision's scope — tracked separately
  (issue to be filed).
- **Shared queue.** The task runs on the default Celery queue alongside CPM
  recalculation, imports and email; a burst of forecasts delays those and vice versa.
  A dedicated queue is #2276's concern and is not done here. `MC_MAX_CONCURRENT` is a
  per-process semaphore: a prefork child runs one task at a time and never contends for
  it, so on the worker the bound is `--concurrency`, and the setting now binds only the
  what-if in the API process. The `simulation_busy` refusal is therefore effectively
  unreachable for this endpoint under prefork.
- **Every member sees the run.** The tracker broadcasts `task_run_*` to the project
  group, so every connected member's `TaskRunIndicator` counts a forecast another
  member started. Kept: it is real background work on the project, finishes in seconds,
  and the indicator already counts imports the same way. Terminal `task_run_*` events
  now carry `task_name` (additive), so the program schedule page, which refetches the
  merged CPM on `task_run_completed`, skips `scheduling.monte_carlo`.
- **Last writer wins.** Two runs of one project are not serialized (the lock is per
  task run); whichever finishes last owns the `mc_latest` cache. A Member's forecast
  lives only in that 24-hour cache, so once it expires `latest/` falls back to the
  most recent persisted (Scheduler+) row — possibly older than the Member's run — and
  says so with `from_history: true`.
- **Stranded runs (known limitation).** A redelivered message for a settled run is a
  no-op (adoption only claims `PENDING`/`RUNNING`). But a worker killed by the hard
  `time_limit` (330 s) or lost without redelivery leaves the row `RUNNING` with nothing
  to advance it, and there is no reaper sweep for `scheduling.monte_carlo`; the web
  client gives up polling at 330 s with a retryable message. A cancel is honored only
  if it lands while the run is still queued and the worker picks it up within the
  cancel flag's 300 s TTL; a cancel of a `RUNNING` simulation does nothing, because
  the engine is one uninterruptible call bounded by `MC_WALL_CLOCK_BUDGET_SECONDS`.
