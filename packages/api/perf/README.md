# API perf/load harness

`load.js` is a [k6](https://k6.io) script that exercises TruePPM's hot read
endpoints under concurrency. It runs nightly in CI as the `perf:load` job and can
be run locally against a dev stack.

## What it is (and isn't)

This is a **relative-regression harness**, not a capacity test. In CI it drives a
single in-pipeline `uvicorn` process on shared runner hardware, so the absolute
latency numbers are **not** representative of production. Its value is:

- **Trend** — the same harness against the same seed each night; a sudden p95
  jump points at a regression (a new N+1, a dropped index, a full-table scan).
- **Tripwires** — the `thresholds` in `load.js` are deliberately loose. k6 exits
  non-zero on a breach, but the CI job is `allow_failure: true`, so a breach is a
  triage signal (warning + artifact), never a red merge gate.

Per-MR N+1 protection lives elsewhere and stays there: the query-count guards in
`tests/apps/projects/test_perf_n_plus_one.py` (#1482) assert *work done*, are
deterministic, and block MRs. This harness complements them by measuring behavior
under concurrent load, which a query count can't.

## Endpoints covered

Mirrors QA plan §9: project list (#1482 N+1 path), task list, program list, and
the sync delta. The task/sync reads are data-driven off the fixture — no
hard-coded UUIDs.

| Tag | Request |
|---|---|
| `project_list` | `GET /projects/` |
| `program_list` | `GET /programs/` |
| `task_list` | `GET /tasks/?project=<id>&page_size=200` — page 1, mirroring what `useScheduleTasks` actually requests |
| `task_list_deep` | the same read at the **last** page, so the OFFSET cost in #2814 lands on the trend line |
| `sync_delta` | `GET /projects/<id>/sync/` |

## Fixture size is part of the measurement

Read this before comparing any two runs.

CI seeds **two** projects: `seed_integration_fixtures` (one task, the login and
smoke fixture) and `seed_capacity` at `PERF_FIXTURE_TASKS` tasks. The harness
targets the capacity project **by name** (`PERF_PROJECT_NAME`, default
`Capacity project 1`), and the digest prints the row count it measured.

Both of those are deliberate, and both are scar tissue from #2816:

- Until then the script took `results[0]` of `/projects/`, which in CI was the
  one-task fixture. **Every `task_list` number the nightly ever reported was the
  latency of serializing a single row.** None of the three regression classes the
  harness advertises was detectable at that size — on one row a dropped index and
  a full-table scan produce the same plan, and an N+1 is one extra query. It is
  why #2767's 3.3x swing survived a 20-commit bisect: no data-scale hypothesis can
  move a one-row query, and the real cause was per-request fixed cost plus runner
  contention.
- With two projects seeded, `results[0]` is whichever the list happens to order
  first — and !1953 has already changed task ordering once. Resolving by name
  makes the target independent of that.

If `PERF_PROJECT_NAME` does not match anything, the harness falls back to the
first visible project and **says so loudly** in the job log. Treat that warning as
"this run's `task_list` numbers are not comparable to any other night's", not as
noise.

## Reading the output

The run prints a digest to the job log and writes the full k6 metrics blob to
`perf-summary.json` (kept as a CI artifact for 30 days). Layout below; the
latencies are **illustrative**, not one specific night's numbers — see
[Endpoint budgets](#endpoint-budgets) for the real 15-night ranges the four
tracked rows were derived from:

```
=== TruePPM perf/load digest ===
iterations:            259
http_req_failed:       0.00%
task_list fixture:     1000 tasks
p95 all endpoints:     1812 ms  (aggregate — not gated)

p95 by endpoint (ms):
  program_list     527  /   4700  ok
  project_list     651  /   4400  ok
  sync_delta       911  /     --  untracked
  task_list        843  /  58000  ok
  task_list_deep  1904  /  50000  ok

RESULT: all endpoint thresholds within budget
================================
```

Each row is `p95 / budget`, where the budget is the endpoint's `p(95)<…`
threshold. **`p95 all endpoints` is an average across every endpoint and no
threshold gates it** — it is printed for continuity only. Read the per-endpoint
rows; those are what k6 exits non-zero on.

`task_list fixture` is the row count behind the two task rows. A `task_list` p95
is only comparable to another run's if both measured the same number of rows, so
check this line before reading a jump as a regression.

`ok` / `BREACH` come from k6's own threshold verdict rather than being re-derived
from the value, so the digest can never disagree with the exit code.

`untracked` means the endpoint is measured but has no budget. k6 only records a
tagged submetric when a threshold references the tag, so an endpoint with no
threshold is invisible — it produces no row, no artifact entry, and no trend.
Such endpoints are therefore given an always-true `p(95)>=0` threshold purely to
materialize the submetric.

### Endpoint budgets

**Four of the five endpoint rows are tracked; `sync_delta` still is not.**
`task_list`, `task_list_deep`, `program_list` and `project_list` were
re-baselined in **#2826** from 15 nightlies against the 1,000-task fixture
(2026-09-04 → 2026-09-15). Per-night p95 (ms):

| date | iterations | `program_list` | `project_list` | `task_list` | `task_list_deep` |
|---|---|---|---|---|---|
| 09-04 | 70 | 1895 | 2208 | 12815 | 9429 |
| 09-05 | 36 | 3097 | 3256 | 21345 | 23602 |
| 09-06 | 69 | 2637 | 3352 | 5240 | 6468 |
| 09-07 | 20 | 156 | 493 | 50447 | 38850 |
| 09-08 | 84 | 1913 | 1918 | 6295 | 3970 |
| 09-09 | 55 | 2094 | 2753 | 18519 | 13080 |
| 09-10 | 79 | 1394 | 1582 | 11919 | 8623 |
| 09-11 01:32 | 57 | 3571 | 3224 | 6676 | 7423 |
| 09-11 05:07 | 75 | 1593 | 1756 | 9032 | 9530 |
| 09-12 | 81 | 1365 | 1478 | 11149 | 9825 |
| 09-13 | 47 | 402 | 830 | 11668 | 13248 |
| 09-14 | 38 | 197 | 450 | 17018 | 17727 |
| 09-15 03:24 | 74 | 2529 | 2485 | 5105 | 4747 |
| 09-15 05:07 | 41 | 389 | 517 | 14496 | 16317 |
| 09-15 12:02 | 46 | 2844 | 3033 | 18622 | 11714 |

Each budget is the observed ceiling in that table times roughly 1.3 (30%
headroom), rounded — a gross-regression tripwire, not an SLA:

| Endpoint | Ceiling | Budget |
|---|---|---|
| `program_list` | 3571 | `p(95)<4700` |
| `project_list` | 3352 | `p(95)<4400` |
| `task_list` | 50447 | `p(95)<58000` |
| `task_list_deep` | 38850 | `p(95)<50000` |

`task_list`'s budget is capped at 58,000 rather than the arithmetic ~65,600: k6's
default per-request timeout is 60 s and `load.js` does not override it, so a
response that actually took 65 s would already have aborted as a request error
(`http_req_failed`) instead of landing in `http_req_duration` as a slow success. A
budget above ~60,000 could never be exercised, so it is capped just under that
wall instead of extrapolating past it.

`program_list` and `project_list` are **not** decoupled into their own k6
scenario, which is what !1964 recommended as the more correct fix — their p95 is
still mostly a measure of queueing behind the heavy task reads in the same
closed-loop iteration, not of the endpoint's own cost. Splitting the light reads
into a separate scenario window (its own executor, its own VU pool) is a harness
redesign that belongs in its own issue with an `architect` pass; #2826 stayed
scoped to giving all four rows an honest number. Practically: a breach on either
of these two rows means "the scenario got slower than any of the last 15
nights," not "this endpoint regressed" — still worth triaging, just not
attributable to that endpoint in isolation.

The wider 15-night sample also complicates the original "faster task reads → more
list-request concurrency → higher list p95" story from the 2026-08-14 breach:
09-07 has both the fewest iterations *and* the slowest task reads *and* some of
the lowest list p95s. Contention on shared CI hardware remains the working
explanation for the spread; it is just not a clean function of iteration count
once more nights are in the sample.

`sync_delta` stayed out of #2826's scope — it has no nightly history of its own
yet — and remains `untracked` under the always-true `p(95)>=0` expression
(`UNTRACKED_EXPR` in `load.js`) purely so k6 materializes its submetric. A future
issue can budget it the same way once a few nightlies establish its range.

## Run it locally

```bash
# 1. Boot the stack and seed fixtures (from repo root)
make up
docker compose exec api python manage.py seed_integration_fixtures

# 2. Seed the task-scale fixture the task-list reads are measured against, and
#    grant the account from step 1 access to it. Skipping this step leaves you
#    measuring a ONE-task project — see "Fixture size is part of the measurement".
export TRUEPPM_CAPACITY_PASSWORD=$(python3 -c \
  'import secrets; print(secrets.token_urlsafe(16))')
docker compose exec -e TRUEPPM_CAPACITY_PASSWORD api python manage.py seed_capacity \
  --projects 1 --tasks 1000 --edge-ratio 1.2 --member-email '<seeded-email>'

# 3. Mint a JWT for that seeded user
TOKEN=$(curl -sf -X POST http://127.0.0.1:8000/api/v1/auth/token/ \
  -H 'Content-Type: application/json' \
  -d '{"username":"<seeded-email>","password":"<password>"}' \
  | python -c 'import sys,json; print(json.load(sys.stdin)["access"])')

# 4. Run the harness
k6 run -e BASE_URL=http://127.0.0.1:8000 -e PERF_TOKEN="$TOKEN" packages/api/perf/load.js
```

The harness looks for a project named `Capacity project 1` and warns loudly if it
finds none, falling back to whatever project it can see. Override the name with
`-e PERF_PROJECT_NAME='<name>'` to point it at a different fixture.

Install k6 from <https://k6.io/docs/get-started/installation/> (Homebrew:
`brew install k6`).

## Cadence in CI

The `perf:load` job is schedule-only (`rules: if $CI_PIPELINE_SOURCE ==
"schedule"`) and non-gating (`allow_failure: true`). Like `api:fuzz`, it
piggybacks on the existing nightly schedules that the workflow allowlist admits
(Renovate / SonarCloud, #2092) — it runs on those scheduled pipelines and never
on MR/push pipelines.

A dedicated weekly schedule with its own flag was the original intent, but
**pipeline-schedule variables are disabled for this project/group** (#2280), so
there is no per-schedule flag to gate on — piggybacking on the nightly is the
working equivalent of `api:fuzz`'s cadence. If schedule variables are re-enabled
later, the job can be moved back onto its own `PERF_SCHEDULED` schedule.
