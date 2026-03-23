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
