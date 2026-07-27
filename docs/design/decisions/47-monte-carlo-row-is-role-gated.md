# Rule 47 — Monte Carlo row is role-gated

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *UI Harmonization Rules (Issue #44)*

**Monte Carlo row is role-gated** — hidden for the Contributor RBAC role; visible for PM, Resource Manager, PMO Director, and Executive roles. Use a role-check hook (`useCurrentUserRole()`) to gate the `MonteCarloRow` render, not CSS visibility. Contributor-role users must not see P50/P80/P95 terminology without context.
