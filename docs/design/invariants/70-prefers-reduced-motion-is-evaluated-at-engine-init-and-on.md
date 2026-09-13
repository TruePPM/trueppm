# Rule 70 — `prefers-reduced-motion` is evaluated at engine init and on media query change

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Motion*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**`prefers-reduced-motion` is evaluated at engine init and on media query change.**
When true: disable the today-line pulse, CP-flip animation, preview-bar fade,
scroll-to-date smooth behavior. Functionality is never disabled — only motion.
