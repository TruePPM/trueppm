# Demo project — Platform Migration

The `seed_demo_project` Django management command bootstraps a coherent
"Platform Migration" project so reviewers can walk through the eight-step
hybrid PM flow end-to-end without manual data entry.

## Run it

```bash
# Inside the running api container (docker compose stack):
docker compose exec api python manage.py seed_demo_project --with-personas

# Or, if you have a local venv pointed at the dev DB:
cd packages/api && python manage.py seed_demo_project --with-personas
```

The command is **idempotent**. Re-running clears the prior demo project and
re-seeds. `--with-personas` additionally creates the six persona logins.

## What gets seeded

The command builds two projects:

- **Platform Migration** (HYBRID methodology — all tabs visible)
- **Pilot Deployment** (AGILE methodology — board-first, no Schedule tab)

On Platform Migration:

- 4 phases (Discovery, Build, Migration, Cutover) as WBS-1..4 summary tasks
- ~11 work packages across the phases with predecessor links so the
  critical path lights up on the Schedule view
- 2 contractual milestones (UAT signoff, Production cutover signoff)
- An active **Contract baseline** snapshot of every task
- 6 resources with one over-allocation (Cleo Ng on two simultaneous packages)
- 8 closed sprints with realistic 38 ± 6 pts velocity history
- 1 active sprint mid-window with 8 days of burndown snapshots and a
  scope-add on day 4 — actual line trends slightly behind ideal
- 1 planned sprint queued for next iteration
- A retro on the most recent closed sprint with 3 action items;
  one is promoted into a real task on the planned sprint
- Board WIP limits configured so the active sprint trips the at-limit /
  over-limit indicators on IN_PROGRESS

On Pilot Deployment, an active sprint with one assigned task — that flips
the multi-team Sprints lens toggle on for users who belong to both.

## Persona logins

| Username | Persona | Role | Password |
|---|---|---|---|
| `maya`   | Maya Singh — Scrum Master       | Member    | `demo` |
| `raj`    | Raj Patel — Project Manager     | Scheduler | `demo` |
| `diana`  | Diana Khan — PMO Director       | Admin     | `demo` |
| `sarah`  | Sarah Lee — Resource Manager    | Scheduler | `demo` |
| `carlos` | Carlos Mendes — Executive       | Viewer    | `demo` |
| `tom`    | Tom Nguyen — Senior Engineer    | Member    | `demo` |

The shared password (`demo`) is intentional — these accounts only exist
in seeded environments. Do **not** run `seed_demo_project` against a
production database.

## What to look at first, by persona

- **Maya** — log in, open the Sprints tab. The Goal card, Burndown chart
  with TODAY marker, capacity preflight (one over-allocated member),
  velocity panel with forecast range, sprint backlog grouped by board
  status, and the retrospective panel are all populated.
- **Raj** — open the Schedule tab. The CPM critical path is highlighted,
  the baseline overlay is visible, and the milestones land on contractual
  dates.
- **Sarah** — open the Sprints tab; the Capacity Preflight panel surfaces
  the over-allocation. With assignments in two active sprints, the
  *My Teams* toggle appears in the breadcrumb row.
- **Diana** — same as Sarah; the multi-team lens shows both projects'
  health from her vantage point.
- **Carlos** — open the project Overview. Forecast confidence intervals
  (P50/P80) from Monte Carlo render alongside the velocity-driven date.
- **Tom** — open the Board. He is the assignee on most active-sprint
  cards; the WIP overload chip on IN_PROGRESS is visible from across
  the room.

## Reset

```bash
docker compose exec api python manage.py seed_demo_project --with-personas
```

A second run clears the prior demo and rebuilds it with the current
state of the codebase. This is the recommended way to refresh after
landing new features that change the seeded surface.
