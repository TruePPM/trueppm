# ADR-0180: Unified "Today" split view for the role-context switcher

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: TodayView)

## Context
The role-context switcher (#412) lets a user pick a per-user *lens* — `pm`,
`scrum_master`, or `unified` — that re-points and re-orders the project surfaces
they land on. The lens itself shipped under ADR-0162 as a strictly
presentation-only layer (`lensOrder.ts`): it never touches RBAC, the methodology
filter, or write-gating, and it is set only through a self-scoped
`PATCH /auth/me/profile/` (no admin path). Today the three lenses land on:
`pm → schedule`, `scrum_master → board`, `unified → overview`.

The `unified` lens exists for the **dual-hat PM + Scrum-Master** — one person who
runs both the waterfall/hybrid program schedule and the agile team. For that
person, "land on Overview" is a placeholder: ADR-0162 explicitly deferred the
bespoke Unified surface. This ADR designs it: a single split screen that
co-locates the schedule status and the active sprint board so the dual-hat user
stops bouncing between the Schedule and Board routes.

**P3M layer:** Programs and Projects (single project) → **OSS**. This is
single-project PM/SM productivity, not cross-project aggregation or governance.
No data moves upward; nothing here is a portfolio rollup.

**VoC (panel avg 4.6/10, dominated by out-of-scope portfolio personas):** the
personas this serves rate it well — Alex (Scrum Master) 7 🟢 and Morgan (Agile
Coach) 8 🟢, the strongest OSS adoption signal, with no design-blocking hard-NOs.
Their conditions are load-bearing and shape the decision below:
1. the lens must stay **strictly self-set** (no admin can set another user's lens);
2. the schedule↔sprint rollup must be **one-way, read-only** (board → schedule) —
   no editing sprint content from Today, completion never flows schedule → board;
3. the board must be **embedded unchanged** (contributor keyboard/scroll/chrome
   untouched — Priya's veto seam);
4. this per-user Today rollup must **never** be surfaced on a PMO/exec dashboard
   (velocity-exposure → Morgan's autonomy guarantee);
5. velocity-forecast, sprint-goal-at-risk, and WIP-overload callouts are deferred.

## Decision
Ship a **frontend-only** Unified "Today" view as a first slice. No model,
migration, or new endpoint.

1. **Register `today` as a project view** in the existing view registry
   (`viewMeta.ts` + `methodologyTabs.ts`), leading the **TRACK** group. It is
   **visible for every methodology** — the board it embeds already is (board is
   visible for WATERFALL/AGILE/HYBRID), and `today` degrades gracefully when a
   project has no active sprint (the sprint chip reads "No active sprint" and the
   board renders its own continuous/empty state). Keeping it universal means the
   lens redirect (below) always resolves with no special-casing. It composes with
   the existing pipeline — `groupedVisibleViews` → `groupedVisibleViewsForUser`
   (hidden-views) → `applyRoleContextLensOrder` — for free, and is added to both
   the web `HIDEABLE_VIEW_KEYS` (derived from `VIEW_GROUPS`) and the server-side
   `HIDEABLE_VIEW_KEYS` constant (`profiles/constants.py`) so a user may hide it
   like any other TRACK view. A standalone route *outside* the tab registry was
   rejected: it would bypass the hidden-views set and the lens pipeline, and be
   unreachable from the view bar.

2. **`unified` lens lands on `today`**: change `LENS_DEFAULT_VIEW.unified` from
   `'overview'` to `'today'`. `today` is *also* an additive tab any user can click
   — the lens only changes the **default** landing, not visibility. Because
   `today` is universally present, the lens-aware `ProjectIndexRedirect` always
   resolves; **no methodology-aware fallback is needed** (rejected as unnecessary
   complexity that would force a project fetch into the hot redirect path). A user
   who hides `today` and uses the unified lens lands on the hidden-but-valid route
   — consistent with ADR-0041's "hidden ≠ blocked".

3. **`TodayView` composition** (new `features/today/`):
   - **Top — `SchedulePulse`** (new, compact, read-only): schedule health band,
     SPI, critical-task count, late-task count, % complete, and the next milestone,
     all from the existing `GET /projects/{id}/overview/` via `useProjectOverview`.
     The active sprint's live progress is shown here as the **rollup link**,
     derived client-side from the already-loaded board tasks scoped to the active
     sprint (`useActiveSprint` for identity/goal/dates; completed-vs-committed from
     the shared task query). The flow is strictly **board → strip**.
   - **Enterprise gate/CR slot**: a new `today_view.gate_status` `SlotId`
     (ADR-0029). OSS renders nothing; Enterprise registers gate-status and
     change-request alert cards. This keeps gate/CR content an extension point, not
     an OSS feature.
   - **Bottom — the existing `BoardView` embedded unchanged**. Under
     `/projects/:id/today` it resolves `projectId` from the same route param, so it
     mounts as-is with its own toolbar and keyboard. No edits to sprint content
     happen on Today beyond what the board already allows for the user's role.

4. **Zero new API.** `GET /projects/{id}/overview/` + `GET /projects/{id}/sprints/?state=ACTIVE`
   + the board's already-loaded task query supply everything. Project-level
   schedule-variance-*days* is intentionally **omitted** from the strip (it does not
   exist on `/overview/` today and is not worth a backend change for v1); the band +
   SPI + counts convey the same "are we on track" signal.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A. Register `today` view + flip unified default (chosen)** | Composes with methodology/hidden-views/lens pipeline; reachable as a tab; no new endpoint | One server constant (`HIDEABLE_VIEW_KEYS`) gains `'today'`; embeds a route-coupled board |
| B. Standalone `/today` route outside the tab registry | Fewer registry edits | Bypasses methodology gating + lens + hidden-views; unreachable from the bar; inconsistent shell |
| C. Build a slimmer bespoke board lane strip for the bottom half | Avoids double toolbar / global board keyboard | Violates "embed board unchanged" (Priya/Morgan); large new surface; diverges from sprint board behavior |
| D. Add a backend `/today` rollup endpoint with a live sprint percent | One canonical number, real-time via WS | New API/model for a v1 that the frontend can already derive; couples Today to a new server contract before the UX is validated |

## Consequences
- **Easier:** the dual-hat user gets one home; the lens finally has a purpose-built
  destination; future PM/SM bespoke surfaces follow the same compose-existing pattern.
- **Harder / risks:**
  - The embedded `BoardView` attaches a **global** `window` keydown listener
    (`useBoardKeyboard`) and renders its own `CalmToolbar`. On Today this means
    board shortcuts are active and there are two toolbars (compact strip + board).
    Accepted for v1 because the board must stay **unchanged**; scoping the board
    keyboard to focus and de-duplicating chrome is a tracked follow-up.
  - The rollup is **computed-on-read** (refreshed when the board re-fetches), not
    push-fresh. A real-time WebSocket sprint-percent rollup is a deferred follow-up.
  - **Boundary risk (Morgan):** this rollup is a *per-user* view. It must never be
    lifted onto a PMO/exec dashboard — doing so would expose team velocity as a
    management metric. Recorded here as a standing constraint for any future slice.

## Implementation Notes
- P3M layer: Programs and Projects (single project)
- Affected packages: `web` only
- Migration required: no
- API changes: no new endpoint/serializer/model. One server-side constant —
  `profiles/constants.py::HIDEABLE_VIEW_KEYS` — gains `'today'` so the nav-hide
  validation stays in sync with the web `VIEW_GROUPS`. Data comes from the existing
  `/projects/{id}/overview/` + `/projects/{id}/sprints/` reads.
- OSS or Enterprise: **OSS** (`trueppm-suite`). Enterprise registers gate/CR cards
  against the new `today_view.gate_status` slot (ADR-0029); OSS renders it empty.

### Durable Execution
1. Broker-down behaviour: **N/A** — frontend-only, read-only composition; no task is dispatched, no DB write occurs on this surface.
2. Drain task: **N/A** — no async work introduced.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: **N/A** — no new server dispatch path; reuses existing read endpoints (`ProjectOverviewView`, `SprintViewSet`).
5. API response on best-effort dispatch: **N/A** — no mutating endpoint added.
6. Outbox cleanup: **N/A** — no outbox rows.
7. Idempotency: **N/A** — GET-only composition; rendering is naturally idempotent.
8. Dead-letter / failure handling: **N/A** — on a failed read the view shows the standard per-panel error/empty state (overview error, "no active sprint" empty state); nothing to retry or dead-letter.
