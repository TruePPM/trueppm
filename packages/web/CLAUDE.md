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
