# Rule 150 — Accept is additive (confirm-toast, no undo); reject is destructive (proceed-then-undo)

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Sprint Scope-Injection Approve-Gate Rules (Issue #882, ADR-0102)*

**Accept is additive (confirm-toast, no undo); reject is destructive (proceed-then-undo).** A single-item accept is a one-tap ✓ with **no confirmation dialog and no undo** — it only adds work to the commitment, which is recoverable by rejecting later; it surfaces a confirmation toast. A single-item reject removes the task from the sprint, so it is a **proceed-then-offer-undo** action (undo re-links via sprint-assign), mirroring the rule-138 guardrail pattern. **Bulk** accept/reject is the one carve-out that uses a confirm dialog (one aggregated confirm for all N pending, never N toasts) because batch decisions are higher-stakes than a single tap. Reason/note fields, where shown, are always optional and never gate the proceed action (rule 139 carryover).
