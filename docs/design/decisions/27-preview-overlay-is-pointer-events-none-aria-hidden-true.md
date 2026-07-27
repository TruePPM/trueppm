# Rule 27 — Preview overlay is pointer-events-none aria-hidden="true"

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Drag Preview Rules (Issue #19)*

**Preview overlay is `pointer-events-none aria-hidden="true"`** — never intercepts pointer events; all drag events route through SVAR.
