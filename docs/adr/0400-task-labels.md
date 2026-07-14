# ADR-0400: Task Labels (colored, filterable categorization on cards and schedule)

## Status
Proposed

> **Number reconciliation:** `0372` (delivery-loop adapter) and `0394` (activity
> streams) are in-flight on other branches per project memory. Run `git fetch origin`
> and re-check `docs/adr/` for the true next-free number before this branch lands;
> The wt tool reserved 0400 for this worktree; renumbered 0373→0400 accordingly.

## Context

TruePPM has **no first-class label/tag on tasks or Kanban cards**. Three lookalike
free-string features exist and are frequently confused with it:

- `BacklogItem.tags` — a `JSONField(default=list)` of free strings on **program-backlog
  intake items** (`projects/models.py:5798`), surfaced via `TagInput` in the backlog
  detail pane and filtered with `tags__contains`.
- `TaskLink.labels` — an `ArrayField` capped at 12 on **external URL links** (assets),
  rendered as `LabelPills` on the Assets page.
- `iteration_label` — unrelated terminology config (renaming "Sprint").

The thing users expect — colored labels on **board cards / tasks**, filterable — was
**deliberately descoped**. ADR-0199 (board filter facets) records it verbatim: *"Label
facet is descoped — no task-labels field/model exists on main (hard dependency on issue
1089)."* The `boardFacets.ts` module left a documented slot (docstring lines 13-16).
Issue **#1089** was never started. **This ADR closes #1089** and defines the model,
API, RBAC, sync, and web surfaces for task labels.

**Reference implementation:** the sibling Visiban codebase (`~/repos/visiban`) ships a
mature first-class labels feature — board-scoped `Label` model (name + hex color, unique
per board), `Card.labels` M2M, colored pills on cards, inline create/assign from card
detail, admin-gated label CRUD, member-level assign, board filter-bar facet, and WS
broadcast on every mutation. This ADR adapts that design to TruePPM's conventions
(UUID PKs, `VersionedModel`/`server_version` offline sync, the 5-role RBAC ordinals, the
`broadcast_task_updated` name-only WS contract, and the MCP agent-as-actor boundary).

**Forces at play:**
- **Tags-vs-labels tool sprawl** (Jordan/PO, sharpest VoC finding): a second
  categorization system with no defined relationship to `BacklogItem.tags` confuses
  backlog grooming. Must be resolved, not left ambiguous.
- **Adoption-first vs curation** (Morgan/Agile Coach): admin-only label creation reads
  as governance/surveillance; teams want to coin `needs-design`/`tech-debt` mid-retro.
  But member-create risks 50 near-duplicate labels (exactly why Visiban gated it).
- **Concurrent-write safety** (Nadia/API): a replace-set `label_ids` PATCH is a
  lost-update race for parallel agents/integrations.
- **Offline sync**: `Task` is a `VersionedModel`; a bare M2M through-table (like
  `TaskResource`) provably never reaches the sync-delta (`sync/views.py` sources list
  omits it). The assignment must reach mobile.
- **P3M layer**: project-scoped task categorization is **Programs/Projects + Operations**
  → OSS. Cross-project/portfolio label rollups (which Marcus/Janet asked for) are
  Portfolio-layer → Enterprise, and are an explicit non-goal here.

## Decision

Ship a **first-class, project-scoped `Label` catalog** with colors and a shared
per-project vocabulary, plus a lightweight assignment through-table, distinct from
`BacklogItem.tags`. Eight concrete decisions:

### D1 — Data model: `Label` catalog (VersionedModel) + `TaskLabel` through-table

- **`Label`** is a new `VersionedModel` in `apps/projects` (colors + shared vocabulary
  require a catalog table; the JSONField-string alternative cannot carry color or a
  curated vocabulary). Project-scoped, unique `(project, name)`.
- **`TaskLabel`** is a **plain `models.Model` through-table** (not a `VersionedModel`),
  `unique(task, label)`. Assignment changes are synced by **bumping `Task.server_version`
  and embedding a flat `label_ids` array on the Task sync payload** — the exact pattern
  `Risk.task_ids` uses (`sync/serializers.py:328-357`), endorsed for low-cardinality
  relations (1–5 labels/task). This is *lighter* than making `TaskLabel` its own synced
  `VersionedModel` collection and avoids adding a WatermelonDB collection + a
  sync-union receiver for the join table. The `Label` **catalog** *is* synced as its own
  small collection (it is a `VersionedModel`).
- A `position: SmallIntegerField` is added on `Label` **now** (Visiban's noted gap —
  retrofitting order is a migration + backfill) for stable palette/legend ordering.
- **Color** is a **fixed 8-key categorical palette stored as an enum key**, not free hex:
  `color` is a `CharField(choices=LabelColor.choices)` (keys: `slate, teal, purple, blue,
  rose, amber, green, cyan`). *(Amended after ux-design a11y review, 2026-07-14: a raw
  `#RRGGBB` hex cannot carry a theme-aware, WCAG-AA-safe foreground/background pair, and
  TruePPM's DS is semantic-first. Each key maps in the frontend — via a `labelTokenStyle`
  lookup following the `identityColors.ts` categorical precedent, rule 208 — to a
  precomputed `{light,dark} × {bg,text,border}` token set verified at ≥ 4.5:1 in both
  themes.)* Full-saturation hue as pill text is prohibited (fails AA; brand §15). Pills
  carry a leading color dot + always-visible name so color is never the sole signal and
  labels don't read as red/amber/green *status* chips.

### D2 — `Label` and `BacklogItem.tags` stay separate; documented, not unified (v1)

Task **labels** (project-scoped, colored, curated, on cards + schedule) and backlog
**tags** (program-backlog free-text on intake items) are **different features at
different lifecycle stages** — an item is *tagged* while in the intake pool, then
*promoted* to a task that carries *labels*. v1 keeps them separate and documents the
distinction in `docs/features/`. A future ADR may (a) seed label suggestions from a
promoted backlog item's tags, or (b) converge tags onto label references — both are
larger migrations and out of scope. **This is the #1 user decision (see Open Questions
🔴-1).**

### D3 — RBAC: member-create, admin-curate (adoption-first, with a floor)

Using the 5-role ordinals (`access/models.py:15`: `VIEWER=0, MEMBER=100, SCHEDULER=200,
ADMIN=300, OWNER=400`), all gates expressed as **inequalities** via DRF
`permission_classes` (ADR-0184 defense-in-depth, ADR-0072 extensibility):

| Action | Gate | Rationale |
|---|---|---|
| List / read labels | `IsProjectMember` (≥ VIEWER) | Everyone sees the vocabulary |
| **Create** a label definition | `IsProjectMemberWrite` (≥ MEMBER) | Morgan: teams coin `needs-design` mid-retro without filing a ticket |
| **Edit / recolor / reorder** a label | `IsProjectAdmin` (≥ ADMIN) | Renaming a shared label changes *everyone's* board — curation gated |
| **Delete** a label | `IsProjectAdmin` (≥ ADMIN) | Destructive across all assigned tasks |
| **Assign / unassign** a label to a task | same as editing that task (`IsProjectMemberWriteOrOwn`) | Assignment is a task edit, not vocabulary management |

A **soft cap** (default 50 label definitions/project, configurable) prevents sprawl —
the member-create escape valve Morgan wants without Visiban's admin bottleneck. **The
create floor is the #2 user decision (see Open Questions 🔴-2).**

### D4 — Assignment API: idempotent attach/detach, not replace-set

Mirroring the dedicated-write `TaskResourceViewSet` pattern (writes go through their own
endpoint; a read-only nested list rides on `TaskSerializer`):

- `POST   /api/v1/tasks/{task_pk}/labels/` body `{"label_id": "..."}` → attach,
  **idempotent** (`get_or_create` under the row lock; 200 whether or not already
  present). Commutative with attaching a *different* label — no lost-update race.
- `DELETE /api/v1/tasks/{task_pk}/labels/{label_id}/` → detach, **idempotent** (204 even
  if absent).
- Both bump `Task.server_version` (explicit `task.save(known_exists=True)`) so the WS
  broadcast + sync-delta reconcile. This resolves Nadia's replace-set race by
  construction. (A convenience replace-set `PATCH` with `If-Match: <server_version>` OCC
  may be added later for the web toggle, but attach/detach is the primary contract.)

### D5 — Label catalog CRUD API + serializer changes

- `GET/POST/PATCH/DELETE /api/v1/projects/{project_pk}/labels/` — `LabelViewSet`
  (`ProjectScopedViewSet` + `McpReadableViewMixin`), per-action `get_permissions()` per
  the D3 matrix. Serializer exposes `id, name, color, position, server_version`.
- `TaskSerializer` gains **read-only** `labels` (nested `[{id,name,color}]`) for the
  board/Gantt, and the sync serializer gains `label_ids: [uuid]` (SerializerMethodField,
  prefetched to avoid N+1). Writes never go through `TaskSerializer` — only attach/detach.
- **Cross-project IDOR guard**: the attach endpoint re-scopes the assignable `label_id`
  queryset to the task's own project (mirroring Visiban `serializers.py:267-282`) — a
  label from another project cannot be attached.

### D6 — Sync + broadcast + MCP wiring

- **Sync (ADR-0142):** `Label` catalog is a new synced `VersionedModel` → add it to the
  `ProjectSyncView.sources` union, add a `post_save` receiver bumping
  `Project.last_sync_version` (the conformance test fails loudly if forgotten), and add a
  WatermelonDB collection. `TaskLabel` is **not** independently synced — assignment rides
  `Task.server_version` + the `label_ids` array (D1).
- **Broadcast (ADR-0152):** attach/detach emits `broadcast_task_updated(project_id,
  task_id, changed_fields=["labels"], version, actor_id)` — **names only, never values**
  (Viewers must not receive gated field values over WS; ADR-0184 excludes Viewers from
  the channel entirely). Catalog CRUD emits `label_created|label_updated|label_deleted`
  with the label **id** (so filter-bar options refresh). All deferred via
  `transaction.on_commit`. `broadcast-check` gate applies.
- **MCP (ADR-0112/0186):** labels are read-reachable **today** — they appear nested in
  `TaskSerializer` (so `get_task` returns them under `mcp:read`), and `LabelViewSet` mixes
  in `McpReadableViewMixin` for a `GET`-only catalog tool. **No new read scope needed.**
  A plain label list is not a *computed* answer, so `stamp_answer`/`_provenance` do **not**
  apply (explicit non-goal). **Agent label writes are deferred**: the OSS MCP surface is
  read-only until the 0.6 write surface (ADR-0186); a future `task:write`-gated agent
  label write is additive to the ADR-0112 capability vocabulary and subject to the RC5
  role-intersection rule — labels are not schedule-durable, so they do **not** route
  through the RC4 single-approver gate.

### D7 — Web surfaces

- **Filter facet (closes #1089):** add `labels: string[]` to `FacetFilters`, param key
  `fl`, a `labelsOf(task)` accessor over `task.labelIds`, a `matchesFacets` predicate
  block, and a `collectLabelOptions(tasks, catalog)` helper — exactly the "one predicate +
  one param key" ADR-0199 promised. `isFilteredOut` (not `isDimmed`) semantics.
- **Card pills:** render in the `BoardCard` badge row (`BoardCard.tsx:894-990`), tone via
  a new `labelChipToneClass` mirroring `riskChipToneClass` — `bg=color/13%, text=color,
  border=color/27%` (Visiban's `+22/+44` alpha, expressed in DS tokens). Density-capped
  with a `+N` overflow chip.
- **Assign/create UX:** inline label popover in the card/task detail (create-if-member,
  toggle-to-assign, optimistic with rollback) + a project-settings "Labels" manager for
  rename/recolor/reorder/delete (ADMIN). Pills also render in the schedule task drawer.
- **Non-goal for v1 (Sarah/PM ask, deferred):** labels in the schedule **PDF export** and
  color-grouping Gantt bars by label — a follow-up (see 🟡-4).

### D8 — OSS/Enterprise boundary

Project-scoped task labels are **OSS** (Programs/Projects + Operations layer; Alex/Priya/
Morgan are the resonant personas). **Cross-project / portfolio label rollups** (Marcus:
"12 tasks flagged client-risk across 4 projects"; Janet: exec dashboard rollup) are
Portfolio-layer → **Enterprise**, registered later against the existing edition-routing
extension point (ADR-0030) — an explicit non-goal here. No `trueppm_enterprise` import;
`grep -r "trueppm_enterprise" packages/` stays at zero. **HTTP webhooks** for label
events (Nadia's ask) are *also* out of OSS scope: OSS real-time is WS + sync-delta poll;
the bidirectional org-wide webhook hub is Enterprise (ADR-0097). Non-browser consumers
poll the REST list or the sync-delta.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. First-class `Label` catalog + `TaskLabel` through, assignment rides `Task.server_version` (CHOSEN)** | Colors + shared vocab; syncs offline cheaply (Risk-style); idempotent attach/detach kills the race; closes #1089 cleanly | New model + migration; a label edit re-syncs the whole task row |
| B. Free-string `labels` JSONField on Task (mirror `BacklogItem.tags`) | Cheapest; zero new model; syncs for free; per-field merge already covers Task | No colors, no curated vocabulary, no catalog — fails the Visiban-parity ask; deepens tags-vs-labels sprawl |
| C. `TaskLabel` as its own synced `VersionedModel` collection | Independent versioning; per-assignment soft-delete tracking | Heavier: new sync-union member + receiver + WatermelonDB collection + conformance test, for a 1–5-cardinality relation — overkill |
| D. Unify `BacklogItem.tags` into `Label` everywhere | One categorization axis; resolves Jordan's concern fully | Large migration touching backlog intake + program scope; couples task-label ship to a backlog refactor; risky for v1 |
| E. Replace-set `label_ids` PATCH (Visiban's approach) | Tiny API; matches Visiban | Lost-update race for concurrent agents (Nadia 🔴); needs OCC bolt-on anyway |

## Consequences

**Easier:**
- Board becomes scannable/filterable by a free categorization axis (Alex, Priya, Sarah).
- Agents can read+filter tasks by label today (MCP read) with no new scope.
- The #1089 dependency is discharged; ADR-0199's facet slot is filled with one predicate.
- Idempotent attach/detach makes label writes safe for parallel integrations by design.

**Harder / risks:**
- A label edit bumps `Task.server_version`, so a label change looks like a task change to
  sync consumers (acceptable — it does **not** trigger CPM recalc; only schedule fields
  do). Mitigated by `changed_fields=["labels"]` on the broadcast.
- Member-create + soft-cap is a judgment call; if 50 is wrong, it's a config tweak, not a
  migration. The create floor itself is a 🔴 user decision.
- Keeping tags and labels separate leaves a documented-but-real conceptual overlap
  (Jordan's concern is *mitigated by docs*, not *eliminated*); convergence deferred.
- Viewers get labels via REST refetch only, never live WS (ADR-0184) — expected, documented.

## Implementation Notes

- **P3M layer:** Programs and Projects + Operations (OSS).
- **Affected packages:** `api` (new `Label`/`TaskLabel` models, `LabelViewSet`, task
  attach/detach, `TaskSerializer` + sync serializer, sync source + receiver, broadcast),
  `web` (facet, card pills, label popover, settings manager, TanStack Query hooks),
  `mobile` (WatermelonDB `labels` collection + pill render — can lag web by a release),
  `docs` (feature page, api docs).
- **Migration required:** yes — one migration: `CreateModel Label`, `CreateModel
  TaskLabel`, `Label` GIN/btree indexes, `unique(project,name)` + `unique(task,label)`.
  Additive, non-destructive (migration-check clean; batch the model edits, one
  `makemigrations`, then `ruff --fix && ruff format`).
- **API changes:** yes — new project-nested label CRUD + task label attach/detach; new
  read-only `labels` on `TaskSerializer`; `label_ids` on the sync serializer. OpenAPI
  regenerated (merge `origin/main` first). No new token scope for v1.
- **OSS or Enterprise:** **OSS** (`trueppm/trueppm-suite`). Cross-project rollup =
  Enterprise, deferred.

### Durable Execution
1. **Broker-down behaviour:** N/A for a durability outbox — the only async side effect is
   the WS broadcast, which is **best-effort by design** (ADR-0152): the DB write is
   durable and clients reconcile via the sync-delta pull on reconnect, so a dropped
   broadcast self-heals. No outbox row needed. Label writes do **not** enqueue CPM recalc.
2. **Drain task:** N/A — no async work is queued by a label mutation.
3. **Orphan window:** N/A — no drain.
4. **Service layer:** N/A — attach/detach is a synchronous DB write in the viewset,
   broadcasting through the existing `broadcast_task_updated` helper. No new
   `services.py` dispatch path.
5. **API response on best-effort dispatch:** synchronous — `200`/`204` with the updated
   resource, not `{"queued": true}`. The write is committed before the response.
6. **Outbox cleanup:** N/A — no outbox.
7. **Idempotency:** attach = `get_or_create` guarded by `unique(task, label)` (duplicate
   attach is a no-op returning 200); detach = delete-if-exists (returns 204 whether or not
   the row existed). Both are naturally idempotent and commutative across *distinct*
   labels, so concurrent single-label toggles never clobber each other.
8. **Dead-letter / failure handling:** N/A — a lost WS broadcast is recovered by the next
   sync-delta pull (self-healing reconciliation); there is no queue to dead-letter.

## Open Questions

### ✅ Resolved (user decision, 2026-07-13)

1. **`Label` vs `BacklogItem.tags` relationship → KEEP SEPARATE** (D2). Task labels are a
   new first-class colored catalog on tasks/board/schedule; `BacklogItem.tags` stays as
   unchanged free-text on backlog intake items. The distinction is documented (item is
   *tagged* in intake → promoted to a task that carries *labels*). Convergence deferred to
   a future ADR. Option D (unify) rejected as too large for v1.

2. **Label-definition create floor → ANY MEMBER + SOFT CAP** (D3). `≥ MEMBER` can create a
   label (50/project soft cap to prevent sprawl); assign is `≥ MEMBER` on editable tasks;
   edit/recolor/reorder/delete are `≥ ADMIN`. Adoption-first per Morgan; Visiban's
   admin-only-create rejected.

### 🟡 Deferrable — a default is chosen; proceed unless you object

3. **Assignment sync mechanic:** Risk-style `label_ids`-on-Task + `server_version` bump
   (chosen, D1) vs `TaskLabel` as its own synced `VersionedModel` (Option C). Implementation
   detail; default stands.
4. **Schedule PDF export + Gantt bar coloring by label** (Sarah/PM 🟢 ask): deferred to a
   follow-up; v1 is board + drawer + filter. Flag if you want it in v1.
5. **Color input:** curated swatch palette + `#RRGGBB` regex (chosen, D1) vs free hex
   picker. Default = palette (coherent boards).
6. **Agent/MCP label *writes*:** deferred to the 0.6 write surface regardless (ADR-0186).
   v1 = MCP read-only. Not a v1 decision, noted for roadmap.
7. **Backlog-tag → label seeding on promote:** future nicety, out of scope.

## Related
- Closes issue **#1089**; completes the descoped facet slot in ADR-0199.
- Honors ADR-0152 (name-only `task_updated` broadcast), ADR-0142 (sync union + receiver),
  ADR-0184 (defense-in-depth RBAC, Viewer WS exclusion), ADR-0072 (role ordinals),
  ADR-0112/0186 (MCP read reach, deferred agent write), ADR-0030 (edition routing for the
  future Enterprise rollup).
