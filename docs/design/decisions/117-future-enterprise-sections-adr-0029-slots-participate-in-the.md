# Rule 117 — Future enterprise sections (ADR-0029 slots) participate in the same contract

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Settings Shell Save Contract (Issue #536)*

**Future enterprise sections (ADR-0029 slots) participate in the same contract.** A slot-registered enterprise section MUST NOT render its own save bar; it publishes dirty state via `useDirtyForm` to the shell's save bar, just like a built-in page.
