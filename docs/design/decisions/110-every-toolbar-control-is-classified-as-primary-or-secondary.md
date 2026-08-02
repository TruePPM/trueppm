# Rule 110 — Every toolbar control is classified as primary or secondary

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Toolbar Responsive Rules (Issue #568)*

**Every toolbar control is classified as primary or secondary.** This classification is the contract — enforce it in code review, not just implementation. Primary controls are always visible at all widths ≥ 768px. Secondary controls collapse at narrow widths (see rule 111). Canonical classification per view:
 - **Schedule toolbar**: `+ Task`, `+ Milestone`, `BUILD MODE` = primary; `CP only`, `Focus chain`, `Critical path`, `Milestones` toggles = secondary; health summary chip, `Columns`, `Today`, ZoomControl = primary. The **Export PDF** button is **primary** (reclassified by #2703; previously secondary with a desk-task carve-out that buried it in the `···` Project-actions overflow and hid it entirely below `md` — the 0.4 VoC panel flagged that the client-ready PDF is a weekly-cadence task for the PM/PMO personas, not a desk-only afterthought). It now follows the standard primary treatment (rule 111): a dedicated toolbar button reading `Export PDF` at `lg`, collapsing to the short label `Export` at `md` (never icon-only, never overflow, never hidden while the toolbar itself renders — same treatment as `Today` and `Fit to project`). It is **not** duplicated in the `···` overflow menu — one home per control, matching `Today`/`ZoomControl`/the Display popover.
 - **Board toolbar** (CalmToolbar): Group, Sort, Density, Layout segmented control, **Columns/WIP settings button** (#1960 — the always-visible icon button that opens `BoardSettingsPanel`; it is icon-only so it never collapses) = primary; `My tasks`, `At-risk`, `Cost` toggles = secondary.
 - **Resource toolbar**: view mode tabs, Prev/Today/Next date nav, `Fit to project` = primary; status filter chips = secondary.
 Adding a new control to any toolbar requires an explicit primary/secondary declaration in the MR description.
