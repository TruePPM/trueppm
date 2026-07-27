# Rule 132 — Pan discoverability lives as one line in the ScheduleLegend body, not a toast

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Schedule View Interaction Rules (Issues #351 / #491)*

**Pan discoverability lives as one line in the `ScheduleLegend` body, not a toast.** The hint "Hold Space + drag, or middle-drag, to pan" is a single `text-xs text-neutral-text-secondary` line under a `border-t` divider at the bottom of the legend body (rule 50 floor; not `tppm-mono`). The legend is the established "what do these affordances mean" surface — do not add a tutorial toast or coachmark that fires on every Schedule open.
