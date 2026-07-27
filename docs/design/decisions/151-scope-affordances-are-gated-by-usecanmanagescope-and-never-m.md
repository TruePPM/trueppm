# Rule 151 — Scope affordances are gated by useCanManageScope and never mount in the me tree

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Sprint Scope-Injection Approve-Gate Rules (Issue #882, ADR-0102)*

**Scope affordances are gated by `useCanManageScope` and never mount in the `me` tree.** The accept ✓, the reject overflow item, the board banner's `Review` button, and the `ScopePendingReviewPanel` controls render only when `useCanManageScope(projectId)` is true (role >= `ROLE_ADMIN`) — this is a **render-gate only**; the server enforces the real gate (role >= ADMIN **and** a real `ProjectMembership` on the task's project) and returns `403 scope_accept_forbidden` regardless of role ordinal, which the client treats as authoritative. The contributor "My Work" tree gets the passive `PendingAcceptanceChip` and **nothing else** — no accept/reject controls ever mount there (the decision is team-owned; the chip is a passive read-state, not a guardrail notice or a notification).
