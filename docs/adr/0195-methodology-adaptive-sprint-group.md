# ADR-0195: Methodology-Adaptive SPRINT Group — Co-locate the Sprint Circuit

## Status
Accepted (2026-07-01)

> **Amends [ADR-0128](0128-v2-grouped-view-bar-health-cluster.md) §A (group → view
> assignment).** Everything else in ADR-0128 — the health cluster, the ADR-0104 velocity
> privacy gate, route suppression, the `Health ▾` collapse, and the visual-only nature of
> grouping (rule 108 / ADR-0030) — is unchanged. This ADR changes only *which group a view
> lands in*, and does so as a function of the project methodology.

## Context

**P3M layer:** Programs and Projects (single-project chrome) → **OSS**. No cross-project
surface; the view bar is hidden on the Portfolio route (ADR-0128 unchanged).

ADR-0128 §A assigned every view to a static group:

| Group | Views (canonical) |
|---|---|
| PLAN | product-backlog · sprints · schedule · grid · calendar |
| TRACK | today · board · risk · reports *(`today` leads TRACK — ADR-0180)* |
| PEOPLE | resources |

This splits the **daily sprint circuit** across a group boundary. The three surfaces a
scrum team touches every day are one cognitive object:

```
Backlog  ─→  Sprints  ─→  Board
(intake)     (container)   (execution state)
   PLAN         PLAN         TRACK   ← the circuit crosses a divider + group header
```

VoC audit of the view-tab bar (2026-07-01, #1466) surfaced this as a **hard-NO from Alex
(Scrum Master)**, echoed by Jordan (PO) and Morgan (Agile Coach):

> Alex: *"Board under TRACK, Sprints under PLAN — that's the structure of a schedule-first
> tool that added a sprint view as an afterthought."*

The grouping silently privileges the **schedule** view of the world over the **sprint**
view — the `schedule-rigidity` tension in `personas.md` (Sarah's CPM cadence vs Alex's
sprint cadence) made structural. Because the grouping *is* the IA, it reads as a values
statement about which cadence the tool considers primary.

### The WATERFALL constraint (why a static move fails)

`board` cannot simply move to PLAN for everyone. Board's **semantic role is
methodology-dependent**:

- **AGILE / HYBRID** — Board is the *execution state of the current sprint*: it belongs
  with the sprint circuit.
- **WATERFALL** — Board is a general kanban of tasks (to-do / doing / done). Waterfall
  hides `sprints` and `product-backlog` (ADR-0041), so there is no sprint circuit to join;
  Board is a pure **tracking** surface and belongs in TRACK, exactly where it is today.

A blanket move of `board` into PLAN would make "Board" *lead the Plan group* on a
Gantt-first project — a schedule-planning group opening with a kanban. That
mis-represents the tool in the opposite direction and is the WATERFALL regression the
issue warns against. Likewise, a static `SPRINT` group would collapse to a lone `board`
under a **"SPRINT"** label on waterfall — surfacing sprint vocabulary into a methodology
that has deliberately hidden sprints. Both static options regress WATERFALL.

The resolution is therefore **methodology-adaptive placement**: the SPRINT group exists
only for sprint-running methodologies, and `board`'s group is chosen per methodology.

### Forces (carried from ADR-0128, still binding)
- Compose **beneath** the ADR-0041 methodology visibility matrix (hidden views stay
  absent from the DOM, within their group; a group with no surviving views renders
  nothing).
- Preserve the a11y group structure: each group is a `role="group"` with an
  `aria-label` ("Sprint views", etc.); empty groups render no label.
- Grouping stays **visual only** — route segments unchanged (rule 108 / ADR-0030). No
  API change; `board`'s URL is still `/projects/:id/board` for every methodology.
- Clear the ADR-0126 design-system CI gate (semantic tokens only).
- `today` (ADR-0180 Unified Today) continues to lead TRACK.
- The ADR-0162 role-context lens re-orders **within a group, never across** — it must
  keep working after the regrouping.

## Decision

### A′. Methodology-adaptive group → view assignment (replaces ADR-0128 §A)

Introduce a fourth group id, **`SPRINT`**, that exists **only for AGILE and HYBRID**.
`board`'s group is chosen by methodology; every other view keeps its ADR-0128 group. The
group order is **PLAN · SPRINT · TRACK · PEOPLE** (SPRINT inserted after PLAN — Plan →
Sprint → Track → People reads as a workflow narrative). `overview` still leads standalone
and `settings` still trails standalone.

The per-methodology result, **after** the ADR-0041 visibility filter is applied within
each group:

**HYBRID** (hides nothing):

| Group | Views |
|---|---|
| *(standalone)* | Overview |
| PLAN | schedule · grid · calendar |
| **SPRINT** | **product-backlog · sprints · board** |
| TRACK | today · risk · reports |
| PEOPLE | resources |
| *(standalone)* | Settings |

**AGILE** (hides schedule · calendar):

| Group | Views |
|---|---|
| *(standalone)* | Overview |
| PLAN | grid |
| **SPRINT** | **product-backlog · sprints · board** |
| TRACK | today · risk · reports |
| PEOPLE | resources |
| *(standalone)* | Settings |

**WATERFALL** (hides sprints · product-backlog) — **no SPRINT group; identical to today**:

| Group | Views |
|---|---|
| *(standalone)* | Overview |
| PLAN | schedule · grid · calendar |
| TRACK | **today · board · risk · reports** |
| PEOPLE | resources |
| *(standalone)* | Settings |

Consequences of the table:
- **AGILE / HYBRID**: the full circuit `Backlog → Sprints → Board` is one contiguous,
  named `SPRINT` group — satisfies the #1466 acceptance (Board and Sprints visually
  adjacent) and answers Alex's "bolted-on" complaint by naming the sprint circuit as a
  first-class cognitive object rather than scattering it.
- **WATERFALL**: unchanged from the shipped ADR-0128 layout — `board` stays in TRACK, no
  `SPRINT` label ever appears. **Zero regression** (the strongest possible guarantee: the
  waterfall render is byte-identical to today).
- **AGILE PLAN degenerates to one item (`grid`)**. Accepted: a one-item group is already
  precedented (PEOPLE = Team in ADR-0128 §A), grid is the methodology-neutral planning /
  flat-list surface, and the empty-group rule already handles the fully-filtered case.

### B′. Role-context lens (ADR-0162) interaction

`applyRoleContextLensOrder` re-orders within a group by construction, so it keeps working
unchanged against the new groups. The observable effect shifts:

- **Before**: the `scrum_master` lens (`['board', 'sprints', 'product-backlog']`) promoted
  `board` to the front of TRACK and `sprints`/`product-backlog` to the front of PLAN — the
  circuit stayed split, just re-ordered within each half.
- **After** (AGILE / HYBRID): all three priority views live in `SPRINT`, so the lens
  re-orders **within SPRINT** → `board · sprints · product-backlog` (daily-driver first for
  the SM). The `unified` (default) lens keeps the canonical circuit order
  `product-backlog · sprints · board`, which reads left-to-right as the workflow.

The `scrum_master` priority list is left **as-is** — both orderings are defensible (base =
workflow order; SM lens = daily-driver-first), and no lens ever moves a view across
groups. `lensOrder.test.ts` is updated to assert the new within-SPRINT promotion.

### C′. ADR-0180 (Unified Today) cross-reference

`today` continues to lead TRACK and continues to embed a board for the at-a-glance daily
view. ADR-0180's rationale is *refined, not amended*: for AGILE/HYBRID, TRACK is now the
**daily-landing + monitoring** group (today · risk · reports) and the **sprint-execution
board** lives in SPRINT. No change to `today` behavior, routing, or the embedded board.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A′ — Methodology-adaptive SPRINT group (chosen)** | Full circuit named + contiguous for agile/hybrid; **zero** WATERFALL change; a11y/route/API all unchanged; lens still works | Group set is now methodology-dependent (a function, not a static const); AGILE PLAN is a one-item group |
| B — Static: move `board` into PLAN for all | One-line change | Board *leads* PLAN on waterfall (kanban heading a schedule-planning group) — regresses WATERFALL; still muddles "plan the schedule" with "run the sprint" |
| C — Static `SPRINT` group for all methodologies | Names the circuit uniformly | Collapses to a lone `board` under a "SPRINT" label on waterfall — surfaces sprint vocabulary where sprints are deliberately hidden; worse than status quo for WATERFALL |
| D — SM-only pinned front SPRINT strip (issue option 2) | Strongest sprint-first statement | Depends on unshipped lens-strip work; only helps users who set the SM lens; default hybrid/agile user still sees the split; larger scope than 0.4 warrants |
| E — Lead with SPRINT (before PLAN) for agile/hybrid | Reads sprint-first, hardest answer to "bolted-on" | Reorders groups relative to the `today` daily-landing expectation; larger IA disturbance than acceptance requires — revisit with the role-lens strip (option D) |

## Consequences
- **Easier**: the sprint circuit is a single scannable object for the teams that run
  sprints; the IA no longer reads as "schedule-first with sprints bolted on"; WATERFALL is
  provably untouched.
- **Harder**: `VIEW_GROUPS` is no longer a single static constant — group membership for
  `board` (and the existence of `SPRINT`) is computed from methodology. The pure
  `groupedVisibleViews(methodology)` contract is preserved (still a pure function of
  methodology), so unit-testability is unchanged; the cost is one branch inside it.
- **Risk**: any future code that imported `VIEW_GROUPS` expecting a static three-group
  shape must go through `groupedVisibleViews(methodology)` instead. Mitigated: the only
  consumers of the raw constant are `HIDEABLE_VIEW_KEYS` (now the deduped union across
  methodologies) and the customize-views UI (which already iterates the computed groups).
  `board` is hideable before and after, so the server mirror (`profiles/constants.py`) is
  unchanged.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: **web** only
- Migration required: **no**
- API changes: **no** (routes, serializers, and the server `HIDEABLE_VIEW_KEYS` mirror are
  all unchanged — `board` remains a hideable key regardless of group)
- OSS or Enterprise: **OSS** (single-project chrome)
- Files: `packages/web/src/features/shell/methodologyTabs.ts` (group assignment becomes
  methodology-adaptive; `SPRINT` added to `ViewGroupId`; `HIDEABLE_VIEW_KEYS` becomes the
  deduped union). Tests: `methodologyTabs.test.ts`, `ViewTabs.test.tsx`, `TopBar.test.tsx`,
  `lensOrder.test.ts`, and the `view-switching.spec.ts` E2E comment/assertion.

### Durable Execution
1. Broker-down behaviour: **N/A** — pure client-side IA change, no async side effects.
2. Drain task: **N/A** — no task dispatch.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: **N/A** — no server call.
5. API response on best-effort dispatch: **N/A** — no API change.
6. Outbox cleanup: **N/A**.
7. Idempotency: **N/A** — rendering a nav bar is inherently idempotent; group derivation is
   a pure function of methodology + role + hidden-views.
8. Dead-letter / failure handling: **N/A** — no async work to fail.
