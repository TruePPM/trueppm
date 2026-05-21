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

# Remove when done (refuses if there's uncommitted work)
scripts/wt remove 600
```

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

## When to skip the helper

- Read-only browsing of someone else's branch — just `git checkout` for a
  minute and back; not worth a worktree.
- Hotfixes that take 5 minutes total — by the time you `cd`, the fix is
  almost merged.
- Single-issue focused work — worktrees are for *parallel* work.

## Cleanup

`scripts/wt remove <issue>` is the canonical path. It refuses if your tree
has uncommitted tracked changes or untracked files beyond the auto-created
set (the two symlinks + `.envrc`). If you really do want to discard work,
pass `--force` as the second argument.

If the worktree directory got nuked manually (rm -rf'd outside the helper),
clean up the orphaned reference with `git worktree prune` in the main
checkout.

## Why not one Docker stack per worktree?

You'd have to remap ports 5432 / 5173 / 8000 in each worktree's compose file,
and end up with multiple PostgreSQL instances duplicating dev data. The
single-stack discipline is fine in practice — the dev DB is throwaway and
migrations are sequential by nature.
