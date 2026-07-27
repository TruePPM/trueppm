# Rule 127 — Continuous zoom uses a stepper, not segmented tiers

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Schedule View Interaction Rules (Issues #351 / #491)*

**Continuous zoom uses a stepper, not segmented tiers.** The Schedule `ZoomControl` is `[ − ]  {derived tier}  [ + ]` in a `role="group" aria-label="Timeline zoom"` (`h-7`, `border border-neutral-border rounded`). `pxPerDay` (in `scheduleStore`) is the source of truth; the discrete `ZoomLevel` is **derived** from it (`deriveTier`) and survives only as a label for header formatting + QuarterModeControl gating. The center readout is a non-interactive `role="status" aria-live="polite"` span showing the derived tier (Day/Week/Month/Quarter/Year) — it IS the active-tier indicator; there is no pressed/segmented active state. `−`/`+` step geometrically (×/÷ `ZOOM_STEP_FACTOR` = 1.5), clamped to the `ZOOM_CONFIGS` day…year band (`MIN_PX_PER_DAY`/`MAX_PX_PER_DAY`) and disabled at the edges; tooltips carry `⌘−`/`⌘=`. A separate `Fit` button (rule 82 style, label "Fit to project", `⌘0`) sits beside the group and calls `engine.fitToProject()`. ZoomControl + Fit are primary toolbar controls (rule 110); the toolbar stays `flex-nowrap h-10` (rule 113).
