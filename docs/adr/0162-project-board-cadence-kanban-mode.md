# ADR-0162: Project-level board cadence — first-class continuous-flow Kanban mode

## Status
Proposed

## Context

Issue #410 asks for Kanban to be a **first-class delivery mode**, not a variant of the
sprint board. Most of the feature already shipped:

- per-task `DeliveryMode` enum `{waterfall, scrum, kanban, milestone}` (`Task.delivery_mode`, ADR-0036)
- throughput rollup (`done/total`) for kanban subtrees (`percent_complete` annotation)
- the methodology-neutral `FlowAnalyticsPanel` on the board (ADR-0137 / ADR-0130 — cycle/lead
  P50/P80/P95, CFD, throughput chart), always rendered collapsed
- a per-card dwell/aging chip in `BoardCard.tsx` (#192) keyed on a frontend-only `slaDays` default
- `Task.status_changed_at` (stamped in `Task.save()` on every status change) plus the
  `dwell_days` and `is_stalled` server-computed serializer fields
- non-destructive scrum↔kanban switching at the **task** level

Two acceptance criteria remain unshipped, and both turn on the same missing primitive:

1. **AC1** — when a project/workstream runs as continuous-flow Kanban (no sprint cadence),
   the board must hide sprint chrome (the `SprintPanel`, the `BoardSprintHeader`, sprint-rank
   reorder) and lean on the already-present `FlowAnalyticsPanel`. Today there is **no
   project-level signal** that a board runs Kanban: `Task.delivery_mode` is per-task, and
   `Project.methodology` is only `{WATERFALL, AGILE, HYBRID}` (ADR-0041, a tab-visibility
   preset). An AGILE/HYBRID project always shows the sprint panel.
2. **AC3** — cards sitting in their current column past a **configurable** threshold get a
   calm "aging" highlight. The visual exists; the threshold (`slaDays`) is a hardcoded
   frontend default and is neither persisted nor configurable.

**The core design fork** is how to represent "this project runs continuous-flow Kanban."
`Project.methodology` is the obvious-looking home, but ADR-0041 explicitly scopes its
3-value enum as an OSS base that **Enterprise extends via the ADR-0029 slot registry**
("additional methodology values (e.g. `CCPM`, `EVM_ONLY`) … Enterprise additional values
and org-level defaults are registered via ADR-0029 slot registry"). Adding a 4th OSS
methodology value would (a) consume a value reserved for the Enterprise extension point and
shift the base set Enterprise registers against — a breaking change for the extension-point
contract — and (b) conflate *planning methodology* with *delivery cadence*, which are
orthogonal axes (a Kanban team is still "AGILE" for tab purposes). AC5 reinforces this: it
speaks of "switching a project between **scrum and kanban delivery mode**," cadence
vocabulary, not methodology vocabulary.

**P3M layer:** Programs/Projects + Operations (single-team board execution). The personas
served are Alex (Scrum Master, 9/10), Morgan (Agile Coach, 8/10), Jordan (PO, 7/10) — the
strongest OSS adoption signal. Cross-project throughput aggregation (Marcus's ask) is
Enterprise and out of scope. **This is OSS.**

## Decision

### 1. New orthogonal project field `Project.board_cadence`

Add `board_cadence = CharField(max_length=16, choices=BoardCadence.choices, default=SPRINT)`
to `Project` (and `HistoricalProject`), with:

```python
class BoardCadence(models.TextChoices):
    SPRINT = "sprint", "Sprint-based"          # default — preserves current behavior
    CONTINUOUS = "continuous", "Continuous flow (Kanban)"
```

- **Orthogonal to `methodology`.** `methodology` keeps driving tab visibility (ADR-0041);
  `board_cadence` drives whether the board runs on a sprint cadence or continuous flow.
  A "Kanban project" is `methodology ∈ {AGILE, HYBRID}` **and** `board_cadence = CONTINUOUS`.
  `WATERFALL` projects already hide the sprint panel via methodology, so `board_cadence` is
  only meaningful (and only surfaced in the UI) for AGILE/HYBRID projects.
- **Additive / non-destructive default.** `default = SPRINT` means every existing project
  keeps its current sprint-showing behavior with zero data change.
- **Authoritative kanban signal.** This becomes the explicit signal that the deferred
  throughput-forecast work (ADR-0130) can consume instead of its current "no
  `velocity_eligible_sprints()`" heuristic.

**RBAC:** `board_cadence` joins `_SCHEDULER_WRITABLE_FIELDS` in `ProjectSerializer` — i.e.
Scheduler+ may set it, mirroring `methodology` (Scheduler is a team role, not Owner-locked).
The viewset gate (`IsProjectScheduler` on `update`/`partial_update`) is unchanged.

**Audit:** `Project` already carries `HistoricalRecords`, so every `board_cadence` change is
captured in `HistoricalProject` with `history_user` (actor), `history_date`, and the
before/after value. This satisfies the "audit the mode change" constraint **without** a new
`AuditEventType` verb — which would require a cross-app `workspace` `AlterField` migration
(choices are tracked in migration state) that risks colliding with the in-flight #1233
inherited-settings branch. A curated operational `AuditEvent` row can be added later if the
workspace audit-log UI needs to surface cadence changes, but the change is durably recorded
today.

### 2. Board consumption (AC1) — clean, full hide

- `BoardView.tsx` passes `boardCadence` (from `projectDetail`) to `SprintPanel`.
- `SprintPanel` hide gate becomes: `if (methodology === 'WATERFALL' || boardCadence === 'continuous') return null;`
  (currently only `=== 'WATERFALL'`).
- `BoardView` suppresses the `BoardSprintHeader` band and the sprint-rank reorder affordance
  when `boardCadence === 'continuous'` (a real removal, not a collapsible toggle a PM can
  re-surface mid-flight).
- `FlowAnalyticsPanel` is already always-rendered (methodology-neutral) — it is the
  throughput replacement, so AC1 is "hide sprint chrome," not "build a new panel."

**Non-destructive switching (AC5):** switching to `CONTINUOUS` only *hides* sprint surfaces;
`Sprint` rows are never mutated or deleted, so an in-flight ACTIVE sprint is preserved and
re-appears verbatim if the project switches back to `SPRINT`. No orphan rows, no throughput
baseline corruption. The settings UI shows a soft confirm when an ACTIVE sprint exists at
switch time (informational, not blocking).

### 3. Aged-item threshold (AC3) — per-column JSON key, no migration

- Add `age_threshold_days` (positive int, or `null` = inherit/off) as a per-column key inside
  `BoardColumnConfig.columns` (a `JSONField`), mirroring `wip_limit` and `color`. **No
  migration** — the JSON schema is extended additively in the serializer.
- `BoardColumnConfigSerializer` validates `age_threshold_days` as a positive int or null and
  round-trips it on GET/PUT (existing Scheduler+ gate, existing `board_config_updated`
  broadcast on commit).
- `useBoardConfig.ts` maps the server `age_threshold_days` → the `slaDays` the existing
  `BoardCard` aging chip already consumes, **falling back to today's hardcoded per-status
  defaults when the server value is `null`** (preserves #192 behavior for unconfigured boards).
- The aging chip itself (`BoardCard.tsx` #192) is unchanged in logic; ux-review will confirm
  the calm-nudge treatment (the existing >2×SLA escalation is evaluated against the
  rule-of-calm; soften if flagged).
- **Threshold visibility:** the per-column threshold is surfaced as a column-header
  annotation (like the WIP-limit chip), so the team can see the aging standard, not just the
  highlight (VoC: Alex/Jordan/Priya).

**RBAC tension (noted):** VoC (Morgan) preferred the threshold be Member+ configurable. The
threshold lives on the shared `board-column-config` endpoint, which also governs `wip_limit`,
labels, colors, and visibility at Scheduler+. Downgrading that endpoint to Member+ would be a
security-relevant change to all of board config, out of scope for #410. We keep Scheduler+,
which is team-accessible and **not** Owner-locked — satisfying Morgan's core "not
Owner-controlled" concern. A future ADR may split per-column SLA into a separately-gated
surface if Member-level ownership is desired.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| (a) Add `Methodology.KANBAN` to the existing enum | Least code; reuses methodology picker, prop flow, and `SprintPanel` gate | **Violates ADR-0041/0029 OSS/Enterprise boundary** (new methodology values are an Enterprise slot-registry extension point); conflates planning-mode with delivery-cadence; drags into `effective_methodology` inheritance (ADR-0107) where a workspace-default "Kanban methodology" is nonsensical |
| (b) **New orthogonal `Project.board_cadence` field** (chosen) | Clean axis separation; additive default; matches AC5 vocabulary; one projects-app migration; authoritative signal for ADR-0130 forecast | One new field + migration; "Kanban project" is two settings (methodology + cadence), surfaced as one combined UI choice |
| (c) Derive kanban-ness (AGILE + no sprints + mostly-kanban tasks) | Zero new fields | Fragile and implicit; a project with zero sprints isn't necessarily Kanban; can't be set intentionally; AC5 ("switch between modes") implies an explicit stored setting |
| Audit via new `AuditEventType` verb | Surfaces in the workspace audit-log UI | Cross-app `workspace` `AlterField` migration (choices tracked) → collision risk with in-flight #1233; #565 dropped exactly this for the same reason |
| Audit via existing `HistoricalProject` (chosen) | Zero extra migration; actor + timestamp + before/after captured automatically | Not surfaced in the curated audit-log UI (acceptable — field-level change history is the right tool here) |
| New DB column for `age_threshold_days` | Queryable | Unnecessary; `BoardColumnConfig` stores all per-column attrs as JSON keys; a column would need a migration for no benefit |

## Consequences

**Easier:**
- A team can opt a board into continuous-flow Kanban explicitly; the sprint chrome disappears
  and the existing flow analytics carry the board.
- Per-column aging thresholds become a real, persisted, team-configurable setting; the
  hardcoded #192 defaults become the fallback, not the ceiling.
- The deferred throughput-forecast work (ADR-0130) gains an explicit, intentional signal to
  key off instead of a heuristic.

**Harder:**
- One additive `projects` migration in a known collision zone (see Implementation Notes —
  renumber at rebase).
- "Kanban project" is conceptually two settings (`methodology` for tabs, `board_cadence` for
  the board); the UI must present this coherently (one cadence control, shown only for
  AGILE/HYBRID).

**Risks:**
- A PM switches an active-sprint board to CONTINUOUS and loses sight of the running sprint.
  Mitigated by the soft confirm and by non-destructive semantics (switch back restores it).
- The aging chip's >2×SLA escalation may read as alarmist (Priya/rule-of-calm). Mitigated by
  routing the visual through ux-review before merge.

## Implementation Notes

- **P3M layer:** Programs/Projects + Operations → **OSS**
- **Affected packages:**
  - `packages/api`: `Project` model + migration `0091` (`board_cadence`), `BoardCadence`
    enum, `ProjectSerializer` (`board_cadence` field + `_SCHEDULER_WRITABLE_FIELDS`),
    `BoardColumnConfigSerializer` (`age_threshold_days` JSON key), OpenAPI regen
  - `packages/web`: `Project`/board types, `BoardView.tsx` + `SprintPanel.tsx`
    (cadence gate), `BoardSprintHeader` suppression, `useBoardConfig.ts`
    (server→`slaDays` mapping), `ProjectWorkflowPage.tsx` (cadence control + per-column age
    threshold input), board column-header threshold annotation
- **Migration required:** Yes — `projects/0091` adds `board_cadence VARCHAR(16) NOT NULL
  DEFAULT 'sprint'` to `project` and `historicalproject` (mirror the `0026_project_methodology`
  pattern). **No** `BoardColumnConfig` migration (JSON key). **No** `workspace` migration
  (audit via history). ⚠ `projects` migrations are a known 3-way collision zone; current head
  is `0090_historicaltask_proj_histdate_index`. Author as `0091`; run `migrate --check` and
  renumber at rebase if another `0091` landed on main.
- **API changes:** `ProjectSerializer.board_cadence` (read-write, Scheduler+);
  `BoardColumnConfigSerializer` per-column `age_threshold_days` (read-write, Scheduler+).
  Regenerate `docs/api/openapi.json` after merging `origin/main`.
- **OSS or Enterprise:** OSS (`trueppm-suite`).

### Durable Execution
1. Broker-down behaviour: **N/A** — both changes are synchronous config writes
   (`Project.save()` field update; `BoardColumnConfig` PUT). No async side effects beyond the
   existing `board_config_updated` WebSocket broadcast, which already uses
   `transaction.on_commit()`.
2. Drain task: **N/A** — no new async work category. Reuses the existing board-config
   broadcast path unchanged.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: **N/A** — the writes go through the existing `ProjectViewSet.partial_update`
   and `BoardColumnConfigView.put`; no new dispatch path. (CPM is untouched: hiding the sprint
   panel does not change scheduling.)
5. API response on best-effort dispatch: **N/A** — both endpoints respond synchronously with
   the updated resource (200).
6. Outbox cleanup: **N/A** — no outbox rows.
7. Idempotency: PATCH `board_cadence` to its current value is a no-op write (same value); PUT
   board-column-config is idempotent by construction (full-list replace). `server_version`
   bumps on the Project write via `VersionedModel.save()`, giving offline-sync conflict
   detection for free.
8. Dead-letter / failure handling: **N/A** — synchronous; a failed write returns 4xx/5xx to
   the caller with no partial state (single-row update inside the request transaction).

- **Issue:** #410
- **Out of scope (follow-ups):** throughput-based delivery forecast on the flow panel
  (Alex #4 / Jordan #2 — file follow-up); surfacing `board_cadence` / aging in any
  program/PMO rollup (Enterprise — explicitly excluded; aging stays board-scoped per
  Morgan/Priya); cross-project throughput aggregation (Enterprise); Member-level RBAC split
  for per-column SLA thresholds.
