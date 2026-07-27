# Rule 23 — Preview bars use ghost-fill / ghost-border tokens

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Drag Preview Rules (Issue #19)*

**Preview bars use `ghost-fill` / `ghost-border` tokens** — slate-500 at 12% / 55% opacity. No ad-hoc rgba() in components; values are defined in `tailwind.config.ts` only. Applied via `style` prop (rule 10 — dynamic values).
