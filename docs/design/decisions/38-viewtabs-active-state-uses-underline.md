# Rule 38 — ViewTabs active state uses underline

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *UI Harmonization Rules (Issue #44)*

**ViewTabs active state uses underline** — `border-b-2 border-brand-primary` — not pill/outlined. Pill style is reserved for the secondary Gantt toolbar (rule 42) to maintain a clear visual hierarchy between top-level navigation and sub-view options. If a pill border is ever used for tabs, it must meet WCAG 1.4.11 3:1 against `bg-neutral-surface`; `border-neutral-border` (#D4D2CE) fails at ~1.51:1.
