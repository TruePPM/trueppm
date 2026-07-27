# Rule 140 — Guardrail / health UI mounts only on planning surfaces — never in a contributor view

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Sprint/Phase/WBS Guardrail Rules (Issue #875, ADR-0101)*

**Guardrail / health UI mounts only on planning surfaces — never in a contributor view.** `GuardrailNotice`, `GuardrailBlock`, and Tier-3 health badges live in the schedule/sprint-planning/settings surfaces (task drawer `SprintSection`, board, sprint panel). They must never be imported into the contributor `me`/"My Work" tree, and guardrail warnings must never become a push notification (Priya non-goal — enforced structurally by *where* the component mounts, not a runtime role check).
