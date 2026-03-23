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

13. **Gantt bar label color**: always `#1A1917` — never white. All Tailwind 400-stop bar colors fail WCAG 4.5:1 contrast with white at 10–11px font size.
14. **Gantt bar heights**: normal/critical/complete = 18px; summary = 8px; milestone diamond = 12px; baseline ghost = 6px.
15. **Task list row height**: 28px fixed — required for scroll sync with SVAR's internal row height.
16. **`readonly={true}` on `<Gantt>`** until WASM CPM drag (issue #19) is implemented — prevents partial drag UX.

## Monte Carlo Row Rules

17. **MC row height is 44px** — outside the virtualizer; does not participate in scroll sync (not 28px like task rows).
18. **MC bars use semantic tokens only** — P50 = `border-semantic-on-track` (solid), P80 = `border-semantic-at-risk` (dashed), P95 = `border-semantic-critical` (dotted). No other colors.
19. **MC bars use stroke-pattern differentiation** (solid / dashed / dotted) in addition to color — required for WCAG 1.4.1 (use of color).
20. **MC histogram SVG bars use `fill-neutral-text-disabled`** — distribution shape is neutral; semantic colors are reserved for the percentile rule lines only.
21. **P80 badge uses `bg-semantic-at-risk/10 text-semantic-at-risk`** — not brand-accent tokens.
22. **MC row and P80 badge are `hidden md:flex`** — suppressed below 768px; mobile surface is deferred.

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
