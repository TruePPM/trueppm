# Rule 476 — Phase and status swatches are one append-only set in `identityColors.ts`

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Color and tokens*. The index carries the rule's headline; this file carries its full text (#1783).

**Every picker that saves a phase or board-status color offers `PHASE_SWATCHES` from `src/lib/identityColors.ts` (today the project workflow settings and the board column settings). A value in that set may be added, never changed or removed.**

**Why.** Both pickers write these hex strings to the server (a phase's `color`, a board column's `color`), and the board's default columns use them too. Changing or dropping a value leaves saved rows rendering a color no swatch matches. The two pickers had separate 8-color sets for the same column field, so each could save a color the other did not offer.

**How to apply.** Import the set; do not declare a local swatch array for phase or status color. Each entry carries a unique `name`, which the swatch button announces (never the hex). The board's phase rail is derived, not saved: `features/board/phaseColors.ts` hashes over its own fixed list picked from the set, with no red, no gray and every pair at least 30 degrees apart in hue, so an appended swatch never recolors a rail. `identityColors.test.ts` and `phaseColors.test.ts` pin both lists. Other categorical palettes (labels, programs, board lanes) are outside this rule.
