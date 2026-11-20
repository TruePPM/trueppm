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
warns (orange) past 45 days and fails past 90.

`semgrep:refresh-mr` (`scripts/refresh-semgrep-rules-mr.sh`) is the refresh. It
rides the nightly `SONAR_SCHEDULED` schedule, does nothing until the stamp is 7
days old, then runs `scripts/update-semgrep-rules.sh` and opens an MR only if a
pack changed (branch `chore/semgrep-rules-refresh-YYYYMMDD`, label
`no-changelog`). When upstream is unchanged it restores the stamp and opens
nothing, so `REFRESHED` records the last refresh that CHANGED the packs: the job
re-fetches nightly while stale, and the 45-day warning can still fire after a
long unchanged upstream. If upstream stays unchanged for 90 days the job goes
RED even though the refresh job is healthy; that is accepted as unlikely. It skips while a refresh MR is open or was closed in
the last 7 days, and fails loudly without `SEMGREP_REFRESH_TOKEN`
(masked project access token, `api` + `write_repository`, Developer+; an
operator creates it). The MR pipeline's `security:semgrep` runs the new packs
against the tree, so a rule that newly flags code reds the MR rather than main.

The job has schedule-only `rules:` and cannot run on an MR pipeline. What is
checkable locally: `bash scripts/refresh-semgrep-rules-mr.sh --self-test` (age
gate, unchanged vs. changed packs, open/closed-MR dedupe, against a stubbed
updater, curl and push target) and `--dry-run` (set `SEMGREP_REFRESH_AFTER_DAYS=0` to force a real fetch;
restores `.semgrep/` afterward). The push and MR-create calls are exercised only
by the first scheduled run. The stamp is written only by the update script,
after a real fetch.
