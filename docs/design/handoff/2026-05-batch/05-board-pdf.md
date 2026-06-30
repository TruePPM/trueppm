# #326 — Board PDF export (print stylesheet)

> ⚠️ **Superseded by [ADR-0159](../../../adr/0159-board-pdf-export-client-side.md).**
> #326 shipped with **client-side** rasterization (off-screen DS-token print
> layout → `html-to-image` + `jspdf`, paginated), **not** the WeasyPrint
> server render proposed below. The engine section is kept for historical
> context only. New PDF-export work (e.g. the schedule report, #79) follows
> the same ADR-0159 client-side pattern — see `packages/web/src/features/board/export/`.

## Engine

WeasyPrint — server-side rendering of a print HTML route. Constraints:

- ✅ Full CSS 2.1 + a chunk of CSS 3 (grid, flex, transforms, masks,
  custom properties, multi-col).
- ✅ `@page` rules, page-break-* properties.
- ❌ No JS execution. Layout must be expressible in static HTML+CSS at
  render time. (The server pre-renders a static board HTML snapshot.)
- ❌ No web fonts via `@font-face url(...)` from external CDNs (allowed
  but slow + flaky). Bundle Inter + JetBrains Mono in the print
  template assets.
- ❌ No CSS `position: sticky`.
- ⚠️ `gap` on flex/grid: supported, prefer it.
- ⚠️ `oklch()`: NOT supported in current WeasyPrint. Use hex or rgb()
  in the print stylesheet; do not let token files leak oklch into it.

## Page geometry

```css
@page {
  size: A4 landscape;        /* default; user-selectable in modal */
  margin: 12mm 14mm 16mm 14mm;
  @bottom-left  { content: "Artemis IV launch program"; font-size: 9pt; color: #6B6965; }
  @bottom-center{ content: counter(page) " / " counter(pages); font-size: 9pt; color: #6B6965; }
  @bottom-right { content: "Exported 2026-05-25"; font-size: 9pt; color: #6B6965; }
}

@page :first {
  @top-left { … board title block … }
}
```

User picks paper size (A4 / Letter) and orientation (landscape /
portrait) in the export modal. Default: A4 landscape — matches almost
every TruePPM board.

## Header / title block (first page only)

```
TruePPM · Artemis IV Launch Program
Board · Phase view                                       2026-05-25
──────────────────────────────────────────────────────────────────
```

Two lines, sans serif:
- Line 1: 18pt, `font-weight: 600`, neutral text primary.
- Line 2: 11pt, secondary text. Filter summary in mono if any filters
  are active: `Group: Sprint · Filter: assignee=Amelia`.

## Board layout in print

- Auto-fit columns to page width. If `columnCount * 180mm > pageWidth`,
  shrink each column proportionally to a minimum of 32mm; if columns
  would go below 32mm, **paginate columns left-to-right** across pages.
  (5 columns on landscape A4 fits at native size; 7+ columns paginate.)
- Lanes (rows) flow top-to-bottom. A lane that overflows the page
  paginates with its header repeating at the top of each continuation
  page via `tr-thead` pattern (use a CSS table or grid with
  `break-inside: avoid` on cards but allow lanes to break).
- Cards: `break-inside: avoid` (never split a card across pages).
- Card fields shown in print (locked):
  - Card ID (mono, secondary)
  - Title (bold)
  - Assignee name (no avatar in print — print is monochrome-friendly,
    avatars are noise)
  - Due date (mono) if set
  - Phase badge (text only, no color stripe in monochrome mode)
- Card fields hidden in print: descriptions, labels (too noisy),
  comments, blocker reasons (print stays at-a-glance).

## Monochrome mode

Modal has a "Print monochrome (better for B&W printers)" toggle. Off
by default. When on:
- Phase color stripes become `border-left: 2px solid #000;` with a
  small phase-letter inside (`E` for engineering, `P` for procurement).
- Status pills become `outline: 1px solid #000;` + text label.

## Empty columns

```
┌──────────────┐
│  Done        │
│  0           │
│              │
│   (italic)   │
│   empty      │
│              │
└──────────────┘
```

Empty columns still render so the structure is intact. `"empty"`
italic, secondary text, centered vertically.

## Pagination strategy summary

| Case | Strategy |
|---|---|
| Fits on 1 page | single-page layout, no col-pagination |
| 1 lane spans > 1 page | repeat lane header on continuation |
| > 7 columns at A4-landscape | columns paginate left→right; lane stays consistent across col-pages |
| > 7 columns AND > 1 page of lanes | matrix paginated: cols first, then lanes |

Add a small `"continued ▶"` / `"◀ continued"` indicator at the corner
of paginated lanes and columns so reviewers know there's more.

## Watermark line (footer)

If `licenseStatus !== 'licensed'`:
```
@page { @bottom-center { content: "Page " counter(page) " of " counter(pages) " · Unlicensed build — do not distribute"; } }
```

Use `--neutral-text-secondary` (#6B6965) at 9pt. NO diagonal watermark
across pages — too aggressive. Footer line is enough.

## Export trigger

Toolbar overflow → "Export PDF…" → opens a small modal:

```
┌───────────────────────────────────────┐
│  Export board as PDF                  │
│                                       │
│  Paper       ( A4 ▾ )                 │
│  Orientation ( Landscape ▾ )          │
│  ☐ Print monochrome                   │
│                                       │
│  Will produce ~3 pages.               │
│                                       │
│             [ Cancel ]  [ Export PDF ]│
└───────────────────────────────────────┘
```

The page-estimate is computed server-side via a quick layout pass and
returned as part of the prepare-export call. If the estimate fails or
takes > 800ms, the modal shows the controls without the estimate line.

## CSS skeleton (drop into the print route)

```css
@page { size: A4 landscape; margin: 12mm 14mm 16mm 14mm; ... }

html, body { background: #fff; color: #1A1917; font: 10pt/1.4 'Inter', sans-serif; }
.print-title { font-size: 18pt; font-weight: 600; }
.print-subtitle { font-size: 11pt; color: #6B6965; margin-bottom: 6mm; }

.print-board { display: grid; grid-template-columns: 32mm repeat(var(--cols), minmax(0, 1fr)); gap: 1mm; }
.print-lane-header { font-size: 10pt; font-weight: 600; padding: 2mm; border-bottom: 1px solid #D4D2CE; }
.print-col-header  { font-size: 9pt; font-weight: 600; padding: 2mm; border-bottom: 1px solid #D4D2CE; }
.print-card        { break-inside: avoid; border: 1px solid #D4D2CE; padding: 1.5mm 2mm; margin-bottom: 1.5mm; }
.print-card .id    { font-family: 'JetBrains Mono'; font-size: 8pt; color: #6B6965; }
.print-card .t     { font-size: 9pt; font-weight: 600; }
.print-card .meta  { font-size: 8pt; color: #6B6965; }
```

## Definition of done

- [ ] Renders a single-page PDF for boards that fit at A4-landscape.
- [ ] Paginates lanes correctly for tall boards.
- [ ] Paginates columns correctly for wide boards.
- [ ] Monochrome toggle works end-to-end.
- [ ] Watermark line appears in unlicensed builds only.
- [ ] No oklch / unsupported CSS leaks into the print stylesheet.
