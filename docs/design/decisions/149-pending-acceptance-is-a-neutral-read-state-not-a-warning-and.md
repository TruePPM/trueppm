# Rule 149 — Pending acceptance is a neutral read-state, not a warning — and it has one shared chip

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Sprint Scope-Injection Approve-Gate Rules (Issue #882, ADR-0102)*

**Pending acceptance is a neutral read-state, not a warning — and it has one shared chip.** A task injected into an active sprint after activation (`task.sprintPending`) renders the shared `features/board/PendingAcceptanceChip.tsx`: neutral/gray surface (`bg-neutral-surface-sunken` + `text-neutral-text-secondary`) with a hollow `○` glyph — **never amber or red**, never a semantic at-risk/critical token. Pending means "visible but not yet committed", which is a state, not a problem. The same component renders on the planning board card and the contributor "My Work" row so the two surfaces can never drift in tone. Copy is outcome-language ("Pending acceptance"), never state-machine jargon.
