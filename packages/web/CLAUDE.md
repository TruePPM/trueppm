# TruePPM Web Frontend — Design Rules

These rules are enforced at review time. Violations block merge.

## Layout & Visual

1. **No drop shadows anywhere** — use `border border-neutral-border` for separation instead of `shadow-*`
2. **Sidebar collapse animation** — `transition-[width] duration-200 ease-out` on the sidebar element itself; do not animate `grid-template-columns`
3. **Bottom nav rail replaces view tabs at `< 768px`** — never show both simultaneously

## Accessibility (WCAG 2.1 AA)

4. **Focus rings on all interactive elements**: `focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1`
   - On `bg-brand-primary` surfaces (sidebar): use `focus-visible:ring-white focus-visible:ring-offset-brand-primary`
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

## Code Conventions

9. **No default exports** — all components use named exports
10. **No CSS-in-JS** — Tailwind utility classes only; use `style` prop only for dynamic values (e.g., CSS custom properties, inline widths derived from state)
11. **Stub hooks over mock network** — while real API hooks don't exist, return fixture data from the hook (`src/hooks/`). Components never import from `src/fixtures/` directly.
12. **Responsive breakpoints** (from `tailwind.config.ts`): `xs`=320px, `sm`=375px, `md`=768px, `lg`=1024px, `xl`=1280px, `2xl`=1440px

## Gantt-Specific Rules

13. **Gantt bar label color on light surface**: `#1A1917` — all 400-stop bar colors fail WCAG 4.5:1 contrast with white at 10–11px. **On `gantt-surface` (dark)**: use `gantt-text-primary` (`#E8E8E8`). The bar label token is surface-dependent; check the rendering context before assigning. See rule 40.
14. **Gantt bar heights**: normal/critical/complete = 18px; summary = 8px; milestone diamond = 12px; baseline ghost = 6px.
15. **Task list row height**: 28px fixed — required for scroll sync with SVAR's internal row height.
16. **`readonly={true}` on `<Gantt>`** until WASM CPM drag (issue #19) is implemented — prevents partial drag UX.

## Monte Carlo Row Rules

17. **MC row height is 44px** — outside the virtualizer; does not participate in scroll sync (not 28px like task rows).
18. **MC bars use semantic tokens only** — P50 = `border-semantic-on-track` (solid), P80 = `border-semantic-at-risk` (dashed), P95 = `border-semantic-critical` (dotted). No other colors.
19. **MC bars use stroke-pattern differentiation** (solid / dashed / dotted) in addition to color — required for WCAG 1.4.1 (use of color).
20. **MC histogram SVG bars use `fill-neutral-text-disabled`** — distribution shape is neutral; semantic colors are reserved for the percentile rule lines only.
21. **P80 badge uses outlined style** — `bg-transparent border border-semantic-at-risk/40 text-semantic-at-risk`. Not `bg-semantic-at-risk/10` fill. Consistent with rule 39.
22. **MC row (`MonteCarloRow`) is `hidden md:flex`** — suppressed below 768px. The P80 badge in `TopBar` is `hidden md:flex` (desktop only). Mobile surfaces P80 via a chip in `StatusBar` (`md:hidden`) — resolved by issue #33. `MonteCarloLabel` shows a persistent "P80: Mon D" chip at `md+` breakpoints.

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

35. **Sidebar background is `bg-gantt-surface`** — not `bg-brand-primary`. The sidebar and Gantt task-list panel share the same dark surface token. `bg-brand-primary` is reserved for interactive elements (buttons, focus rings, active accents) — never large-area backgrounds.

36. **Sidebar section headers** (`PORTFOLIO`, `PROJECTS`, `VIEWS`) use `text-xs font-semibold tracking-widest uppercase text-gantt-text-secondary`. Minimum size is `text-xs` (12px) — `text-[10px]` is prohibited; fails design system floor and WCAG 1.4.3 at 2.38:1 on the dark surface. They are `<h2>` elements with `aria-label` matching the visible text. Hidden when sidebar is collapsed.

37. **Sidebar active-row indicator** is a 2px left border (`border-l-2 border-brand-primary`) in addition to `bg-white/10`. The border is the primary non-color visual signal; background fill is secondary. Never use border alone without the fill.

38. **ViewTabs active state uses underline** — `border-b-2 border-brand-primary` — not pill/outlined. Pill style is reserved for the secondary Gantt toolbar (rule 42) to maintain a clear visual hierarchy between top-level navigation and sub-view options. If a pill border is ever used for tabs, it must meet WCAG 1.4.11 3:1 against `bg-neutral-surface`; `border-neutral-border` (#D4D2CE) fails at ~1.51:1.

39. **TopBar status badges use outlined style** — `bg-transparent border border-{semantic-color}/40 rounded px-2 py-0.5 text-xs`. Badge labels include the full semantic word: `{n} at risk`, `{n} critical`, `P80: {date}`. Labels must also specify scope (tasks vs. projects) — ambiguous counts are a PMO compliance risk. `aria-label="{n} at risk tasks"` or `"{n} critical tasks"`. At-risk and critical badges are `<button aria-haspopup="menu">` elements — NOT `listbox` (listbox implies selection, not navigation). They open a `role="menu"` popover with `role="menuitem"` task entries.

40. **Gantt dark surface** — the task-list panel and SVAR timeline use `bg-gantt-surface` (`#0F1117`). All text inside those panels uses `gantt-text-*` tokens or `gantt-semantic-*` tokens (see rule 41). No `neutral-surface*` or `neutral-text-*` tokens inside the Gantt split pane. SVAR overrides live exclusively in `gantt.css` — no inline styles on SVAR host elements.

41. **Dark-surface semantic tokens are required on `gantt-surface`** — the standard `semantic-*` tokens were designed for light backgrounds and fail WCAG 1.4.3 on `#0F1117` (critical: 2.93:1; at-risk: 2.72:1; on-track: 2.65:1). Use the dark-surface variants defined in `tailwind.config.ts`:
    - `gantt-semantic-critical` → Red 400 `#F87171` (4.87:1 on `#0F1117`)
    - `gantt-semantic-at-risk` → Orange 400 `#FB923C` (5.96:1 on `#0F1117`)
    - `gantt-semantic-on-track` → Green 400 `#4ADE80` (5.28:1 on `#0F1117`)
    Never use `semantic-critical` / `semantic-at-risk` / `semantic-on-track` tokens directly on `gantt-surface`.

42. **GanttToolbar view-switcher** (Gantt · WBS · Table) uses `role="group" aria-label="View mode"` with `aria-pressed` on the active item. Action buttons (+ Task · Baseline · Monte Carlo) are plain `type="button"` elements. All toolbar buttons: `border border-neutral-border rounded h-7 px-3 text-xs font-medium`. WBS and Table render as `disabled aria-disabled="true"` until their panels are implemented.

43. **Gantt column layout** — duration and start date are concatenated as a single `COL_DUR_START = 100px` column, formatted `{n}d · {MMM D}` (e.g., `14d · Mar 3`). Separate `COL_DURATION` and `COL_START` constants are removed. The `%` progress column shows text only — no mini progress bar.

44. **StatusBar legend has exactly four items** in this order: ● Complete (`semantic-on-track`) · ● In progress (`brand-primary`) · ● Critical path (`semantic-critical`) · ◆ Milestone (`brand-accent`). All four items must include a visible text label — shape or color alone fails WCAG 1.4.1. The ◆ character must be `aria-hidden="true"`; the text label carries the meaning for screen readers. Legend item order and copy are frozen; changes require a design rule update.

45. **StatusBar copy**: last-saved format is `Last saved: {N} min ago` / `Last saved: just now` (spell out "min", not "m"; omit "s" — US English convention). Online users: `{n} users online` with a `w-1.5 h-1.5 bg-semantic-on-track rounded-full aria-hidden="true"` dot. Online count is visible from `lg` (1024px) using `hidden lg:flex` — not `2xl:contents`. The StatusBar must distinguish data-entry save from CPM engine recalculation: "Last saved" refers to the most recent task edit; a separate "Recalculated: {time}" indicator covers the scheduling engine.

46. **Focus rings on `gantt-surface`** — any interactive element on `bg-gantt-surface` must use `focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-gantt-surface`. `brand-primary` focus rings fail WCAG 1.4.11 on the dark surface (2.89:1 vs. 3:1 required). Pattern follows rule 4's `bg-brand-primary` override.

47. **Monte Carlo row is role-gated** — hidden for the Contributor RBAC role; visible for PM, Resource Manager, PMO Director, and Executive roles. Use a role-check hook (`useCurrentUserRole()`) to gate the `MonteCarloRow` render, not CSS visibility. Contributor-role users must not see P50/P80/P95 terminology without context.

48. **Export / print mode renders on white** — any PDF or PNG export of the Gantt must apply a `print-light` CSS class that overrides `gantt-surface` with `#FFFFFF` and `gantt-text-*` with `neutral-text-*` equivalents. Dark theme is incompatible with standard corporate report templates. This override is mandatory before any export feature ships.

49. **Critical-path red requires a plain-English tooltip** — `title="This task is on the critical path — a delay here delays the project end date"` on every red task row. Color alone (WCAG 1.4.1) and a legend entry are insufficient for first-time users; the tooltip is the accessible fallback.

50. **`text-[10px]` is prohibited** — the design system floor is `text-xs` (12px). Arbitrary size values below 12px bypass the token ladder and introduce WCAG 1.4.3 failures on any surface.

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

72. **Bar label text uses `gantt-text-primary` (`#E8E8E8`) on `gantt-surface`.**
    `ctx.fillStyle = '#E8E8E8'` for all label text on the dark canvas surface.
    Never use neutral-text tokens inside the canvas render path (rule 40 / 41).

73. **Critical path bars use `gantt-semantic-critical` (`#F87171`) — not `semantic-critical`.**
    Same applies to at-risk and on-track: use the dark-surface `gantt-semantic-*`
    variants. Standard semantic tokens fail WCAG 1.4.3 on `#0F1117` (rule 41).

74. **Non-working day shading uses `rgba(255,255,255,0.03)`** — a very subtle
    white overlay on weekend columns. Visible but not distracting. Applied on
    `canvas-bg`, not recalculated during drag.

75. **Dependency arrows are cubic Bézier curves** with control points offset 40px
    horizontally from the source and target bar endpoints. FS arrows emerge from
    the bar right edge and enter the next bar left edge. Critical-path arrows use
    `gantt-semantic-critical` stroke; non-critical use `gantt-text-secondary`
    (`rgba(148,163,184,0.6)`). Arrow line width: 1.5px logical px.

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
    `tasks.length === 0`. Uses `bg-gantt-surface` surface color and `role="status"`
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

83. **Selection visual** — in the canvas bars layer: a 2px white inset stroke ring
    is drawn after the bar fill using `ctx.save()/restore()` (rule 59, canvas-bars
    layer only). In the task list row: `bg-white/10 border-l-2 border-brand-primary`
    class on the selected row. Selection state is read from `engine.selectedTaskIds`
    (immutable Set) — never duplicated in local component state.

84. **Cursor states on canvas-interaction** — `ixCanvas.style.cursor` is set by
    `GanttEngineImpl._updateCursor()` based on FSM state and hit zone type:
    `grab` over bar body, `col-resize` over resize handle, `crosshair` over
    link-dot, `grabbing` during active drag, `default` otherwise. Never set
    cursor on bg or bars canvas layers.

85. **Resize handle indicator** — when hovering over a resize handle hit zone, a 1px
    vertical line is drawn on canvas-interaction at `barRight - 4` px, spanning the
    full bar height (`BAR_TOP_OFFSET` to `BAR_TOP_OFFSET + BAR_HEIGHT`). Color:
    `rgba(148,163,184,1.0)` (textSecondary token). This meets WCAG 1.4.11 (3:1
    against the dark surface). Drawn by `drawResizeIndicator()` in GanttRenderer.ts.

## Risk Register Rules

86. **Risk severity color mapping** — always use these token pairs for severity labels and chips.
    Never use ad-hoc colors. All combinations achieve WCAG 4.5:1 on `neutral-surface` (#FFFFFF):
    - CRITICAL (20–25): `text-semantic-critical` on `bg-semantic-critical/10`
    - HIGH (12–19): `text-brand-accent-dark` (#C17A10) on `bg-brand-accent-light` (#FFF3CD)
    - MEDIUM (6–11): `text-neutral-text-primary` on `bg-brand-accent-light/50`
    - LOW (2–5): `text-neutral-text-secondary` on `bg-neutral-surface-raised`
    - MINIMAL (1): `text-neutral-text-secondary` on `bg-neutral-surface-sunken`
    The severity chip is read-only in the UI — always computed from `probability × impact`.

87. **`text-neutral-text-disabled` on `bg-neutral-surface-sunken` is prohibited** — this
    combination yields 1.97:1 contrast, failing WCAG 1.4.3 on all text sizes. MINIMAL severity
    labels must use `text-neutral-text-secondary` (#6B6965, 3.12:1 on #EBEBEB) at minimum.
    This prohibition applies everywhere in the app, not only to risk register.

88. **Risk matrix zone tokens live in `tailwind.config.ts` under `colors.risk`** — no hex
    literals inside `RiskMatrix.tsx` or `RiskMatrixCell.tsx`. Required tokens:
    ```
    risk.zone-critical: rgba(185, 28, 28, 0.08)
    risk.zone-high:     rgba(232, 160, 32, 0.12)
    risk.zone-medium:   rgba(232, 160, 32, 0.06)
    risk.zone-low:      #F5F5F0  (neutral-surface-raised)
    risk.zone-minimal:  #FFFFFF  (neutral-surface)
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
