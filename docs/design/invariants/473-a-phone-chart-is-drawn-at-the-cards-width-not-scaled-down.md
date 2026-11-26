# Rule 473 — A chart on a phone is drawn at the card's own width, not a desktop viewBox scaled down

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md). The index carries the rule's headline; this file carries its full text (#3150).

**A chart that sits in a phone card is given the card's width and a shorter height through the chart's own `width` / `height` props (via `useBreakpoint() === 'sm'`). It is never left at its desktop 640-wide viewBox and shrunk by CSS.**

**Why.** The shared charts are SVGs with a fixed viewBox. Scaled into a ~340px card, a 640-wide viewBox renders at about half size, so axis ticks and marker labels fall below legible type. Drawing at the card's width keeps the type at its designed size.

**How to apply.** Pick the dimensions at the call site (340 x 220 for a lead S-curve at 390px). Keep the same series, markers and labels; only the geometry changes. Reference: `LeadCard` in `src/features/project/ProjectOverview2.tsx`, asserted in `e2e/overview-v2.spec.ts` ("phone layout").
