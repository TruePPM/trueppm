# Rule 37 — Sidebar active-row indicator

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *UI Harmonization Rules (Issue #44)*

**Sidebar active-row indicator** is a 2px left border (`border-l-2 border-brand-primary`) in addition to `bg-brand-primary/10`. The border is the primary non-color visual signal; background fill is secondary. Never use border alone without the fill.
