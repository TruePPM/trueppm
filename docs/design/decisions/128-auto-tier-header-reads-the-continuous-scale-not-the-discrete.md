# Rule 128 — Auto-tier header reads the continuous scale, not the discrete enum

> **Decision record.** Moved out of `packages/web/CLAUDE.md` by #2433 (ADR-0653): precedent bound to one surface, not a general invariant. It is still binding for the surface it governs.
>
> Original section: *Schedule View Interaction Rules (Issues #351 / #491)*

**Auto-tier header reads the continuous scale, not the discrete enum.** `drawTimelineHeader` chooses its emphasized (major) and de-emphasized (minor) units from the scale's continuous `pxPerDay` via `headerUnitsForPxPerDay`, so emphasis swaps smoothly across the whole Day↔Year continuum as the user pinch/Ctrl-wheel zooms. Thresholds (`HEADER_TIERS`, constants in `GanttScaleData.ts`): ≥80 Hour/Day · 24–80 Day/Week · 8–24 Week/Month · 2.5–8 Month/Quarter · 0.7–2.5 Quarter/Year · <0.7 Year. The 'hour' minor tick unit is **deferred** — above 80 px/day the header caps the major at Day until an hour unit ships.
