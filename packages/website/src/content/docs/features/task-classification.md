---
title: Task classification
description: Set a task's type, governance class, and delivery mode — the work-item taxonomy that drives board lanes, rollups, and the hybrid overlay.
---

Every task carries three classification fields — `type`, `governance_class`, and `delivery_mode` — that describe *what kind of work it is*, *which overlay governs it*, and *how it executes and rolls up*. They have always been part of the [unified data model](/features/unified-data-model/) and are set by the demo seeds, but until now there was no way to change them from the task editor.

:::note[0.3]
The **Classification** controls land in **0.3** (the agile team). The fields are already stored and read everywhere; 0.3 will add the editor. They are purely additive — every existing task keeps its current values (`task` / `flow` / `waterfall`), so nothing changes unless you set them.
:::

## Where you will set it

The task create/edit dialog will gain a **Classification** group with three selects — Type, Governance class, and Delivery mode — each with a one-line description of the selected value. The group is hidden when you create a milestone (a milestone is a zero-duration marker, not typed or governed work — its `is_milestone` flag is what matters there).

The controls are read-only for Viewers and non-owning Members; the server remains the authority on who may write each field.

## Type — what kind of work this is

`type` drives the board lane, the work-item badge, and whether the task carries schedulable effort.

| Type | Meaning |
|------|---------|
| **Task** | Standard unit of work with effort and dates. The default. |
| **Story** | A user-facing increment, estimated in story points. |
| **Bug** | A defect against accepted scope. |
| **Spike** | Time-boxed research; answers a question and ships no deliverable. |
| **Tech Debt** | Refactoring or remediation work. Scheduled like a Task and **counts toward velocity**, but reported separately so a team can see how much capacity went to debt. |
| **Epic** | A structural parent. It groups child work and rolls up — and it is **excluded from CPM scheduling** and every committed-delivery aggregate, exactly like a recurring template. |

Epic is special: it changes hierarchy rather than adding schedulable work, so changing a task to or from `epic` is gated to the Product Owner or an Admin. If you do not hold that role, the editor surfaces the server's refusal rather than silently dropping the change.

**Tech Debt** is the deliberate opposite of Epic: it *is* schedulable work that consumes sprint capacity, so it is **not** excluded from velocity — hiding it would understate a team's real throughput. Its only distinct treatment is visibility. A tech-debt card will carry a **Tech Debt** badge on its board face (other types stay unbadged to keep the board calm), the board toolbar will gain a quiet **Tech debt** filter that narrows the board to remediation work, and any client can chart debt distinctly through the `?type=tech_debt` task-list filter. Together these answer the recurring engineering question — *how much of our capacity is going to debt versus features?* — without removing that capacity from the numbers.

## Governance class — which overlay governs the subtree

`governance_class` selects *which* governance model applies to a task and its subtree. It is distinct from delivery mode: governance is about oversight, delivery is about execution.

| Governance class | Meaning |
|------------------|---------|
| **Flow** | Agile work, governed by the sprint or kanban board. The default. |
| **Gated** | Phase-gate–governed waterfall work. |
| **Hybrid** | Mixes flow and gated within the same subtree. |

## Delivery mode — how the work executes and rolls up

`delivery_mode` selects *how* a task is executed, estimated, and rolled up. It is finer-grained than the project-level [methodology preset](/features/methodology-preset/): a single hybrid program can hold tasks in different delivery modes.

| Delivery mode | Rolls up from |
|---------------|---------------|
| **Waterfall** | Explicit percent-complete. Participates in CPM and the baseline. The default. |
| **Scrum** | Story-point burndown; velocity-tracked. |
| **Kanban** | Item throughput (done / total) on a WIP-limited board. |
| **Milestone** | A zero-duration gate marking a date or phase. |

Delivery mode is what the rollup engine reads to interpret a parent's percent-complete — a Scrum subtree rolls up from burndown while a Waterfall subtree rolls up from explicit percent — so setting it correctly keeps a hybrid program's rollups honest.

## Why this matters

The three fields are the seam that lets one task hierarchy serve Waterfall, Agile, and Hybrid teams at once without translation. A program manager can mark a compliance subtree `gated` / `waterfall` while the team next to it runs `flow` / `kanban`, and both roll up into the same program view. Before the editor, that taxonomy could only be set through the seed data or the API; 0.3 puts it in front of the user.

## Related

- [Unified data model](/features/unified-data-model/) — the full Task field set these three fields belong to
- [Methodology preset](/features/methodology-preset/) — the project-level planning model, which delivery mode refines per task
- [Scheduler](/features/scheduler/) — how CPM consumes the schedulable fields (and skips epics)
