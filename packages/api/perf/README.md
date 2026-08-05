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
the sync delta. The task/sync reads are data-driven off the first project the seed
created — no hard-coded UUIDs.

## Reading the output

The run prints a digest to the job log and writes the full k6 metrics blob to
`perf-summary.json` (kept as a CI artifact for 30 days):

```
=== TruePPM perf/load digest ===
iterations:            259
http_req_failed:       0.00%
p95 all endpoints:     1812 ms  (aggregate — not gated)

p95 by endpoint (ms):
  program_list     527  /   1500  ok
  project_list     651  /   1500  ok
  sync_delta       911  /     --  untracked
  task_list       2225  /   2000  BREACH (+11%)

RESULT: 1 threshold breach(es) — see above
================================
```

Each row is `p95 / budget`, where the budget is the endpoint's `p(95)<…`
threshold. **`p95 all endpoints` is an average across every endpoint and no
threshold gates it** — it is printed for continuity only. Read the per-endpoint
rows; those are what k6 exits non-zero on.

`ok` / `BREACH` come from k6's own threshold verdict rather than being re-derived
from the value, so the digest can never disagree with the exit code.

`untracked` means the endpoint is measured but has no budget. k6 only records a
tagged submetric when a threshold references the tag, so an endpoint with no
threshold is invisible — it produces no row, no artifact entry, and no trend.
`sync_delta` is therefore given an always-true `p(95)>=0` threshold purely to
materialize the submetric; give it a real budget once a few nightlies establish
its range.

## Run it locally

```bash
# 1. Boot the stack and seed fixtures (from repo root)
make up
docker compose exec api python manage.py seed_integration_fixtures
# optionally load a larger sample for more representative task lists:
#   docker compose exec api python manage.py load_sample_project --with-personas

# 2. Mint a JWT for a seeded user
TOKEN=$(curl -sf -X POST http://127.0.0.1:8000/api/v1/auth/token/ \
  -H 'Content-Type: application/json' \
  -d '{"username":"<seeded-email>","password":"<password>"}' \
  | python -c 'import sys,json; print(json.load(sys.stdin)["access"])')

# 3. Run the harness
k6 run -e BASE_URL=http://127.0.0.1:8000 -e PERF_TOKEN="$TOKEN" packages/api/perf/load.js
```

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
