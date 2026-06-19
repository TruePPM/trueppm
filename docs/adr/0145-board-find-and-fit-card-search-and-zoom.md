# ADR-0145: Board Find-and-Fit — full-text card search + board-local zoom

## Status
Accepted

## Context
The Board view has two long-standing usability gaps, both surfaced repeatedly on the
2026-05-04 VoC board wishlist:

1. **No way to find a card** (#323). The only way to locate a known card is a visual
   scan plus a saved-view filter. Priya scored search 9/10 ("two-second find for the
   card I know exists"); Sarah 7, Alex 7. The leading cross-persona pull on the board.
2. **No way to fit more on screen** (#379). The board has a Density toggle (vertical
   card padding only) but no zoom. Users resort to browser zoom (Cmd/Ctrl±), which
   shrinks the entire app shell — sidebar, top bar, tabs — not just the board.

Both are single-project board conveniences for the contributor / delivery layer
(Priya, Alex, Jordan). Neither aggregates across projects.

**P3M layer:** Programs and Projects (single project board). **OSS.** No portfolio
rollup, no cross-project data, no enterprise hook.

A fresh VoC panel (avg ~6.1; on-target 0.3 cohort Priya 9 / Alex 7 / Jordan 6.5)
surfaced one load-bearing constraint: server-side search **must not** leak fields a
member's role cannot see (Morgan/Marcus boundary), and must be IDOR-safe (Viewer+
membership only). Sarah's mobile and David's allocation 🔴s are release-window
structural (pre-0.4 / pre-0.5) and are not a rescope signal per `personas.md`.

## Decision

### Feature 1 — Board full-text card search (#323)
- **Endpoint:** a dedicated `@action(detail=False, methods=["get"], url_path="search")`
  named `search` on the existing `TaskViewSet` →
  `GET /api/v1/tasks/search/?project=<uuid>&q=<term>` (the task API is flat and
  `?project=`-scoped, matching the existing board `/tasks/?project=` list fetch).
  - Returns a **slim payload** per match: `{id, name, status, short_id}`. Nothing else.
  - Matching: case-insensitive substring (`Q(name__icontains=q) | Q(notes__icontains=q)`),
    ordered name-matches-first then `name`. `name` = the card title, `notes` = the card
    description (the issue's "title, description"). Comment-body search is out of scope
    until #311 (a `# TODO(#311)` marker records the seam).
  - **Index:** a `GinIndex(opclasses=["gin_trgm_ops"])` on `Task.name` and `Task.notes`,
    modeled exactly on the existing backlog prior art
    (`0050_backlog_item_trgm_search.py`). The `gin_trgm_ops` index is the canonical
    accelerator for `ILIKE '%term%'` / `icontains` — so substring matching stays
    predictable *and* indexed. `pg_trgm` already exists (created by 0050); the new
    migration (`projects/0086`) only adds the two indexes.
  - **Guards:** `project` is required (400 without it); `q` is trimmed, min length 1
    (empty → empty list), capped at 100 chars (DoS guard); result set capped at 500
    rows (no unbounded payload).
- **RBAC / field visibility:** the action falls through `TaskViewSet.get_permissions`
  to `IsProjectMember` (Viewer+), and `ProjectScopedViewSet.get_queryset` already
  restricts the queryset to projects the user is an active member of (IDOR-safe). The
  slim payload carries **no cost/budget/sensitive fields**, so role-based field
  visibility is moot by construction — this is what keeps the Morgan/Marcus VoC
  constraint satisfied without per-field gating.
- **Frontend:** a search input in the board toolbar (`CalmToolbar`), keyboard-opened
  with `/`. On query change (200 ms debounce) the board calls the search endpoint,
  intersects the returned IDs with the cards currently rendered, and sets the existing
  `BoardCard isDimmed` prop on non-matches (dim to 30% opacity + `aria-hidden`). A
  result counter chip ("N matches") shows the count among visible cards; Esc or the ×
  button clears. The query is reflected in the `?q=` URL param (the board already
  drives `?sprint=` and `?view=` via `useSearchParams`) so a searched board is a
  shareable link.

### Feature 2 — Board-local zoom (#379)
- **Discrete 3 levels** — `small | normal | large` (default `normal`) — chosen over a
  continuous `transform: scale()` / CSS `zoom`. This is **not** a stylistic choice: the
  board is a dnd-kit drag surface, and dnd-kit computes pointer coordinates in CSS
  pixels — a `transform: scale()` or `zoom` on any *ancestor* of a draggable silently
  breaks the drop math. The only safe lever is real CSS *sizing*, which discrete levels
  express cleanly. Rendered as a `−` / level-label / `+` stepper in `CalmToolbar`,
  visually paralleling the Schedule `ZoomControl`.
- **Mechanism:** each level sets **coordinated CSS custom properties for board chrome
  spacing** on the board grid container — `--board-phase-col` (the phase-column width,
  shared by the column-header grid, every lane grid, and `PhaseMilestoneRail`, which all
  hard-code `188px` today and must stay column-aligned), `--board-lane-gap` (inter-column
  gap), and `--board-rail-h` (phase-rail height). Shrinking the phase column + gaps + rail
  reclaims horizontal and vertical space so more card area fits; growing them gives a
  roomier presentation board. Only the board element is affected; the app shell stays
  native. **Glyph/font scaling is deliberately left to Density** (and the browser) — it
  would require either an ancestor `transform`/`zoom` (breaks dnd-kit) or an invasive
  em-conversion of every `BoardCard` text class (out of scope for a toolbar wave). Zoom
  scales board *spacing*; Density scales *card padding*; together they control how much
  fits — the two independent axes the issue calls for.
- **Persistence:** an additive `zoom` field on the existing `useBoardToolbarPrefs`
  store (`localStorage` key `trueppm.board.toolbarPrefs.v1`, already cross-tab synced).
  Absent key defaults to `normal`, so the change is backwards-compatible without a
  version bump.
- **Accessibility:** stepper buttons are tabbable with `aria-label`s, disabled at the
  bounds, with a live region announcing the level; focus ring per design rule 4.
  **Independent axis from Density** (Density = per-card vertical padding; zoom = how
  much board fits on screen). **Hidden below 768 px** — zoom is a desk task (matches
  the #326 board-export mobile rule and the VoC "desk task" note).

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **Search: dedicated `search` @action (chosen)** | Slim payload sidesteps field-visibility; API-first + MCP-reachable ("find tasks matching X"); reuses viewset RBAC/scoping; doesn't touch the hot list path | One more route |
| Search: `?q=` on `TaskViewSet.list` | No new route | Runs the heavy `TaskSerializer` + per-page milestone-rollup batching on every keystroke; forces field-visibility reasoning over the full payload |
| Search: pure client-side filter over loaded cards | Zero backend, instant | Violates the API-first contract (not MCP-reachable, no server fact); no shareable semantics at project scale; AC explicitly requires the endpoint |
| **Zoom: discrete CSS-sizing levels (chosen)** | Coordinated spacing tokens; dnd-kit-safe (no ancestor transform); crisp text; predictable | Fixed steps; spacing not glyph scaling |
| Zoom: continuous `transform: scale()` / CSS `zoom` | Feels like Cmd± | **Breaks dnd-kit drag math** (pointer coords are CSS-px; an ancestor transform/zoom desyncs the drop); blurs text at non-integer scales |

## Consequences
- **Easier:** finding a buried card (Priya/Sarah/Alex); fitting a dense multi-column
  board on one screen (Alex multi-team); sharing a filtered board via URL; an agent can
  search tasks over the API.
- **Harder:** two new toolbar controls add to `CalmToolbar`'s control budget — mitigated
  by grouping (search leads the toolbar; zoom sits in the existing zoom/density cluster).
- **Risks:** (1) trigram GIN index build cost on `Task.notes` for very large projects —
  acceptable at board scale, additive/online-safe (`AddIndex`, no rewrite). (2) Toolbar
  surface collision with in-flight board branches (#853 touches `BoardView.tsx`; #740
  touches `BoardCard.tsx`) — additive changes, renumber/rebase at merge. (3) Search
  results can include cards outside the current sprint/view filter; the board only dims
  among *visible* cards and the counter reflects visible matches — documented behavior,
  not a defect.

## Implementation Notes
- P3M layer: Programs and Projects.
- Affected packages: api (TaskViewSet action + migration), web (CalmToolbar, BoardView,
  useBoardToolbarPrefs, board CSS, a search hook).
- Migration required: yes — `projects/0086` adds two `gin_trgm_ops` GIN indexes
  (`pg_trgm` already present from 0050). Additive, no data change.
- API changes: yes — one new read-only action `GET .../tasks/search/`. OpenAPI schema
  regenerated; `api-docs` synced.
- OSS or Enterprise: **OSS** (single-project board convenience).

### Durable Execution
1. Broker-down behaviour: **N/A** — search is a synchronous read endpoint; zoom is pure
   frontend. Neither has async side effects.
2. Drain task: **N/A** — no async work.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: **N/A** — read-only queryset filter in the viewset; no CPM/dispatch.
5. API response on best-effort dispatch: **N/A** — synchronous `200` with the slim
   result list.
6. Outbox cleanup: **N/A** — no outbox.
7. Idempotency: **N/A** — `GET` is naturally idempotent and side-effect-free.
8. Dead-letter / failure handling: **N/A** — no task; a query error surfaces as a normal
   DRF `4xx/5xx`.
