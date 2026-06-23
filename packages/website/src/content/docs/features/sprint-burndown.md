---
title: Sprint burndown
description: Actual vs ideal burn line, scope-add markers, today line, and forecast close date.
---

A hand-rolled SVG burndown for the active sprint. Renders Actual (solid), Ideal (dashed), Scope-add markers (amber dots), and a vertical TODAY line — with a trending callout below the chart and a forecast close date right-aligned.

## Where this lives in the story

Step 6 ([Execute](/the-story/#6-execute--daily-cadence-two-worlds-in-sync)) of the [hybrid PM flow](/the-story/) — this is the chart Maya watches during the standup and the chart Carlos's exec view derives confidence from at Step 7.

## What you see

- **Y-axis:** remaining story points
- **X-axis:** working days of the sprint (Day 1 → Day N)
- **Today marker:** vertical dashed `semantic-critical` line labeled `TODAY`
- **Trending callout:** `Trending {N} pts ahead/behind of ideal · scope-add {date} (+{N} pts)` — color reflects on-track / at-risk
- **Forecast close:** linear extrapolation from current pace to zero remaining

## Burn up view

A **Burn down / Burn up / Combined** toggle sits on the chart card. **Burn up** plots two ascending lines instead of the descending remaining line:

- **Completed:** cumulative completed points per day.
- **Total scope:** committed scope plus accepted mid-sprint injections (`committed_points + scope_change_points`). When accepted scope is injected, this line **steps up** — making scope creep visible at a glance, which a burndown alone hides (a flat burndown can mean "no work done" *or* "work done but matched by added scope"). **Combined** overlays remaining, completed, scope, and ideal on one chart.

## Where to find it in the app

- Route: `/projects/:projectId/sprints` (left ~60% of the metrics row)
- Renders for the active sprint; selecting a closed sprint shows its frozen historical burndown in the read-only review.

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/v1/sprints/{id}/burndown/` | Sprint metadata + actual snapshot series |

The ideal line is computed client-side from `committed_points`; the API does not return it.

## Where the data comes from

- `SprintBurnSnapshot` rows are written daily at 01:00 UTC by the `update_sprint_burndown_snapshots` Beat task.
- Real-time UPSERTs fire from the `task_status_changed` signal whenever a task in the active sprint changes status — today's row stays current without waiting for the nightly job.
- Scope-change markers (`scope_change_points`) signal mid-sprint scope additions/removals separately from burn movement.

## Related ADRs

- [ADR-0022](/architecture/decisions/) — Burn charts (API endpoint design)
- [ADR-0037](/architecture/decisions/) — Sprint model: snapshot semantics

## If you are…

- **Maya** — your at-a-glance sprint health. The trending callout tells you whether to escalate at standup.
- **Carlos** — you don't open this directly. You read the aggregate milestone-health and schedule-confidence signals; the [velocity forecast](/features/velocity/) it feeds is team-private by default (ADR-0104) and visible to you only when the team's signal audience includes your tier.
