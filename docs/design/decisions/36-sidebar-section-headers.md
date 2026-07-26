# Rule 36 — Sidebar section headers

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *UI Harmonization Rules (Issue #44)*

**Sidebar section headers** (`PROJECTS`, `ORG`) use `text-xs font-semibold tracking-widest uppercase text-chrome-text-secondary`. Minimum size is `text-xs` (12px) — `text-[10px]` is prohibited; fails WCAG 1.4.3. They are `<h2>` elements with `aria-label` matching the visible text. Hidden when sidebar is collapsed.
