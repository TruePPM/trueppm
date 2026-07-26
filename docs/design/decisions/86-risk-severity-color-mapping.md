# Rule 86 — Risk severity color mapping

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Risk Register Rules*

**Risk severity color mapping** — always use these token pairs for severity labels and chips.
Never use ad-hoc colors. Each pair clears WCAG 1.4.3 4.5:1 on its own surface **as written
here** — the amber HIGH text is `text-brand-accent-text` (#92400E), NOT `text-brand-accent-dark`
(#C17A10): the `-dark` token is a fill/border weight and only 3.13:1 as text on the accent-light
tint (the false-"all pass" claim corrected in #2197). `text-brand-accent-text` is the readable
amber foreground (≥6:1 on #FFF3CD); pair it with the `dark:` override.
Dark mode alternates are required — `bg-brand-accent-light` (#FFF3CD) is white and flashes in dark mode.
Light → Dark overrides:
- CRITICAL (20–25): `text-semantic-critical bg-semantic-critical-bg` (semantic tokens adapt automatically via CSS vars)
- HIGH (12–19): `text-brand-accent-text dark:text-brand-accent bg-brand-accent-light dark:bg-brand-accent/20`
- MEDIUM (6–11): `text-neutral-text-primary bg-brand-accent-light/50` (neutral tokens adapt via CSS vars)
- LOW (2–5): `text-neutral-text-secondary bg-neutral-surface-raised` (neutral tokens adapt via CSS vars)
- MINIMAL (1): `text-neutral-text-secondary bg-neutral-surface-sunken` (neutral tokens adapt via CSS vars)
The severity chip is read-only in the UI — always computed from `probability × impact`.
