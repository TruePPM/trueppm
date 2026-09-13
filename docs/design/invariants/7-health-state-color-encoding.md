# Rule 7 — Health state color encoding

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Color and tokens*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**Health state color encoding**:
- On-track → `text-semantic-on-track` / `bg-semantic-on-track`
- At-risk → `text-semantic-at-risk` / `bg-semantic-at-risk`
- Critical → `text-semantic-critical` / `bg-semantic-critical`
- Unknown → `text-neutral-text-secondary` — **never `-disabled`**, which is 2.66:1 and fails WCAG 1.4.3 for anything a reader must read (rule 169). `-disabled` is for inert affordances; an unknown or unavailable health is *status text*. This row said `-disabled` until #3525, one rule away from the code that adds a fourth muted health read (the health chip's `Health —` when `status-summary` fails, which correctly uses `-secondary`). A genuinely value-less placeholder — the em dash in `ForecastRows` / `VelocityRow` — may keep `-disabled`; a word may not.
