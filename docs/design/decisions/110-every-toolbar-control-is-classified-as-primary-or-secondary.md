# Rule 110 — Every toolbar control is classified as primary or secondary

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Toolbar Responsive Rules (Issue #568)*

**Every toolbar control is classified as primary or secondary.** This classification is the contract — enforce it in code review, not just implementation. Primary controls are always visible at all widths ≥ 768px. Secondary controls collapse at narrow widths (see rule 111). Canonical classification per view:
 - **Schedule toolbar**: `+ Task`, `+ Milestone`, `BUILD MODE` = primary; `CP only`, `Focus chain`, `Critical path`, `Milestones` toggles = secondary; health summary chip, `Columns`, `Today`, ZoomControl = primary. The **Export** button (`ScheduleExportButton`, #1438) is **secondary with a desk-task carve-out** from rule 111's icon-only-at-`md` tier: a deck-style PDF export is a desktop task, so it renders as a labeled button at `lg` only, folds straight into the `···` Project-actions overflow menu at `md` (as "Export schedule as PDF…", opening the same options dialog), and is **hidden entirely below `md`** — it never renders an icon-only `md` variant. A control may take this two-tier (`lg` label → `md` overflow → hidden) collapse instead of the standard three-tier when its cost or desk-only nature justifies it, but the carve-out must be named here per-control (this is the documented instance).
 - **Board toolbar** (CalmToolbar): Group, Sort, Density, Layout segmented control, **Columns/WIP settings button** (#1960 — the always-visible icon button that opens `BoardSettingsPanel`; it is icon-only so it never collapses) = primary; `My tasks`, `At-risk`, `Cost` toggles = secondary.
 - **Resource toolbar**: view mode tabs, Prev/Today/Next date nav, `Fit to project` = primary; status filter chips = secondary.
 Adding a new control to any toolbar requires an explicit primary/secondary declaration in the MR description.
