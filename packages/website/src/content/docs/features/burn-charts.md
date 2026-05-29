---
title: Burn charts
description: Project-level burn down, burn up, and combined progress charts in the Reports tab.
---

Three standard agile/iterative progress charts scoped to a single project: burn down (remaining work over time), burn up (completed work against a scope line), and a combined overlay of both. All three share a Y-axis unit selector — story points, task count, or hours — so you can read them in the unit that matches your planning cadence.

Portfolio-level burn charts (aggregated across projects) are an Enterprise feature.

## Where this lives in the story

Step 7 ([Reporting and confidence](/the-story/#7-report--executive-confidence)) of the [hybrid PM flow](/the-story/). Carlos checks this tab to answer "are we still on track?" before his weekly executive update; Maya uses it between sprints to spot scope drift that the sprint burndown doesn't show.

## Chart variants

### Burn Down

Plots remaining work from the project start date to today. The ideal burn line runs from total scope at start to zero at the planned finish date.

- **Y-axis:** remaining story points / task count / hours (user-selectable)
- **X-axis:** calendar dates from project start to planned finish
- **Ideal line (dashed):** straight diagonal from total scope to zero
- **Actual line (solid):** cumulative remaining work per day
- A line above the ideal means you're behind; below means ahead.

### Burn Up

Shows how much work has been completed as scope grows over time.

- **Completed line (solid):** cumulative done work per day, growing from zero
- **Scope line (dashed):** total scope per day — flat until a scope change, then stepping up or down
- The gap between the two lines is the remaining backlog. A narrowing gap means delivery; a widening scope line means scope creep.

### Combined

Overlays burn down and burn up on the same axes. The area between the two lines is the active backlog — useful for presenting at reviews where both the "how much is left" and "how much is done" questions arise in the same conversation.

## Where to find it in the app

- Route: `/projects/:projectId/reports`
- Tab: **Reports** — visible for HYBRID, AGILE, and WATERFALL projects
- Mode selector in the chart toolbar: **Burn Down · Burn Up · Combined**
- Unit selector: **Points · Tasks · Hours**

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/v1/projects/{id}/burn-charts/` | Burn chart data series for the project |

Query parameters:

| Parameter | Values | Default |
|---|---|---|
| `mode` | `down`, `up`, `combined` | `down` |
| `unit` | `points`, `tasks`, `hours` | `points` |

The response includes a `series` array with one entry per calendar day and a `meta` object containing `planned_finish`, `total_scope`, and `scope_changes` (date + delta pairs for scope-change markers).

`IsAuthenticated` + project read permission required. Project must be a member of the requesting user's accessible projects.

## Related ADRs

- [ADR-0022](/architecture/decisions/) — Burn charts: API endpoint design and snapshot semantics
- [ADR-0062](/architecture/decisions/) — Burn charts web implementation (recharts, combined mode, unit selector)

## If you are…

- **Carlos (executive)** — open the Reports tab before your weekly update. The Combined chart answers "how much is left and how much is done" in one view. A diverging scope line is your prompt to ask the PM what changed.
- **Maya (Scrum Master)** — use Burn Down between sprints to see whether the project-level trajectory matches what the sprint burndowns predict. Sprint burndowns show iteration health; this shows project health.
- **Diana (PMO / Portfolio Manager)** — the Burn Up chart's scope line tells you whether this project is taking on more work than it planned. Scope creep here often explains why the milestone dates drift in the Schedule view.
