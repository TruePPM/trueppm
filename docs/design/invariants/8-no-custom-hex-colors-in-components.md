# Rule 8 — No custom hex colors in components

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Color and tokens*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**No custom hex colors in components** — always use Design System tokens from `tailwind.config.ts`. The `design-system-v2` gate (`scripts/check-design-system-v2.sh`) ratchets hex **color literals** — a `#hex` that is quoted (`'#f59e0b'`), in a Tailwind arbitrary value (`bg-[#…]`), or a CSS value (`stroke: #fff`). It does **not** count a bare `#1236`-style issue reference in a comment, so cite issue numbers freely — do **not** rewrite them to "issue N" to appease the gate (that was a workaround for an old false positive, now fixed). If the gate fails, you added a real hardcoded color: tokenize it, don't launder the number.
