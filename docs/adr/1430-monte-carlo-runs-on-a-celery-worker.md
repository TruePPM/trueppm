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
   freeze, `n_simulations`, and the two COUNT size caps (402 / 400) — creates a
   `PENDING` `TaskRun` (`scheduling.monte_carlo`) and answers **202**
   `{task_run_id, status: "pending", n_simulations}`. The `monte_carlo` throttle still
   gates the `POST`.
2. `scheduling.run_monte_carlo_simulation` runs on a worker, adopting that `TaskRun`
   (`TaskRunTracker(task_run_id=...)`) so the id the client polls is the one that
   finishes. It runs the same body the view ran: admission, the engine, the
   `mc_latest` cache refresh, and the attributed `MonteCarloRun` row.
3. **The attributed-row decision is made in the request.** A Member's run refreshes the
   forecast but records no history row (#1502); the worker has no request to read a
   role from, so the view passes `persist`.
4. **Refusals keep their bodies.** A refusal that used to be a 400/402/503 response is a
   `FAILED` run whose `result_summary` is that body plus `status_code`
   (`TaskRunRefused`). `result_summary` is readable by every member; `error_detail`
   stays Admin-only raw exception text. The web hook rebuilds the refusal as the axios
   error it used to receive, so `describeWriteRefusal` renders it unchanged. The busy
   refusal loses its `Retry-After` header — a task run has no headers.
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
  throttle); it is non-mutating and out of this decision's scope.
