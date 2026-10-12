# Rule 169 — `neutral-text-disabled` is for inert/disabled affordances ONLY — never for readable content

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Accessibility floors*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**`neutral-text-disabled` is for inert/disabled affordances ONLY — never for readable content.** The token resolves to `#A09D99` (~2.66:1 on white) light / `#64748B` (~3.7:1 on navy) dark — both below the WCAG 1.4.3 AA 4.5:1 floor for normal text. De-emphasized but *readable* content — timestamps, "by {user}" attributions, parenthetical context (the `SprintDailyDeltaPanel` since-hint and burndown `prior → current` context were the #925 ux-review 🔴) — must use `neutral-text-secondary` (4.63:1 light / 7.45:1 dark, passes), and lean on **size/weight** for the quieter visual hierarchy, not a sub-AA color. Reserve `neutral-text-disabled` for genuinely non-interactive/disabled controls where the low contrast *is* the "you can't use this" signal. Corollary (the #925 burndown 🔴): when meaning is carried by an `aria-hidden` glyph + semantic color (an ▲/▼ arrow + green/amber), the accessible name must restate that meaning in words (`aria-label="Remaining work down 8 points — on track"`), not just the raw number — the SR user otherwise loses the polarity a sighted user reads from the arrow/color (1.4.1).

**Superseded 2026-10 (#4379, rule 435).** The 4.5:1 floor is no longer the reason to
route informational/readable text to `neutral-text-secondary` instead of
`neutral-text-disabled` — the disabled token was darkened to `#686663` light /
lightened to `#7F93B0` dark and now clears 4.5:1 on every neutral surface in both
themes. It is still the more muted of the two tokens (by design, picked as the
closest-to-AA-floor value so it stays visually distinct from secondary rather than
converging on it), but the AA-exemption rationale above is gone. See rule 435.
