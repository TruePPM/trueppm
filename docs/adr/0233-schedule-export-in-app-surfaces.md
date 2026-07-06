# ADR-0233: Schedule Export — In-App Surfaces (Entry Point, Options Dialog, Generation States)

## Status
Accepted

## Context
Epic #79 (schedule PDF export) is delivered in five children. #1436 (shared print
infra) and #1437 (Layout A one-page Gantt) are merged; the export pipeline
(`exportSchedulePdf`, `SchedulePrintLayout`, `buildSchedulePrintData`) already exists
and works. Today the **only** entry point is a single item buried in the schedule
toolbar's `···` overflow menu ("Export schedule as PDF") that runs with hard-coded
defaults (Letter paper, whole schedule, everything included) and reports progress only
through a docked `role="status"` line (web-rule 209).

#1438 turns that hidden action into a real feature: a dedicated **Export** toolbar
button, an **options dialog** (layout / paper / timeline range / include toggles), and
in-dialog **generation states** (generating with a cancelable progress bar → success
file card → error). It is **frontend-only** — no API, model, migration, or permission
surface. ADR-0188 already made the durability/rasterization decisions; this ADR extends
it with the control-panel UI, and must stay consistent with the *same* cancel + progress
contract rather than inventing a second one.

P3M layer: **Programs and Projects** (single project's schedule). OSS — a PM exporting
their own project's schedule is core adoption, no cross-program/governance surface. The
edition seam is the existing `scheduleExportEdition.ts` watermark (ADR-0188); this ADR
adds no new edition branch.

## Decision

### 1. Entry point — a dedicated secondary toolbar button, responsive by breakpoint
A new `ScheduleExportButton` (secondary style, download glyph + chevron) opens the
options dialog. The design's px tiers (≥1100 / 768–1100 / <768) map onto the app's three
real breakpoints (`useBreakpoint` → `lg` ≥1024 / `md` 768–1023 / `sm` <768):
- **`lg`**: standalone labelled "Export" button in the primary toolbar cluster (just
  before the `···` Project-actions menu).
- **`md`**: the standalone button is hidden; the export entry folds into the existing
  `···` Project-actions `ToolbarOverflowMenu` as an action item **that opens the dialog**
  (replacing the old one-click `export-pdf` item).
- **`sm`**: export is hidden entirely — a deck-style export is a desk task (matches the
  current `breakpoint !== 'sm'` guard and the board precedent).
- Keyboard shortcut **⌘⇧E / Ctrl+Shift+E** opens the dialog whenever export is available
  (md+), wired next to the existing schedule keyboard handling.
- **Disabled** only when the schedule is **empty** (no activities to plot). See §3 for
  why there is no viewer/role gate.

### 2. Options dialog — `ScheduleExportDialog`
A hand-rolled `role="dialog" aria-modal="true"` modal following the repo's canonical
recipe (there is no shared `Modal`; `CloseSprintDialog` is the closest "N options →
confirm" precedent, ADR-0052):
- `useFocusTrap(open, onClose)` on the panel (traps Tab, restores focus to the trigger,
  routes Escape to close — no second `document` Escape listener, per web-rule 204/206).
- Scrim `bg-neutral-overlay` (web-rule 8d) with `motion-safe:animate-scrim-fade`; panel
  `bg-neutral-surface border border-neutral-border rounded-card` with
  `motion-safe:animate-modal-scale-in` (web-rules 181/185). Click-outside-to-cancel via
  an `onPointerDown` target check.
- **Option controls** (native `<input type="radio">` in `<fieldset><legend>` groups so
  arrow-key roving + grouping come free — web-rule 167/175; styled as segmented pills for
  Paper/Range per web-rule 179's fill-not-color-alone active state):
  - **Layout** — `A — One-page Gantt` (default, enabled) · `B — Report` **disabled**
    with the rule-122 placeholder recipe (not `opacity-50`) + `title`/help "Available
    soon — 3-page report" and a `#1439` tracking reference. Shown so the dialog matches
    the design and signals the roadmap; #1439 flips it enabled and adds the renderer.
  - **Paper** — `Letter` / `A4` segmented (landscape fixed). Already plumbed end-to-end
    through `exportSchedulePdf`/`SchedulePrintLayout`.
  - **Timeline range** — `Full schedule` (default) / `Visible window`. See §4.
  - **Include** toggles (`role="switch"`) — Dependency arrows (on), Non-critical tasks
    (off ⇒ critical-path chain only), Critical-path summary box (on), Owner column (on).
- **Footer read-out**: live activity count (post-filter) + a coarse render-time estimate
  derived from that count (a pure `estimateRenderMs(count)` heuristic — no measurement).
- **Actions**: primary **Export PDF** (shared `Button variant="primary"`) / ghost
  **Cancel**. This is an *action* dialog, not an edit form, so it does **not** use the
  `DialogFooter`/`useDirtyForm` save-contract (web-rule 217's instant-action reading) —
  closing loses nothing of consequence; there is no dirty guard.

### 3. Options thread into the existing pipeline — one path, parameters not a fork
Per ADR-0188, options are parameters into the *same* render + `exportSchedulePdf`
helper, never a divergent path.
- **paper** → `exportSchedulePdf({ paper })` + `SchedulePrintLayout paper` (already wired).
- **Row-set filters** (timeline range, non-critical off) → applied **once upstream** in
  `buildSchedulePrintData` via new optional args `windowStart?`/`windowEnd?` and
  `criticalOnly?`. Filtering the `tasks` array there keeps `rows`, `links` (dangling
  endpoints already pruned), `kpis`, and `cpChain` mutually consistent — filtering inside
  `SchedulePrintLayout` would desync its positional `rowIndex`/arrow math.
- **Presentational includes** (arrows, owner column, CP-summary box) → new
  `SchedulePrintLayout` props `includeArrows` / `includeOwnerColumn` / `includeCpSummary`
  (all default `true`), gating the `<svg>` overlay, the owner header+badges (shrinking
  `LABEL_COL_PX` when off), and the existing `cpChain.length > 0` block respectively.

### 4. Visible-window range — no engine change
Derived where the dialog is opened, from already-public API + the DOM scroll ref
`ScheduleView` already holds:
`start = engine.scrollLeft`, `end = start + canvasScrollRef.current.clientWidth`,
`[windowStart, windowEnd] = [leftToDate(start, engine.scales), leftToDate(end, scales)]`.
Passed as `windowStart/windowEnd` into `buildSchedulePrintData` (§3). When the engine or
scales are unavailable (fallback table), the "Visible window" radio is disabled and the
export uses Full schedule.

### 5. Generation-state machine (in the same dialog)
`configuring → generating → (success | error)`; `Export again…` → `configuring`;
`Done`/`Cancel`/Escape → close.
- **generating**: spinner + a **determinate** bar fed by the existing `onProgress`
  (`{phase, done, total}`), phase-appropriate copy ("Rendering the schedule…" during
  `rasterize`; "Placing page N of M…" / `done`/`total` during `paginate`; "Finishing…"
  during `finalize`), reassurance line "Renders in your browser · nothing leaves the
  project", and a **Cancel** wired to an `AbortController` (aborts between bands, nothing
  saved — the existing `signal` contract).
- **success**: "PDF ready · download started" + a file card
  (filename · pages · paper · size from `ExportResult`). Actions **Export again…**
  (→ configuring), **Open in viewer** (`window.open(result.blobUrl)`), **Done**.
- **error**: a short machine-readable message + **Try again** (→ configuring). ADR-0188
  names `RASTER_TIMEOUT` (schedule too large for one rasterize pass) as a distinct
  failure; the error copy surfaces "the schedule may be too large to render in one pass"
  as the actionable hint.

`exportSchedulePdf` is extended to return an optional `blobUrl` in `ExportResult`: the
PDF blob is materialized **once** (reusing the `pdf.output('blob')` call that already
computes `byteSize`) to both trigger the download and back "Open in viewer"; the URL is
revoked on dialog close/unmount. In jsdom/tests `output('blob')` is absent, so `blobUrl`
is `null` and "Open in viewer" hides — no behavior change to the existing fast path.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Layout B: **disabled placeholder now (chosen)** | Dialog matches the imported design; roadmap visible; #1439 becomes a one-line enable + renderer | A disabled radio is inert until #1439 |
| Layout B: omit the Layout section until #1439 | No inert control | Diverges from design; #1439 must add the whole section + wiring; a single-option "Layout" reads oddly |
| Layout B: build the 3-page renderer here too | One complete feature | Balloons the MR; #1439 exists precisely to sequence it "after A" |
| Add a viewer/role export gate | Matches the design's literal "viewer without export permission" copy | No such gate exists today (Viewers can already export); adding one is a **behavior change / policy decision** out of #1438's scope — a PDF is a read-only printout of data the viewer already sees |
| Visible-window: add `engine.visibleDateRange()` | Cleaner API | Unnecessary — the window is derivable from existing public API + the DOM ref; a new engine method is scope this ADR doesn't need |
| Reuse `DialogFooter`/`useDirtyForm` | Shared primitive | Built for dirty-save edit forms; an export action has no persisted dirty state — force-fitting it is wrong (web-rule 217 instant-action carve-out) |

## Consequences
- **Easier**: the export is discoverable and configurable; the progress/cancel plumbing
  ADR-0188 pre-built is finally surfaced; #1439 (Layout B) drops in behind a ready radio;
  #1440 (week-boundary banding) reuses the same `bandWidthPx` seam and generating state.
- **Harder**: `SchedulePrintLayout` gains three `include*` branches and
  `buildSchedulePrintData` two filter args — more render permutations to test. Mitigated
  by keeping every filter upstream in the pure transform (unit-testable without a DOM).
- **Risks**: (a) the determinate bar is coarse for a one-page Layout A (one band → jumps
  0→1); acceptable, the reassurance copy carries the wait, and it becomes meaningful for
  wide/multi-band exports (#1440). (b) `blobUrl` leaks memory if not revoked — revoked on
  close/unmount. (c) "Visible window" clips to whatever is scrolled into view — the count
  read-out + the print masthead make the clip explicit so it is never a silent surprise.

## Implementation Notes
- P3M layer: Programs and Projects (single project schedule).
- Affected packages: **web** only.
- Migration required: **no**.
- API changes: **no**.
- OSS or Enterprise: **OSS** (`trueppm-suite`). No `trueppm_enterprise` import; edition
  seam unchanged (`scheduleExportEdition.ts`).

### Durable Execution
Pure client-side render; no server dispatch — the whole checklist is N/A, inherited from
ADR-0159/0188.
1. Broker-down behaviour: **N/A** — no async server work; the PDF is generated in-browser.
2. Drain task: **N/A** — nothing is enqueued.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: **N/A** — no dispatch path; the export helper is a pure client function.
5. API response on best-effort dispatch: **N/A** — no API call.
6. Outbox cleanup: **N/A** — no outbox.
7. Idempotency: **N/A** server-side. Client-side, re-export is inherently safe (a fresh
   render); the button/menu item is disabled while a generation is in flight so a second
   run can't overlap.
8. Dead-letter / failure handling: **N/A** server-side. A generation failure surfaces in
   the dialog's error state with a Try-again affordance; nothing is persisted, so re-run
   is the only (and sufficient) recovery — the ADR-0159/0188 stance.
