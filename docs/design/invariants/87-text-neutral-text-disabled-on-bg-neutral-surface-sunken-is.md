# Rule 87 — `text-neutral-text-disabled` on `bg-neutral-surface-sunken` is prohibited

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Accessibility floors*. The index carries the rule's headline; this file carries its full text (#3744, ADR-0653 amendment). Binding everywhere, not only on the surface that produced it.

**`text-neutral-text-disabled` on `bg-neutral-surface-sunken` is prohibited** — this
combination yields 1.97:1 contrast, failing WCAG 1.4.3 on all text sizes. MINIMAL severity
labels must use `text-neutral-text-secondary` (#6B6965, 3.12:1 on #EBEBEB) at minimum.
This prohibition applies everywhere in the app, not only to risk register.
The disabled token has almost no contrast headroom, so the prohibition extends to **any
surface darker than `bg-neutral-surface` (#FFFFFF)** — including `-raised`, `-sunken`, and
any `hover:bg-*` state on a row that contains disabled-token text (the hover state is the
worst case and the one that must pass AA). Informational text that must stay legible uses
`text-neutral-text-secondary` as the floor. (Surfaced by ux-review on #590.)

**Superseded 2026-10 (#4379, rule 435).** `--neutral-text-disabled` was darkened to
`#686663` light / lightened to `#7F93B0` dark, which clears 4.5:1 on every neutral
surface in both themes (4.55:1 on sunken, the binding light surface). The prohibition
above was a contrast workaround for a token that failed AA below white; it no longer
applies. See rule 435 for the current numbers and the `tokenContrast.test.ts` guard
that now enforces the floor directly on the token instead of on where it may be used.
