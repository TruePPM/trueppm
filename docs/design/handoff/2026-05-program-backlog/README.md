# #742 — Program Backlog List + Pull-Down UI

UI design handoff for the `/programs/:id/backlog` surface (milestone 0.2, OSS).
Replaces the `ProgramBacklogStubPage` body
(`packages/web/src/features/programs/ProgramBacklogStubPage.tsx`). The route and
tab shell already exist — this handoff covers the tab **content** only, not a new
route or shell.

- **Issue**: #742 (split from #501)
- **Design of record**: ADR-0069
  (`docs/adr/0069-dual-level-backlog-program-backlog-item-and-project-backlog.md`)
- **Closest sibling pattern**: `ProgramProjectsPage.tsx` — mirror its container,
  title row, toolbar buttons, list, empty state, pulse skeleton, and inline
  `role="alert"` errors.
- **Workflow**: `architect` (satisfied by ADR-0069) → **ux-design (this doc)** →
  implement → `ux-review`.

---

## ⚠️ Two blocking dependencies on the endpoint/model issue

The #742 issue text and ADR-0069 contradict each other. Both must be resolved in
the model/endpoint issue before implementation — they are **not** UI decisions.

### 🔴 1. Program-level pool vs project-scoped rows

- The issue + the stub's location in `ProgramShell` describe a **program backlog**
  where you "select an item → pick a **target project** → confirm." That only works
  if items are not bound to a project until pulled.
- ADR-0069's model has `project = FK → Project (CASCADE)` **non-null**, endpoint
  `/projects/{pk}/backlog-items/`, and `/pull/` creates a Task in `item.project` —
  **no target-project choice exists.**

This handoff is written for the **issue's** interpretation (program-level pool;
target project chosen at pull), because that matches the route, the stub shell, and
the explicit "pick a target project" acceptance criterion. The endpoint issue must
either (a) make `BacklogItem` program-scoped with `project` nullable until pull, or
(b) add a program-aggregation list endpoint + a `target_project` param on `/pull/`.

**If the team instead confirms ADR-0069's project-scoped model, the pull-down picker
(flow 1) is removed entirely and this becomes a per-project aggregate read — a
materially different design.** Resolve before building.

### 🟡 2. `tags` field is not in the ADR model

The issue requires a `tags` badge, filter, and column; ADR-0069's `BacklogItem` has
no `tags` field. The endpoint issue must add `tags: string[]` or drop tags from
#742. This handoff assumes `tags: string[]`.

---

## Personas & job-to-be-done

- **PO (Jordan), SM (Alex), PM (Sarah)** — primary.
- **Coach (Morgan)** — sprint-sovereignty guardrail (🔴 VoC blocker, resolved by
  ADR-0069): pull lands work in a **project backlog**, never a sprint.

JTBD: maintain a searchable program-level intake pool of proposed work, and pull a
selected item into a specific project's backlog (never a sprint).

---

## Desktop layout (≥1024px)

Container matches `ProgramProjectsPage` but wider: `mx-auto max-w-5xl px-6 py-6`
(two panes).

```
┌────────────────────────────────────────────────────────────────────────┐
│ Program Backlog  ⓘ                                              23       │  h2 + tppm-mono count
│ Work proposed for this program — pull items into any project's backlog.  │  subhead (ADR risk mitigation)
├────────────────────────────────────────────────────────────────────────┤
│ [🔍 Search proposed work…        ] [Type ▾] [Tags ▾]      [+ New item]   │  filter row + create (EDITOR+)
├──────────────────────────────────┬─────────────────────────────────────┤
│ LIST PANE  (40%, scrolls)        │ DETAIL / EDIT PANE  (60%, scrolls)    │
│ ┌──────────────────────────────┐ │  [EPIC]  Billing rework               │
│ │ [EPIC] Billing rework      ▸ │ │  PROPOSED · rank 1 · 8 pts            │
│ │ ◆ rank 1 · 8 pts · #tax #fin │ │  #tax  #finance                       │
│ │ [STORY] CSV export      ◀sel │ │  ──────────────────────────────────   │
│ │ [TASK] Migrate auth lib      │ │  Description / Acceptance criteria …  │
│ └──────────────────────────────┘ │  [ Edit ]      [ Pull to project ⤓ ]  │  EDITOR+ only
│ ▸ Pulled (5)        (collapsed)   │                                       │
└──────────────────────────────────┴─────────────────────────────────────┘
```

- **List pane**: `ul divide-y divide-neutral-border rounded border border-neutral-border
  bg-neutral-surface`. Each row is a `<button>` selecting into the right pane;
  `hover:bg-neutral-surface-raised`, selected `bg-brand-primary/10 border-l-2
  border-brand-primary`. Row: item_type badge, title (`text-sm font-medium`,
  truncate), meta line (`tppm-mono text-xs text-neutral-text-secondary`):
  `rank {n} · {pts} pts · {tags}`. Sorted server-side by `priority_rank` (nulls last).
- **Item-type badge**: neutral outlined pill — `bg-transparent border
  border-neutral-border rounded px-1.5 text-[11px] uppercase tppm-mono
  text-neutral-text-secondary`. Types are categories, **not** health states → no
  semantic colors; badge text is the WCAG 1.4.1 signal.
- **Detail/edit pane**: read view by default; `Edit` switches to inline form (same
  pane, no modal); `Pull to project ⤓` opens the pull dialog. Nothing selected →
  centered `Select an item to view its details`.
- **Pulled section**: collapsible group below the list, collapsed by default
  (`▸ Pulled (N)`, `tppm-mono`); expanding lazy-fetches `?status=pulled`. Pulled rows
  show a `PULLED` badge + destination project + Task link. Archived is reached via a
  `Show archived` toggle in the `Type ▾` popover footer — not a primary control.

## Tablet (768–1023px)

Two-pane 45/55, `max-w-full px-4`. Filter labels collapse to icon-only (web rule
111); `Type`/`Tags` keep icon + `aria-label`.

## Mobile (<768px)

Single column, **list → push-detail** navigation (not a drawer — detail is a primary
editing surface).

```
┌─────────────────────────┐   tap row →   ┌─────────────────────────┐
│ Program Backlog     23  │               │ ‹ Back                  │
│ [🔍 Search…          ]  │               │ [EPIC] Billing rework   │
│ [Type ▾] [Tags ▾]       │               │ PROPOSED · rank 1 · 8pts │
│ [EPIC] Billing rework ▸ │               │ #tax #finance            │
│ [STORY] CSV export    ▸ │               │ Description / AC …       │
│ ▸ Pulled (5)            │               │ [ Edit ] [ Pull ⤓ ]      │
│                    (＋) │ ← FAB         └─────────────────────────┘
└─────────────────────────┘
```

- Create entry = **FAB** (`fixed bottom-16 right-4 w-14 h-14 rounded-full
  bg-brand-primary border border-brand-primary-dark`, no shadow — matches Risk rule
  90 / Board rule 104), above the program tab bottom nav.
- Detail/edit = full-screen pushed view with `‹ Back`. Create = same view, create mode.
- Pull = **bottom sheet** (85vh, drag handle) instead of the desktop modal.

---

## Interaction flows

### 1. Pull-down (the novel pattern)

Desktop = modal dialog `PullToProjectDialog` (`role="dialog" aria-modal="true"`,
480px); mobile = bottom sheet. Modal is justified despite the "modals for destructive
actions only" convention: pull is a state commitment requiring a focused required
choice + sprint-sovereignty reassurance.

```
┌─ Pull "CSV export" to a project ──────────────────┐
│ Target project                                     │
│ [ Select a project…                            ▾ ] │  required; this program's projects
│ ┌────────────────────────────────────────────────┐│
│ │ ⓘ This adds the item to the project backlog as  ││  sprint-sovereignty copy (Morgan 🔴)
│ │   a task. It will NOT be added to any sprint —  ││
│ │   sprint assignment stays in Sprint Planning.   ││
│ └────────────────────────────────────────────────┘│
│                              [ Cancel ] [ Pull ⤓ ] │  Pull disabled until a project is chosen
└────────────────────────────────────────────────────┘
```

- Project picker lists the program's projects (`useProgramProjects`). Required;
  `Pull` disabled until chosen.
- On confirm: **optimistic** — close dialog, move item out of Proposed into the
  Pulled section, toast `Pulled "{title}" to {project} backlog`. Fire
  `POST …/pull/` with `{ target_project }`.
- **Rollback**:
  - `409 Conflict` (already pulled/archived): roll back optimistic move, refetch the
    item, `role="alert"` toast `"{title}" was already pulled — refreshed`.
  - Network / non-2xx: roll back to Proposed, toast `Couldn't pull — check your
    connection and try again`.
  - **Offline guard** (web rule 29 pattern): check `navigator.onLine` before firing;
    if offline, no optimistic move, toast `You're offline — pull will not be saved`,
    no spinner.

### 2. PULLED-state surfacing

Resolved as the **collapsed "Pulled (N)" section** at the list bottom (not an
in-place badge in the Proposed list) — keeps the proposed pool clean. Default list
fetch is `?status=proposed`; the section fetches `?status=pulled` on expand.

### 3. Create / edit form (inline pane; pushed view on mobile)

No modal. Fields in order:

| Field | Control | Notes |
|---|---|---|
| `title` | text | **required**, ≤512; inline error `Title is required` on blur-empty |
| `item_type` | select | Epic / Feature / Story / Task (default Task) |
| `description` | textarea | optional, auto-grow |
| `acceptance_criteria` | textarea | optional |
| `priority_rank` | number | optional, min 1, `tppm-mono`; helper `Lower = higher priority` |
| `story_points` | number | optional, min 0 |
| `tags` | chip/token input | `tags: string[]` (pending endpoint dependency #2) |

Footer `[ Cancel ] [ Save ]`; Save disabled until dirty + valid. Errors inline
`role="alert"` (not toast). Create success → select new item; edit success → return
to read view.

### 4. Filters + search

Single filter row, combine with **AND**:

- **Search** — `?q=` trigram, debounced **300ms**, `flex-1`, `×` to clear.
- **Type ▾** — multi-select dropdown (`role="menu"` + `menuitemcheckbox`); empty = all.
- **Tags ▾** — multi-select dropdown (pending endpoint dependency #2).
- **Status** — not a visible chip: Proposed is the default list, Pulled is the
  collapsible section, Archived is a `Show archived` toggle inside the `Type ▾`
  popover footer (`?status=archived`).

---

## States

- **Empty (no items)**: centered card (`rounded border border-neutral-border
  bg-neutral-surface-raised p-6 text-center`), copy `No proposed work yet. Capture
  features, stories, and tasks here, then pull them into a project when you're
  ready.` + `[ + New item ]` (EDITOR+).
- **No results**: `No items match your filters.` + `[ Clear filters ]`.
- **Loading**: 3 pulse skeleton rows (`h-14 animate-pulse rounded border
  border-neutral-border bg-neutral-surface-raised`, `aria-label="Loading backlog"`).
- **Error (list)**: `role="alert"` `Failed to load the backlog.` + `[ Retry ]`.
- **Offline**: banner `Working offline — changes will sync when connected`;
  create/edit/pull guarded.
- **Success**: toast for pull; inline return-to-read for save.

---

## Role gating

Create / Edit / Pull gated to **EDITOR+** (ADR-0069 `role ≥ EDITOR`). Viewers get a
fully usable read surface (list, detail, search, filters) with no `+ New item`,
`Edit`, `Pull`, or FAB. **Confirm the program-role numeric that maps to EDITOR** —
`ProgramProjectsPage` uses `>= 3` for admin; backlog edit is a lower bar, so the
threshold differs and must not be copied blindly.

---

## API dependencies (built by the endpoint/search issue)

- `GET …/backlog-items/?q=&item_type=&tags=&status=proposed&ordering=priority_rank` — list
- `GET …/backlog-items/?status=pulled` — Pulled section (lazy)
- `GET …/backlog-items/{id}/` — detail
- `POST …/backlog-items/` — create
- `PATCH …/backlog-items/{id}/` — edit
- `POST …/backlog-items/{id}/pull/` body `{ target_project }` → `201 {task}` | `409`
  (exact path/body pending blocking dependency #1)
- `useProgramProjects(programId)` — target-project picker (exists)

Hooks to add (`src/hooks/`, stub-returning fixtures until the API lands, web rule
11): `useBacklogItems`, `useBacklogItem`, `useCreateBacklogItem`,
`useUpdateBacklogItem`, `usePullBacklogItem`. State: TanStack Query for server state;
selected-item id + Pulled-expanded flag are component `useState` — **no Zustand**.

---

## New web design rules (add to `packages/web/CLAUDE.md` before merge)

1. **Item-type badges are neutral-outlined, never semantic-colored** — epic/feature/
   story/task are categories, not health states; reserve red/amber/green for status.
2. **Pull-down is a focused commitment dialog** (modal desktop / bottom sheet mobile)
   and must carry the sprint-sovereignty copy: pull lands work in the project
   backlog as a task, never a sprint. Target-project select is required; `Pull` stays
   disabled until chosen.
3. **Backlog two-pane collapses to push-navigation on mobile, not a drawer** — the
   detail pane is a primary editing surface (distinct from the risk-detail drawer,
   web rule 89).
