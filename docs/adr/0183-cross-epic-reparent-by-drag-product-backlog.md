# ADR-0183: Cross-epic reparent-by-drag on the Product Backlog

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: useReparentStory)

## Context

ADR-0110 shipped manual drag-to-reorder on the Product Backlog grooming view, but
**explicitly deferred** dragging a story from one epic into another:

> ADR-0110 §5: "It never changes `parent_epic`: dragging a story between epic groups in
> the UI is **out of scope** for this ADR (rank-only). Cross-epic reparent-by-drag, if
> wanted, is a separate follow-up." … "the UI must visually constrain drag to reordering,
> not reparenting, **or a follow-up ADR must cover reparent semantics**."

This ADR is that follow-up (issue #1345). Today, the only way to move a story to a
different epic is the epic `<select>` in `StoryDetailDrawer` — a slow, indirect path
for a PO grooming a large backlog. We want the PO to **drag a story and drop it onto an
epic**, with that epic **lit up / contrasted** to show where the drop will land.

P3M layer: **Programs and Projects** (single-project backlog grooming) → **OSS**. No
cross-program or portfolio scope.

The structural blocker is that ADR-0110 renders each epic group (and the ungrouped
section) as its **own isolated `DndContext` + `SortableContext`**, so drag is physically
confined to one group. Cross-epic drag requires unifying these into one drag surface.

The backend already supports reparenting with **no change**:
- `PATCH /api/v1/tasks/{id}/` accepts `parent_epic` (an epic id, or `null` to ungroup).
  The serializer validates: target must be `type=EPIC`, same project, not self, not
  itself nested (`serializers.py::_validate_product_backlog`, lines 2201–2222).
- The write is gated **Project Manager+ OR Product Owner facet** — the same gate as the
  reorder endpoint (`can_manage_backlog`), and the same as the web `useCanManageBacklog`.
- The PATCH bumps `server_version`, fires `task_updated`, and enqueues a CPM recalc that
  is a **no-op** for a BACKLOG task (excluded from the CPM graph, ADR-0105 §1).

So this is a **frontend-only** change: a @dnd-kit restructure plus one optimistic PATCH
mutation. No new endpoint, no serializer change, no migration.

## Decision

### D1 — One `DndContext` spans the whole By-epic view; epic groups become droppables
Replace the per-group isolated `SortableGroup` (each its own `DndContext`) with a
**single `DndContext`** wrapping all epic groups and the ungrouped section. Each epic
group keeps its `SortableContext` (`verticalListSortingStrategy`) for within-group
reorder; each epic group container **and** the ungrouped container additionally register
as a droppable reparent target (`useDroppable`, id `epic:<epicId>` / `epic:__ungrouped__`).
This mirrors the established board cross-column drag (`features/board/BoardView.tsx`:
one `DndContext`, droppable columns, a tracked drop-over highlight).

### D2 — The drop target disambiguates reorder vs reparent
On `onDragEnd`, resolve the `over` target's owning group:
- `over` is a **story in the same group** as `active` → **reorder** (the existing
  rank-only `useReorderBacklog` path, unchanged).
- `over` resolves to a **different epic group** (its droppable, its header, or a story
  inside it) → **reparent** the active story into that epic.
- `over` resolves to the **ungrouped** droppable → **reparent to `null`** (ungroup).
- `active.id === over.id`, or no `over` → no-op.

### D3 — Reparent is a single optimistic `PATCH parent_epic`, NOT a combined reorder
Drop-onto-an-epic reparents via **one** `PATCH /tasks/{id}/ { parent_epic }` (new
`useReparentStory` hook). The story lands in the target epic **ordered by its existing
`priority_rank`** (the read endpoint orders each group's stories by `priority_rank`); the
PO can then drag-reorder within the new epic via the existing rank-only path.

We deliberately do **not** combine reparent with a precise within-target reorder. The
combined operation would require two sequenced requests — PATCH (which bumps the moved
row's `server_version`) **then** `POST product-backlog/reorder` with the *new*
`server_version`, or the reorder 409s on a stale version — and a partial-failure recovery
between them. The issue asks to drop **onto an epic** (the epic is the highlighted target,
not an inter-row gap), so "join this epic, keep your rank" is the faithful, robust v1.
Precise drop-position on a cross-epic drop is a documented deferral (see Consequences).

Optimistic update: move the story object from its source group's `stories` array into the
target group's `stories` (or `ungrouped`) in the cached `ProductBacklog`, then PATCH. On
error, **roll back** and surface the existing reload notice (reuse the `conflict` banner).
The PATCH carries no `server_version` (it is a normal partial update, not the
version-checked reorder), so it cannot 409; the failure modes are 403 (permission), 400
(validation — e.g. target not an epic, which the UI structurally prevents), or network.
On success, invalidate `['product-backlog', projectId]` so the server-true order (and any
peer changes signalled by `task_updated`) reconciles.

### D4 — Highlight the whole epic group region, using the rule-103 drop-target affordance
The droppable surface is the **entire epic group container** (header + its rows area), not
just the header — dropping anywhere on an epic should join it, matching the board column.
While a story is dragged over an epic, that epic's container shows the canonical board
drop-target affordance (web-rule 103): `bg-brand-primary/5` fill + a sage emphasis edge.
The exact ring/border treatment is the ux-design agent's call; the **structure** is: one
tracked "over-epic" id (set in `onDragOver`, cleared on end/cancel), applied to that one
container, never to the source group. The ungrouped section gets the same affordance when
it is the drop target.

### D5 — Accessibility: the drawer epic `<select>` is the keyboard alternative; add aria-live
Drag-and-drop is not keyboard-operable, but unlike the board (which had no other path and
therefore needed a "Move to…" menu, web-rule 105), the Product Backlog **already has a
fully keyboard-accessible reparent path**: the epic `<select>` in `StoryDetailDrawer`.
We document that as the WCAG 2.1.1 alternative and do **not** add a redundant "Move to
epic" row menu. We add one `aria-live="polite"` region (written via DOM ref per rule 30 /
ADR-0056) announcing each drop: `"Moved {story} to epic {epic}."` / `"Moved {story} out of
all epics."` / on failure `"Couldn't move {story}."`. dnd-kit's existing `KeyboardSensor`
(Space to lift) continues to work within the unified context for reorder.

### D6 — Permission gating
Reparent is gated **PM+ / PO facet** server-side (identical to reorder). Client-side, gate
the reparent branch on `useCanManageBacklog(projectId)` so a non-manager's drop is a no-op
with no misleading error (the within-group reorder behavior is unchanged from ADR-0110).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Single DndContext + droppable epic groups + single PATCH reparent (chosen)** | Reuses board precedent; one optimistic request; no backend change; faithful to "drop onto an epic" | Cross-epic drop can't pick a precise rank within the target (lands by existing rank) |
| B. PATCH parent_epic **then** reorder (two requests) for precise position | Drop lands exactly where released | Two sequenced writes; second 409s on stale `server_version`; partial-failure recovery; more surface for a flaky drag |
| C. New `POST product-backlog/reparent` combined endpoint | One atomic server op; precise rank | Backend change + migration-free but new view/serializer/tests/RBAC; ADR-0110's reorder already does rank — duplicates concurrency machinery for marginal UX |
| D. Keep per-group DndContexts, add a separate "drop zone" strip | Smallest diff | A separate drop strip is a worse affordance than the epic itself lighting up; doesn't satisfy the issue's "epic lit up" requirement |

Option A is chosen: it satisfies the issue exactly, adds zero backend, and keeps the
robust single-write optimistic pattern. B/C are the upgrade path if "drop at an exact
position in another epic" becomes a real request.

## Consequences

**Easier**
- One-gesture reparent for the PO; the epic lights up as a clear drop target.
- The By-epic view becomes one coherent drag surface (board-consistent).

**Harder / risks**
- The reorder `onDragEnd` logic gains a branch (same-group reorder vs cross-group
  reparent); must be unit-tested for both paths and the ungrouped⇄epic cases.
- Unifying the `DndContext` changes collision detection across more droppables; keep
  `closestCenter` but verify a within-group reorder still resolves to the story, not the
  group, when dropping between two rows (test the boundary).
- **Deferred (documented, not a silent cap):** a cross-epic drop lands the story by its
  existing `priority_rank`, not at the exact drop position. If users ask for precise
  cross-epic placement, adopt Alternative B/C in a follow-up. Call this out in the docs/
  features copy so it reads as intentional, not a bug.

## Implementation Notes
- P3M layer: Programs and Projects (OSS).
- Affected packages: **web** only.
- Migration required: **no**.
- API changes: **no** — reuses `PATCH /api/v1/tasks/{id}/ { parent_epic }` and the
  unchanged `POST product-backlog/reorder` for the within-group path.
- OSS or Enterprise: **OSS** (`trueppm-suite`).
- Key files: `features/project/backlog/ProductBacklogPage.tsx` (DnD restructure),
  `features/project/backlog/hooks/useProductBacklog.ts` (+ `useReparentStory`),
  `features/project/backlog/api.ts` (reuse `patchStory` / a thin reparent call).
- Tests: vitest for the reorder-vs-reparent disambiguation + optimistic move/rollback;
  Playwright e2e for the golden drag-into-epic path + the ungroup path.

### Durable Execution
1. Broker-down behaviour: **N/A** — frontend-only; the one write reuses the already-shipped
   `PATCH /tasks/{id}/`, whose own side-effects (task_updated broadcast, `task.updated`
   webhook, no-op CPM recalc enqueue) are unchanged existing behavior of that endpoint.
2. Drain task: **N/A** — no new async work introduced.
3. Orphan window: **N/A** — no new outbox rows.
4. Service layer: **N/A** — no new server dispatch path; the PATCH already routes through
   `TaskViewSet.perform_update`.
5. API response on best-effort dispatch: **N/A** — synchronous PATCH returning the updated
   task; no queued/202 path added.
6. Outbox cleanup: **N/A** — no new outbox category.
7. Idempotency: a repeated reparent PATCH is naturally idempotent — setting `parent_epic`
   to the same value yields the same row state; the client also invalidates and refetches
   the server-true backlog after success.
8. Dead-letter / failure handling: a failed reparent PATCH rolls back the optimistic cache
   move and surfaces the reload notice + the aria-live failure announcement; the user
   retries. No server-side queue is involved.
