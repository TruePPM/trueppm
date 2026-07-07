# ADR-0276: Row-aware, header-repeating pagination for the schedule PDF export

## Status
Accepted

## Context

The Schedule → **Export PDF** feature (ADR-0188, issues #1436/#1437/#1438/#1440)
rasterizes an off-screen `SchedulePrintLayout` (a "Layout A" one-page report:
masthead → 5-cell KPI strip → Gantt → legend → Critical-Path-Chain card → footer)
into a single tall bitmap, then slices that bitmap into landscape pages.

Two defects make the artifact read as "a web page printed to PDF" rather than a
professional report (issue #1694):

1. **Dependency connector lines are missing.** `SchedulePrintLayout` re-projects FS
   links as an SVG overlay — a stroked `<path>` connector + a filled `<polygon>`
   arrowhead. In the rasterized PDF only the arrowheads appear. **Root cause
   (confirmed empirically):** `html-to-image` silently drops **CSS-class `stroke`**
   on SVG `<path>` elements while it keeps class `fill` on `<polygon>` and honors
   `stroke` set via inline `style`/attribute. The connectors used `className="stroke-…"`
   (Tailwind) and vanished; the arrowheads used `fill-…` and survived. A one-line
   isolated repro: a class-stroke path rasterizes to 0 ink; an inline-style stroke
   path rasterizes fully.

2. **Pagination cuts content mid-block.** When the report is taller than one landscape
   page (a ~19-row schedule already overflows), `exportSchedulePdf`'s plain vertical
   path slices the bitmap at a fixed pixel height, cutting **through** Gantt rows, the
   Critical-Path-Chain table, and the footer — leaving a near-empty page 2 with a few
   stranded rows.

The user requires: page breaks fall only at safe boundaries (never through a Gantt row,
a CP-chain row, or the footer); when Gantt rows continue onto a page, the **Activity +
date-scale header** is repeated at the top; when the CP-chain continues, a **"Critical
Path Chain (Continued)"** header is repeated.

P3M layer: **Programs and Projects / Operations** — a per-project schedule artifact.
Pure OSS, pure client-side; no cross-program aggregation, no API/model/migration.

## Decision

**Keep the "rasterize the off-screen surface once → slice the bitmap" architecture**
(fast; a ~150-activity schedule stays well under the generation target — one rasterize,
N cheap canvas slices). Make the **vertical** slicing row-aware and header-repeating —
the vertical analog of the existing horizontal week-banding (#1440), which already
repeats the frozen left **label** strip on every column sheet.

Three parts:

### A. Arrow fix (settled)
Set the connector `stroke` and the arrowhead `fill` via inline
`style={{ stroke: 'rgb(var(--<token>))' }}` instead of Tailwind classes. This is
gate-safe (no hex literal; still single-sourced through the DS CSS variable) and is the
one form `html-to-image` reliably rasterizes. Per the ux-design pass, FS arrows become
**charcoal** (`--neutral-text-secondary`), hard vs. soft differentiated by **solid vs.
dashed** — not by color — matching the canvas renderer convention (ADR-0063 rule 75:
critical state is carried by the red *bar*, not the arrow; red arrows over red critical
bars merge).

### B. Vertical flow geometry (layout → rasterizer handoff)
The vertical block heights are **text-driven** (the masthead/KPI heights depend on
content), so they cannot be stamped as constants from React. Instead `SchedulePrintLayout`
tags its structural blocks with **`data-print-vmark`** markers — `gantt` (the whole
Gantt block), `gantt-rows` (the breakable rows band), `cp` (the CP card), `cp-list`
(the CP `<ol>`), `footer` (the keep-together sign-off strip) — plus two stamped row
counts on the root (`data-print-gantt-row-count`, `data-print-cp-row-count`). The
off-screen surface is mounted with real layout (`absolute -left-[99999px]`, never
`display:none`), so at export time the rasterizer **measures** each marker's
`getBoundingClientRect` relative to the root and derives, in source image px:

- `ganttHeader = { top: ganttTop, height: rowsTop − ganttTop }` — the repeatable
  Activity + date-scale band (measured, so any CSS change to the header is absorbed);
- `ganttRows = { top, bottom, rowH: height / ganttRowCount }`;
- `cp = { headerTop, rowsTop, rowsBottom, rowH: listHeight / ceil(cpRowCount / 2) }`
  (2-column grid), or null;
- `footerTop`.

Measurement (vs. stamping) means the geometry can never drift from the rendered
layout. In jsdom `getBoundingClientRect` is zero, so the reader returns null and the
plain bitmap-band path (with all its existing tests) runs unchanged. The existing flat
`data-print-*` band-geometry attributes (#1440) are untouched.

### C. Pure vertical planner (`scheduleVerticalPlan.ts`)
A React-free, unit-tested module. All math in **source-image px** (the rasterizer's
coordinate space), like `scheduleSheetPlan.ts`:

```ts
planVerticalPages({
  imageHeightPx,   // full bitmap height
  pageBodyPx,      // usable body height per page = pageH / scale (img px)
  vflow,           // the geometry above, ×PIXEL_RATIO into img px
}): VerticalPage[]

interface VerticalPage {
  sy: number;                 // source-y where this page's body slice begins
  sh: number;                 // body slice height
  header:                     // repeated header composited above the slice (or null on page 1)
    | null
    | { kind: 'gantt'; height: number; bandSy: number }  // band lifted from the bitmap
    | { kind: 'cp'; height: number };                    // blank band; text drawn by the rasterizer
}
```

Algorithm — **greedy over a safe-break list**:
1. Enumerate safe break offsets: every Gantt row boundary, the CP-card top, every
   CP-row boundary, the footer top, and the report end. (Never inside a row; footer is
   keep-together — its only interior breaks are its top and the report end.)
2. Page 1 body starts at 0; take the **largest break ≤ pageBodyPx**; emit `[0, break]`.
3. Each continuation page: the cursor's region decides the repeated header —
   - inside the Gantt rows region → repeat the Gantt header band; available =
     `pageBodyPx − ganttHeader.height`.
   - inside the CP rows region → repeat the CP header band with `continued: true`;
     available = `pageBodyPx − cp.headerH`.
   - otherwise (legend/gap/footer) → no header; available = `pageBodyPx`.
   Take the largest break ≤ `cursor + available`; emit. If no break fits (a single unit
   taller than a page — impossible at ROW_H≈22 vs a ~560px page body, but guarded),
   force-advance by `pageBodyPx`.
4. Repeat until the cursor reaches `imageHeightPx`.

`exportSchedulePdf` re-composites each page onto an offscreen canvas: the optional
repeated header on top, then the body slice below it; `pdf.addImage`. The two header
kinds are deliberately different — the **Gantt** header must be pixel-accurate (bars
align to their dates), so it is a bitmap band lifted from the source at
`bandSy..bandSy+height`; the **CP** header is just a list heading, so the compositor
reserves a blank band and stamps **"Critical Path Chain (Continued)"** as real
`pdf.text` (the same real-PDF-text mechanism as the "Sheet n of N" caption). A text
header is subtitle-free by construction — the "N activities drive the finish date"
summary stays on the first CP page only, as the ux-design pass specified. The
bottom-right caption reads **"Page n of N"** for the top-to-bottom report (the
horizontal "Sheet n of N" wording stays for the wide multi-column path).

### D. Composition with horizontal week-banding (#1440) — scoping call
The CP-chain card, legend, and footer sit **below** the chart at full report width —
they are not timeline content and are not horizontally bandable. Fully composing
row-aware vertical pagination × horizontal column banding × repeated-CP-continued
headers is a combinatorial layout problem with little real-world payoff (a schedule that
is *both* wider than a page *and* taller than a page is rare).

**Scope the new repeated-header vertical pagination to the single-column
(chart-fits-one-page-wide) case** — which is the reported bug and the overwhelmingly
common shape. The wide multi-column path (#1440) keeps its existing horizontal banding;
its vertical slicing is routed through the **same safe-break planner** so it no longer
cuts through rows either, but the CP "(Continued)" refinement and a perfect CP-in-wide
layout are **not** in scope (documented limitation; existing behavior otherwise
preserved). This keeps the new code focused, testable, and low-regression-risk.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Row-aware bitmap slicing + repeated headers (chosen)** | Keeps the fast one-rasterize pipeline; repeated headers are cheap canvas re-composites of an already-captured band; planner is pure + testable | A small layout engine to build and test; geometry handoff via a stamped attribute |
| B. Re-render the print surface per page (true paginated DOM) | "Real" page objects; arbitrary per-page chrome | N rasterizes instead of 1 (slower, against ADR-0188's one-rasterize principle); the surface would need page-break-aware React layout — much larger change |
| C. Scale the whole report to fit one page | Trivial | Illegible for any non-trivial schedule; a 19-row Gantt + KPIs + CP chain shrinks below the readability floor — the exact anti-pattern MIN_PRINT_PX_PER_DAY exists to avoid |
| D. Server-side PDF (headless render / reportlab) | Real paginated PDF, selectable text | New backend surface + infra; contradicts ADR-0188's deliberately client-side, offline-capable design; out of scope for a bug fix |

## Consequences

- **Easier:** the common report paginates cleanly with readable continuation pages;
  the geometry seam (`data-print-vflow` + pure planner) makes the pagination logic
  unit-testable without a browser; the arrow fix generalizes to any future
  SVG-stroke-in-a-rasterized-surface (documented gotcha).
- **Harder:** one more geometry contract between the layout and the rasterizer to keep
  in sync; the planner adds a module to maintain.
- **Risks:** geometry drift if `SchedulePrintLayout`'s block heights change without
  updating the stamped vflow — mitigated by deriving every stamped value from the same
  layout constants (ROW_H, HEADER_H, SHEET_PAD_PX) already used to render, and by a
  layout test asserting the stamped vflow matches the rendered structure. A wide+tall
  schedule keeps a known imperfect CP-chain layout (documented; follow-up issue if a
  user hits it).

## Implementation Notes
- P3M layer: Programs and Projects / Operations
- Affected packages: **web** only
- Migration required: no
- API changes: no (reads only already-loaded schedule state; no new endpoint)
- OSS or Enterprise: **OSS** — a per-project artifact, no cross-program aggregation

### Durable Execution
Pure client-side rasterization; no broker, no Celery, no async side effects.
1. Broker-down behaviour: **N/A** — no dispatch; the export runs entirely in the browser.
2. Drain task: **N/A** — no async work.
3. Orphan window: **N/A**.
4. Service layer: **N/A** — no server call; reads in-memory `Task[]`/`TaskLink[]`.
5. API response on best-effort dispatch: **N/A** — no API call.
6. Outbox cleanup: **N/A**.
7. Idempotency: **N/A** for server state. The export itself is deterministic — the same
   schedule state produces the same paginated artifact (the content fingerprint in the
   footer already pins this).
8. Dead-letter / failure handling: **N/A** server-side. A client rasterize failure
   surfaces the machine code in the #1438 dialog error state; nothing is persisted, so a
   retry is the only recovery (unchanged from ADR-0188).
