# Rule 438 — bare `border-chrome-border` falls back to `--chrome-border-opacity`

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Color and tokens*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**A bare `border-chrome-border` falls back to `--chrome-border-opacity` (~8%); an explicit `/N` overrides it.** `tailwind.config.ts` resolves the no-modifier case to the token's own alpha, because Tailwind's `<alpha-value>` would otherwise resolve to 1 and paint a solid black or white rule (#4765). The opacity scale has **no step 12** (only `8` was added) — `/12` compiles to nothing, so use a scale step or an arbitrary `/[0.12]`. `tokenContrast.test.ts` compiles the real utility and fails if the hairline alpha exceeds 0.2 or the hairline is not fainter than `--chrome-text-secondary` in either theme.
