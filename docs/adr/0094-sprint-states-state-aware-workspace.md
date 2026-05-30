# ADR-0094: Sprint States — state-aware Sprint workspace (Planning + Closed depth)

## Status

Accepted (2026-05-30) — all six open questions resolved with user's "makes sense; continue" reply on 2026-05-30; implementation may begin.

## Context

Issue #567 (umbrella, milestone 0.3) scoped a state-aware Sprint workspace whose
primary motivation was deduplicating the live burndown between the Board's
`SprintPanel` and the Sprint workspace (`SprintsView`). Its proposed PLANNED branch
was "existing layout, no change of substance"; CLOSED was an outcome card +
frozen burn-down + retro panel.

On 2026-05-24, a claude.ai/design handoff bundle ("Unaccounted Designs 0.2")
produced a far deeper Sprint States design — substantially extending PLANNED
(bridge banner, capacity preflight depth, scope-vs-velocity dial, candidate list
with ready/risk/source pills, estimation poker, carryover sidebar) and CLOSED
(5-card summary row, velocity comparison chart, per-task rollover action, retro
snapshot with metric cards) beyond #567's body. Four child issues — #863 (poker),
#864 (CapacityPreflight depth), #865 (carryover preview), #866 (planning bridge
banner) — were filed on 2026-05-30 to track the new depth.

This ADR reconciles #567's narrow scope with the design, splits the work across
0.3 and 0.4 under a six-week 0.3 budget, and corrects three data-model
assumptions in the child issues that the codebase scan invalidated.

**P3M layer**: Programs and Projects (single-project sprint workspace). Fully OSS —
sprint workspace is the core agile-execution surface; no enterprise hooks.

**Persona context**: 0.3 was triaged 2026-05-30 113→72 with the agile cohort as
the target (Alex Coach 8, Jordan SM 8, Morgan PO 8, Sarah PM 7, Priya RM 5🔴-deferred).
Issue #860 (sprint-close → CPM reforecast) is the 0.3 killer-feature; the
CLOSED-state design here is effectively the demo's visual layer.

## Decision

### 1. Rewrite #567 to absorb design depth — option (a)

Keeping #567 narrow leaves PLANNED/CLOSED depth orphaned and forces children to
invent their own contract. The umbrella owns the state contract; children own
surface components within it.

**Replacement #567 body** (supersedes the "no change of substance" /
outcome-card-only sketches):

> **PLANNED** — `SprintHeader` (Activate CTA); **bridge banner** (#866) with
> `Sprint.goal` + advancing-milestone diamond; **`CapacityPreflight` depth** (#864,
> team-aggregate only — per-person bars 0.4-deferred); `SprintBacklogTable` with
> candidate-row pills (ready/risk derived from existing data); **carryover preview
> sidebar** (#865 Planning half); `VelocityPanel` collapsed.
>
> **ACTIVE** — Launcher per the existing #567 body. Unchanged.
>
> **CLOSED** — `SprintHeader` (read-only); 5-card outcome row (goal status,
> committed, completed, rolled over, velocity Δ); frozen historical `<BurnChart>`;
> velocity comparison panel (reuses #607 once shipped, falls back to inline if
> not); "What didn't ship" list with **read-only rollover preview** (per-task
> rollover service deferred to 0.4 — see Open Q4); `RetroPanel` with 4-metric
> retro-snapshot header.

The body update also moves the trailing `## Phase` line from "0.2" → "0.3"
(currently stale).

### 2. 0.3 vs 0.4 split

| Issue | Milestone | Justification | Rough estimate |
|---|---|---|---|
| **#567** (rescoped) | **0.3** | State skeleton + ACTIVE dedup + CLOSED frozen-chart foundation; on #860 launch-path. | 1.5–2 weeks |
| **#866** Planning bridge banner | **0.3** | No data model change (`Sprint.target_milestone` exists). UI variant of `AdvancingToMilestoneCard`. On #860 launch-path. | 3–4 days |
| **#864** CapacityPreflight depth | **0.3 (partial)** | **0.3 reduced to team-aggregate uplift**: over/under-capacity chip + plain-English footer band. **Per-person bars deferred to 0.4** (needs per-member persistence — Open Q1). | 3–4 days |
| **#865** Carryover preview | **0.3 (Planning half only)** | Planning sidebar is read-only re-derivation from existing `apply_carry_over` decision. **Closed-side per-task rollover service deferred to 0.4** (changes `apply_carry_over` from immediate to deferred-with-preview). | Planning: 3–4 days. Closed-side rollover: 5–7 days (0.4). |
| **#863** Estimation poker | **0.4** | New models (`PokerSession` + `PokerVote`), 4 endpoints, WS broadcast on commit, 2 viewport surfaces. ~2–3 weeks. Jordan-8 values it but #860 demo ships without it. Will need its own ADR when picked up. | 2–3 weeks (in 0.4) |

**0.3 budget check**: rescoped #567 (~2 wk) + #866 (~0.5 wk) + #864 partial
(~0.5 wk) + #865 Planning half (~0.5 wk) ≈ **3.5 weeks** of previously-unaccounted
work. Within the six-week ceiling agreed in `project_03_milestone_triage_voc`,
leaves headroom for the inevitable architect-clarification round on #860.

### 3. Data-model corrections (three issue bodies edited before implementation)

| Issue | Drafted | Reality | Required body edit |
|---|---|---|---|
| **#866** | "Migration adds `Sprint.advances_milestone_id` FK" | FK already exists as `Sprint.target_milestone` → `Task` (where `is_milestone=True`). No `ScheduleMilestone` model anywhere. | Strike migration. Banner reads from existing `target_milestone`; UI-only. |
| **#864** | "`Sprint.team_member_capacity` field-or-model" | Aggregate-only `Sprint.capacity_points` (ADR-0073). `capacity_summary()` returns per-person hours, not points. No `SprintMembership` model. | Defer per-person bars to 0.4. 0.3 scope: header chip variant + footer hint band using existing `capacity_points`. |
| **#865** | "`Sprint.rollover_to()` service + idempotent endpoint + per-side audit" | Existing `apply_carry_over(sprint, carry_over_to)` runs inside `SprintCloseRequest` drain (ADR-0037); the decision is captured in the outbox row. | 0.3 ships read-only Planning preview: `GET /sprints/{id}/incoming_carryover/` re-derives prior-sprint unfinished + next-sprint matched tasks. 0.4 ships per-task closed-side rollover (refactor `apply_carry_over` from immediate to deferred-with-preview). |

#### Data-model decisions for 0.3-scoped work

- **#866** — Zero schema change. Reuses `Sprint.target_milestone`. The
  "predecessor tasks landing in this sprint" count is derived from
  `target_milestone.predecessors ∩ sprint.tasks`. Component is a variant of the
  existing `AdvancingToMilestoneCard.tsx`.
- **#864** (partial) — Zero schema change. Reads `Sprint.capacity_points` and sums
  `Task.story_points` over `sprint.tasks` for "draft load." No new endpoint.
- **#865** (Planning half) — New GET endpoint `GET /sprints/{id}/incoming_carryover/`.
  Derived: prior closed sprint via
  `Sprint.objects.filter(project=p, state=COMPLETED, finish_date < self.start_date).order_by('-finish_date').first()`,
  then unfinished tasks (`status != DONE` at `closed_at`) intersected with
  `self.tasks` to show pre-checked vs. available. No model change. RBAC: same as
  `SprintViewSet.retrieve`.
- **#567** (state-branch skeleton) — Zero schema change. Pure UI conditional on
  `sprint.state`.

### 4. Durable Execution

1. **Broker-down behaviour**: N/A — 0.3 scope is pure UI + a read-only GET
   endpoint. No async dispatch.
2. **Drain task**: N/A — no new async work.
3. **Orphan window**: N/A.
4. **Service layer**: Existing — `apply_carry_over()` in
   `apps/projects/services.py:669` already routes through the canonical pattern.
   The new read endpoint calls `Sprint.objects` directly.
5. **API response on best-effort dispatch**: N/A — synchronous reads.
6. **Outbox cleanup**: N/A.
7. **Idempotency**: GET endpoint is naturally idempotent.
8. **Dead-letter / failure handling**: N/A.

Deferred 0.4 work (#863 poker, #865 closed-side rollover) will need its own ADR
with a full durable-execution analysis — poker commits trigger WS broadcast and
`Task.story_points` write under `transaction.on_commit`; closed-side rollover
changes `apply_carry_over` semantics from immediate to deferred-confirm and may
need a new outbox category.

### 5. WebSocket broadcast

0.3-scoped work has no new mutations. The existing `sprint_updated` broadcast
(`views.py:4824`) covers PLANNED-state `target_milestone` edits made via the new
bridge banner — already wired through `transaction.on_commit()` and
`broadcast_board_event()`.

### 6. HistoricalRecords

No model changes in 0.3 scope. `Sprint.history` already excludes
`_HISTORY_EXCLUDED_BASE` and captures `target_milestone` + `capacity_points`
changes (ADR-0073). No new exclusions needed.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **(a) Rewrite #567 to absorb design depth** (chosen) | Single source of truth for the state contract; children own surface components | Bigger umbrella; #567 status reset to in-design |
| (b) Keep #567 narrow; let children own PLANNED/CLOSED depth | #567 ships fast as a skeleton MR | Depth becomes orphaned across 4+ issues; no place to document the state contract |
| (c) Ship the full design in 0.3 (including poker + per-person bars + closed-side rollover) | Single coherent landing | ~8–9 weeks; blows 0.3 budget; risks #860 demo slip |
| (d) Defer the entire Sprint States design to 0.4 | Clean 0.3 focus on #860 alone | #860 has no CLOSED-state UI without this; loses the agile-cohort beta narrative |

## Consequences

**Easier:**

- #860 ships into a real CLOSED-state surface, not the existing thin outcome card
- Children #864 / #865 / #866 ship with clear sub-scope; #863 has a clean 0.4 home
  with its own ADR
- #567's PLANNED branch finally has visual depth that matches the agile cohort's
  expectations from the design handoff

**Harder:**

- Three child-issue bodies must be rewritten before implementation (#864, #865,
  #866 — see §3)
- 0.4 milestone gains ~3–4 weeks of follow-up work (#863 poker + per-person
  capacity bars + closed-side rollover refactor) — must be tracked as new
  0.4 issues
- "Per-person capacity bars" become a 0.4 design pass on top of a likely new
  `SprintMembership` model

**Risks:**

- If Open Q1 (per-person capacity persistence) doesn't land in 0.4 design before
  implementation, 0.4 slips
- #554 (variance preview, currently milestone 0.4) overlaps the Planning
  scope-vs-velocity dial — the dial is **out of 0.3 scope** because #554 is
  already 0.4; the user may want them re-yoked
- The "ready" / "risk" pills on the candidate list (per design) require
  derivation rules that aren't currently specified — see Open Q2

## Sequence (MR order, parent-issue annotations)

Run serially via `/mr`. Each MR follows the standard pre-MR gate cluster.

1. **#567 skeleton + body update** — `feat(web): sprint workspace state-aware
   branching skeleton (no depth)`. Rewrites SprintsView's conditional into a
   `sprint.state` switch; ACTIVE branch drops `<BurnChart>`; CLOSED branch wires
   frozen `<BurnChart>` + RetroPanel; PLANNED unchanged for this MR. Updates
   `## Phase` to 0.3 in the issue body. Foundation for everything else.
2. **#866 Planning bridge banner** — `feat(web): SprintPlanning bridge banner
   (target_milestone variant of AdvancingToMilestoneCard)`. Smallest, most
   isolated.
3. **#864 (partial)** — `feat(web): CapacityPreflight team-aggregate depth
   uplift (chip + footer band)`. No backend.
4. **#865 (Planning half)** — `feat(api+web): sprint incoming-carryover preview
   (Planning sidebar, read-only)`. One new GET endpoint, one component.
5. **#567 CLOSED-state outcome cards** — `feat(web): sprint closed-state outcome
   cards + retro snapshot header`. Lands inside the #567 umbrella as a follow-up
   MR; ships the 5-card row + retro-snapshot 4-card header.

**Deferred to 0.4** (each will need a new issue filed when picked up; #863 will
need its own ADR):

- #863 estimation poker (PokerSession/Vote models + 4 endpoints + WS broadcast)
- Per-person capacity bars (requires SprintMembership decision)
- Closed-side per-task rollover (refactor `apply_carry_over` semantics)

## Resolved Questions (accepted 2026-05-30)

User accepted all six recommendations in a "makes sense; continue" reply on
2026-05-30. Recording the resolutions inline so implementers don't have to
chase back through chat history.

✅ **Q1 — Per-person capacity bars source.** Defer to 0.4 via new
`SprintMembership(sprint, user, capacity_points)` model — filed as **#870**.
0.3 ships team-aggregate-only depth via #864 partial. Per-person bars
deliberately deferred so 0.3 budget holds.

✅ **Q2 — Candidate-row "ready" / "risk" pills.** Derive in the serializer.
Rules:

- `risk` = task is linked to a `Risk` row (via the existing
  `Task.risks` reverse relation) OR explicitly flagged through the Risk
  register's existing `affected_tasks` set
- `ready` = task has `story_points NOT NULL` AND `assignee NOT NULL` AND all
  predecessors have `status == DONE`

Surface as serialized booleans `risk_flagged` and `ready_for_sprint` on
`TaskSerializer` for sprint-planning contexts only. No new fields on the
`Task` model.

✅ **Q3 — Estimation poker 0.4 slip.** Confirmed acceptable. #863 reslotted to
milestone 0.4. Bridge demo (#860) ships in 0.3 without poker — Jordan's
value-prop preserved through #866 bridge banner + #864 capacity depth.

✅ **Q4 — Carryover semantics.** 0.3 ships read-only Planning preview over the
existing `apply_carry_over` decision (#865 Planning half). Closed-side per-task
rollover service refactor — which would defer `apply_carry_over` from
immediate to deferred-with-preview — is **0.4 ADR-gated**, filed as **#871**
with `needs-design` label.

✅ **Q5 — #554 (variance preview, currently 0.4) overlap.** Status quo —
**#554 stays at milestone 0.4**. The scope-vs-velocity dial on the design's
PLANNED state is **out of 0.3 scope**. Sprint Planning in 0.3 ships without
the dial; it lands with #554 in 0.4.

✅ **Q6 — Carryover endpoint URL.** `/sprints/{id}/incoming_carryover/`
(sprint-detail action, consistent with the `burndown` / `capacity` / `retro`
siblings).

## Out of scope (explicit)

- **New `ScheduleMilestone` entity** — does not exist, not needed.
  `Task(is_milestone=True)` is the milestone model.
- **`SprintMembership` model** — deferred to 0.4 follow-up under Q1.
- **Refactoring `apply_carry_over`** — close-time semantics unchanged in 0.3.
- **Estimation poker** — entirely deferred to 0.4 (#863 stays open, milestone
  reslotted, will get its own ADR).
- **Mobile** — sprint workspace is web-only in 0.3 scope; mobile sprint surfaces
  are 0.4+ work per `project_mobile_platform_priority`.
- **Multi-writer collaborative planning** — single-writer optimistic, consistent
  with the current `RetroPanel`.
- **Enterprise hooks** — no portfolio rollup, no cross-program sprint
  coordination.

## Implementation Notes

- **P3M layer**: Programs and Projects
- **Affected packages**: `api` (1 new GET endpoint), `web` (5–6 new components +
  1 view refactor)
- **Migration required**: **no** for 0.3 scope; yes for 0.4 follow-ups
  (SprintMembership under Q1, carryover semantics under Q4, #863 poker models)
- **API changes**: 1 new endpoint (`GET /sprints/{id}/incoming_carryover/`); no
  breaking changes to existing endpoints
- **OSS or Enterprise**: OSS,
  `packages/api/src/trueppm_api/apps/projects/` (sprint models live there, not
  in a separate `sprints` app) and `packages/web/src/features/sprints/`

### Durable Execution

1. Broker-down behaviour: **N/A** — 0.3 scope is pure UI + read-only GET; no
   async dispatch
2. Drain task: **N/A**
3. Orphan window: **N/A**
4. Service layer: existing — `apply_carry_over()` already routes through
   `apps/projects/services.py:669`; the new endpoint calls `Sprint.objects`
   directly
5. API response on best-effort dispatch: **N/A** — synchronous reads
6. Outbox cleanup: **N/A**
7. Idempotency: GET endpoint is naturally idempotent
8. Dead-letter / failure handling: **N/A**

## References

- Design bundle (local): `/tmp/sprint-design/trueppm/project/Sprint States.html`
  + `sprint-states-pages.jsx`
- Design source URL:
  `https://api.anthropic.com/v1/design/h/CjgoVnt3FMRt4qaTUO302Q?open_file=Sprint+States.html`
- Origin chat: `/tmp/sprint-design/trueppm/chats/chat7.md`
  ("Unaccounted Designs 0.2", 2026-05-24)
- Umbrella: #567
- Children: #863 (poker, reslotting to 0.4), #864 (capacity depth, 0.3 partial),
  #865 (carryover preview, 0.3 Planning half), #866 (bridge banner, 0.3)
- 0.3 killer-feature: #860 (bridge demo) — this ADR's CLOSED-state design is its
  demo surface
- Related issues: #554 (variance preview, 0.4), #607 (8-sprint velocity, 0.3),
  #851 (live retro board, 0.3), #858 (retro action item promote, 0.3),
  #543 (mid-sprint scope-injection audit, 0.3), #861 (sprint-close bridge
  digest, 0.3)
- Foundational ADRs: ADR-0036 (hybrid PM philosophy), ADR-0037 (sprint model +
  close outbox), ADR-0059 (sprint task drawer section), ADR-0065 (hybrid bridge
  v1.1), ADR-0071 (retro pipeline), ADR-0073 (sprint planning + SprintPanel),
  ADR-0074 (sprint→milestone rollup), ADR-0080 (durable workflow),
  ADR-0091a (transactional WS broadcast style reference)
