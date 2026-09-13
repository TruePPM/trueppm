# Rule 8c — `.tppm-mono` applies JetBrains Mono with tabular numerals

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Color and tokens*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**`.tppm-mono` applies JetBrains Mono with tabular numerals** — use it on every numeric value: KPIs, percentages, dates, durations, counts, build hashes. It is defined as a Tailwind utility in `globals.css` and maps to `font-family: 'JetBrains Mono'; font-feature-settings: "tnum"`.
