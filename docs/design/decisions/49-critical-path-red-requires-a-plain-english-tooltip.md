# Rule 49 — Critical-path red requires a plain-English tooltip

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *UI Harmonization Rules (Issue #44)*

**Critical-path red requires a plain-English tooltip** — `title="This task is on the critical path — a delay here delays the project end date"` on every red task row. Color alone (WCAG 1.4.1) and a legend entry are insufficient for first-time users; the tooltip is the accessible fallback.
