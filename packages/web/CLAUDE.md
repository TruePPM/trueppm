# TruePPM Web Frontend — Design Rules

These rules are enforced at review time. Violations block merge.

## Layout & Visual

1. **No drop shadows anywhere** — use `border border-neutral-border` for separation instead of `shadow-*`
2. **Sidebar collapse animation** — `transition-[width] duration-200 ease-out` on the sidebar element itself; do not animate `grid-template-columns`
3. **Bottom nav rail replaces view tabs at `< 768px`** — never show both simultaneously

## Accessibility (WCAG 2.1 AA)

4. **Focus rings on all interactive elements**: `focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1`
   - On a **sage fill** (primary button, `bg-sage-500`): use `focus-visible:ring-navy-700 focus-visible:ring-offset-sage-500` (navy-on-sage 6.8:1).
   - **No dark-mode override needed for `brand-primary` (ADR-0103).** `brand-primary` is now mode-aware sage — sage-600 #3E8C6D (light, 4.6:1) / sage-400 #66B998 (dark, ≥3:1) — so `ring-brand-primary` passes WCAG 1.4.11 in both modes. The old `dark:focus-visible:ring-semantic-on-track` escape hatch (for green #1C6B3A's 2.81:1 dark failure) is **retired** — do not reintroduce it.
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

8b. **`--sem-*-bg` tokens are for badge pill fills and status cards** — `bg-semantic-critical-bg`, `bg-semantic-at-risk-bg`, `bg-semantic-on-track-bg`, `bg-semantic-warning-bg`. These are pre-computed RGBA values so they cannot be combined with Tailwind's opacity modifier. Always pair with the matching full semantic token for text/border (e.g. `border-semantic-at-risk/80 bg-semantic-at-risk-bg text-semantic-at-risk`). **Never substitute `bg-semantic-{state}/N` (the opacity modifier) for `bg-semantic-{state}-bg`** — `/N` applies Tailwind's alpha to the token's RGB channels and will NOT match the pre-computed dark-mode RGBA in `globals.css`, so a `/10` badge fill silently diverges from the design system in dark mode. The `-bg` tokens are the only correct form for semantic badge/pill fills. (Surfaced by ux-review on #691.)

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

40. **Schedule view adapts to color scheme** — in light mode the task-list panel and canvas use `bg-neutral-surface` (#FFFFFF); in dark mode they use the dark navy surface (#15223C, ADR-0103). The canvas renderer switches palettes via `setRendererColorMode(isDark)` called from `GanttEngineImpl` before each paint pass. `CanvasGanttTimeline` derives `isDark` from `useThemeStore` and passes it to `useGanttEngine`. `COLOR` (light) and `COLOR_DARK` (dark) palettes in `GanttRenderer.ts` are the canonical color sources; no hex literals in component files.

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

73. **Critical path bars use `COLOR.barCritical` (`#B91C1C`)** — `semantic-critical` on light surface. Complete bars use `COLOR.barComplete` (`#3E8C6D` = sage-600, brand on-track per ADR-0103; `#66B998` sage-400 on dark) — `semantic-on-track`. Both values are defined once in `GanttRenderer.ts`; update there only.

74. **Non-working day shading uses `rgba(0,0,0,0.03)`** — a very subtle dark overlay on weekend columns on the light canvas. Applied on `canvas-bg`, not recalculated during drag.

75. **FS dependency arrows use collision-avoiding Manhattan routing with merge junctions** (issue #466,
    ADR-0063). Spec lives in `docs/adr/0063-gantt-dependency-routing-rules.md` and next to the code
    in `GanttRenderer.ts` (header comment for `calculateDependencyPath`). Behavior contract:
    - **Pure Manhattan polyline.** No Bézier, no diagonals. 3 to 7 segments. Every segment is
      strictly horizontal or strictly vertical.
    - **Stubs.** Exit stub from source's right edge ≥ `EXIT_STUB` (5px). Approach stub from the last
      Manhattan waypoint to the arrowhead base ≥ `APPROACH_STUB` (8px). The router targets the
      arrowhead base (`tipX − arrowSize`), NOT the bar/diamond edge, so the visible stroked shaft
      before the arrowhead is always APPROACH_STUB long. Arrowhead never sits at a path corner.
    - **Algorithm — decision tree** (ADR-0063 §"Routing engine"):
      1. Same row: 3 segments — exit stub → H → run-in.
      2. Stacked-sequential (target.x ≤ source.barRight + EXIT_STUB): 5-segment gutter dogleg
         per R12 — exit stub → V to row-gap gutter → H along gutter → V to target row → run-in.
      3. V at exit column blocked by a non-source/non-target bar: 5-segment left-detour —
         exit stub → V to gutter → H west past blocker's left edge → V south past blocker →
         run-in. Used for cases like milestone → child-of-phase where the exit column
         lands inside the containing summary's X range.
      4. Otherwise: collapsed 3-segment canonical L — exit stub → V at exit column straight
         to target row → run-in.
    - **Arrow color is charcoal, always.** `arrowNormal` and `arrowCritical` both resolve to
      `#444441` (light) / `#B8B5AE` (dark). Critical-path state is conveyed by the red BAR fill
      (rule 73), NOT by the arrow. Previous "critical arrow = red" rendered red arrows visually
      merging with red bars where they crossed (issue #466 gap P0-1).
    - **Summary rollups CAN be arrow endpoints.** Waterfall PMs use phase-to-phase dependencies
      as the primary relationship; suppressing them hides the user's working structure. Rollups
      are also obstacles for routing other arrows.
    - **Milestone flank rules.** Incoming arrows enter on the LEFT vertex flank (tip at
      `cx − milestoneHalfDiag`). Outgoing arrows exit from the RIGHT edge (= right vertex of the
      milestone). Entry and exit vertices on a single milestone naturally differ because FS sources
      always exit right and FS targets always enter left.
    - **JUNCTION RULE (codified, do not deviate).** A junction dot renders only where 3 OR MORE
      distinct arrow LINES meet at one (x, y) — TRUE convergences. Counting segments is the wrong
      lens: a T-junction has 3 segments but is visually indistinguishable from any Manhattan
      corner (one line passing through + one branching off), and a dot there reads as noise. The
      rule applies to:
      - **Merge** (convergence): 2+ predecessor lines arrive at one point and a single trunk
        line continues to the target = 3+ distinct lines meeting. Junction at
        `min(maxPredecessorExitX, tipX − arrowSize − APPROACH_STUB)`. Each predecessor terminates
        AT the junction (no arrowhead). A single trunk arrow with the only arrowhead runs east
        to the target.
      - **Split** (divergence) — **NO dot.** When a source has 2+ outgoing arrows that share a V
        column, each "intermediate" turn-off is a T-junction (one V line passing through + one H
        branching off east). Two visible lines, not three — corner, not junction. The deepest
        target's turn-off is the same (V terminating + H branching off). Splits draw no dots.
      - **Cross-arrow intersections** — bridge hop per ADR-0063 Rule 15 Type A. Two independent
        arrows crossing at one (x, y) get a 10-px-wide, 6-px-tall quadratic Bézier arc on the
        "over" segment (horizontal by default). Not a dot. Implemented via the collect-then-draw
        refactor in `drawDependencyArrows`: every Manhattan path is collected first, then
        `detectHops()` walks every pair of paths to record orthogonal interior crossings, then
        `drawPathWithHops()` strokes each path with arcs inserted at hop positions. Bézier
        (SS/FF/SF) arrows skip detection — Bézier-vs-Manhattan crossings are out of scope for v1.
      - **One arrow terminating on another arrow's path** — small T-junction dot per Rule 15
        Type B (spec adopted; implementation deferred). Halo radius 5 + dot radius 4 —
        intentionally one pixel smaller than the merge marker to reinforce the hierarchy.
      - **Junction visual (merge).** Outer halo (radius `MERGE_HALO_RADIUS=6`, `palette.surface`)
        + inner dot (radius `MERGE_DOT_RADIUS=5`, stroke color). Drawn LAST so it sits on top of
        every line endcap. If a junction would land inside a task bar's body, push it to the
        nearest row gutter (it should never sit ON an object). Original spec values were 4/3;
        bumped to 6/5 after canvas testing — 4/3 was visually subordinate to the 2-px arrow
        stroke and easy to miss on dense charts. See ADR-0063 "Junction rule (codified)" for
        rationale and Rule 15.2 for the full size hierarchy.
    - **Selection emphasis.** When the source OR target is in `engine.selectedTaskIds`, the arrow
      uses `palette.selectionRing` stroke at 2.5px. Other arrows hold 2px.
    - **SS / FF / SF unchanged** — cubic Bézier with 40px control-point offsets. Same charcoal
      stroke. Manhattan routing collapses these to U-shapes that cross the source bar; Bézier
      reads cleaner for same-edge links and matches MS Project's convention.
    - **Source connection dot is removed** — the arrow tail is the affordance; the dot added noise.
    - **Ancestors of the arrow's target are transparent obstacles** (ADR-0063 Override 4). A
      summary rollup is a visual aggregation of its children, not a real wall — an arrow into a
      deep descendant descends straight through the rollup's body instead of doing a chart-spanning
      U-detour around the entire summary bar. Source-side descendants stay as walls; only
      target-side ancestors are excluded.
    - **Redundant FS edges to descendants of a summary target are suppressed at render** (ADR-0063
      Override 5). When a source has FS to both summary S AND one or more descendants of S, only
      the summary edge renders. Schedule semantics are unchanged (data still has both edges, CPM
      still uses both); the renderer drops the descendant edges to declutter. Example: milestone
      → phase 4 and milestone → daddy3 (daddy3 ∈ phase 4) — only milestone → phase 4 renders.
    - **Lag annotation and click-to-delete on the arrow** are out of scope for v1.

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

83. **Selection visual** — in the canvas bars layer: a 2px `COLOR.selectionRing` (**navy `#1B2A4A`** light / **reversed `#E9EDF3`** dark) inset stroke ring is drawn after the bar fill using `ctx.save()/restore()` (rule 59, canvas-bars layer only). The ring is navy INK — not sage — so it stays visible on a sage complete bar (distinguishability triad, ADR-0103 D4: complete = sage fill, selected = navy ring, today = sage line). In the task list row: `bg-brand-primary/10 border-l-2 border-brand-primary` (sage) on the selected row. Selection state is read from `engine.selectedTaskIds` (immutable Set) — never duplicated in local component state.

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
    The disabled token has almost no contrast headroom, so the prohibition extends to **any
    surface darker than `bg-neutral-surface` (#FFFFFF)** — including `-raised`, `-sunken`, and
    any `hover:bg-*` state on a row that contains disabled-token text (the hover state is the
    worst case and the one that must pass AA). Informational text that must stay legible uses
    `text-neutral-text-secondary` as the floor. (Surfaced by ux-review on #590.)

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

102a. **Drag-lifted rows in list/backlog views use ring, not shadow.** A sortable row in the
     dragging state (e.g. the Product Backlog grooming view) uses `ring-2 ring-brand-primary
     opacity-60` — never `shadow-*` (rule 1). This mirrors the Board card drag treatment (rule
     102) so the shadow prohibition is not reintroduced piecemeal on each new sortable list.
     The drag handle is a `min-h-[44px] min-w-[44px]` button (rule 5 touch target) carrying the
     dnd-kit listeners, with an `aria-label` and the rule-4 `focus-visible` ring; the row stays
     clickable. Fixed-column list grids that exceed a phone's width wrap their header + rows in a
     `min-w-max` container inside an `overflow-auto` shell so columns stay aligned under
     horizontal scroll rather than compressing and misaligning.

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

108. **Canonical view tab order is `Overview · Board · Schedule · WBS · Table · Calendar · Team · Risks`** (issue #204, updated per VoC review 2026-04-29). Overview is first — it is the canonical landing/orientation surface (ADR-0030). Board is second — the execution surface. The route segment for the Schedule view is `/schedule`. Never change this order without a design review. `ViewTabs.tsx` is the source of truth. The mobile `BottomNav` mirrors this order and omits Risks (infrequent on mobile). The methodology-gated **Backlog** tab (`product-backlog`, #1096) sits between **Board** and **Sprints**, visible only on Agile/Hybrid projects (gated via `methodologyTabs.ts`, the same mechanism as Sprints — web-rule 154); it links to the existing `/projects/:id/product-backlog` grooming page. It is desktop-only: `BottomNav` deliberately does **not** mirror it (an 8th mobile tab harms phone UX; mobile backlog cards are tracked in #1044).

109. **TopBar status pills collapse below 1024px (`lg:`)** (issue #205). At `lg+` viewports: P80 pill, at-risk badge, and critical badge render individually (`hidden lg:flex`). Below `lg:`: all three collapse into a single `HealthDropdown` button (`lg:hidden`) that expands a `role="menu"` listing the task items. The `HealthDropdown` renders nothing when there are no health signals. P80 pill is a `<button>` that opens the MC distribution panel (issue #196, shipped in wave/2-board).

## Toolbar Responsive Rules (Issue #568)

110. **Every toolbar control is classified as primary or secondary.** This classification is the contract — enforce it in code review, not just implementation. Primary controls are always visible at all widths ≥ 768px. Secondary controls collapse at narrow widths (see rule 111). Canonical classification per view:
     - **Schedule toolbar**: `+ Task`, `+ Milestone`, `BUILD MODE` = primary; `CP only`, `Focus chain`, `Critical path`, `Milestones` toggles = secondary; health summary chip, `Columns`, `Today`, ZoomControl = primary.
     - **Board toolbar** (CalmToolbar): Group, Sort, Density, Layout segmented control = primary; `My tasks`, `At-risk`, `Cost` toggles = secondary.
     - **Resource toolbar**: view mode tabs, Prev/Today/Next date nav, `Fit to project` = primary; status filter chips = secondary.
     Adding a new control to any toolbar requires an explicit primary/secondary declaration in the MR description.

111. **Three-tier breakpoint collapse for toolbar controls:**
     - `lg:` (≥ 1024px): all controls visible with full text labels. This is the reference layout — screenshots and design specs target this width.
     - `md:` (768–1023px): secondary controls render icon-only — wrap the label text in `<span className="hidden lg:inline">` so it disappears but the icon and `aria-label` remain. Primary controls keep their short text labels.
     - `< md:` (< 768px): secondary controls disappear from the toolbar entirely and move into the `ToolbarOverflowMenu` (rule 112). Primary controls remain visible with short labels. Never render a standalone secondary control below 768px.
     Use `hidden lg:inline` on label text spans, `hidden md:flex` / `md:hidden` on visibility toggles — the same pattern already enforced on `TopBar` (rule 109).

112. **`ToolbarOverflowMenu` is the shared overflow container for all views** — do not implement a per-view overflow popover. Import from `src/components/toolbar/ToolbarOverflowMenu.tsx`. The trigger is `<button aria-label="More options" aria-haspopup="menu">` rendering `⋯`. The popover is `role="menu"` with one `role="menuitem"` per secondary action or `role="menuitemcheckbox" aria-checked={…}` per secondary toggle. The overflow button is rendered only below `md:` (`md:hidden`); it must not appear at `lg:`. Keyboard: `ArrowDown`/`ArrowUp` navigate items; `Enter`/`Space` activate; `Escape` closes and returns focus to the trigger.

113. **Toolbar root must be `flex flex-nowrap` — wrapping to multiple rows is a bug.** The fixed height is `h-10` for view-level toolbars (Schedule, Board, Resource) and `h-7` for sub-toolbars (GanttToolbar secondary row). If a toolbar wraps, it is missing breakpoint collapse rules (rule 111). `flex-nowrap` is explicit so lint / visual review surfaces the problem immediately rather than silently producing a two-row layout.

114. **`ScheduleToolbarToggle` and any new toggle button accept a `hideLabel` prop.** When `hideLabel={true}`, the text label is omitted from the render; the button still carries `aria-label` and `title` matching the full label text. Used by the `md:` tier (rule 111) to switch secondary toggles to icon-only mode. Do not add a new size variant to the design system for this — the existing `h-7 px-3 text-xs font-medium` sizing is retained in both modes.

## Settings Shell Save Contract (Issue #536)

115. **Every settings page with a save-bar form follows the dirty/save/discard contract.** Two paths:
     - **API is wired**: the page MUST call `useDirtyForm({ values, initialValues, onSave, onReset, apiReady: true })` from `src/features/settings/hooks/useDirtyForm.ts`. The hook publishes the page's dirty state to `useSettingsSaveStore`, which `SettingsShell` reads to render the save bar, the `ConfirmDiscardDialog`, the `beforeunload` listener, and the `Ctrl/Cmd+S` save shortcut. Pages keep their own `useState` per field — `useDirtyForm` does not own field state, only observes a `values` / `initialValues` pair via `JSON.stringify` compare.
     - **API not yet wired (stub page)**: the page MUST wrap its content in `<StubFieldset disabled>` from `src/features/settings/components/StubFieldset.tsx`. The `<fieldset disabled>` disables every form control and the `.settings-stub :disabled` CSS rule in `globals.css` applies the visual treatment. When the page's API ships (typically one of #517–#530), flip from `<StubFieldset>` to `useDirtyForm({ apiReady: true })`.

     Pages with row-level mutations and no save-bar (e.g. `WorkspaceMembersPage`, `WorkspaceGroupsPage`, `ProjectIntegrationsPage`, `ProjectAccessPage`, `ProgramAccessPage`, `ProgramProjectsPage`) and danger-zone pages with typed-confirm flows (`WorkspaceDangerPage`, `ProjectArchivePage`, `ProgramArchivePage`) are exempt — they don't have a save-bar UI surface.

116. **Discard semantics: page owns the snapshot.** The "last-saved snapshot" lives in the page (typically alongside the field `useState` calls). On save success, the page bumps its `initialValues` to the freshly-saved values so `useDirtyForm` re-derives `dirty=false`. On discard, the page resets its field `useState` back to `initialValues` from inside the `onReset` callback. Never store the snapshot inside `useDirtyForm` or `useSettingsSaveStore` — both are stateless aggregators.

117. **Future enterprise sections (ADR-0029 slots) participate in the same contract.** A slot-registered enterprise section MUST NOT render its own save bar; it publishes dirty state via `useDirtyForm` to the shell's save bar, just like a built-in page.

118. **Settings-surface density exception (rules 5, 45, 50).** Pages and components under `features/settings/` use a compact admin density: `text-[11px]` / `text-[10px]` for secondary and label text, and `h-6` / `h-7` controls, are permitted — an explicit override of rules 5, 45, and 50. Rationale: settings is a desktop-admin-first surface, and matching the established Workspace/Project/Program settings density (e.g. `WorkspaceMembersPage`, `ProjectWorkflowPage`) is better UX than per-component rule conformance that would make one page visually inconsistent with its siblings. This exception is **scoped to `features/settings/` only** — it does not apply elsewhere. Two clauses remain non-negotiable inside settings: (a) every interactive control still requires the full rule-4 `focus-visible` ring; (b) a third-party-fidelity preview (e.g. a Slack-message mock) may use the third party's literal palette as product content, exempt from rule 8, but must carry a code comment stating the intent. Modal focus-trap/restore and sub-44px touch targets remain a known codebase-wide a11y gap tracked separately — not introduced by, nor required to be fixed in, settings MRs. The settings density exception floor is `text-[10px]`; `text-[9px]` and below are prohibited everywhere, including settings.

122. **`SettingsShell` scroll containers reserve a stable scrollbar gutter.** Both the sidebar `<nav>` and the content panel `<div>` in `SettingsShell.tsx` carry `[scrollbar-gutter:stable]` alongside `overflow-y-auto`. The shell is the single scroll authority for every settings scope (Workspace/Program/Project) and React Router swaps only the `<Outlet>` content between sub-pages, so without a reserved gutter the scrollbar appears/disappears between a tall sub-page (Program General, Risk policy) and a short one (Projects, Integrations) and shifts the panel ~15px horizontally on platforms with classic scrollbars (#776). Never drop the `[scrollbar-gutter:stable]` utility from these two containers; use `stable` (scrollbar-side only), not `both-edges`, so the left `px-6` content rhythm is preserved. The content container carries `data-testid="settings-content-scroll"`; its gutter is asserted in `SettingsShell.test.tsx` (class present) and `e2e/settings-shell-ux.spec.ts` (computed `scrollbar-gutter === 'stable'`).

123. **Entity shells suppress their working chrome on `/settings` routes.** The shared `SettingsShell` (SCOPE switcher + context selector + nav) is mounted in all three scopes — Workspace (`/settings`, directly under `AppShell`), Project (under `ProjectShell`), and Program (under `ProgramShell`). It must mount at the **same vertical position** in every scope, or clicking the SCOPE switcher relocates the switcher itself and the user loses their place (#776). The constant-height global `TopBar` (its project `ViewTabs` are `h-full` inside it, adding no height) is the only chrome permitted above the shell. Therefore an entity shell that renders its own header/tab chrome above the `<Outlet>` (today: `ProgramShell`'s program header + `Overview/Backlog/Projects/Members` tab strip) **must suppress that chrome on its settings routes** — detect via `useMatch('/programs/:programId/settings/*')` (or the scope's equivalent) and render only a minimal full-height wrapper around `<Outlet>`, mirroring `ProjectShell`. Entity identity in settings is carried by the `SettingsShell` context-selector pill; exit is the fixed-position global left Sidebar — do **not** add a per-scope "back to {entity}" bar, which reintroduces the per-scope height delta this rule removes. Suppressing the program `<h1>` on settings routes is also correct: `SettingsPageTitle` already renders the page `<h1>`, so the previous program-header `<h1>` was a duplicate. New entity shells follow the same contract. Covered by `ProgramShell.test.tsx` and `e2e/program-general-settings.spec.ts`.

124. **The settings context pill is a searchable entity switcher, and its chevron means "switchable".** `SettingsShell` renders `SettingsContextSwitcher` (the program/project identity row) as a `aria-haspopup="listbox"` trigger whenever it receives `contextOptions` with **≥ 2** entries, letting the user jump straight to another program's / project's settings — the option `to` preserves the current sub-page (`…/test/settings/cadence` → `…/test2/settings/cadence`), and selection routes through the shell's `guardedNavigate` so a dirty form still hits `ConfirmDiscardDialog`. With **0–1** options it is a static identity row with **no chevron** — never render the chevron when no switch is possible (the pre-#776 always-on chevron was a dead affordance). The open popover is **always** a `combobox` search input + `role="listbox"` of `role="option"` rows (no scan-then-search gap, no menu-vs-combobox mode split): type-to-filter is case-insensitive substring on name; focus stays in the input with the highlight via `aria-activedescendant`; `aria-selected` marks the current entity (checkmark); arrows/Home/End/Enter navigate; two-stage Escape clears the query then closes; empty result → a `role="status"` "No …s match" row; focus returns to the trigger on close. The per-row health dot is `aria-hidden` (rule 6), so health is also carried in each row's and the trigger's `aria-label` (e.g. `"test2, critical"`). The search box gets its focus ring via `focus-within` (it receives programmatic focus on open, where `focus-visible` is unreliable). Workspace scope passes no `contextOptions` (single workspace) → static pill. Covered by `SettingsContextSwitcher.test.tsx`, `SettingsShell.test.tsx`, and `e2e/program-general-settings.spec.ts`.

125. **The SCOPE switcher never navigates to a blank page; unavailable scopes are disabled, not faked.** `SettingsScopeLink.to` is `string | null` (+ optional `disabledReason`); a non-active scope segment with `to === null` renders **disabled** (`<button disabled aria-disabled title={disabledReason}>`, kept in the 3-way control so the tri-scope model holds) rather than falling back to a non-settings route (#776). **Targets:** Workspace → always `/settings/general` (always enabled — one workspace, always valid). Program → from a project, the project's **parent program** (`project.programId`) ?? first program ?? disabled "No programs yet"; from workspace, first program. Project → from a program, first project in that program ?? any project ?? disabled "No projects yet"; from workspace, first project. A scope switch always lands on **`/general`** (scopes have different sub-page sets, so do NOT preserve the sub-page across scopes — only the same-scope context pill does that, rule 124). While the backing `usePrograms()`/`useProjects()` list is still loading, the target is `null` → the segment is disabled until it resolves (prevents the transient blank). The disabled segment's `text-neutral-text-disabled` is **exempt from rule 87 / WCAG 1.4.3** as an inactive UI component (and must read dimmer than the `text-secondary` enabled segments). Covered by `SettingsShell.test.tsx` and `e2e/settings-shell-ux.spec.ts`.

## KPI Rollup / Overview Rules (Issue #713)

119. **A configured-but-not-computable metric renders as a muted card with a reason, never hidden.** When a dashboard or overview is driven by a user-selected metric set (e.g. the program rollup KPIs), a metric the user enabled but for which no value can be computed yet MUST render as a muted card (`border-dashed border-neutral-border`, value `—` in `text-neutral-text-disabled`) with a short plain-language reason in the `sub` slot (e.g. "Needs cost data"). Do not silently drop it from the grid — the user enabled it and must see *why* it is blank. The machine-readable `reason` from the API drives the human label via a lookup map; never render the raw reason code. See `ProgramOverviewPage.tsx`.

120. **Health/variance values pair color with a non-color signal (rule-12 reinforcement for rollups).** A health band card shows the band *text* ("At risk") alongside the semantic color and an `aria-label` on any pill; a day-variance shows a signed `+9d` / `-3d` so the sign — not only the color — conveys late-vs-early. Counts and scores are plain numerals. This keeps KPI cards WCAG 1.4.1-compliant without a legend.

## Enterprise Boundary Affordance (Issue #541)

121. **Enterprise-only capability rows carry an inline `EE` badge that is itself the link.** On any OSS surface that advertises capabilities reserved for TruePPM Enterprise (Settings → Roles & permissions matrix today; the future `/programs` and `/portfolio` gateways), mark each Enterprise row data-driven (`ee: true` on the capability/row object — never a hardcoded list in the render, so it stays in sync as the Enterprise repo adds capabilities) and render the `EnterpriseBadge`: a focusable `<a>` to the Enterprise page (`https://trueppm.com/enterprise`), `target="_blank" rel="noopener noreferrer"`, with `title` **and** `aria-label` "Available in TruePPM Enterprise". **The badge IS the link** — a hover-tooltip that contains a link is unreachable (it dismisses as the pointer travels to the link and is invisible to keyboard users), so never wrap the link in a tooltip. Gate rendering on `useEdition() === 'community'`: under the Enterprise edition the capability is available, so the badge is suppressed (it would be noise). Badge style (settings density, rule 118): `bg-brand-primary/10 text-brand-primary text-[10px] font-semibold uppercase tracking-wide` + the standard rule-4 `focus-visible` ring. This is the concrete implementation of the ux-review §6.2 boundary-affordance requirement — it turns "dead" Enterprise cells (a check in a column that does nothing in OSS) into a purchase-decision path and stops missing Enterprise features from reading as broken OSS. The badge is the shared `features/settings/components/EnterpriseBadge.tsx` (#791) — it **self-gates** on `useEdition()` (returns null unless community), so callers render `<EnterpriseBadge />` without an edition check of their own. It applies to whole action buttons too, not just matrix cells: an Enterprise-reserved action (e.g. "Sync from directory" = LDAP, "View change history" = audit trail) renders as a disabled button with the badge alongside it as the reachable upsell link.

## Disabled Placeholder / Stub Controls (Issue #791)

122. **Disabled placeholder/stub controls in `features/settings/` use the `.settings-stub` recipe — never `disabled:opacity-50`.** Half-opacity body text fails WCAG 1.4.3 and diverges from the established stub treatment. Two equivalent paths: wrap a whole section in `StubFieldset` (preferred — the `.settings-stub :disabled` rule in `globals.css` recolors every descendant in one place, used by `WorkspaceDangerPage`), or for an individual button apply the recipe as `disabled:` utilities at opacity 1 — `disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed` (drop the bg/border pair for borderless text-link buttons; recolor + `disabled:cursor-not-allowed` is enough). Always keep the full rule-4 `focus-visible` ring **including `ring-offset-1`**, and add a `title` explaining why the control is unavailable: `#NNN` for an OSS gap, "Available in TruePPM Enterprise" paired with `EnterpriseBadge` (rule 121) for an Enterprise-reserved action. Dead-but-clickable buttons are worse than disabled ones (#669) — disable the placeholder, link the tracking issue, ship.

## Program Navigation (Issue #790, ADR-0091)

126. **Program navigation lives in the global TopBar, mirroring project `ViewTabs` (ADR-0091).** `ProgramTabs.tsx` renders inside `TopBar` (alongside `ViewTabs`), gated on `useProgramId()`, `hidden md:flex h-full` so it adds no height. Canonical order: `Overview · Backlog · Projects · Members · Settings` — Settings is last, matching projects, and is the discoverable entry to program settings (#790). `ViewTabs` and `ProgramTabs` are **mutually exclusive** — each returns null without its id, and a URL is either project- or program-scoped — so exactly one renders; do not render program nav in-content (`ProgramShell` is a minimal `<Outlet>` wrapper, like `ProjectShell`). Styling is identical to `ViewTabs` (web-rule 38: underline active `border-brand-primary text-brand-primary` + `aria-current="page"`, rule-4 focus ring, leading `aria-hidden` icon, `text-sm`). Active tab = the path segment after `:programId`; the Settings tab stays active across every `/programs/:id/settings/*` sub-route. No role gating on the tabs — writes are gated inside each page. `BottomNav` program parity is a deferred mobile follow-up. Covered by `ProgramTabs.test.tsx` and `e2e/programs.spec.ts`.

## Schedule View Interaction Rules (Issues #351 / #491)

127. **Continuous zoom uses a stepper, not segmented tiers.** The Schedule `ZoomControl` is `[ − ]  {derived tier}  [ + ]` in a `role="group" aria-label="Timeline zoom"` (`h-7`, `border border-neutral-border rounded`). `pxPerDay` (in `scheduleStore`) is the source of truth; the discrete `ZoomLevel` is **derived** from it (`deriveTier`) and survives only as a label for header formatting + QuarterModeControl gating. The center readout is a non-interactive `role="status" aria-live="polite"` span showing the derived tier (Day/Week/Month/Quarter/Year) — it IS the active-tier indicator; there is no pressed/segmented active state. `−`/`+` step geometrically (×/÷ `ZOOM_STEP_FACTOR` = 1.5), clamped to the `ZOOM_CONFIGS` day…year band (`MIN_PX_PER_DAY`/`MAX_PX_PER_DAY`) and disabled at the edges; tooltips carry `⌘−`/`⌘=`. A separate `Fit` button (rule 82 style, label "Fit to project", `⌘0`) sits beside the group and calls `engine.fitToProject()`. ZoomControl + Fit are primary toolbar controls (rule 110); the toolbar stays `flex-nowrap h-10` (rule 113).

128. **Auto-tier header reads the continuous scale, not the discrete enum.** `drawTimelineHeader` chooses its emphasized (major) and de-emphasized (minor) units from the scale's continuous `pxPerDay` via `headerUnitsForPxPerDay`, so emphasis swaps smoothly across the whole Day↔Year continuum as the user pinch/Ctrl-wheel zooms. Thresholds (`HEADER_TIERS`, constants in `GanttScaleData.ts`): ≥80 Hour/Day · 24–80 Day/Week · 8–24 Week/Month · 2.5–8 Month/Quarter · 0.7–2.5 Quarter/Year · <0.7 Year. The 'hour' minor tick unit is **deferred** — above 80 px/day the header caps the major at Day until an hour unit ships.

129. **Cursor-anchored zoom for wheel/pinch; viewport-center for keyboard/toolbar.** Ctrl/Cmd+wheel (and trackpad pinch, delivered by the browser as a ctrl+wheel) zoom toward the pointer — the date under the cursor stays fixed (`setPxPerDay(px, { clientX })`: capture `anchorDate` + `viewportX` before the scale change, restore `scrollLeft = newAnchorCanvasX − viewportX`). The `−`/`+` buttons and `⌘=`/`⌘-` keyboard zoom use viewport-center anchoring (rule 80). Plain wheel over the timeline keeps scrolling; plain wheel over the left task-list pane keeps scrolling vertically — only the Ctrl/Cmd modifier zooms.

130. **Drag-to-pan uses a separate `GanttPanFSM` arbitrated on pointerdown.** When Space is held OR the middle button (`e.button === 1`) is pressed, the pan FSM claims the gesture and the task-bar drag FSM (`GanttDragFSM`) is bypassed entirely; otherwise drag behaves as before. Pan moves both axes (clamp `scrollLeft`/`scrollTop` to `[0, max]`); vertical pan flows to the task list via the existing `taskListScrollRef` scroll-sync, so no extra wiring. Only the timeline canvas pans — the left task-list pane never initiates a pan, and Space there does nothing pan-related.

131. **Pan cursor precedence extends rule 84; pan is exempt from rule 70.** In `_updateCursor`: `_panning` → `grabbing` (whole canvas) > `_panArmed` (Space held) → `grab` (whole canvas, overrides hit-zone cursors) > existing drag/hit-zone logic. Space-arming is scoped to canvas hover/focus (`_canvasHovered`) — never a global Space capture (which would break Space on buttons, checkboxes, and page scroll) and never inside an editable target. Pan is direct 1:1 manipulation with **no momentum/inertia**, so it is exempt from `prefers-reduced-motion` (there is no animation to suppress; do not add inertia without gating it on rule 70). A pan release suppresses the synthetic `contextmenu` once so middle/right-drag never opens the context menu.

132. **Pan discoverability lives as one line in the `ScheduleLegend` body, not a toast.** The hint "Hold Space + drag, or middle-drag, to pan" is a single `text-xs text-neutral-text-secondary` line under a `border-t` divider at the bottom of the legend body (rule 50 floor; not `tppm-mono`). The legend is the established "what do these affordances mean" surface — do not add a tutorial toast or coachmark that fires on every Schedule open.

## Schedule Backlog-Promote Rules (Issue #318)

133. **The Unscheduled gutter is a two-section tray (To Do above, Backlog below) in one scroll container.** `UnscheduledGutter` partitions its task list by `status === 'BACKLOG'` into an upper "To Do" section (NOT_STARTED, no committed `planned_start`) and a lower "Backlog" section (`BACKLOG` ideas). Each section is a `<section role="group">` with a count in its `aria-label`, and a sticky sub-header (`sticky top-0` inside the scroll container) using the rule-36/101 token (`text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary`): `TO DO · UNSCHEDULED ({n})` and `BACKLOG ({n})` (the Backlog header adds a `hidden lg:inline` italic hint "drag onto the timeline to promote & schedule" only when non-empty). The gutter header count is the **sum** of both sections. Each section renders a muted `role="status"` empty row ("No unscheduled To Do tasks" / "No backlog items") rather than collapsing — **never hide one section while the other has items**. Both empty falls back to the existing whole-gutter "all scheduled" header behavior. Sections are separated by `border-t border-neutral-border`.

134. **Backlog chips differ from To Do chips by a 2px dashed left edge + a readiness label, never color alone.** `UnscheduledTaskRow` takes a `variant: 'todo' | 'backlog'` prop. The backlog variant adds `border-l-2 border-dashed border-neutral-border` (the at-a-glance cue that a drop **promotes** BACKLOG → To Do, not merely schedules) plus a readiness label reusing the `BacklogBand` ReadinessChip semantics (idea / estimated / ready / baselined) — the text label is the WCAG 1.4.1 non-color signal (rule 107). Idea-readiness rows render the name `italic text-neutral-text-secondary`. To Do chips carry no dashed edge.

135. **Promoting a backlog item is a `{ planned_start, status: 'NOT_STARTED' }` PATCH via `usePromoteTask` (decision A2).** Sending an explicit `status: 'NOT_STARTED'` in the body skips the server serializer's date-gated NOT_STARTED → IN_PROGRESS auto-bump (which only fires when `status` is absent), so a backlog promotion lands deterministically in To Do regardless of the drop date — and the success toast verb is fixed: `Promoted '{name}' to To Do and scheduled for {date}` (`{date}` = `MMM D`, matching the drop-indicator label). The To Do gutter path is unchanged — it sends only `planned_start` and the server owns the bump (#336). `usePromoteTask` carries an `onMutate` optimistic cache snapshot (the chip leaves its section immediately) + `onError` rollback (the chip returns), mirroring `useUpdateTask`/`useToggleComplete`. The offline guard (rule 29) skips the PATCH, clears the preview, and leaves the chip; aria-live is written via DOM ref (rule 30): "Promoted {name}, scheduled for {date}." / "Could not schedule {name}." Esc cancels mid-drag (rule 28). There is **no** server change and **no** new endpoint — reuse `PATCH /tasks/{id}/`.

136. **The keyboard alternative for backlog scheduling is the shared `ScheduleTaskDialog` (the rule-105 parallel).** `features/schedule/ScheduleTaskDialog.tsx` (`role="dialog" aria-modal="true"`, ~360px, `bg-neutral-surface border border-neutral-border rounded-lg`, no shadow) is reachable from **two** entry points but is a single component: the gutter backlog chip's `···` menu (replaces the inline form; the To Do row keeps its inline form) and the Board `BacklogCard`'s `···` action (mounted once in `BoardView`, single instance like `BacklogDemoteConfirmDialog`, passed down via `BacklogBand`'s `onSchedule`). The date input defaults to today (local ISO) and is focus-first; focus is trapped; Esc + ✕ cancel and **return focus to the trigger** (copy `BacklogDemoteConfirmDialog`'s pattern). Schedule issues the same A2 PATCH (`{ planned_start, status: 'NOT_STARTED' }`) and the same success toast + aria-live "Scheduled {name} for {date}."; on error it stays open with an inline `text-xs text-semantic-critical` message; offline disables the Schedule button with a `title`.

137. **Focus-ring form in the Schedule view: `focus-visible:` wins; no dark-mode override.** The Schedule view (`features/schedule/`) uses `focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface` per rules 46/126 — this overrides the generic ux-review `focus:` preference for standalone controls. The Schedule view adapts to dark mode (rule 40), but `brand-primary` is now mode-aware sage (sage-700 #316F57 light / sage-400 #66B998 dark, ≥3:1 on the dark surface #15223C), so `ring-brand-primary` passes WCAG 1.4.11 in **both** modes. The old `dark:focus-visible:ring-semantic-on-track` override — added for the pre-rebrand green #1C6B3A's 2.81:1 dark failure — is **retired; do not reintroduce it** (rule 4, ADR-0103). Steppers inside a bordered `role="group"` may use `ring-inset` without an offset.

## Sprint/Phase/WBS Guardrail Rules (Issue #875, ADR-0101)

138. **Guardrail warnings are inline, proceed-then-offer-undo notices — never a blocking modal.** A Tier-1 guardrail (summary/phase/recurring/out-of-window task assigned to a sprint) fires *after* the assignment already succeeds: the `GuardrailNotice` renders inline under the control with `role="status"` + `aria-live="polite"` (NOT `role="alert"`), a single `Keep it here` tap to dismiss, and `Undo` to revert. Only a Tier-2 *block* (`GuardrailBlock`) uses `role="alert"`, and it offers no override — it is resolved only by removing the offending state (`Got it` dismisses the notice; the server never changed the FK). Only bulk operations may use a confirm dialog (one aggregated confirm for N tasks, never N notices).

139. **The override reason field is always optional and never gates the proceed action.** `GuardrailNotice`'s note input is collapsed behind a `▸ Add a note (optional)` toggle and is one-tap-skippable; `Keep it here` works with an empty reason. No policy tier may make it required at the warn level — the override is recorded server-side via the task's history regardless.

140. **Guardrail / health UI mounts only on planning surfaces — never in a contributor view.** `GuardrailNotice`, `GuardrailBlock`, and Tier-3 health badges live in the schedule/sprint-planning/settings surfaces (task drawer `SprintSection`, board, sprint panel). They must never be imported into the contributor `me`/"My Work" tree, and guardrail warnings must never become a push notification (Priya non-goal — enforced structurally by *where* the component mounts, not a runtime role check).

141. **Guardrail copy uses outcome language, never WBS jargon.** User-facing strings come from the server in consequence terms ("This double-counts in velocity", "Phases group work; assign the tasks inside it instead") — never structural terms like "WBS L1 root" or "summary task". The frontend renders the server `detail` verbatim; it does not synthesize its own jargon copy.

## Design System v2.0 — Navy/Sage Brand (ADR-0103)

> The full token + role mapping is ADR-0103; the gold standard is the brand
> package at `packages/web/brand/` (`brand-guidelines.html`). `brand-primary` is
> now mode-aware **sage** (sage-600 #3E8C6D light / sage-400 #66B998 dark) — it
> reverses itself, so most pre-v2 rules that cite `brand-primary` are still
> correct; only the green hex *figures* changed. Rules 142–148 are the deltas.

142. **The brand mark is the duotone dependency-arrow `LogoMark`** (`Icons.tsx`) — navy nodes (`fill-navy-700 dark:fill-reversed`) + sage arrow (`fill-sage-500`, holds in both modes). Never `currentColor` (it is two-color). The wordmark (`Logo.tsx`) is **"True" navy + "PPM" sage**, `font-display` (Space Grotesk) Bold `-0.02em`, no space; the accessible name lives on the lockup's `aria-label` (the visible text is split across spans — assert it via `getByLabelText`/`getByRole`, never `getByText('TruePPM')`). Render ≥24px; below 28px use the favicon build.

143. **Sage shade discipline (WCAG).** sage-500 `#4FA884` = **fills only**, always with navy text (navy-on-sage 6.8:1); it is ~2.9:1 on white so it is **never** body text, a foreground icon, or a thin border on a light surface. **sage-700 `#316F57` = foreground text / link / ring / border on light (5.93:1)** — this is what `brand-primary` resolves to in light mode. (sage-600 `#3E8C6D` is only **4.06:1** on white — it fails AA for normal text; it is a *fill/dot* weight, e.g. the on-track `-bg` tint, never foreground text.) sage-400 `#66B998` = text/affordance on **dark**. Putting sage-500 or sage-600 on white as foreground text is a 1.4.3 failure — use sage-700.

144. **Primary actions use the shared `Button` component** (`src/components/Button.tsx`), not ad-hoc `bg-brand-primary` fills. `variant="primary"` is the brand recipe `bg-sage-500 text-navy-900 border-sage-600` (+ sage-400 fill on dark). New primary/secondary/ghost/danger buttons import `Button`; do not hand-roll the fill recipe.

145. **Semantic amber/red: brand hue is a FILL, on-light text keeps the AA-dark variant.** at-risk fill/dot `#DE9326` but text/border `#92400E`; critical fill/dot `#CF4438` but text/border `#B91C1C`. Never set `text-semantic-at-risk`/`text-semantic-critical` to the brand hue — those brand values fail AA as text on white (2.4:1 / 4.0:1). on-track `#3E8C6D` and info `#2F6FD1` are AA as text and used directly.

146. **Canvas selection ring is navy/reversed, never sage** (rule 83). Because sage carries both action and positive-state, the navy ring is what stays visible on a sage complete bar. Triad: complete = sage *fill*, today = sage *line*, selected = navy *ring*. Two sage meanings on one surface must differ by component geometry + a text/icon label, never hue alone (1.4.1).

147. **Body ink and dark surfaces are navy.** `--neutral-text-primary` = navy `#1B2A4A` (light) / reversed `#E9EDF3` (dark). Dark surfaces are navy: `--neutral-surface` #15223C, `--chrome-surface` #0E1626. (Canvas bar-label `COLOR.text` stays `#1A1917` — legibility-tuned for bar fills, rule 72; the divergence is intentional.)

148. **Three type families (brand §06):** `font-display` (Space Grotesk) for display/wordmark/big numbers; `font-sans` (Inter) for UI/body; `.tppm-mono` (JetBrains Mono, rule 8c) for data. Load via the `index.html` Google-Fonts link.

## Sprint Scope-Injection Approve-Gate Rules (Issue #882, ADR-0102)

149. **Pending acceptance is a neutral read-state, not a warning — and it has one shared chip.** A task injected into an active sprint after activation (`task.sprintPending`) renders the shared `features/board/PendingAcceptanceChip.tsx`: neutral/gray surface (`bg-neutral-surface-sunken` + `text-neutral-text-secondary`) with a hollow `○` glyph — **never amber or red**, never a semantic at-risk/critical token. Pending means "visible but not yet committed", which is a state, not a problem. The same component renders on the planning board card and the contributor "My Work" row so the two surfaces can never drift in tone. Copy is outcome-language ("Pending acceptance"), never state-machine jargon.

150. **Accept is additive (confirm-toast, no undo); reject is destructive (proceed-then-undo).** A single-item accept is a one-tap ✓ with **no confirmation dialog and no undo** — it only adds work to the commitment, which is recoverable by rejecting later; it surfaces a confirmation toast. A single-item reject removes the task from the sprint, so it is a **proceed-then-offer-undo** action (undo re-links via sprint-assign), mirroring the rule-138 guardrail pattern. **Bulk** accept/reject is the one carve-out that uses a confirm dialog (one aggregated confirm for all N pending, never N toasts) because batch decisions are higher-stakes than a single tap. Reason/note fields, where shown, are always optional and never gate the proceed action (rule 139 carryover).

151. **Scope affordances are gated by `useCanManageScope` and never mount in the `me` tree.** The accept ✓, the reject overflow item, the board banner's `Review` button, and the `ScopePendingReviewPanel` controls render only when `useCanManageScope(projectId)` is true (role >= `ROLE_ADMIN`) — this is a **render-gate only**; the server enforces the real gate (role >= ADMIN **and** a real `ProjectMembership` on the task's project) and returns `403 scope_accept_forbidden` regardless of role ordinal, which the client treats as authoritative. The contributor "My Work" tree gets the passive `PendingAcceptanceChip` and **nothing else** — no accept/reject controls ever mount there (the decision is team-owned; the chip is a passive read-state, not a guardrail notice or a notification).

152. **Accept/reject are not offline-queueable — disable, do not queue.** When offline (`!navigator.onLine`), the pending chip still renders from synced data, but every accept/reject control is **disabled with an explanatory `title`** and the action is **never queued**. A stale offline accept could re-commit work the team rejected (or vice-versa) on reconnect; the decision must be made against live state. This is the deliberate exception to the optimistic-write pattern used elsewhere — scope decisions fail closed offline.

153. **Forecast-transparency copy is a shared, API-driven string gated on `pending_count > 0`, planning surfaces only.** Any commitment/forecast surface that can have pending items behind it (sprint panel committed line, burndown caption) renders `forecastScopeCaption(sprint.pending_count)` — the single shared helper in `features/sprints/sprintMath.ts` returning `"Forecast reflects accepted scope only — N pending acceptance"` — so the surfaces can never word it differently, and the client never derives the count (the API supplies `sprint.pending_count`). It renders `null` (nothing) when `pending_count <= 0` — no "0 pending" noise. This copy belongs on planning surfaces only, never the contributor view.

## Team Settings + Facet Axis Rules (Issue #927, ADR-0078)

154. **The Project Settings → Team tab is methodology-gated in 0.3, not team-count-gated.** The tab (`features/settings/team/ProjectTeamPage.tsx`) renders in the Setup nav group iff `project.methodology` is `AGILE` or `HYBRID` (hidden on `WATERFALL`) — so waterfall projects never see Team UI. This is deliberately **not** the ADR-0078 §F single-team-invisibility rule: that rule (`team_count === 1` → hide) governs *multi-team chrome* (team picker, team-name labels, Sprint/Task team fields), which this tab does not render until #599. With only the auto-created default team existing in 0.3, a count gate would hide the tab forever and make facet assignment impossible, defeating the issue. Gate by methodology; the tab shows the single default team's role+facet matrix with no multi-team chrome.

155. **Role and facets are independent axes; the two facets are soft-singletons reassigned by the server.** A `TeamMemberRow` carries a team-role `<select>` (Member/Admin) plus two `role="switch"` facet toggles (`FacetToggle`) for Scrum Master and Product Owner — never conflate them (an Admin need hold no facet; a Member can be Product Owner). Turning a facet **on** when another member already holds it does **not** PATCH immediately: the page shows an inline `role="alertdialog"` confirm ("{holder} is currently {facet}. Make {target} the {facet} instead?") with Reassign/Cancel, because the server clears the prior holder (at most one per team). Turning a facet **off** is immediate (the facet may sit vacant). On success, invalidate the whole `['team-members', teamId]` query — the prior holder's row changed too, so never patch a single row optimistically.

156. **Edit rights follow the ADR-0078 §D low-consent split: project Admin+ OR explicit team Admin.** `canEdit` is `myRole >= ROLE_ADMIN` (project inheritance) **or** the caller's own team-membership row has `role === 'admin'`. Read-only callers (viewers, plain members) get the same roster with the role `<select>` replaced by static text and the switches `disabled` — facet badges stay visible so everyone can *see* who the SM/PO is. The server enforces the same gate (`IsTeamFacetEditor`) and 403s regardless; the render-gate is UX only.

## Icon-prefixed input focus (Issue #933)

157. **Icon-prefixed inputs ring the wrapper, not the input (rule 4 corollary).** When an `<input>` sits inside a bordered `<span>`/`<div>` alongside a leading icon — the `flex items-center gap-2 rounded-md border … h-9` field pattern used in `PromoteMilestoneDialog` (`CreateModeBody`, `BindModeBody`) — the rule-4 focus ring goes on the **wrapper** via `focus-within:ring-2 focus-within:ring-brand-primary focus-within:ring-offset-1`, with `focus-visible:outline-none` on the inner input. Stripping the input's outline without a wrapper ring leaves the field with **no** focus indicator (WCAG 2.4.7) — the regression the #933 ux-review caught. A bare text/date input with no icon wrapper rings itself directly, per `PlanSprintModal`. (Same `focus-within` rationale as rule 124's settings search box.)

## Program visual identity & wayfinding (Issue #963)

158. **Program color is identity, not status — shape encodes the signal, color is the value.** A program's `program.color` renders ONLY through `ProgramIdentitySquare` (`features/programs/ProgramIdentitySquare.tsx`) — a rounded **square**. Project/program *health* renders ONLY as a **circle** dot (the existing `ProjectListItem`/`HealthDot`). The square-vs-circle distinction is the firewall that keeps an accent hue (even green) from ever reading as a status. Never tint the identity square by health, never render it as a hollow outline, and never render `program.color` directly in a component — the dynamic accent goes through the `style` prop only (rule 10), with the palette + `contrastText()` single-sourced in `programColor.ts` (no hex literals, rule 8). **Unset color is the common case** and is a faint **filled** `bg-neutral-surface-sunken` square, never health-tinted. The square is always `aria-hidden`; the program **name** is the accessible signal (rule 6). Sizes: `sm` (10px, wayfinding dot, no label) / `md` (16px) / `lg` (36px, `showLabel` renders ≤3-char code-or-initials). Per-row squares are only for genuinely **cross-program** lists; a single-program board marks the program **once in its header** (the #959 redundant-per-row-tag lesson).

159. **WIP-limit indicators use the shared three-band `wipState()` — never a local `count > limit` check.** Every WIP-limit surface (board column header/badge, the sprint-panel header chip, future swimlane/column counters) imports `wipState(count, limit)` from `features/board/wip.ts` and maps the band to chrome identically: `under` → neutral, `at` (count === limit) → `text-semantic-at-risk` amber, `over` → `text-semantic-critical` red (rule 145 keeps those as the AA-dark text variants, never the brand fill hue), `none` (limit null) → suppressed/neutral. A `5/5` at-limit state must read amber everywhere and never neutral on one surface and amber on another — a two-band local check is the drift bug the #546 ux-review caught. Color is never the sole cue: pair the flagged bands with a `⚠` glyph (`aria-hidden`) and an aria-label that names the band ("at limit" / "over limit"), per rule 107 (WCAG 1.4.1).

160. **The sprint-timeline selected-card ring is navy, never sage (rule 83/146 corollary).** `SprintTimelineStrip`'s selected card uses `ring-2 ring-navy-700 ring-offset-1 dark:ring-reversed` — NOT `ring-brand-primary` (which resolves to sage). The active card carries a sage on-track tint (`bg-semantic-on-track-bg`) + a sage progress fill, so a sage selection ring would put two sage meanings on one surface (action/positive + selected), a WCAG 1.4.1 hue-only collision. Selection = navy ring; active-but-unselected = the faint sage `ring-brand-primary/30` tint; the two never share hue. Same rule that keeps the canvas selection ring navy (rule 83), extended to the sprint-card selector (#567 ux-review).

## Responsive labels & presentational headers (Issue #975 / #974)

161. **A responsive abbreviation must always carry its full accessible name.** When a control shows a short label at narrow widths and the spelled-out term at `md:`+ — the `<span className="hidden md:inline">{full}</span><span className="md:hidden">{abbrev}</span>` pattern established by the Signal-privacy ladder rungs (`SignalLadder.tsx`), the matrix-lens column headers (`SignalMatrixLens.tsx` `<th>`), and any future status/role chip — the **full** term must be the element's `aria-label` (and `title` for hover) so a screen reader or pointer never gets the ambiguous abbreviation regardless of which span is visible. The decorative abbrev/full spans carry no `aria-*`. Where horizontal space always allows (a roomy vertical list, e.g. the raise-ceiling radio options), skip the responsive split and render the full term directly. A single source-of-truth label map pairs the abbreviated and full forms (`AUDIENCE_RUNG_LABEL` / `AUDIENCE_RUNG_LABEL_FULL`); never inline either string.

162. **An `aria-hidden` visual column-header row is the correct pattern when every column's control already carries its own accessible name and the mobile layout re-labels inline.** The Project → Team facet roster (`ProjectTeamPage.tsx`) renders a `hidden sm:flex` header row (`Member / Role / Scrum Master / Product Owner`) that is `aria-hidden="true"`: the role `<select>` and the two facet `role="switch"` toggles each own their `aria-label`, and the `< sm` layout labels each control inline per row, so a SR-exposed header would only duplicate. Do not "fix" such a header by removing `aria-hidden` (it re-introduces the duplication) and do not drop the header (sighted desktop users lose the column key). Column widths in the header must mirror the row's exactly (`flex-1 / w-32 / w-36 / w-36` + `gap-3 px-4`).

## Progress / commitment bars (Issue #1107)

163. **A bar that can exceed its target never clamps to 100% — it scales to `max(target, actual)` and shows the overage past a capacity marker.** The `CommitmentBar` in `SprintTimelineStrip.tsx` is the reference: bar width represents `max(committed, completed)`; the on-track portion (`0→committed`) fills `bg-semantic-on-track`; the overage (`committed→completed`) fills `bg-semantic-at-risk`; a 2px `bg-neutral-text-primary` **capacity tick** (`aria-hidden`) marks the target line and is rendered **only when over** (under target, the bar end *is* the target). A clamped `Math.min(actual/target, 1)` bar that reads "done" when a sprint actually over-delivered is the bug this rule prevents (the #1107 VoC blocker). Colour is never the sole cue (1.4.1): pair the overflow with a text label carrying the count — `⚠ +{N} over` in `text-semantic-at-risk` (the `⚠` is `aria-hidden`; the count stays `.tppm-mono` per rule 8c — do **not** swap font-family mid-line). ARIA keeps `valuenow ≤ valuemax` by scaling `aria-valuemax` to the bar denominator and naming the target + overage in `aria-label` (`"{actual} of {target} … {N} over commitment"`), never `valuenow > valuemax`. The capacity tick uses `neutral-text-primary` (not a semantic hue) so it reverses to light in dark mode (rule 147) and clears 1.4.11 3:1 on both the green and amber fills. Reuse this anatomy for any future budget/capacity/load bar that can exceed its reference.

## List-detail inline-edit drawers (Issue #1043)

164. **A detail drawer opened from a list/backlog row owns a local deferred Save bar — never `useDirtyForm`.** The Product Backlog `StoryDetailDrawer` (`features/project/backlog/`) is the reference. It inline-edits an entity's scalar fields via a **drawer-local** model: a `dirty = JSON.stringify(draft) !== JSON.stringify(initial)` compare, a footer Save bar (`shrink-0 border-t`, hidden until dirty) that batches **all changed scalar fields into one PATCH** (send only the changed keys so a Member's title-only edit never posts Admin-gated structural fields), a Cancel that reverts to `initial`, and a discard-guard on Esc/✕/row-swap when dirty. It MUST NOT call `useDirtyForm`/`useSettingsSaveStore` (rule 115) — that hook publishes into the `SettingsShell` save bar, which is not mounted outside `/settings`. **Three carve-outs mutate immediately (optimistic, outside the dirty batch)**, because each is a different endpoint, gate, or server-owned toggle: (a) child-collection items on their own flat endpoint (acceptance criteria — Member+ writes to `/acceptance-criteria/`, while the scalar batch is Admin+/PO); (b) a single server-gated state toggle whose validity the drawer reflects live (Definition of Ready — the readiness gate re-evaluates as AC/points change in the same drawer); (c) a live computed preview (the scoring `score` is recomputed client-side to mirror the server `compute_score` exactly — same formula, same "any input missing OR denominator falsy → `—`" rule, 1-decimal; `scorePreview.ts`). **Fields whose server permission gate differs from the caller's role render read-only** (the scoring/type/epic structural fields are `useCanManageBacklog` / Admin+ / PO-facet; below that they are static reads with a one-line "managed by the Product Owner" note, never disabled inputs that imply editability). The selected row carries a **navy** selection ring (`ring-2 ring-inset ring-navy-700 dark:ring-reversed`), never sage — sage `ring-brand-primary` is already the drag-lift state (rule 102a) and the focus ring (rule 4), so selection must differ by hue (rules 146/160). The desktop drawer is non-modal (`aria-modal="false"`, no focus trap, no backdrop — the list stays usable, rule 89); only the mobile bottom sheet is modal. The drag handle calls `e.stopPropagation()` so a handle tap reorders without opening the drawer; the row body opens it.
