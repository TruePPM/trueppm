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
- **Today marker:** vertical dashed `semantic-critical` line labelled `TODAY`
- **Trending callout:** `Trending {N} pts ahead/behind of ideal · scope-add {date} (+{N} pts)` — colour reflects on-track / at-risk
- **Forecast close:** linear extrapolation from current pace to zero remaining

## Where to find it in the app

- Route: `/projects/:projectId/sprints` (left ~60% of the metrics row)
- Renders only when an `ACTIVE` sprint exists.

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

- [ADR-0022](/architecture/adr/) — Burn charts (API endpoint design)
- [ADR-0037](/architecture/adr/) — Sprint model: snapshot semantics

## If you are…

- **Maya** — your at-a-glance sprint health. The trending callout tells you whether to escalate at standup.
- **Carlos** — you don't open this directly; you read its derived signal in [the velocity forecast](/features/velocity/).
