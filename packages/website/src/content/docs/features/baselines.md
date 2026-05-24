---
title: Baselines
description: Capture an immutable snapshot of your schedule and compare planned dates against where the project actually stands. Capturing and managing baselines is currently API-driven.
---

A **baseline** is a frozen snapshot of your project's schedule at a point in time. Capture
one when you commit a plan to stakeholders, then compare it against the live schedule to
see exactly how far — and which tasks — have drifted.

:::caution[Capture & management are API-only today]
The baseline **data model and endpoints are fully available**, but capturing, activating,
and deleting baselines is currently done **through the REST API** — there is no in-app
"Capture baseline" button yet. Once an active baseline exists, TruePPM shows a read-only
baseline-vs-current comparison in the task detail drawer (see
[Comparing against the plan](#comparing-against-the-plan)). A capture/manage UI and
structured rebaseline reasons are planned for 0.4.
:::

## What a baseline captures

Capturing a baseline records, for every task in the project at that moment:

- the task name (kept even if the task is later deleted),
- planned **start** and **finish** dates,
- **duration**, and any **actual** start/finish already recorded.

Snapshots are **immutable** — once written, a baseline's task rows never change, so a
baseline remains a faithful record of what the plan looked like when you took it. A
baseline notes whether its tasks had computed CPM dates at capture time, so a comparison
can flag a snapshot that was taken before the schedule was fully calculated.

## Multiple baselines

A project can hold **many baselines** — for example one per phase gate — but **one is
active** at a time. The active baseline is the one used for comparison. Activating a
different baseline automatically deactivates the previous one.

## Capturing and managing baselines via the API

All endpoints are project-scoped and authenticated with a bearer token (`$JWT`);
`$PROJECT_ID` is the project UUID.

```bash
# 1. Capture a baseline (name optional — auto-named "Baseline N" if omitted).
#    Requires project Admin. Snapshots every task atomically.
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"name": "Phase 1 commit"}' \
  https://trueppm.example.com/api/v1/projects/$PROJECT_ID/baselines/

# 2. List baselines for the project.
curl -H "Authorization: Bearer $JWT" \
  https://trueppm.example.com/api/v1/projects/$PROJECT_ID/baselines/

# 3. Activate a baseline (deactivates any other). Requires project Admin.
curl -X POST -H "Authorization: Bearer $JWT" \
  https://trueppm.example.com/api/v1/projects/$PROJECT_ID/baselines/$BASELINE_ID/activate/

# 4. Delete a baseline. Requires project Owner.
curl -X DELETE -H "Authorization: Bearer $JWT" \
  https://trueppm.example.com/api/v1/projects/$PROJECT_ID/baselines/$BASELINE_ID/
```

| Method & path | Purpose | Permission |
|---|---|---|
| `GET /api/v1/projects/{id}/baselines/` | List baselines | Project member |
| `POST /api/v1/projects/{id}/baselines/` | Capture a baseline (auto-named if blank) | Admin |
| `GET /api/v1/projects/{id}/baselines/{baselineId}/` | Retrieve (with task count) | Project member |
| `POST /api/v1/projects/{id}/baselines/{baselineId}/activate/` | Make active, deactivate others | Admin |
| `DELETE /api/v1/projects/{id}/baselines/{baselineId}/` | Delete a baseline | Owner |

## Comparing against the plan

Once a baseline is **active**, opening a task in the Schedule view shows a **Baseline**
section in the task detail drawer with the planned-vs-current comparison for that task:

| Planned (baseline) | Current (live) | Delta |
|---|---|---|
| Start / finish at capture | Start / finish from the latest CPM run | Variance in days (e.g. `+3 days`) |

The same per-task comparison is available directly from the API:

```bash
# Active baseline vs current schedule for a single task.
curl -H "Authorization: Bearer $JWT" \
  https://trueppm.example.com/api/v1/projects/$PROJECT_ID/tasks/$TASK_ID/baseline/
```

The response is discriminated by `has_baseline` / `in_baseline`: it reports no baseline,
a task added after the baseline was taken, or a full comparison row with
`start_delta_days` / `finish_delta_days` (positive = slipping later than planned).
