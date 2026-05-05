# TruePPM Web Frontend — Design Rules

These rules are enforced at review time. Violations block merge.

## Layout & Visual

1. **No drop shadows anywhere** — use `border border-neutral-border` for separation instead of `shadow-*`
2. **Sidebar collapse animation** — `transition-[width] duration-200 ease-out` on the sidebar element itself; do not animate `grid-template-columns`
3. **Bottom nav rail replaces view tabs at `< 768px`** — never show both simultaneously

## Accessibility (WCAG 2.1 AA)

4. **Focus rings on all interactive elements**: `focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1`
   - On `bg-brand-primary` surfaces (sidebar): use `focus-visible:ring-white focus-visible:ring-offset-brand-primary`
   - In dark mode on neutral surfaces: add `dark:focus-visible:ring-semantic-on-track` — `brand-primary` (#1C6B3A) is only 2.81:1 on dark surface (#12141E), failing WCAG 1.4.11. `semantic-on-track` (#4ADE80) achieves 5.28:1.
   - Never use `outline-none` without a visible replacement
5. **Touch targets** — minimum 44×44px at all breakpoints
6. **Color dots** (8px project color indicators) are always `aria-hidden="true"` — health state must also be conveyed via text or `aria-label`

## Color & Semantic Tokens

7. **Health state color encoding**:
   - On-track → `text-semantic-on-track` / `bg-semantic-on-track`
   - At-risk → `text-semantic-at-risk` / `bg-semantic-at-risk`
   - Critical → `text-semantic-critical` / `bg-semantic-critical`
   - Unknown → `text-neutral-text-disabled`
8. **No custom hex colors in components** — always use Design System tokens from `tailwind.config.ts`

8a. **`--chrome-*` tokens are for fixed UI furniture** (sidebar, Schedule task-list panel, TopBar) that follows the active theme. `--neutral-*` tokens are for page content surfaces. Use `bg-chrome-surface` on shell chrome, `bg-neutral-surface` on content areas. Both adapt with the `.dark` class on `<html>`. In dark mode `--chrome-surface` equals the legacy `gantt-surface` deep navy (#0F1117). Chrome tokens: `surface`, `surface-raised`, `border`, `text-primary`, `text-secondary`, `row-hover`, `row-active`, `grid`.

8b. **`--sem-*-bg` tokens are for badge pill fills and status cards** — `bg-semantic-critical-bg`, `bg-semantic-at-risk-bg`, `bg-semantic-on-track-bg`, `bg-semantic-warning-bg`. These are pre-computed RGBA values so they cannot be combined with Tailwind's opacity modifier. Always pair with the matching full semantic token for text/border (e.g. `border-semantic-at-risk/80 bg-semantic-at-risk-bg text-semantic-at-risk`).

8c. **`.tppm-mono` applies JetBrains Mono with tabular numerals** — use it on every numeric value: KPIs, percentages, dates, durations, counts, build hashes. It is defined as a Tailwind utility in `globals.css` and maps to `font-family: 'JetBrains Mono'; font-feature-settings: "tnum"`.

## Code Conventions

9. **No default exports** — all components use named exports
10. **No CSS-in-JS** — Tailwind utility classes only; use `style` prop only for dynamic values (e.g., CSS custom properties, inline widths derived from state)
11. **Stub hooks over mock network** — while real API hooks don't exist, return fixture data from the hook (`src/hooks/`). Components never import from `src/fixtures/` directly.
12. **Responsive breakpoints** (from `tailwind.config.ts`): `xs`=320px, `sm`=375px, `md`=768px, `lg`=1024px, `xl`=1280px, `2xl`=1440px

## Gantt-Specific Rules

13. **Gantt bar label text is `#1A1917`** (`neutral-text-primary`) — the Schedule view uses a light surface. Canvas bar label: `ctx.fillStyle = COLOR.text` from `GanttRenderer.ts`. SVAR CSS var: `--wx-gantt-task-color: #1a1917`.
14. **Gantt bar heights**: normal/critical/complete = 18px; summary = 8px; milestone diamond = 12px; baseline ghost = 6px.
15. **Task list row height**: 28px fixed — required for scroll sync with SVAR's internal row height.
16. **`readonly={true}` on `<Gantt>`** until WASM CPM drag (issue #19) is implemented — prevents partial drag UX.

## Monte Carlo Row Rules

17. **MC row height is 44px** — outside the virtualizer; does not participate in scroll sync (not 28px like task rows).
18. **No always-visible mini-histogram strip in the MC row** — the always-visible surface is chips-only (`P50 {date}` · `P80 {date}` · `P95 {date}`) plus a "Detail ›" hint. Real-world inputs without PERT estimates collapse to a single histogram bar that misleads more than it informs; the chips are the persona-aligned signal. Distribution shape lives only in the hover/focus tooltip (desktop) and the bottom-sheet (mobile).
19. **MC histogram SVG bars in the tooltip use `fill-neutral-text-disabled`** — distribution shape is neutral; semantic colours are reserved for the P50/P80/P95 vertical rule lines inside the tooltip. The same rule applies to the histogram inside `MonteCarloSheet` (mobile) and `MCResultPanel` (TopBar P80 click).
20. **P50 / P80 / P95 date chips are permanently visible** in the `MonteCarloTimeline` row — outlined style (`bg-transparent border border-{semantic}/40 text-{semantic}`), not fill. Hover or keyboard-focus opens the detailed histogram tooltip; chip text is the WCAG 1.4.1 fallback so colour is never the sole signal.
21. **P80 badge uses outlined style** — `bg-transparent border border-semantic-at-risk/40 text-semantic-at-risk`. Not `bg-semantic-at-risk/10` fill. Consistent with rule 39.
22. **MC row (`MonteCarloRow`) is `hidden md:flex`** — suppressed below 768px. The P80 badge in `TopBar` is `hidden md:flex` (desktop only). Mobile surfaces P80 via a chip in `StatusBar` (`md:hidden`) — resolved by issue #33. `MonteCarloLabel` is text-only (σ + "Monte Carlo") — the previous left-side P80 chip was a duplicate of the right-side P80 chip in the timeline and was VoC-flagged as noise.

22a. **MC row uses a browser-native `title`, not a custom popover.** The plain-English explanation (`"8 in 10 simulations finish by {date}"` for real distributions, `"Every simulation finished on {date}. Add PERT estimates …"` when percentiles collapse to one date) is carried by the `title` attribute on the row's static `div`, mirrored to `aria-label` for screen readers. The previous `mouseenter`-triggered popover opened on cursor pass-through and overlapped the unscheduled gutter sitting directly above; native `title` doesn't fire on transient hovers and never positions over adjacent elements. The full histogram lives in `MCResultPanel` (TopBar P80 click) and `MonteCarloSheet` (mobile) — surfaces where the user has explicitly asked for distribution shape.

22b. **MC chips use a colon separator** — `P50: Nov 30`, `P80: Nov 30`, `P95: Nov 30`. Consistent across `MonteCarloTimeline` and `MobileMonteCarloCard`. Never render the label and date with only a space.

## Drag Preview Rules (Issue #19)

23. **Preview bars use `ghost-fill` / `ghost-border` tokens** — slate-500 at 12% / 55% opacity. No ad-hoc rgba() in components; values are defined in `tailwind.config.ts` only. Applied via `style` prop (rule 10 — dynamic values).
24. **Call them "preview bars" in code and comments** — not "ghost bars". Baseline ghost bars (6px, rule 14) are a distinct concept; the naming must not collide.
25. **Critical preview bar: `ghost-border` → `semantic-critical` border only; fill stays `ghost-fill`** — a red fill on a provisional bar is alarming. Border alone signals critical-path flip.
26. **Critical-path flip requires a non-color signal** — a "CP" badge (min 400ms) must accompany the `semantic-critical` border change. Color alone fails WCAG 1.4.1.
27. **Preview overlay is `pointer-events-none aria-hidden="true"`** — never intercepts pointer events; all drag events route through SVAR.
28. **"Esc to cancel" label is mandatory during drag** — render a small `aria-hidden="true"` label adjacent to the dragged bar. Remove on pointerup or Escape.
29. **Offline guard before drop commit** — check `navigator.onLine` before PATCH. If offline: skip success animation, clear preview bars immediately, show toast "You're offline — change not saved."
30. **`aria-live` region is written via DOM ref, not React state** — prevents re-render storms on every pointermove event.
31. **MilestoneDeltaTooltip mounts at GanttView level** — not inside GanttTimeline, to escape `overflow:hidden`.
32. **Cap preview bars at 10** — show "+N more affected" count label for the remainder.
33. **Preview bars animate out only (150ms opacity, `motion-safe` only)** — they appear immediately; animation on entry causes flicker during fast drags.
34. **Keyboard drag alternative is a known WCAG 2.1.1 gap** — tracked in issue #34. Do not claim WCAG 2.1 AA conformance for the Gantt feature until #34 is resolved.

## UI Harmonization Rules (Issue #44)

35. **Sidebar background is `bg-chrome-surface`** — the adaptive chrome token (warm off-white in light mode, deep navy in dark mode via CSS custom properties). `bg-brand-primary` is reserved for interactive elements (buttons, focus rings, active accents) — never large-area backgrounds.

36. **Sidebar section headers** (`PROJECTS`, `ORG`) use `text-xs font-semibold tracking-widest uppercase text-chrome-text-secondary`. Minimum size is `text-xs` (12px) — `text-[10px]` is prohibited; fails WCAG 1.4.3. They are `<h2>` elements with `aria-label` matching the visible text. Hidden when sidebar is collapsed.

37. **Sidebar active-row indicator** is a 2px left border (`border-l-2 border-brand-primary`) in addition to `bg-brand-primary/10`. The border is the primary non-color visual signal; background fill is secondary. Never use border alone without the fill.

38. **ViewTabs active state uses underline** — `border-b-2 border-brand-primary` — not pill/outlined. Pill style is reserved for the secondary Gantt toolbar (rule 42) to maintain a clear visual hierarchy between top-level navigation and sub-view options. If a pill border is ever used for tabs, it must meet WCAG 1.4.11 3:1 against `bg-neutral-surface`; `border-neutral-border` (#D4D2CE) fails at ~1.51:1.

39. **TopBar status badges use outlined style** — `bg-transparent border border-{semantic-color}/40 rounded px-2 py-0.5 text-xs`. Badge labels include the full semantic word: `{n} at risk`, `{n} critical`, `P80: {date}`. Labels must also specify scope (tasks vs. projects) — ambiguous counts are a PMO compliance risk. `aria-label="{n} at risk tasks"` or `"{n} critical tasks"`. At-risk and critical badges are `<button aria-haspopup="menu">` elements — NOT `listbox` (listbox implies selection, not navigation). They open a `role="menu"` popover with `role="menuitem"` task entries.

40. **Schedule view adapts to color scheme** — in light mode the task-list panel and canvas use `bg-neutral-surface` (#FFFFFF); in dark mode they use the dark surface (#12141E). The canvas renderer switches palettes via `setRendererColorMode(isDark)` called from `GanttEngineImpl` before each paint pass. `CanvasGanttTimeline` derives `isDark` from `useThemeStore` and passes it to `useGanttEngine`. `COLOR` (light) and `COLOR_DARK` (dark) palettes in `GanttRenderer.ts` are the canonical color sources; no hex literals in component files.

42. **GanttToolbar view-switcher** (Gantt · WBS · Table) uses `role="group" aria-label="View mode"` with `aria-pressed` on the active item. Action buttons (+ Task · Baseline · Monte Carlo) are plain `type="button"` elements. All toolbar buttons: `border border-neutral-border rounded h-7 px-3 text-xs font-medium`. WBS and Table render as `disabled aria-disabled="true"` until their panels are implemented.

43. **Gantt column layout** — the task list has five resizable columns: **Task** (name + WBS indent), **Dur** (duration in days, e.g. `14d`), **Start** (early start, e.g. `Apr 9`), **Finish** (early finish, e.g. `Apr 21`), **%** (progress, text only — no mini bar). Column widths are persisted in localStorage under `trueppm.gantt.columnWidths.v4`. Default widths: task=220, dur=52, start=74, finish=74, progress=44. Full-height `border-r border-neutral-border/20` dividers appear on Task, Dur, Start, and Finish columns; the header resize-handle indicator is right-aligned within its hit zone to align with the row borders. Dur/Start/Finish/% visibility is persisted in localStorage under `trueppm.gantt.columnVisibility.v1` and toggled via the Columns popover in the toolbar.

44. **StatusBar layout** (issue #201 — overrides the old Gantt-legend footer design): 24px height, `bg-neutral-surface-sunken border-t border-neutral-border`, `hidden md:flex`. Three regions left-to-right: (1) live dot (`bg-semantic-on-track`) + `Live · {N} online` count from `useProjectPresence`; (2) `build {sha}` in `.tppm-mono` from the `__BUILD_SHA__` compile-time constant; (3) spacer + status note `{project.name} · {activeView}` in `.tppm-mono`. Hidden on Login (not inside AppShell) and on viewports < 768px.

45. **StatusBar text size is `text-[11px]`** — this is a deliberate override of the 12px floor (rule 50) for the status bar only. 11px matches the design spec for this single component; do not apply `text-[11px]` elsewhere. The exception is documented here because the design system floor is 12px everywhere else.

46. **Focus rings in the Schedule view** use `focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface` — same as the global rule 4 pattern. No special dark-surface override needed.

47. **Monte Carlo row is role-gated** — hidden for the Contributor RBAC role; visible for PM, Resource Manager, PMO Director, and Executive roles. Use a role-check hook (`useCurrentUserRole()`) to gate the `MonteCarloRow` render, not CSS visibility. Contributor-role users must not see P50/P80/P95 terminology without context.

48. **Export / print mode** — the Schedule view already uses a light surface; no theme override is needed for PDF/PNG export. Ensure `@media print` does not introduce dark backgrounds from browser defaults.

49. **Critical-path red requires a plain-English tooltip** — `title="This task is on the critical path — a delay here delays the project end date"` on every red task row. Color alone (WCAG 1.4.1) and a legend entry are insufficient for first-time users; the tooltip is the accessible fallback.

50. **`text-[10px]` is prohibited** — the design system floor is `text-xs` (12px). Arbitrary size values below 12px bypass the token ladder and introduce WCAG 1.4.3 failures on any surface. Exception: `text-[11px]` is permitted in the global StatusBar only (rule 45 documents the rationale).

## Keyboard Reschedule Rules (Issue #34)

51. **Keyboard instruction strip is mandatory during keyboard reschedule** — render
    `"← → Shift+arrow · d date · Enter confirm · Esc cancel"` in the `PreviewOverlay`
    instruction strip when `isKeyboardMode` is `true`. The mouse-drag strip `"Esc to cancel"`
    must remain unchanged (rule 28). Both are `aria-hidden="true"` — the assertive aria-live
    region (rule 53) carries the accessible equivalent.

52. **Origin ghost bar is required during keyboard reschedule** — show a dashed 2px
    `ghost-border` outline bar at the task's pre-nudge start/finish position so the user
    has a spatial reference point. Uses `OriginBar` in `PreviewOverlay`; only visible when
    `isKeyboardMode` is `true` (SVAR renders its own drag shadow for pointer drags).
    Fill is `transparent`; no CP badge; no label. Bar height follows rule 14 (18px).

53. **Assertive aria-live region is required for keyboard reschedule** — a second
    `aria-live="assertive"` region (`ariaAssertiveRef` in `GanttView`) must announce each
    nudge immediately: `"{N} working day{s} later/earlier"` or `"Back to original start date"`.
    Confirm announces `"Reschedule confirmed."`, cancel announces `"Reschedule cancelled."`,
    mode-entry announces the task name and key legend. The existing polite region
    (`ariaLiveRef`) continues to handle milestone slip messages. Never merge assertive and
    polite into one region — the polite queue delay makes nudge feedback unintelligible.

## Canvas Renderer Rules (feat/gantt-canvas-renderer)

> These rules govern the purpose-built canvas Gantt renderer that replaces
> @svar-ui/react-gantt. SVAR-specific rules (16, 15's "scroll sync with SVAR",
> 27's "route through SVAR") are superseded by the rules below for any code
> inside `src/features/gantt/engine/` or that imports from it.

### Architecture

54. **`GanttEngine` is the sole integration boundary** — `GanttView`, `useDragCpm`,
    `useKeyboardReschedule`, `PreviewOverlay`, and `MonteCarloTimeline` hold a
    `GanttEngine | null` reference and nothing else. No component may import from
    `GanttEngineImpl` or any engine sub-module directly — only through
    `src/features/gantt/engine/index.ts`. Violations break the stable API contract.

55. **`GanttEngine.on()` always returns an unsubscribe function — always call it.**
    Every `engine.on(event, handler)` call must be paired with the returned teardown
    in a `useEffect` cleanup. Do not use `engine.on()` outside of a `useEffect`.
    This fixes the SVAR `intercept()` memory leak (handlers accumulated on remount).

56. **`GanttScaleData` is the canonical coordinate system** — `dateToLeft`,
    `leftToDate`, and `parseUTCDate` from `engine/GanttScaleData.ts` are the only
    permitted coordinate utilities. Do not use SVAR's `scales.diff()`, the old
    `dateFromCanvasLeft`, or any millisecond-approximation math. The new functions
    are DST-safe (UTC-only arithmetic).

57. **`dateToLeft` returns canvas-origin coordinates** — the result is px from the
    canvas x=0 origin, not viewport-relative. Subtract `engine.scrollLeft` when
    positioning DOM overlay elements (e.g. `PreviewOverlay`, `MilestoneDeltaTooltip`).
    Pass canvas-origin coordinates directly to CPM workers and drag event handlers.

58. **`GanttEngineStub` is the only permitted test double for `GanttEngine`** — do not
    hand-roll mock objects with `{ on: vi.fn(), scales: null, ... }`. The stub is a
    typed class that will fail to compile if the interface changes, surfacing test
    staleness immediately.

### Canvas Rendering

59. **Three-layer canvas stack — one responsibility each:**
    - `canvas-bg` (z-index 0): row bands, grid lines, today line, weekend shading. Rarely repaints.
    - `canvas-bars` (z-index 1): task bars, dependency arrows, float bars, baseline ghosts. Dirty-rect per row.
    - `canvas-interaction` (z-index 2): active drag shadow, resize highlight, link-creation preview. Cleared completely between frames.
    Never draw task bar content on `canvas-bg` or interaction chrome on `canvas-bars`.

60. **Dirty-rect invalidation — never full-repaint during drag.** On each drag-move
    only the dragged row and the rows containing CPM preview results are invalidated.
    A 500-task project must repaint ≤ 11 rows per frame during a typical drag.
    Full repaints are only permitted on: zoom change, scroll > 1 viewport width,
    window resize, baseline mode toggle.

61. **Row virtualisation is mandatory — always.** The renderer only paints rows
    whose `top` falls within `[scrollTop - overscan, scrollTop + viewportHeight + overscan]`
    where `overscan = 5 rows`. This must hold from the first commit — never paint
    all rows and optimise later. Phase 1 (≤500 tasks) and Phase 2 (2,000 tasks)
    use the same virtualisation path.

62. **`devicePixelRatio` scaling is applied once at canvas init and on `ResizeObserver`.**
    All logical coordinates (bar positions, hit zones, font sizes) use logical pixels.
    The canvas backing store is scaled by `window.devicePixelRatio`. Never scale
    individual draw calls — scale the context once via `ctx.scale(dpr, dpr)`.

63. **Hit testing uses a spatial index — never per-pixel color mapping.**
    The `HitIndex` array is indexed by `rowIndex` and rebuilt on data change or
    zoom change (O(n), < 1ms for 2,000 tasks). Hit zones per row:
    - Bar body: `[barLeft, barRight]` × `[barTop, barBottom]`
    - Resize handle: `[barRight - 8, barRight + 4]` logical px (expand to 20px on touch)
    - Link-dot: `[barRight + 4, barRight + 16]` × full row height (expand to 44px on touch)

### Interaction

64. **Drag FSM has 5 states: IDLE → HOVER_WAIT → DRAG_STARTED → DRAGGING → DROP/CANCELLED.**
    The 4px movement threshold between HOVER_WAIT and DRAG_STARTED prevents
    accidental drags on clicks and tap-and-hold on iPad. `setPointerCapture` is
    called at DRAG_STARTED to ensure `pointermove` fires outside the canvas.

65. **Snap-to-day is applied inside the renderer before emitting `drag-task-move`.**
    The `left` value in the event payload is always snapped to the nearest UTC
    midnight boundary. Holding Shift suspends snap (free-drag). `useDragCpm` must
    not snap independently — do not double-snap.

66. **Use the Pointer Events API throughout — not Mouse Events or Touch Events.**
    `touch-action: none` on all canvas elements. Pinch-to-zoom is handled via two
    simultaneous active pointers (pointer span delta). This unifies mouse and touch
    without branching.

### Accessibility

67. **`GanttAriaOverlay` is mandatory — canvas is `aria-hidden="true"`.**
    A transparent DOM layer (`position: absolute; inset: 0; pointer-events: none`)
    provides the WCAG 2.1 grid structure over the canvas. Structure:
    `role="grid"` > `role="row"` > `role="gridcell"`. The overlay is virtualised
    to match the canvas render window. Canvas elements have no ARIA attributes.

68. **ARIA grid uses roving tabindex.** The focused `gridcell` has `tabIndex={0}`;
    all others have `tabIndex={-1}`. When the focused row scrolls out of the
    virtualised window, `engine.scrollToDate()` is called before `.focus()`.
    Keyboard navigation (ArrowUp/Down, Enter, Space) is handled in the overlay
    component, not in the canvas event listeners.

69. **`buildTaskAriaLabel(task)` format is canonical:**
    `"{name}, {durationDays} days, starts {start}, finishes {finish}, {CP status}"`
    e.g. `"Design sprint, 10 days, starts Apr 7, finishes Apr 18, on the critical path"`.
    Used as `aria-label` on the focused gridcell. The canvas bar is `aria-hidden`.

70. **`prefers-reduced-motion` is evaluated at engine init and on media query change.**
    When true: disable the today-line pulse, CP-flip animation, preview-bar fade,
    scroll-to-date smooth behavior. Functionality is never disabled — only motion.

### Visual Design (Canvas)

71. **Canvas font is `"12px Inter, system-ui, sans-serif"`** — set once at engine
    init, not per draw call. Must match Tailwind's `font-sans` stack so canvas
    labels are visually identical to the task list text. `ctx.font` is a global
    state — reset it after any draw call that changes it.

72. **Bar label text uses `COLOR.text` (`#1A1917`)** — `neutral-text-primary` on the light canvas surface. Set via `ctx.fillStyle = COLOR.text`. All color values live in the `COLOR` constant in `GanttRenderer.ts`; never use hex literals in draw functions.

73. **Critical path bars use `COLOR.barCritical` (`#B91C1C`)** — `semantic-critical` on light surface. Complete bars use `COLOR.barComplete` (`#166534`) — `semantic-on-track`. Both values are defined once in `GanttRenderer.ts`; update there only.

74. **Non-working day shading uses `rgba(0,0,0,0.03)`** — a very subtle dark overlay on weekend columns on the light canvas. Applied on `canvas-bg`, not recalculated during drag.

75. **Dependency arrows are cubic Bézier curves** with control points offset 40px
    horizontally from the source and target bar endpoints. FS arrows emerge from
    the bar right edge and enter the next bar left edge. Critical-path arrows use
    `COLOR.arrowCritical` (`#B91C1C`); non-critical use `COLOR.arrowNormal`
    (`rgba(107,105,101,0.6)`). Arrow line width: 1.5px logical px.

### Performance

76. **Performance budget (enforced in CI visual regression):**
    - First render of 2,000 tasks: < 200ms
    - Frame budget during drag (500 tasks): < 16ms (60fps)
    - Zoom level change: < 100ms
    - Smooth scroll at 60fps with no dropped frames
    Any PR that regresses these targets must include a profiler screenshot.

77. **`TaskSoA` (Structure of Arrays) is required at 10,000+ tasks (Phase 3).**
    For Phase 1–2 (≤ 2,000 tasks), a plain `Task[]` array is acceptable.
    Do not introduce SoA prematurely — the abstraction cost is not justified
    below 10k tasks.

78. **Empty state on zero tasks** — `GanttEmptyState` component renders when
    `tasks.length === 0`. Uses `bg-neutral-surface` and `role="status"`
    so screen readers are informed. Never render the canvas stack with no tasks.

79. **Engine init failure fallback** — `GanttFallbackTable` renders a plain `<table>`
    when `canvas.getContext('2d')` returns null (e.g. headless test environments or
    very old browsers). Shown instead of the canvas timeline; not a degraded mode —
    all task data is accessible. Check support once at startup, not per frame.

80. **Zoom preserves center date** — when `engine.setZoom()` is called, the engine
    computes the canvas-origin coordinate of the viewport center before zoom and
    calls `container.scrollLeft` to restore it after `scales-change`. The visible
    date range shifts symmetrically around the user's current view midpoint.

81. **Initial viewport: today at 25% from left** — on engine `ready` event, set
    `container.scrollLeft` so today's date lands at 25% of the viewport width from
    the left edge. Provides immediate context without centering (which would hide
    near-term tasks).

82. **"Today" button in toolbar** — a `type="button"` element with the same style
    as ZoomControl buttons (rule 42): `border border-neutral-border rounded h-7 px-3
    text-xs font-medium`. Calls `engine.scrollToDate(todayIso, 'smooth')` (or
    `'instant'` when `prefers-reduced-motion` is active, rule 70). Placed to the
    left of the ZoomControl in the toolbar.

83. **Selection visual** — in the canvas bars layer: a 2px `COLOR.selectionRing` (`#1C6B3A`) inset stroke ring is drawn after the bar fill using `ctx.save()/restore()` (rule 59, canvas-bars layer only). In the task list row: `bg-brand-primary/10 border-l-2 border-brand-primary` on the selected row. Selection state is read from `engine.selectedTaskIds` (immutable Set) — never duplicated in local component state.

84. **Cursor states on canvas-interaction** — `ixCanvas.style.cursor` is set by
    `GanttEngineImpl._updateCursor()` based on FSM state and hit zone type:
    `grab` over bar body, `col-resize` over resize handle, `crosshair` over
    link-dot, `grabbing` during active drag, `default` otherwise. Never set
    cursor on bg or bars canvas layers.

85. **Resize handle indicator** — when hovering over a resize handle hit zone, a 1px
    vertical line is drawn on canvas-interaction at `barRight - 4` px, spanning the
    full bar height (`BAR_TOP_OFFSET` to `BAR_TOP_OFFSET + BAR_HEIGHT`). Color:
    `COLOR.textSecondary` (`#6B6965`). This meets WCAG 1.4.11 (3:1 against `neutral-surface`). Drawn by `drawResizeIndicator()` in GanttRenderer.ts.

## Risk Register Rules

86. **Risk severity color mapping** — always use these token pairs for severity labels and chips.
    Never use ad-hoc colors. All combinations achieve WCAG 4.5:1 on `neutral-surface` (#FFFFFF).
    Dark mode alternates are required — `bg-brand-accent-light` (#FFF3CD) is white and flashes in dark mode.
    Light → Dark overrides:
    - CRITICAL (20–25): `text-semantic-critical bg-semantic-critical/10` (semantic tokens adapt automatically via CSS vars)
    - HIGH (12–19): `text-brand-accent-dark dark:text-brand-accent bg-brand-accent-light dark:bg-brand-accent/20`
    - MEDIUM (6–11): `text-neutral-text-primary bg-brand-accent-light/50` (neutral tokens adapt via CSS vars)
    - LOW (2–5): `text-neutral-text-secondary bg-neutral-surface-raised` (neutral tokens adapt via CSS vars)
    - MINIMAL (1): `text-neutral-text-secondary bg-neutral-surface-sunken` (neutral tokens adapt via CSS vars)
    The severity chip is read-only in the UI — always computed from `probability × impact`.

87. **`text-neutral-text-disabled` on `bg-neutral-surface-sunken` is prohibited** — this
    combination yields 1.97:1 contrast, failing WCAG 1.4.3 on all text sizes. MINIMAL severity
    labels must use `text-neutral-text-secondary` (#6B6965, 3.12:1 on #EBEBEB) at minimum.
    This prohibition applies everywhere in the app, not only to risk register.

88. **Risk matrix zone tokens live in `tailwind.config.ts` under `colors.risk`** — no hex
    literals inside `RiskMatrix.tsx` or `RiskMatrixCell.tsx`. Tokens reference CSS custom
    properties defined in `globals.css` so dark mode automatically swaps to higher-opacity
    values that remain legible on dark surfaces. Light / dark values:
    ```
    risk.zone-critical: rgba(185,28,28,0.08)   /  rgba(248,113,113,0.28)
    risk.zone-high:     rgba(232,160,32,0.12)  /  rgba(251,146,60,0.22)
    risk.zone-medium:   rgba(232,160,32,0.06)  /  rgba(251,191,36,0.16)
    risk.zone-low:      rgb(245,245,240)        /  rgba(74,222,128,0.22)
    risk.zone-minimal:  rgb(255,255,255)        /  rgba(74,222,128,0.08)
    ```

89. **Risk detail opens as a drawer (desktop) / bottom sheet (mobile) — not a modal** —
    a drawer keeps the risk list visible while a user references WBS numbers to fill in
    linked tasks. A full-screen modal blocks this context. On mobile (< 768px), use a
    bottom sheet (85vh, drag handle, `role="dialog" aria-modal="true"`). On desktop
    (≥ 768px), use a right-side slide-in drawer (480px wide).

90. **Mobile "Add Risk" entry point is a FAB** — `fixed bottom-16 right-4 w-14 h-14 rounded-full
    bg-brand-primary`. Positioned above the BottomNav rail. Uses `border border-brand-primary-dark`
    for elevation affordance (no drop shadow, per rule 1). The FAB opens the bottom sheet.
    Tap count to save a minimal risk must be ≤ 4 taps + typing.

## Resource Utilization View Rules (Issue #22)

91. **Cell display is load % bars — not task bars.** Each cell in the resource grid shows a
    single filled bar representing load as a percentage of capacity. Task bars (mini) are not
    the default; they may only appear in a drill-down tooltip. Color thresholds:
    - Green (`semantic-on-track`): load < 85% of capacity
    - Amber (`semantic-at-risk`): 85% ≤ load ≤ 100%
    - Red (`semantic-critical`): load > 100% (overallocated)
    Never invert this color scheme. Red must mean overallocation without exception.

92. **Capacity baseline is `resource.calendar.hours_per_day` — never a fixed 8h/day global.**
    The API returns actual hours computed from the resource's own calendar. The UI divides
    `day.hours / resource_calendar_hours_per_day` to compute the fill percentage. Part-time
    workers (e.g. 6 h/day) must show 100% at 6 h, not at 8 h. Never hard-code 8 as the
    denominator. If `resource.calendar` is null, fall back to `project.calendar.hours_per_day`,
    then to 8.0 as a last resort — in that priority order.

93. **Default date range is rolling ±4 weeks from today.** On first render, `window_start` =
    Monday of (today − 4 weeks) and `window_end` = Sunday of (today + 4 weeks). A
    **"Fit to project"** button in the toolbar resets the range to
    `[project.start_date, max(task.early_finish)]`. After "Fit to project" is clicked,
    the button label changes to "Reset to today" until the user navigates away.

94. **Permission gate: ResourceView is only rendered for SCHEDULER (role ≥ 2) and above.**
    Team Member (MEMBER, role=1) and Viewer (role=0) must see `PermissionDeniedNotice`
    instead of the grid. Gate via `useCurrentUserRole()` on the client side; the API
    enforces the same gate server-side (HTTP 403). Never render the grid for lower roles
    even if the API call happens to return 200.

95. **409 "schedule not run" state renders `ResourceEmptyState` with a scheduler CTA.**
    When the API returns HTTP 409, show the empty-state component with the message
    "Run the scheduler to see resource utilization" and a "Run Scheduler" button that
    triggers a CPM recalculation. Do not show a generic error toast for 409.

96. **`calendar_differs_from_project` flag triggers a tooltip on the resource name.**
    When `resource.calendar_differs_from_project === true`, render a `ⓘ` icon next to
    the resource name. The `CalendarMismatchTooltip` reads: "This resource uses a different
    calendar than the project. Load is computed from the resource's calendar." Never
    suppress this flag silently.

97. **Column headers are week labels (Mon DD MMM), not individual day labels.** The grid
    groups days into ISO weeks. Each column header shows the Monday of that week formatted
    as `"Mon 2 Mar"`. Individual day cells are 32px wide; the week header spans 7 × 32px.
    Weekends are rendered at 50% opacity — they are never working days in the default
    calendar but are shown for date continuity.

98. **Resource rows are sorted alphabetically by `resource_name`.** The API returns them
    pre-sorted; the frontend must not re-sort. Unassigned task count (`unassigned_task_count`)
    is displayed in the toolbar as `"{N} task(s) without resource assignment"` in
    `text-semantic-at-risk` when N > 0, hidden when N = 0.

99. **Load tooltip on cell hover shows hours + task list.** Hovering any cell with load > 0
    opens `LoadTooltip` containing: total hours for that day, capacity hours, percentage,
    and a bulleted list of task names contributing to the load. The tooltip is positioned
    above the cell and uses `role="tooltip"` with `aria-describedby` wiring. It must
    dismiss on `Escape` and on pointer-leave.

100. **ResourceGrid uses CSS Grid, not canvas.** Unlike the Gantt (rule 59), the resource
     grid is a standard HTML/CSS layout: `display: grid` with `grid-template-columns`
     driven by the date window. Row virtualization is not required for the initial
     implementation (projects have ≤ 50 resources). Do not apply canvas-rendering rules
     (rules 59–85) to the resource grid.

## Board / Kanban View Rules (Issue #21)

101. **Board column header style** — same token as Sidebar section headers (rule 36):
     `text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary`.
     Column count badge: `ml-2 text-neutral-text-disabled`. Column headers are `<h2>`
     elements with `aria-label` matching the visible text (e.g. `aria-label="In Progress, 12 tasks"`).

102. **Board card elevation** — `bg-neutral-surface border border-neutral-border rounded-md p-3`.
     No shadow (rule 1). Drag-lifted state: `ring-2 ring-brand-primary opacity-60 scale-105`
     with `motion-safe:rotate-1`. The original slot shows a dashed placeholder of equal height
     (`border-2 border-dashed border-neutral-border rounded-md`). Never animate the card on entry —
     only the lifted (drag) and snap-back (error) states animate.

103. **Board drag-over target** — `bg-brand-primary/5` fill + `border-l-2 border-brand-primary`
     on the column container during an active drag. Applied on `pointerenter` over the column drop
     zone; removed on `pointerleave` and `pointerup`. Never highlight the source column while a
     drag is in progress.

104. **Mobile board uses horizontal snap scroll** — `scroll-snap-type: x mandatory` on the board
     container; each column `scroll-snap-align: start`; column width `85vw`. A dot-strip indicator
     (`role="tablist"` with one `role="tab"` per column, `aria-selected` on the visible column)
     sits below the board and updates on scroll. Never use a column-picker dropdown on mobile — it
     hides spatial context. The mobile FAB creates a task in the currently-visible column's status,
     following the same pattern as the Risk Register FAB (rule 90).

105. **Board keyboard move alternative is mandatory** — drag-and-drop is not keyboard accessible
     (known WCAG 2.1.1 gap, parallel to Gantt rule 34). Every card's `···` overflow menu **must**
     include a "Move to…" item that opens a submenu listing the other columns. Arrow keys
     navigate the submenu; Enter commits. An `aria-live="polite"` region announces the result:
     `"{task name} moved to {column name}"`. This is not optional — it is the only keyboard path
     to change task status from the board.

106. **5-column board model** (issue #178) — the canonical status set is `BACKLOG | NOT_STARTED | IN_PROGRESS | REVIEW | COMPLETE`. `ON_HOLD` is a legacy value kept for data compatibility; it must never appear as a column in new board configs. The `_CANONICAL_STATUSES` frozenset in `serializers.py` is the authoritative list.

107. **Board card readiness states** (issue #179) — every `BoardCard` renders a `ReadinessChip` when `task.readiness` is present. Four states:
     - `idea`: no assignee — dashed-border chip, italic task name, `?` avatar circle, no progress ring, no accent bar
     - `estimated`: has owner — neutral chip with dot prefix
     - `ready`: has owner + predecessor links — brand-primary chip with ⛓ icon
     - `baselined`: in active baseline — neutral chip with 🔒 icon, accent bar uses `semantic-on-track`
     The left accent bar follows readiness, overridden by `isCritical` (→ `semantic-critical`). Absent `readiness` field → no chip rendered (backwards compat with pre-#179 API responses).

## Shell Navigation Rules (Issues #204–#205)

108. **Canonical view tab order is `Overview · Board · Schedule · WBS · Table · Calendar · Team · Risks`** (issue #204, updated per VoC review 2026-04-29). Overview is first — it is the canonical landing/orientation surface (ADR-0030). Board is second — the execution surface. The route segment for the Schedule view is `/schedule`. Never change this order without a design review. `ViewTabs.tsx` is the source of truth. The mobile `BottomNav` mirrors this order and omits Risks (infrequent on mobile).

109. **TopBar status pills collapse below 1024px (`lg:`)** (issue #205). At `lg+` viewports: P80 pill, at-risk badge, and critical badge render individually (`hidden lg:flex`). Below `lg:`: all three collapse into a single `HealthDropdown` button (`lg:hidden`) that expands a `role="menu"` listing the task items. The `HealthDropdown` renders nothing when there are no health signals. P80 pill is a `<button>` that opens the MC distribution panel (issue #196, shipped in wave/2-board).
