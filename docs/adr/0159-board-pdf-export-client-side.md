# ADR-0159: Board PDF Export (client-side, boardroom-clean single page)

## Status
Accepted

## Context
Executives and clients consume the board, not the tool. The VoC panel (2026-05-04,
board wishlist #13) surfaced a recurring ask: Janet (Exec Sponsor, 7) — *"a clean PDF
of the board state for the deck"*; Sarah (PM, 8) — *"share the board with a client
without portal access"*; Marcus (SM, 5) — *"evidence"*. Issue #326 tracks an
"Export PDF" action on the board toolbar that produces a print-quality, single-page
artifact: column headers, cards (title + assignee + due + key chips), swimlane labels,
and a footer (project name, timestamp, exporting user, active filter/saved-view name).

The issue's original proposal was **backend** generation (`GET .../board/export.pdf`
via WeasyPrint or headless Chromium). The repo already ships a **client-side** export
precedent: `packages/web/src/features/reports/BurnChart.tsx` exports PNG/PDF by
dynamically importing `html-to-image` (`toPng`) and `jspdf` (`addImage` / `save`).
Both `html-to-image` and `jspdf` are already direct dependencies of `packages/web`.

P3M layer: **Programs and Projects** — the board is a single-project artifact. OSS.

## Decision
Generate the PDF **client-side**, mirroring the `BurnChart` export helper. A dedicated,
off-screen **print layout** component renders the *already-loaded* board data (no extra
fetch) at a fixed print width; `html-to-image.toPng` rasterizes it and `jspdf` places
the image, paginating with `addPage()` when the rendered height exceeds one page.
The board's current saved view (filters/sort/density/collapsed swimlanes) is honored
implicitly because the print layout consumes the same in-memory, already-filtered card
set the live board renders from.

The community-edition watermark is composed through a tiny **extension-point seam** so
an Enterprise build can suppress it without forking the export code.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **Client-side (chosen)** — html-to-image + jspdf, reuse BurnChart pattern | No new dep; web-only (no endpoint, no RBAC/perf/migration surface); zero collision with in-flight backend branches; renders exactly what the user sees (filters/density honored for free); ships fast | Fidelity bound to the browser's render; very large boards rasterize to a tall image (mitigated by per-swimlane page breaks); no server-side scheduled delivery (explicitly deferred by the issue) |
| Backend WeasyPrint | Pixel-stable server render; reusable for future scheduled email | Heavy new dependency; must re-derive the filtered card set server-side (duplicate of board query logic); new endpoint → RBAC + perf + security gates; slower to land |
| Backend headless Chromium (Playwright) | Highest fidelity to the real DOM | Chromium in the API image is a large operational + supply-chain cost; overkill for a deck export |

## Consequences
- **Easier**: no API/migration/permission surface; the export honors the live filtered
  view with no server-side query duplication; reuses an established, tested pattern.
- **Harder**: pagination of very tall boards is a layout concern handled in the print
  component (page-break per swimlane), not free from the library.
- **Risks**: `html-to-image` can miss cross-origin images (avatars) — render assignee
  **initials**, not remote avatar `<img>`, in the print layout to keep rasterization
  deterministic and offline-safe. Permission is implicit: anyone who can view the board
  can screenshot it, so Viewer+ "export what you can see" introduces no new exposure.

## Implementation Notes
- P3M layer: Programs and Projects
- Affected packages: **web** only
- Migration required: **no**
- API changes: **no** (renders already-loaded board state in-browser)
- OSS or Enterprise: **OSS**

### Component structure (web)
- `features/board/export/BoardPrintLayout.tsx` — pure presentational, off-screen
  (`position: absolute; left: -99999px`), fixed print width (~1123px ≈ A4 landscape @
  96dpi). Renders swimlane groups → column headers → compact cards (title, assignee
  initials, due, status/blocker/points chips) + a footer band. No interactivity, no
  gradients, no editing affordances.
- `features/board/export/exportBoardPdf.ts` — the BurnChart-style helper: dynamic-import
  `html-to-image`/`jspdf`, `toPng(node, { pixelRatio: 2 })`, slice into A4-landscape
  pages via `addPage()`, `save('board-<project>-<date>.pdf')`.
- `features/board/export/boardExportEdition.ts` — the watermark seam (below).
- Toolbar: an "Export PDF" item in `features/board/CalmToolbar.tsx` (hidden `<768px`
  via the existing responsive utility), which mounts `BoardPrintLayout` and invokes the
  helper. Button disabled while a generation is in flight.

### Watermark / edition seam
`boardExportEdition.ts` exports `boardExportFooterWatermark(): string | null`. The OSS
implementation returns the community line (e.g. *"Generated with TruePPM Community"*).
The footer renders the string only when non-null. Enterprise overrides this module at
build time (same web extension-point convention as the settings `EnterpriseBadge`/edition
checks) to return `null`, suppressing the line. The seam is a single pure function — no
runtime enterprise import in OSS, preserving the Apache-2.0 one-way boundary.

### Pagination strategy
Render the full print layout once, measure, and slice the single tall PNG into
page-height bands in `exportBoardPdf.ts`; each band becomes a `jsPDF` page. Swimlane
group headers repeat with a "(continued)" suffix when a group spans a page boundary
(AC: "Phase 3 (continued)"). Target: <5s for a 200-card board (rasterize once, paginate
the bitmap — no per-page re-render).

### Durable Execution
1. Broker-down behaviour: **N/A** — pure client-side render, no server dispatch.
2. Drain task: **N/A** — no async server work.
3. Orphan window: **N/A**.
4. Service layer: **N/A** — web-only `exportBoardPdf.ts` helper, no API.
5. API response on best-effort dispatch: **N/A** — no API call.
6. Outbox cleanup: **N/A**.
7. Idempotency: **N/A** — export is a read-only, repeatable browser action with no
   server side effect; re-running simply produces another file.
8. Dead-letter / failure handling: a generation error surfaces a toast ("Couldn't
   generate the PDF — try again"); nothing is persisted, so retry is the only recovery.
