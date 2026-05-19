# ADR-0073: Sprint Planning Capacity, Board Sprint Panel, and Velocity Sparkline

## Status
Proposed (2026-05-19, issue #482)

## Context

ADR-0036 (hybrid PM philosophy) and ADR-0037 (sprint model, data, and API)
established Sprint as a first-class entity. ADR-0059 added the sprint section
to the task drawer. ADR-0065 wired sprint velocity into CPM duration
calibration. ADR-0071 added the retro-to-backlog promote pipeline.

Issue #482 was filed at the data-model level ("Sprint is currently modelled as
a date filter or label") without knowledge of that prior work. The Sprint
model, full CRUD endpoints, burndown snapshots, retro/scope-change models,
velocity endpoint with 8-sprint rolling window, and the `SprintsView` web
workspace are all already shipped. The genuine gaps relative to the issue
text are three:

1. **Planning capacity target** — the Sprint model snapshots
   `committed_points` on activation (immutable record of "what we locked in")
   and `completed_points` on close, but has no field for a PM/Scrum-Master-entered
   *planning target* — the team's pre-activation answer to "how many points
   can we take?". `services.capacity_summary` derives a resource-allocation-based
   capacity in hours, which is a different quantity from a team's points-based
   commitment ceiling.

2. **Board-view sprint context** — `BoardView.tsx` does not reference Sprint
   at all today. The sprint workspace lives at a separate `/sprints` route.
   ADR-0037 §"Board Integration" anticipated a "slim banner above the board
   shows sprint goal, days remaining, mini burndown sparkline" but that
   banner was never built — the prior work shipped the standalone workspace
   instead.

3. **Velocity trend sparkline** — `VelocityPanel` renders a full-section
   velocity card; there is no compact inline sparkline suitable for embedding
   in a panel header.

### Persona-panel results (VoC, 2026-05-19)

| Persona | Score | Notes |
|---|---|---|
| Jordan (PO) | 7/10 🟡 | Right direction; wants remaining-capacity + top-N backlog in panel |
| Alex (Scrum Master) | 7/10 🟡 | Sprint-on-board is correct; velocity exposure is risky |
| Morgan (Agile Coach) | 5/10 🟡 | Velocity sparkline in shared Board view = surveillance pipeline (🔴 unless gated) |
| Priya (Team Member) | 5/10 🟡 | Additive chrome; must be collapsed by default for contributors |
| Marcus (PMO) | 4/10 🟡 | Useful primitive; no portfolio rollup (out-of-scope at OSS) |
| Sarah (PM) | 3/10 🟡 | Construction projects don't use sprints; panel intrudes |
| David (Resource Manager) | 3/10 🔴 | Story-point capacity is not allocation conflict prevention (orthogonal) |
| Janet (COO) | 2/10 🔴 | Never opens Board; out-of-scope at OSS layer |

Panel average 4.5/10; agile-persona average (Jordan + Alex + Morgan + Priya) 6.0/10.
Janet/David/Sarah scores reflect persona-mismatch, not feature defects — they
are not the target. **Jordan + Alex both at 7/10 is the strongest OSS adoption
signal per `.claude/personas.md`** ("if a feature delights both the PO and the
Scrum Master, it belongs in OSS without further debate").

## Decision

Add three OSS-scope deliverables under issue #482:

### A. `Sprint.capacity_points` planning target field

```python
capacity_points = models.PositiveIntegerField(
    null=True,
    blank=True,
    help_text=(
        "PM/Scrum-Master-entered planning target — the team's points "
        "ceiling for this sprint, decided pre-activation. Distinct from "
        "committed_points (snapshotted on activate) and from the "
        "resource-allocation-based capacity returned by services."
        "capacity_summary() (which is hours-based)."
    ),
)
```

- Direct field on `Sprint`. No sub-model. No JSONField.
- `null=True` so existing rows have a clear "not set" sentinel and so teams
  that don't run point-based sprints (Sarah's construction crews) are not
  forced to enter a value.
- `server_version` auto-increments via `VersionedModel.save`; no custom bump.
- Migration `0037_sprint_capacity_points.py` is purely additive (nullable
  column add); no backfill, no downtime.

**Editability window** — `capacity_points` is editable on PLANNED **and**
ACTIVE sprints (locked on COMPLETED/CANCELLED). This deliberately differs
from `SprintSerializer.validate()` line 1374, which currently locks
name/goal/dates on any non-PLANNED state. Justification: team capacity may
revise mid-sprint as people join, leave, or take PTO — Morgan's coaching
guidance is to surface this as a deliberate decision, not to prevent it.
A `Sprint.history` entry (django-simple-history, already wired) captures
the audit. No row added to `SprintScopeChange` — that table is scoped to
task-level scope additions, not capacity revisions.

**RBAC — SCHEDULER+ write only.** `capacity_points` is the team's planning
target, owned by the Scrum Master / Resource Manager — not every team
member (Jordan + Alex + Morgan sovereignty). Field-level RBAC: the
`SprintSerializer.validate()` method rejects any `capacity_points` write
from a user whose project membership is below `Role.SCHEDULER` (ordinal
200). The viewset's `IsProjectMemberWrite` gate (MEMBER+, ordinal 100)
still applies to every other Sprint field — only `capacity_points` is
layered with the additional Scheduler check. This is the only place in
the SprintViewSet where field-level RBAC is applied; it is justified by
the sovereignty concern and confined to a single field.

### B. SprintPanel embedded in BoardView

A new component at `packages/web/src/features/board/SprintPanel.tsx`
inserted in `BoardView.tsx` between `<CalmToolbar>` and the DnD lane grid.

**Visibility rules** (ADR-0041 precedent — methodology hides chrome,
does not gate the route):

| Condition | Behaviour |
|---|---|
| `project.methodology === 'WATERFALL'` | Panel not rendered |
| No ACTIVE sprint exists | Panel not rendered |
| ACTIVE sprint exists, role < SCHEDULER | Panel rendered, collapsed by default |
| ACTIVE sprint exists, role >= SCHEDULER | Panel rendered, expanded by default |

Collapsed-state persistence: `localStorage` key
`trueppm.board.${projectId}.sprintPanel.open` (boolean). The role-based
default applies only on first load; user choice persists thereafter.

**Always-visible header band** (when panel rendered): sprint goal,
short_id (`SP-XXXXXXXX`), date range, days remaining. **Collapsible body**:
burndown chart (reuses `<BurnChart sprintId={...} />`), VelocitySparkline,
`capacity_points` editor for SCHEDULER+.

The panel reuses `SprintGoalCard` and `SprintHeader` from
`features/sprints/`. `SprintBacklogTable`, `SprintTimelineStrip`, and
`CapacityPreflight` are **not** embedded — they are workspace-scale and
duplicate what the Board surface already shows (cards) or pulls hours-based
capacity that the panel header does not need.

### C. VelocitySparkline

A new shared component at
`packages/web/src/features/sprints/VelocitySparkline.tsx`. Consumes
`useProjectVelocity(projectId)` (existing hook → existing
`/projects/<id>/velocity/` endpoint per ADR-0065 — no new endpoint).
Renders an 8-sprint rolling window as a 64×24 px inline SVG sparkline with
the most recent completed_points as a label.

**Velocity-visibility sovereignty (Morgan blocker resolution)** —
**at OSS scope, no per-project visibility gate is added.** The Morgan
concern is that velocity becomes a PMO surveillance pressure gauge once
exposed to management. At OSS scope **there is no PMO surface** — no
portfolio dashboard, no cross-project velocity rollup, no executive digest.
The architectural absence of those surfaces is the gate. The sparkline is
visible to VIEWER+ on the project (same band as the existing
`/projects/<id>/velocity/` endpoint, which is already accessible to
VIEWER+).

When Enterprise adds a portfolio velocity rollup, a separate ADR must
define the per-project opt-in toggle. **This ADR explicitly forbids that
future Enterprise work from defaulting to "include all projects" or
"opt-out" — the Morgan sovereignty rule requires opt-in per project, owned
by SCHEDULER+ on that project.** Recording this decision here is the
sovereignty enforcement; the Enterprise repo will reference this ADR when
the portfolio surface is built.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A1**: Add `capacity_points` to a new `SprintPlanning` sub-model | Separates planning from execution semantically | Over-engineering — no other planning fields exist; would change every read path; adds JOIN overhead |
| **A2**: Reuse `committed_points` for both planning and snapshot | One field | Destroys the immutable snapshot ADR-0037 explicitly relies on |
| **B1**: Render Sprint panel always when methodology=AGILE | Simpler hide rule | Forces panel onto projects with no active sprint (clutter) |
| **B2**: Place the panel inside CalmToolbar instead of above the lanes | Reuses an existing slot | CalmToolbar is for board view controls (group/sort/density); semantic mismatch |
| **B3**: Build the panel as an ADR-0029 widget-registry slot | Maximizes Enterprise extensibility | Premature — slot registry overhead is justified only when Enterprise has a concrete enhanced variant ready |
| **C1**: Add an opt-in `Project.velocity_visibility` field now | Future-proofs Enterprise rollup | Forces a migration + UX surface for an Enterprise concern that doesn't exist yet in OSS — pure speculation |
| **C2**: Hide velocity sparkline from non-team roles by default | Strongest Morgan defense | Construction PMs and PO observers (legitimate viewers) lose the signal; the absence of a PMO rollup at OSS scope makes this unnecessary |

## Consequences

### Easier
- PM/SM can store a planning target separate from the activation snapshot —
  the gap between planning intent and what gets committed becomes inspectable
  ("planned for 35, committed 41 — let's discuss") which is a primary
  Scrum Master coaching signal.
- The Board view becomes the single primary surface for active work
  including sprint context — no more flip to `/sprints` to see the burndown
  while the team is talking about a card.
- Velocity trend is visible at a glance during sprint planning without
  opening a separate report panel.

### Harder
- Non-agile (WATERFALL) projects gain a methodology branch in BoardView's
  render path. Mitigated: same branch ADR-0041 already established for
  schedule/sprint tab visibility — convention exists.
- A future "hide velocity from observers" requirement at OSS scope will
  require a follow-up migration. Accepted risk: ADR explicitly defers
  that until Enterprise rollup work justifies it.

### Risks
- **R1 (low)** — PM mid-sprint edit of `capacity_points` is silent to the
  team unless they read history. Mitigated: `Sprint.history` already
  captures the change; a follow-up could surface a "capacity revised"
  toast in the panel header. Out of scope here.
- **R2 (medium)** — `SprintSerializer.validate()` exception list for the
  capacity_points field on ACTIVE sprints risks future drift if another
  developer adds an unrelated ACTIVE-state lock. Mitigated: explicit
  comment in the validate() method and a regression test asserting the
  PATCH succeeds on ACTIVE sprints.
- **R3 (low)** — VelocitySparkline on construction projects (Sarah's
  workflow) is suppressed by the WATERFALL methodology guard but
  `useProjectVelocity` still fetches data. Negligible (8 sprint rows max).
- **R4 (deferred to Enterprise)** — Portfolio velocity rollup surfacing
  per-team velocity creates the gaming pressure Morgan warned about.
  Resolved by ADR text mandating per-project opt-in when that work lands.

## Implementation Notes

- **P3M layer**: Programs and Projects (single-project sprint planning) +
  Operations (team-facing velocity surface)
- **Affected packages**: api, web
- **Migration required**: yes — `0037_sprint_capacity_points.py` (additive
  nullable column)
- **API changes**: yes — `SprintSerializer` gains `capacity_points` in
  `Meta.fields`, omitted from `read_only_fields`, `validate()` exempts it
  from the non-PLANNED lock. `docs/api/openapi.json` will need
  regeneration via `scripts/export-openapi.sh`.
- **OSS or Enterprise**: OSS. Jordan + Alex both 7/10 — strongest OSS
  adoption signal per personas.md. No portfolio aggregation; per ADR-0072
  band-boundary contract, all permission checks use `role >=` inequalities
  so Enterprise custom roles inherit correctly.

### Durable Execution

1. **Broker-down behaviour**: N/A — `capacity_points` PATCH is a synchronous
   DB write. The only side effect is `broadcast_board_event("sprint_updated", ...)`
   which is already wired through `transaction.on_commit()` at
   `views.py:3458`; if the broker is down the broadcast is dropped (best-effort
   semantics, same as every other Sprint mutation today — ADR-0037 §"Sync
   protocol" explicitly accepts this).
2. **Drain task**: N/A — no new outbox category; no new async work.
3. **Orphan window**: N/A.
4. **Service layer**: No new service function. Existing
   `SprintViewSet.perform_update` (`views.py:3452`) handles save + broadcast.
5. **API response**: 200 with updated `SprintSerializer` payload (no async
   path — capacity_points does not enqueue CPM recompute; the value does
   not affect schedule dates).
6. **Outbox cleanup**: N/A.
7. **Idempotency**: PATCH is naturally idempotent (replays settle to the
   same field value). `server_version` increments on each save and is
   exposed in the response so the client can detect concurrent edits.
8. **Dead-letter / failure handling**: Standard DRF validation errors
   (400). `validate()` raises `ValidationError` on
   COMPLETED/CANCELLED writes; no retry path; client must surface the
   error to the user.

## Implementation Checklist

### Backend
- [ ] `Sprint.capacity_points` field
- [ ] Migration `0037_sprint_capacity_points.py`
- [ ] `SprintSerializer.Meta.fields` += `capacity_points`
- [ ] `SprintSerializer.validate()` — exclude `capacity_points` from the
      non-PLANNED lock; lock on COMPLETED and CANCELLED only
- [ ] Test: PATCH `capacity_points` on PLANNED, ACTIVE — 200 (SCHEDULER+)
- [ ] Test: PATCH `capacity_points` on COMPLETED, CANCELLED — 400
- [ ] Test: VIEWER cannot PATCH (403, blocked by IsProjectMemberWrite)
- [ ] Test: MEMBER cannot PATCH (400, field-level Scheduler gate in `validate`)
- [ ] Test: SCHEDULER can PATCH (200)
- [ ] Test: `Sprint.history` records the change
- [ ] OpenAPI schema regeneration

### Frontend
- [ ] `SprintPanel.tsx` in `features/board/`
- [ ] `VelocitySparkline.tsx` in `features/sprints/`
- [ ] BoardView.tsx integration (between CalmToolbar and DnD context)
- [ ] `useUpdateSprint` (existing) gains `capacity_points` in payload
- [ ] `ApiSprint` type regenerated from schema
- [ ] Vitest: SprintPanel — hidden on WATERFALL, hidden with no active
      sprint, collapsed-by-default for VIEWER, expanded-by-default for
      SCHEDULER
- [ ] Vitest: VelocitySparkline — empty / single-sprint / 8-sprint cases
- [ ] Playwright: Board → active sprint → panel visible → toggle collapse
      persists

### Cross-cutting
- [ ] `changelog.d/482-sprint-panel-and-capacity-points.added.md`
- [ ] `docs/features/sprints.md` updated (panel section + capacity_points
      planning vs commitment distinction)
- [ ] regression-check, rbac-check, perf-check, broadcast-check skills run
      before MR
