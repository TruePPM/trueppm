---
title: Risk Register
description: Standards-aligned risk tracking with probability × impact scoring, task links, and real-time board integration.
---

:::note[0.1]
The Risk Register shipped in 0.1 — UI, scoring, lifecycle states, task links, and CSV export.
:::

The Risk Register surfaces project risks in a dedicated **Risks** tab within the project workspace. Each risk is scored by probability × impact, tracked through a lifecycle, and can be linked to the tasks it affects.

## Risk scoring

Severity is **probability × impact**, computed from two 1–5 integer fields. A 5×5 grid gives scores 1–25 across five bands:

| Score | Band | Color |
|-------|------|-------|
| 20–25 | CRITICAL | Red |
| 12–19 | HIGH | Amber |
| 6–11 | MEDIUM | Amber (lighter) |
| 2–5 | LOW | Neutral |
| 1 | MINIMAL | Neutral (muted) |

The severity is read-only in the UI — it is always derived from the two inputs, never stored as a separate value.

## Lifecycle states

| Status | Meaning |
|--------|---------|
| `OPEN` | Identified and being monitored |
| `MITIGATING` | Active mitigation in progress |
| `RESOLVED` | Mitigation succeeded — threat no longer applies |
| `ACCEPTED` | Risk acknowledged; no further action |
| `CLOSED` | Archived |

The risk matrix on the register view treats `OPEN` and `MITIGATING` as **active** risks. `RESOLVED`, `ACCEPTED`, and `CLOSED` risks are hidden by default; use the **Show closed** toggle to include them.

## Filtering and sorting

:::note[0.3]
Register filtering and severity sort land in 0.3.
:::

Above the risk table, a segment filter narrows the list to the slice that needs attention:

| Filter | Shows |
|--------|-------|
| **All** | Every risk (default) |
| **High** | Severity ≥ 12 (HIGH and CRITICAL) |
| **Unmitigated** | Risks still `OPEN` or `MITIGATING` — the live threats |
| **Mine** | Risks you own |

The segment filter composes with the **exposure-matrix cell filter** (clicking a P×I cell): both apply together, and each is shown as a removable token with a **Clear all** reset. The exposure matrix and the critical/high count chips always reflect the full risk set, not the filtered view.

The **Severity** column header sorts the table — click to cycle descending → ascending → back to the default order (most impactful first). Unmitigated risks also carry an always-on left-edge highlight so live threats stand out regardless of the active filter.

A **Hide low severity** toggle in the toolbar will also collapse LOW-severity risks (score 1–5) out of the table — a client-side declutter that composes with the segment and matrix-cell filters. Your choice is remembered in the browser, so the register opens the same way next time.

## Response strategies

Each risk can be assigned one response strategy:

| Strategy | Meaning |
|----------|---------|
| **Avoid** | Change the plan to eliminate the threat |
| **Mitigate** | Reduce probability or impact |
| **Transfer** | Shift the consequence to a third party (insurance, contract) |
| **Accept** | Consciously accept the potential impact |

## Risk categories

Risks can be tagged with a standard source category:

- **Technical** — technology, quality, complexity
- **External** — market, regulatory, vendor
- **Organizational** — resources, funding, prioritization
- **Project Management** — estimation, planning, communication

## Linking risks to tasks

A risk can be linked to one or more tasks to indicate which tasks are exposed to it. The link is advisory — it does not affect CPM scheduling — but it does surface in two places:

- **Task detail drawer** → Risks section shows linked risks with severity chips
- **Board cards** — the `linkedRisksCount` and `linkedRisksMaxSeverity` fields power the risk badge on board cards so teams can see at a glance which tasks are exposed

## Short IDs

Every risk receives a project-scoped short ID (e.g. `R-00000003`) that shares the same counter as tasks. Short IDs appear in the risk drawer header, comments, and audit logs.

## Permissions

| Action | Minimum role |
|--------|-------------|
| View risks | Viewer |
| Create / edit / delete risks | Member |
| Add risk comments | Member |

## Real-time

Creating, updating, or deleting a risk broadcasts a `risk_created` / `risk_updated` / `risk_deleted` WebSocket event to all connected project members. Board cards and task drawers update without a page refresh.
