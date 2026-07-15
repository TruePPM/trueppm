# Parallel worktrees

Working on multiple issues at once is friction-heavy in a single working tree —
`git checkout` swaps thousands of files, file watchers thrash, and parallel
agent sessions step on each other's branches. The `scripts/wt` helper sets up
a per-issue git worktree so each ticket lives in its own directory with shared
dev dependencies.

## Safe by construction

Parallel agents can self-serve `wt new` / `wt remove` without a human
coordinating who owns which checkout. Three **structural** guards — not process
discipline — stop one session from stomping another's worktree:

1. **Fresh branches don't track `origin/main`.** `wt new` creates the branch
   with `--no-track`, so a just-created, uncommitted, unpushed worktree is never
   mistaken for a merged-and-deleted branch. (That confusion was the original
   bug: both look like a 0-commit ancestor of `origin/main` with no
   `origin/<branch>`, so `wt prune` reaped the fresh one out from under a running
   agent.) The branch gets its real upstream on its first `git push -u`.
2. **A freshness grace window.** Each worktree is stamped with a `.wt-owner`
   marker at creation. `wt prune` refuses to reap any worktree younger than
   `TRUEPPM_WT_GRACE_MIN` minutes (default **30**) unless you pass `--force`, so
   an agent mid-startup is protected even before it commits anything.
3. **Per-worktree test database.** `.envrc` exports a unique
   `TRUEPPM_TEST_DB=test_trueppm_wt_<slug>`, so N worktrees each create and drop
   their **own** Postgres test DB. Parallel `pytest` runs no longer collide on a
   shared `test_trueppm`, which removes the need for an external run lock (and
   `flock(1)` isn't available on macOS anyway).

Those local guards stop two *worktrees* from editing the same files. A second,
distinct hazard is two *agents* independently implementing the **same issue** and
opening duplicate MRs (this happened with #1985 → !1352 + !1353). The GitLab
`status::wip` label (below) is the checked claim signal against that, and the
[pre-push duplicate-MR gate](#pre-push-duplicate-mr-gate) re-enforces it at push
time for **every** branch — including one created with a plain `git checkout -b`,
which bypasses the in-`wt` lock entirely.

## Quick start

```bash
# Create a worktree for issue #600 (slug derived from glab issue title)
scripts/wt new 600

# List active worktrees and current WIP count
scripts/wt list

# Move into the worktree
cd ../trueppm-wt/600-crud-ui-for-project-program-integrations
source .envrc                          # exports COMPOSE_PROJECT_NAME=trueppm
# … work, commit, push, open MR …

# Remove when done (refuses if there's uncommitted work; releases the check-out)
scripts/wt remove 600
```

## Issue check-out lock

When several agents (or people) work the backlog in parallel, they share one
GitLab identity — so assigning yourself an issue or leaving a "taking this"
comment does **not** stop another agent from grabbing the same one. The result
is two worktrees editing the same files, which is exactly the collision the
worktree workflow is meant to prevent.

`wt new` closes that gap by **checking out** the issue on GitLab: it applies a
`status::wip` scoped label and posts a check-out comment recording the branch
and worktree path. Before creating the worktree it first checks whether the
issue is *already* checked out and refuses if so:

```bash
$ scripts/wt new 600
wt: issue #600 is already checked out (label 'status::wip').
  🔒 checked out 2026-07-01T11:24:54Z · branch `feat/600-crud-ui` · worktree `…/trueppm-wt/600-crud-ui`
wt: another agent/worktree is likely on it. Re-run with --force to take it over.
```

- **Take over a stale claim** — if the previous session crashed or abandoned the
  issue, re-run with `--force`: `scripts/wt new 600 --force`. The takeover is
  recorded as a new check-out comment.
- **Claim before you start** — if you've picked an issue up but aren't ready to
  create the worktree yet, `scripts/wt claim 600` applies the same lock with no
  worktree, so a parallel agent sees the claim immediately. Turn it into a
  worktree later with `wt new` (no `--force` needed — you already hold it).
- **Release** — `wt remove` and `wt prune` clear the label automatically when the
  worktree is torn down. To release a `claim` you never turned into a worktree
  (or clear a lock by hand), run `scripts/wt release 600`.

The lock is **best-effort visibility**: if `glab` isn't installed or a call
fails, `wt` warns and still creates the worktree — it never blocks worktree
management on a network blip, because the [structural guards](#safe-by-construction)
(no-track branches + the prune grace window) are what actually prevent a
collision. The label name is overridable with `TRUEPPM_WT_LOCK_LABEL`.

Only issue-numbered branches are locked. A branch with no leading issue number
(`chore/some-slug`, `docs/0.4-release-notes`) is created without a check-out.

**This lock only guards the `wt` code path.** A branch created with a plain
`git checkout -b feat/<issue>-…` never calls it, so on its own the lock cannot
stop a raw-git session from duplicating an issue `wt` already claimed. The
pre-push gate below closes that hole.

## Pre-push duplicate-MR gate

`scripts/check-issue-collision.sh` runs as the first step of `make pre-push`
(and therefore of the `git push` pre-push hook), *before* the code gates, so a
duplicate aborts the push in one `glab` call rather than after ~60s of
lint/typecheck. It is the **path-independent** backstop: every branch is pushed,
however it was created, so this is the one chokepoint that catches the
`git checkout -b` bypass.

For a branch whose name starts with an issue number it checks GitLab for merge
requests referencing that issue and:

- **Blocks the push** if an **open MR already exists from a different branch** —
  the strong, authoritative duplicate signal. (Had this gate existed, the #1985
  second session would have been stopped: its push found `!1352` open on another
  branch before it could open `!1353`.)
- **Warns only** if the issue carries `status::wip` claimed by another worktree
  but no MR is open yet — the label/comment can be stale, so it is not
  authoritative enough to block.
- **Passes** for a branch with no issue number, for the branch that owns the
  existing MR (re-pushing your own branch is fine), and — best-effort, mirroring
  the `wt` lock — when `glab` is missing or offline.

Legitimate stacked or multi-MR-per-issue work overrides the block:

```bash
TRUEPPM_ALLOW_DUP_MR=1 git push        # or: TRUEPPM_ALLOW_DUP_MR=1 make pre-push
```

## Reserving ADR and migration numbers

Parallel feature agents hit a subtler collision than shared files: they pick the
**same next number** for an ADR or a migration. Each agent independently computes
"next ADR = highest on `main` + 1", so three parallel branches all write
`docs/adr/0211-*.md`, and the CI `lint:adr-collisions` gate has to bounce the second
and third MR to renumber at merge time. Migrations collide the same way, per app.

`wt` removes that race by **reserving** numbers atomically. Reservations live in a
shared ledger in the repo's git *common* directory (so every worktree sees the same
file), guarded by a lock, and the next number is one past the highest seen across
the working tree, `origin/main`, **and** outstanding reservations:

```bash
# Reserve the next free ADR number — prints it, and records the claim so a
# parallel worktree can't pick the same one.
$ scripts/wt reserve adr
wt: reserved ADR-0217 for feat/600-crud-ui — create docs/adr/0217-<slug>.md
0217

# Reserve the next migration number for a specific Django app.
$ scripts/wt reserve migration notifications
0008
```

The bare number goes to **stdout** and the human note to **stderr**, so it
composes: `NUM="$(scripts/wt reserve adr)"`.

**Feature branches reserve an ADR automatically.** Because the architect step of a
new feature almost always produces an ADR, `wt new` reserves one up front for any
`feat/*` branch and records it in the worktree's `.wt-reservation` marker:

```bash
$ scripts/wt new 600
…
wt: reserved ADR-0217 for this worktree (use it for docs/adr/0217-<slug>.md)
```

Pass `--no-adr` to skip it (a feature branch that adds no ADR), or `--adr` to force
a reservation on a `fix/`, `chore/`, or `docs/` branch that does need one.

Reservations are released automatically when the worktree is removed or pruned, so
a number claimed but never used is freed for reuse. `wt list` shows every
outstanding reservation.

**The ledger is the local first line, not the whole defense.** It only sees the
worktrees on *this* machine, so a collision with an open MR from another machine
still falls to the CI `lint:adr-collisions` gate — the ledger just makes the common
case (parallel agents on one host) collision-free before the push.

## What it sets up

For each `wt new`:

- **Branch** — `feat/<issue>-<slug>` off `origin/main` (or your full branch
  name if you pass one explicitly)
- **Worktree path** — `<repo-parent>/trueppm-wt/<branch-leaf>/`
- **Symlinks** — `packages/api/.venv` and `packages/web/node_modules` point
  back to the main checkout. No duplicated dependencies; no per-worktree
  `npm ci` or venv creation.
- **`.envrc`** — exports `COMPOSE_PROJECT_NAME=trueppm` so the worktree reuses
  the Docker stack you brought up in the main checkout (`make pre-push`
  inside a worktree needs to find the running `trueppm-api-1` container), and
  `TRUEPPM_TEST_DB=test_trueppm_wt_<slug>` so this worktree's `pytest` uses an
  isolated test database (see [Safe by construction](#safe-by-construction)).
- **`.wt-owner`** — a marker recording who created the worktree and when. It
  powers the `wt prune` grace window and the `AGE` column in `wt list`. Like
  `.envrc` and the symlinks, it's excluded from the `wt remove`/`wt prune`
  dirty-checks, so it never counts as "uncommitted work."
- **`.wt-reservation`** — for `feat/*` branches (and any `--adr` run), the ADR
  number reserved for this worktree (plus any migration numbers you reserve). Also
  excluded from the dirty-checks. See [Reserving ADR and migration
  numbers](#reserving-adr-and-migration-numbers).

If you use [direnv](https://direnv.net/), `cd` into the worktree and run
`direnv allow` once. Without direnv, run `source .envrc` after each `cd`.

## The WIP cap

The helper warns at **8 active worktrees** and refuses at **10**. The cap is
deliberate — beyond ~10 concurrent issues, you'll forget which one has the
auth fix, MRs sit unreviewed, and the gains from parallelism evaporate. If you
truly need more, override with `TRUEPPM_WT_CAP=15 scripts/wt new …`, but ask
yourself first whether finishing what you started would be cheaper.

## Verifying health

`scripts/wt doctor` checks (run from a worktree):

- Both symlinks resolve to existing targets
- `COMPOSE_PROJECT_NAME` is set in the current shell
- The shared `trueppm-api-1` Docker container is running

If anything is amber, the message tells you what to fix.

## Shared infrastructure ground rules

One Docker stack, one dev database, multiple worktrees:

- **Migrations apply once.** Each branch may have new migrations; the active
  branch's set of migrations is what's applied to the dev DB. Switching
  worktrees doesn't roll back migrations. The rule: only one branch at a time
  should run `makemigrations`/`migrate` against the dev DB. If a teammate's
  branch has a migration you don't, `migrate` it and remember to `migrate
  --plan` before testing your own branch.
- **`npm install` is forbidden in a worktree.** Use `npm ci` only — it's
  idempotent and matches the lockfile. `npm install` would rewrite the
  shared `node_modules` directory and break the main checkout.
- **The docker stack lives in the main checkout.** Run `make up` /
  `make down` there. Worktrees just point at the running containers via
  `COMPOSE_PROJECT_NAME=trueppm`.

## Troubleshooting: `column … already exists` on startup

**Symptom.** The `trueppm-api-1` container loops on boot and never goes
healthy; the web app shows `ECONNREFUSED`. Its logs show `migrate` failing
with, e.g.:

```
django.db.utils.ProgrammingError: column "is_archived" of relation
"projects_project" already exists
  Applying projects.0044_project_archive_program_close...
```

**Cause.** A merged branch *renamed or renumbered* one of its migrations at
merge time (common when a merge migration reorders the graph). Your shared dev
DB already applied that migration under its **old** name, so the column exists —
but `django_migrations` has no record under the **new** name on `main`, so
Django re-runs it and collides. This is a shared-DB-across-worktrees artifact,
not a code bug: the migration on `main` is correct, and a *fresh* DB migrates
cleanly.

**Confirm it's a rename** — the recorded name has no file, the file has no
record (substitute the app from the traceback):

```bash
# what the DB thinks is applied
docker exec trueppm-db-1 psql -U trueppm -d trueppm -tAc \
  "SELECT name FROM django_migrations WHERE app='projects' ORDER BY name;"
# what the merged code actually ships
ls packages/api/src/trueppm_api/apps/projects/migrations/
```

If you see the *same* migration under two numbers (one recorded, one on disk),
it's a rename.

**Fix (preserves dev data)** — correct the recorded name to match the file,
then restart:

```bash
docker exec trueppm-db-1 psql -U trueppm -d trueppm -c \
  "UPDATE django_migrations SET name='<new-name>' \
   WHERE app='<app>' AND name='<old-name>';"
docker restart trueppm-api-1
```

Prefer the `UPDATE` over `migrate <app> <migration> --fake`: faking adds a
*second* record and leaves the old, file-less one orphaned.

**Fix (nuclear)** — if the divergence is tangled or you don't care about local
data, reset the dev DB from the main checkout:

```bash
docker compose down -v && make up   # destroys all local dev data
```

## When to skip the helper

- Read-only browsing of someone else's branch — just `git checkout` for a
  minute and back; not worth a worktree.
- Hotfixes that take 5 minutes total — by the time you `cd`, the fix is
  almost merged.
- Single-issue focused work — worktrees are for *parallel* work.

## Cleanup

**Per-worktree:** `scripts/wt remove <issue>` (or `make wt-remove ISSUE=N`)
is the canonical path. It refuses if your tree has uncommitted tracked
changes or untracked files beyond the auto-created set (the two symlinks,
`.envrc`, `.wt-owner`, and `.wt-reservation`). If you really do want to discard
work, pass `--force` as the second argument. Removing a worktree also releases
its issue check-out (see [Issue check-out lock](#issue-check-out-lock)) and frees
any ADR/migration numbers it reserved.

**Bulk cleanup after merges:** `scripts/wt prune` (or `make wt-prune`)
sweeps every worktree whose branch has been merged to `main` and deleted
on `origin`. Detection works like this:

1. `git fetch --prune` drops local tracking refs for branches deleted upstream
2. **Skip anything inside the freshness grace window** — a worktree younger than
   `TRUEPPM_WT_GRACE_MIN` minutes (default 30) is never reaped, so an agent
   mid-startup is safe (override with `--force`)
3. For each remaining worktree, check that its branch (a) had an upstream, (b) no
   longer has one on `origin`, and (c) is fully an ancestor of `origin/main`
4. Apply the same safety guards as `wt remove` — refuse to drop worktrees
   with uncommitted local work (override with `--force` if you really mean it)
5. Report what got pruned, what was skipped, and what was kept

Run `make wt-prune` periodically — after a merge train, end of day, or
whenever your `wt list` looks bloated. It's idempotent (running twice is
free) and conservative (never drops work).

If the worktree directory got nuked manually (`rm -rf`'d outside the
helper), clean up the orphaned reference with `git worktree prune` in the
main checkout — that's git's built-in, distinct from our `wt prune`.

## Why not one Docker stack per worktree?

You'd have to remap ports 5432 / 5173 / 8000 in each worktree's compose file,
and end up with multiple PostgreSQL instances duplicating dev data. The
single-stack discipline is fine in practice — the dev DB is throwaway and
migrations are sequential by nature.
