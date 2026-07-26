# Rule 30 — aria-live region is written via DOM ref, not React state

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Drag Preview Rules (Issue #19)*

**`aria-live` region is written via DOM ref, not React state** — prevents re-render storms on every pointermove event.
