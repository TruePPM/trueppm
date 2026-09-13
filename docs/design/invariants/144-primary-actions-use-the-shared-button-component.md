# Rule 144 — Primary actions use the shared `Button` component

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Color and tokens*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**Primary actions use the shared `Button` component** (`src/components/Button.tsx`), not ad-hoc `bg-brand-primary` fills. `variant="primary"` is the brand recipe `bg-sage-500 text-navy-900 border-sage-600` (+ sage-400 fill on dark). New primary/secondary/ghost/danger buttons import `Button`; do not hand-roll the fill recipe.
