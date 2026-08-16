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
latencies are **illustrative, not measured** — the two task rows have no published
range yet (#2826):

```
=== TruePPM perf/load digest ===
iterations:            259
http_req_failed:       0.00%
task_list fixture:     1000 tasks
p95 all endpoints:     1812 ms  (aggregate — not gated)

p95 by endpoint (ms):
  program_list     527  /     --  untracked
  project_list     651  /     --  untracked
  sync_delta       911  /     --  untracked
  task_list        843  /     --  untracked
  task_list_deep  1904  /     --  untracked

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

**Every endpoint row is untracked today**, and `#2826` is where they get budgets
back. `sync_delta` never had one. `task_list` and `task_list_deep` lost theirs in
**#2816**: the old `p(95)<2000` was calibrated to serializing one row, so carrying
it onto a 200-row page would breach every night — and a tripwire that always fires
is worse than none, which is exactly what made #2767 un-bisectable.

`program_list` and `project_list` lost their `p(95)<1500` for the same reason one
step removed. #2816 did not change what those two request; it changed what they
queue behind. The scenario is a closed loop — 20 VUs issue the five requests in
sequence against a single uvicorn process — so once the task reads went from ~1 ms
to 8–50 s, a list request's p95 became mostly the wait for the heavy read in front
of it. Over the four post-#2816 nightlies `program_list` ran 251 / 740 / 183 /
2570 ms and `project_list` 431 / 979 / 352 / 2610 ms, a 14x spread with no
relevant code change, and the 2026-08-14 breach that prompted this landed on a day
whose only commit touched three unrelated viewsets. The coupling also runs the
wrong way for a latency budget: the breach night was the one where the task reads
were *fastest*, which let 50 iterations through instead of 24 — more list
requests, higher concurrency, higher p95. Iterations and latency are the same
variable here (#2767).

So the harness currently gates only `http_req_failed`, and the endpoint rows are
pure trend lines. When setting budgets in #2826, derive each from the observed
range rather than picking a round number — a budget nobody measured is
indistinguishable from noise. For the two list rows, prefer decoupling them into
their own scenario window over simply widening the number: a wider budget on a
contention-coupled metric buys a quieter nightly, not a better signal.

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
