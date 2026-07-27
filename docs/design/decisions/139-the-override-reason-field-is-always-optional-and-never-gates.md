# Rule 139 — The override reason field is always optional and never gates the proceed action

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Sprint/Phase/WBS Guardrail Rules (Issue #875, ADR-0101)*

**The override reason field is always optional and never gates the proceed action.** `GuardrailNotice`'s note input is collapsed behind a `▸ Add a note (optional)` toggle and is one-tap-skippable; `Keep it here` works with an empty reason. No policy tier may make it required at the warn level — the override is recorded server-side via the task's history regardless.
