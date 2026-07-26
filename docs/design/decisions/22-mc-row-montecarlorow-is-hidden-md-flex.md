# Rule 22 — MC row (MonteCarloRow) is hidden md:flex

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Monte Carlo Row Rules*

**MC row (`MonteCarloRow`) is `hidden md:flex`** — suppressed below 768px. The P80 badge in `TopBar` is `hidden md:flex` (desktop only). Mobile surfaces P80 via a chip in `StatusBar` (`md:hidden`) — resolved by issue #33. `MonteCarloLabel` is text-only (σ + "Monte Carlo") — the previous left-side P80 chip was a duplicate of the right-side P80 chip in the timeline and was VoC-flagged as noise.
