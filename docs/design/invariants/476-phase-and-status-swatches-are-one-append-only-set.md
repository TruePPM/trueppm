# Rule 476 — Phase and status swatches are one append-only set in `identityColors.ts`

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Color and tokens*. The index carries the rule's headline; this file carries its full text (#1783).

**Every surface that offers or derives a phase or status color reads `PHASE_SWATCHES` from `src/lib/identityColors.ts`. A value in that set may be added, never changed or removed.**

**Why.** The settings picker writes these hex strings to the server (a phase's `color`, a board column's `color`). Changing or dropping a value leaves saved rows rendering a color no swatch matches. The board rail and the picker had separate 8-color sets for the same concept, so the two never agreed.

**How to apply.** Import the set; do not declare a local swatch array. Each entry carries a `name`, which the swatch button announces (never the hex). `identityColors.test.ts` pins the values.
