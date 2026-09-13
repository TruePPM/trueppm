# Rule 120 — Health/variance values pair color with a non-color signal (rule-12 reinforcement for rollups)

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Signal encoding*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**Health/variance values pair color with a non-color signal (rule-12 reinforcement for rollups).** A health band card shows the band *text* ("At risk") alongside the semantic color and an `aria-label` on any pill; a day-variance shows a signed `+9d` / `-3d` so the sign — not only the color — conveys late-vs-early. Counts and scores are plain numerals. This keeps KPI cards WCAG 1.4.1-compliant without a legend.
