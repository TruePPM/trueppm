# Rule 141 — Guardrail copy uses outcome language, never WBS jargon

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Sprint/Phase/WBS Guardrail Rules (Issue #875, ADR-0101)*

**Guardrail copy uses outcome language, never WBS jargon.** User-facing strings come from the server in consequence terms ("This double-counts in velocity", "Phases group work; assign the tasks inside it instead") — never structural terms like "WBS L1 root" or "summary task". The frontend renders the server `detail` verbatim; it does not synthesize its own jargon copy.
