# Rule 153 — Forecast-transparency copy is a shared, API-driven string gated on pending_count > 0, planning surfaces only

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Sprint Scope-Injection Approve-Gate Rules (Issue #882, ADR-0102)*

**Forecast-transparency copy is a shared, API-driven string gated on `pending_count > 0`, planning surfaces only.** Any commitment/forecast surface that can have pending items behind it (sprint panel committed line, burndown caption) renders `forecastScopeCaption(sprint.pending_count)` — the single shared helper in `features/sprints/sprintMath.ts` returning `"Forecast reflects accepted scope only — N pending acceptance"` — so the surfaces can never word it differently, and the client never derives the count (the API supplies `sprint.pending_count`). It renders `null` (nothing) when `pending_count <= 0` — no "0 pending" noise. This copy belongs on planning surfaces only, never the contributor view.
