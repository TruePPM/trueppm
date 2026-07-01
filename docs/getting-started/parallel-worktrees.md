# Parallel worktrees

Working on multiple issues at once is friction-heavy in a single working tree —
`git checkout` swaps thousands of files, file watchers thrash, and parallel
agent sessions step on each other's branches. The `scripts/wt` helper sets up
a per-issue git worktree so each ticket lives in its own directory with shared
dev dependencies.

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

The lock is **best-effort**: if `glab` isn't installed or a call fails, `wt`
warns and still creates the worktree — it never blocks worktree management on a
network blip. The label name is overridable with `TRUEPPM_WT_LOCK_LABEL`.

Only issue-numbered branches are locked. A branch with no leading issue number
(`chore/some-slug`, `docs/0.4-release-notes`) is created without a check-out.

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
  inside a worktree needs to find the running `trueppm-api-1` container).

If you use [direnv](https://direnv.net/), `cd` into the worktree and run
`direnv allow` once. Without direnv, run `source .envrc` after each `cd`.

## The WIP cap

The helper warns at **4 active worktrees** and refuses at **5**. The cap is
deliberate — beyond ~5 concurrent issues, you'll forget which one has the
auth fix, MRs sit unreviewed, and the gains from parallelism evaporate. If you
truly need more, override with `TRUEPPM_WT_CAP=10 scripts/wt new …`, but ask
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
changes or untracked files beyond the auto-created set (the two symlinks +
`.envrc`). If you really do want to discard work, pass `--force` as the
second argument. Removing a worktree also releases its issue check-out (see
[Issue check-out lock](#issue-check-out-lock)).

**Bulk cleanup after merges:** `scripts/wt prune` (or `make wt-prune`)
sweeps every worktree whose branch has been merged to `main` and deleted
on `origin`. Detection works like this:

1. `git fetch --prune` drops local tracking refs for branches deleted upstream
2. For each worktree, check that its branch (a) had an upstream, (b) no
   longer has one on `origin`, and (c) is fully an ancestor of `origin/main`
3. Apply the same safety guards as `wt remove` — refuse to drop worktrees
   with uncommitted local work (override with `--force` if you really mean it)
4. Report what got pruned, what was skipped, and what was kept

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
