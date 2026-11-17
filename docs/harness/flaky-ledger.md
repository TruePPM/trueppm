# Flake detection harness: ledger, MR soak, semgrep freshness

Three CI additions that turn silent failure modes into recorded or loud ones.

## `web:e2e:soak` (#2753)

MR-only. Runs the spec files the MR adds or modifies (`web:e2e:soak:detect`
lists them via `scripts/ci/changed-e2e-specs.sh`) with `--repeat-each=5
--workers=8 --retries=0`. Both exposing variables are deliberate: repetition
alone did not reproduce #2752, CPU contention did. `--retries=0` because a retry
would convert a 1-of-5 failure into a pass. Blocking. It does not cover an
unchanged spec destabilized by a source change; that is the nightly run in #3547.

## Flaky ledger (#2754)

`packages/web/scripts/check-flaky.mjs` only sees fail-then-pass inside one job.
`packages/web/scripts/flaky-ledger.mjs` adds a persisted ledger and a job-level
retry detector (the same job `failed` and then `success` for one sha, read from
`GET /projects/:id/pipelines/:id/jobs?include_retried=true` over the last 20
`main` pipelines). The `web:flaky-ledger` job (main pushes, `allow_failure`)
downloads the previous run's `packages/web/flaky-ledger.jsonl`, appends, and
re-publishes it as an artifact (90 days).

### Contract for other writers (#3547)

One JSON object per line:

```
{ "schema": 1, "kind": "retry-pass" | "job-retry" | "repeat-fail",
  "date": "YYYY-MM-DD", "sha": "...", "pipeline": 123, "job": "web:e2e",
  "test": "optional title path", "file": "optional spec path" }
```

`repeat-fail` is reserved for the nightly `--repeat-each` run. A new writer
should import `mergeLedger` / `parseLedger` from `flaky-ledger.mjs` and append to
the same artifact rather than creating a second one. Entries de-duplicate on
`(kind, sha, pipeline, job, test)`.

Not done: `TRUEPPM_FLAKY_FAIL=1` stays off until the suite is clean, and the
`CI_JOB_TOKEN` read of the jobs API is unproven until the first main run (the job
logs the HTTP status and stays green if refused).

## `lint:semgrep-freshness` (#3103)

`.semgrep/REFRESHED` is written by `scripts/update-semgrep-rules.sh`. The job
warns (orange) past 45 days and fails past 90. Refresh is manual; a scheduled
refresh MR needs a write token and a new pipeline schedule.
