# 2026-09-16 — same-host A/B and the JIT finding (#3829)

Raw data behind the corrected tested envelope in
`packages/website/src/content/docs/administration/sizing.md`.

The two earlier published runs were taken on **different machines** (2026-07-26 on an
Apple M1 Max, 2026-09-15 on an Apple M5 Pro), so they could not be compared. This run
puts both code versions on **one** host, back to back, and then diagnoses what the
harness had been measuring.

## Host

Apple M5 Pro (6 performance + 12 efficiency cores), 64 GB, macOS 26.5.1. Docker Desktop
29.7.2 allocated 18 CPU / 8 GB / 1 GB swap (the Docker Desktop defaults on this machine,
and the allocation the 2026-09-15 run used). PostgreSQL 16 as configured in
`docker-compose.capacity.yml` (`shared_buffers=1GB`). The developer stack was running in
the same Docker VM throughout; every run shares that condition. Swap moved by at most
3 MB in any run and ~3.8 GB stayed available, so memory was not a constraint.

## Code under test

| Name | Commit | Notes |
|---|---|---|
| `july` | `89fc5137f` + the July `seed_capacity.py` | The command did not exist at `89fc5137f`; the July image was built with it uncommitted. It is taken from `2323f6d64` and is the only file added. |
| `current` | `9dca6c525` | The commit the 2026-09-15 run measured. Predates #2814. |
| `main` | `311511854` | `main` when the fix branch was cut; includes #2814. Used only as the control for `fix`. |
| `fix` | `311511854` + #3829 | `main` with PostgreSQL JIT turned off on every application connection. Also the image behind `scale/` and `multi/`. |

Both images were built with `PSYCOPG_EXTRA=binary`, as the dev compose builds
`trueppm-api:local`. One copy of the harness (`run_capacity.py` from `9dca6c525`,
unchanged) drove every run; `scripts/compose.diff` shows the three changes made to its
compose file: a ≥12-character DB password so `9dca6c525` boots (#3826), the seeder's
source mount taken from a variable so each arm seeds with its own code, and `jit` made a
variable for the diagnostics.

The seeders' task and edge generation and fixed random seed are identical in both
versions; they differ only in sync bookkeeping fields that the task read does not touch.

## Files

| Path | What |
|---|---|
| `runs/{july,current}-{a,b,c}/` | `run_capacity.py --dimension full_load`, three interleaved runs per arm. `meta.json` records chip, core split, Docker allocation, image id and host load. |
| `runs/current-jit-off/` | The same sweep on `current` with PostgreSQL `jit = off`. |
| `diagnostics/current-fresh-stack-2000.txt` | Seeding straight to 2,000 tasks on a fresh stack: no slow request. |
| `diagnostics/current-harness-sequence-autovacuum.txt` | Replaying the harness's step sequence with `pg_stat_user_tables` sampled: the slow request follows autoanalyze. |
| `diagnostics/forced-analyze-jit-on.txt` | `ANALYZE` after every seed, both arms, `jit = on`: the steady state. |
| `diagnostics/jit-off-sweep-and-forced-analyze.txt` | The same with `jit = off`, up to 8,000 tasks. |
| `diagnostics/main-with-and-without-fix-forced-analyze.txt` | The fix, verified with the **server** left at `jit = on`: `main` 0.74 s @ 1k / 14.4 s @ 2k; `main` + fix 0.50 s @ 1k / 1.1 s @ 2k / 2.8 s @ 4k / 7.7 s @ 8k. The only difference between the two images is the fix. |
| `diagnostics/slow-query-log-*-2000-tasks-jit-on.txt` | Every statement over 3 s during seven 2,000-task loads. All are the page `SELECT`; none is the pagination `COUNT`. |
| `explain/current-2000-tasks-offset1000-jit-{on,off}.txt` | `EXPLAIN (ANALYZE, BUFFERS)` of one page: 4,512 ms with JIT on (4,457 ms of it JIT), 49 ms with JIT off. |
| `explain/current-page-query-offset1000.sql` | The statement explained above. |
| `scale/` | One project from 2,000 to 100,000 tasks on the `fix` image, `ANALYZE` after each seed: first/middle/last page timings, response size, whole-project load (measured to 16,000, computed from page timings above), task-table size, and a CPM recalculation run in-process as the Celery worker runs it, with its peak RSS. Container CPU and memory peaks for both phases. 64,000 and 100,000 were refused by the scheduler's span guard (#3830). **Every size re-seeded the same database**, so the larger sizes ran after heavy delete/insert churn — see `fresh/` for the load figures `sizing.md` publishes. |
| `fresh/fresh-database-16k-32k-100k.log` | The same whole-project reading at 16,000, 32,000 and 100,000 tasks, each on a **freshly created** database (`down -v` between sizes). About three times faster at the top end than `scale/`, which re-seeded one database at every size; `sizing.md` publishes these figures and notes the difference. Produced by `scripts/fresh_probe.py`. |
| `explain/fix-32000-tasks-offset31800-jit-off.txt` | `EXPLAIN (ANALYZE, BUFFERS)` of the last page of a 32,000-task project on the `fix` image with JIT off: 1,800 ms, the nested loop emitting all 32,000 rows with 21 per-task subplans before the `LIMIT` discards 31,800. The same query at `OFFSET 0` took 24 ms. |
| `explain/fix-page-query-offset31800.sql` | The statement explained above. |
| `multi/concurrent-users-*.log` | 1, 2, 4 and 8 users opening one 8,000-task Schedule simultaneously, with the shipped single uvicorn process and with `scripts/compose-workers4.yml` (`--workers 4`) — the only difference between the two (#3833). |
| `multi/neighbors-and-program-cpm.log` | A 5,000-task project alone vs. among 20 (100,000 tasks in the database): Schedule open, program rollup, project list. Then 20 × 1,500-task projects: one member's recalculation vs. the merged program recalculation. |
| `multi/multi.json` | The same, structured. |
| `scripts/` | The driver scripts. They assume a scratch layout with `harness/` (a copy of `perf/capacity/` with `compose.diff` applied) and `src-<arm>/` checkouts beside them, and read `TRUEPPM_REPO` and `TRUEPPM_CAPACITY_PASSWORD` from the environment. For the `july` arm the password must be the July seeder's hard-coded value. |

## Reading the harness JSON

Each step takes 7 samples, and the harness's `p95` is `times[int(n * 0.95)]` — with
n = 7 that is the **slowest** sample. Read `p50_ms` alongside it. The harness does not
`ANALYZE` after seeding, so a step's plan depends on whether autovacuum has refreshed
statistics yet; the `forced-analyze` diagnostics are the steady-state figures.
