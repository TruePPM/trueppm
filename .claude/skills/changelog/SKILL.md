---
name: changelog
model: sonnet
description: >
  CHANGELOG.md update for TruePPM. Use before finishing any branch that touches
  source code to ensure a changelog fragment is created in changelog.d/. The CI
  changelog-check job will block the pipeline if the fragment is missing.
---

# Changelog Skill

You are creating a changelog fragment for a TruePPM branch before it is merged.

## Fragment system

Changelog entries live in `changelog.d/<slug>.<type>.md` — **never edit `CHANGELOG.md`
directly**. Fragments are assembled into `CHANGELOG.md` at release time by
`scripts/assemble-changelog.sh`.

### Naming

```
changelog.d/<slug>.<type>.md
```

- **slug** — short identifier: issue number (e.g. `56`) or a brief description
  (e.g. `auth-retry-race`, `board-view`)
- **type** — one of: `added`, `changed`, `fixed`, `security`

Examples:
```
changelog.d/56.fixed.md
changelog.d/board-view.added.md
changelog.d/api-token-refresh.security.md
```

### Content format

One or more bullet points describing the user-visible change. Match the Keep a
Changelog bullet style:

```markdown
- **Short label**: what changed and why it matters to the user.
```

Or for longer descriptions:

```markdown
- **Auth 401-retry race**: after logging in, TanStack Query retried stale 401
  errors before the new token was stored, causing a persistent "Failed to load
  projects" screen. Fixed by gating renders on Zustand hydration and suppressing
  401 retries at the query level.
```

## What to include

**Always include:**
- New API endpoints or fields
- Changed API behavior (even non-breaking)
- New CLI flags or commands
- New model fields visible to API consumers
- Bug fixes that affected users
- Performance improvements with measurable impact

**Never include:**
- CI pipeline changes
- Test additions with no behavior change
- Internal refactors with no API/UI impact
- Dependency version bumps (unless behavior changes)
- Code style / lint fixes

## Process

1. Run `git diff main...HEAD` to understand all changes on the branch
2. Determine the correct type: `added` (new feature), `changed` (modified behavior),
   `fixed` (bug fix), `security` (security fix)
3. Choose a slug: use the issue number if one exists, otherwise a short description
4. Write the fragment content — plain English from the user's perspective
5. Create the file `changelog.d/<slug>.<type>.md`
6. Commit with message: `chore(changelog): add fragment for <slug>`

## Example entries

```markdown
- REST endpoint `POST /api/v1/schedules/trigger/` to kick off CPM recalculation
  for a project asynchronously; returns a Celery task ID for polling.
```

```markdown
- `GET /api/v1/tasks/` now requires `?project=<uuid>` — unfiltered list is
  rejected with 400 to prevent full-table scans.
```

```markdown
- **Gantt blank rendering**: tasks with null `early_start`/`early_finish` dates
  produced NaN canvas coordinates, causing both panels to render as blank boxes.
  Engine now filters unscheduled tasks from range calculation.
```
