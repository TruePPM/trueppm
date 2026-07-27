# Rule 43 — Gantt column layout

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *UI Harmonization Rules (Issue #44)*

**Gantt column layout** — the task list has five resizable columns: **Task** (name + WBS indent), **Dur** (duration in days, e.g. `14d`), **Start** (early start, e.g. `Apr 9`), **Finish** (early finish, e.g. `Apr 21`), **%** (progress, text only — no mini bar). Column widths are persisted in localStorage under `trueppm.gantt.columnWidths.v4`. Default widths: task=220, dur=52, start=74, finish=74, progress=44. Full-height `border-r border-neutral-border/20` dividers appear on Task, Dur, Start, and Finish columns; the header resize-handle indicator is right-aligned within its hit zone to align with the row borders. Dur/Start/Finish/% visibility is persisted in localStorage under `trueppm.gantt.columnVisibility.v1` and toggled via the Columns popover in the toolbar.
