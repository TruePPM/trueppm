---
title: Capacity preflight
description: Per-person committed/available hours with on-track / at-risk / over-capacity bands.
---

The Resource Manager's view of an active sprint, at-a-glance. A donut chart shows aggregate committed/capacity ratio; a scrollable list shows per-person commitments with avatar initials. Three color bands signal severity: under, at, or over capacity.

## Where this lives in the story

Step 3 ([Capacity preflight](/the-story/#3-capacity-preflight--the-resource-manager-vetoes)) of the [hybrid PM flow](/the-story/) — Sarah's veto surface. Catches contention at plan time before sprint execution starts.

## What you see

- **Donut chart** — aggregate ratio (`committed_hours / available_hours`), tinted by band:
  - under 90% → `semantic-on-track`
  - 90–100% → `semantic-at-risk`
  - over 100% → `semantic-critical`
- **Aggregate label** — `{committed} / {capacity} hours committed · On track · {buffer} hours of buffer` (or `overrun` when negative)
- **Per-person rows** — initials avatar + name + `{committed}/{capacity}` text; over-allocated members get a red avatar tint

## Points ceiling (ships in 0.3)

:::note[Ships in 0.3]
The points chip and capacity footer below ship in 0.3 (the agile team release). They are not yet in a tagged build — see the [roadmap](/overview/roadmap/).
:::

The per-person hours view answers "who is overcommitted?". A team that plans in story points also needs "are we over the sprint's points ceiling?". When the sprint carries a `capacity_points` value, the panel adds a points-based read alongside the hours view:

- **Points chip** — `{committed}/{capacity} pts · {pct}%`, summing the story points of every task committed to the sprint. The chip turns red once `committed_points` exceeds the sprint's `capacity_points` ceiling.
- **Plain-English footer** — a one-line summary the whole team can read without parsing the donut: *"Team is at 75% of capacity. 6 pts free."* (or *"Team is 4 pts over capacity."* when over the ceiling).

Both are **omitted entirely when no points ceiling is set** — a sprint that plans in hours only never sees an empty or zero-valued points chip. The `capacity_points` ceiling is set on the [Plan Sprint dialog](/features/plan-sprint/) and editable while the sprint is planned.

> _Screenshot of the points chip and capacity footer to be added once 0.3 ships._

## Where to find it in the app

- Route: `/projects/:projectId/sprints` (right column of the metrics row, top half)

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/v1/sprints/{id}/capacity/` | Per-member committed/available hours + aggregate totals |

The activate endpoint also surfaces a warnings-only slice via `capacity_check`; this endpoint exposes the broader dataset.

## Where the data comes from

For each `TaskResource` assigned to a task in the sprint:

```
committed_hours = sum(units × working_days × hours_per_day)
available_hours = max_units × working_days × hours_per_day
```

Working days span the sprint window honoring the project calendar's `working_days` bitmask. Hours-per-day is read from the calendar (8.0 default).

PTO is a placeholder zero until a dedicated time-off model lands.

## Related ADRs

- [ADR-0037 §Q2](/architecture/decisions/) — Capacity check at activate time

## If you are…

- **Sarah (Resource Manager)** — this is your veto surface. If the aggregate is over 100% before activate, escalate before the sprint starts.
- **Maya (Scrum Master)** — the per-person list answers "who's overcommitted?" without a separate spreadsheet. The points footer (0.3) gives you the one-line "are we over the ceiling?" answer to read out at planning.
- **Raj (PM)** — capacity warnings on activate inform whether to pull scope before the sprint window opens.
