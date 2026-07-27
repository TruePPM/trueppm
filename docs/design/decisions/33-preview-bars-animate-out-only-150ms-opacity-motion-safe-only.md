# Rule 33 — Preview bars animate out only (150ms opacity, motion-safe only)

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Drag Preview Rules (Issue #19)*

**Preview bars animate out only (150ms opacity, `motion-safe` only)** — they appear immediately; animation on entry causes flicker during fast drags.
