---
title: Baselines
description: Capture an immutable snapshot of your schedule and compare planned dates against where the project actually stands — variance, drift, and slip, at a glance.
---

A **baseline** is a frozen snapshot of your project's schedule at a point in time. Capture
one when you commit a plan to stakeholders, then compare it against the live schedule to
see exactly how far — and which tasks — have drifted.

:::note[0.1]
Baselines shipped in 0.1 and are part of the **Community (OSS)** edition. Structured
rebaseline reasons (recording *why* a baseline was taken) are planned for 0.4.
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
active** at a time. The active baseline is the one overlaid on the schedule for comparison.
Activating a different baseline automatically deactivates the previous one.

## Comparing against the plan

With a baseline active, the Schedule view overlays faint **ghost bars** at the baselined
dates beneath each task's current bar, so slip is visible directly on the Gantt. The
**Baseline** tab shows the same comparison as a table:

| Planned (baseline) | Current (live) | Delta |
|---|---|---|
| Start / finish at capture | Start / finish from the latest CPM run | Variance in days (e.g. `+3 days`) |

## API

| Method & path | Purpose | Permission |
|---|---|---|
| `GET /api/v1/projects/{id}/baselines/` | List baselines | Project member |
| `POST /api/v1/projects/{id}/baselines/` | Capture a baseline (auto-named if blank) | Admin |
| `GET /api/v1/projects/{id}/baselines/{baselineId}/` | Retrieve (with task count) | Project member |
| `POST /api/v1/projects/{id}/baselines/{baselineId}/activate/` | Make active, deactivate others | Admin |
| `DELETE /api/v1/projects/{id}/baselines/{baselineId}/` | Delete a baseline | Owner |

Capturing a baseline is atomic — all task rows are snapshotted in a single transaction —
and broadcasts a `baseline_created` event to connected clients.
