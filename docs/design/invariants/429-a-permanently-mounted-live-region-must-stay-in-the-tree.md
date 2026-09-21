# Rule 429 — A permanently-mounted live region must stay in the accessibility tree while empty, and responsive copy hidden with `hidden` is hidden from AT too

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Accessibility floors*. The index carries the rule's headline; this file carries its full text. Binding everywhere, not only on the surface that produced it.

**`display:none` removes a node from the accessibility tree.** Two patterns in this codebase are built on the opposite assumption, and both fail silently — nothing in `tsc`, eslint, vitest or axe reports them, because the markup is valid and the text is present in the DOM.

**1. The mounted-empty live region.** Rule 335's pattern — mount `role="status"` / `aria-live` permanently and empty, then inject text into it — exists because a region that appears *with* its content is announced inconsistently across screen readers. `empty:hidden` defeats it exactly: while the region is empty it is `display:none` and therefore **not in the tree**, so the instant text arrives the region and its content enter together. That is conditional rendering wearing the mounted-region pattern's clothes. Hide it with **`empty:sr-only`** (or a zero-height `overflow-hidden` box) — in the tree, no layout. `ScheduleView`'s assertive region is the reference: plain `sr-only`, always mounted.

**2. Responsive copy.** `hidden md:inline` on the second half of a sentence does not hide it "visually only" — below `md` a screen-reader user hears the shorter sentence and a sighted user at `md` reads the longer one. Where the full sentence must reach every user, the mechanism is **`sr-only md:not-sr-only`**, not `hidden`. Where the shorter sentence is genuinely acceptable on a small screen, `hidden` is fine — but then say so, and do not claim the truncation is visual.

**The tell is a comment asserting the guarantee.** Both instances of this class shipped with a comment stating that assistive technology still reads the whole thing. A comment is not a mechanism, and here it was the only thing standing behind the claim. When you write "visually only", check which utility you actually used.
