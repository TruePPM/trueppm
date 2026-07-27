# Rule 138 — Guardrail warnings are inline, proceed-then-offer-undo notices — never a blocking modal

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Sprint/Phase/WBS Guardrail Rules (Issue #875, ADR-0101)*

**Guardrail warnings are inline, proceed-then-offer-undo notices — never a blocking modal.** A Tier-1 guardrail (summary/phase/recurring/out-of-window task assigned to a sprint) fires *after* the assignment already succeeds: the `GuardrailNotice` renders inline under the control with `role="status"` + `aria-live="polite"` (NOT `role="alert"`), a single `Keep it here` tap to dismiss, and `Undo` to revert. Only a Tier-2 *block* (`GuardrailBlock`) uses `role="alert"`, and it offers no override — it is resolved only by removing the offending state (`Got it` dismisses the notice; the server never changed the FK). Only bulk operations may use a confirm dialog (one aggregated confirm for N tasks, never N notices).
