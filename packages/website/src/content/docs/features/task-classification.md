---
title: Task classification
description: Set a task's type, governance class, and delivery mode — what each field means, which of them the product reads today, and how the defaults follow your project's methodology.
documentedFor: "0.4"
---

Every task carries three classification fields — `type`, `governance_class`, and `delivery_mode` — that describe *what kind of work it is*, *which governance model applies to it*, and *how it executes and rolls up*. They have always been part of the [unified data model](/features/unified-data-model/) and are set by the demo seeds, but until now there was no way to change them from the task editor.

The three fields are not read to the same depth. `type` and `delivery_mode` are consumed across the product; `governance_class` is stored, cascaded, imported and exported faithfully, but only one place in the product currently branches on its value. Each section below says which.

:::note[Added in 0.3]
The **Classification** controls were added in **0.3** (the agile team). The fields were already stored and set by the seeds; 0.3 added the editor. They are purely additive — every existing task keeps its current values (`task` / `flow` / `waterfall`), so nothing changes unless you set them.
:::

:::note[Ships in 0.4]
Before **0.4**, a new task's Governance class and Delivery mode always defaulted to **Flow** / **Waterfall**, regardless of the project's own methodology — so a Waterfall project's new task opened on an agile governance overlay, and an Agile project's task never engaged point-burndown rollup. **0.4** makes the default follow the project's [effective methodology](/features/methodology-preset/) instead: see [Defaults follow the project](#defaults-follow-the-project) below. Every value stays selectable on every methodology either way — only which option opens pre-selected, and which values the picker lists first, changes.
:::

## Where you will set it

The task create/edit dialog will gain a **Classification** group with three selects — Type, Governance class, and Delivery mode — each with a one-line description of the selected value. The group is hidden when you create a milestone (a milestone is a zero-duration marker, not typed or governed work — its `is_milestone` flag is what matters there).

In **0.4**, each of the three fields will also carry an info (ⓘ) button next to its label. Clicking it opens a short popover that lists *every* option for that field with its one-line meaning — so you can compare all the choices before you pick, rather than selecting each in turn to read its description — plus a **Learn more** link back to the relevant section of this page. The inline description of the current selection stays put; the popover is additive.

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

`governance_class` records *which* governance model applies to a task and its subtree. It is distinct from delivery mode: governance is about oversight, delivery is about execution.

**What reads it today.** One thing: a template's **gates** count, which tallies the milestones marked `gated` in the shape you are about to publish or adopt. Everything else stores the value and carries it faithfully — the classification cascade sets it across a subtree and reports how many overrides it kept, MS Project and seed import/export round-trip it, and the API returns it — but no board lane, rollup figure, forecast or schedule overlay currently changes because a task is `gated` rather than `flow`. Set it to describe your plan and to drive the template gate count; do not expect a different number anywhere else yet.

| Governance class | Meaning |
|------------------|---------|
| **Flow** | Agile work, governed by the sprint or kanban board. |
| **Gated** | Phase-gate–governed waterfall work. |
| **Hybrid** | Mixes flow and gated within the same subtree. |

## Delivery mode — how the work executes and rolls up

`delivery_mode` selects *how* a task is executed, estimated, and rolled up. It is finer-grained than the project-level [methodology preset](/features/methodology-preset/): a single hybrid program can hold tasks in different delivery modes.

| Delivery mode | Rolls up from |
|---------------|---------------|
| **Waterfall** | Explicit percent-complete. Participates in CPM and the baseline. |
| **Scrum** | Story-point burndown; velocity-tracked. |
| **Kanban** | Item throughput (done / total) on a WIP-limited board. |
| **Milestone** | A zero-duration gate marking a date or phase. |

Delivery mode is what the rollup engine reads to interpret a parent's percent-complete — a Scrum subtree rolls up from burndown while a Waterfall subtree rolls up from explicit percent — so setting it correctly keeps a hybrid program's rollups honest.

## Defaults follow the project

Creating a task pre-selects Governance class and Delivery mode from the project's [effective methodology](/features/methodology-preset/) *(ships in 0.4)* — the values a self-managing team would pick anyway, so the dialog never opens on a value that contradicts the project it belongs to:

| Project methodology | Governance class default | Delivery mode default |
|---|---|---|
| **Waterfall** | Gated | Waterfall |
| **Agile** | Flow | Scrum — or **Kanban** if the project's board already runs continuous flow with no sprint cadence |
| **Hybrid** | Flow | Waterfall (unchanged — Hybrid is the preset that deliberately mixes both models) |

The picker still lists every governance class and every delivery mode on every methodology — the taxonomy stays additive, so a Waterfall program can mark one compliance-sensitive subtree `flow` / `scrum` without losing anything, and a Hybrid program can mix freely as before. The methodology-consistent value(s) are simply listed first; the rest sit under an "Other" group in the same select, one click away.

The default is resolved **server-side**, in the task-create request, so web, mobile, and the MCP server agree — none of them re-implements the rule. It is a *create-time* default only: switching a project's methodology later never rewrites the stored `governance_class` / `delivery_mode` on its existing tasks, and editing an existing task always shows what is actually stored, never a re-derived value.

## Declaring a whole subtree at once

:::note[Ships in 0.4]
Through **0.3**, the only way to classify work was one row at a time in the task
editor — so declaring that phase 4 runs as sprints meant opening every task under it.
**0.4** adds the classification popover and the subtree cascade described below. On the
current release, use the per-task editor above.
:::

A hybrid plan is usually declared a **branch** at a time, not a row at a time. Press
`⌘⇧M` (`Ctrl+Shift+M` on Windows and Linux) to open a popover that sets both axes for a
task and, optionally, everything beneath it.

It is reachable from two surfaces, because an agile project and a scheduled one start in
different places:

- **Schedule** — focus a row and press the chord, or right-click the row and choose
  **Classification…**.
- **Product backlog** — select a story or epic and press the chord, or use the classify
  affordance on the card itself. A project created with an agile methodology opens on the
  backlog, so a compliance subtree can be declared without going to the Schedule first.

The popover has three rows:

- **Preset** — *Gated*, *Scrum*, or *Flow*. Each writes **both** fields, which covers the
  common case in one click.
- **Governed by** — the `governance_class` values above.
- **Progress from** — the `delivery_mode` values above.

The two axis rows stay visible under the presets, so a blended team can say
*flow + kanban* without being routed through Scrum vocabulary. Either axis can be left
on **No change** — the cascade writes only what you name.

### The footer says what will happen before it happens

Before you apply anything, the popover's footer states the outcome: how many tasks
change, how many milestones are left alone, and how many explicit governance overrides
are preserved. Three of those numbers are worth understanding:

- **Milestones are never re-typed.** `is_milestone`, `delivery_mode = milestone`, and
  `duration = 0` are three encodings of one fact. Cascading an agile delivery mode across
  a phase skips every gate inside it and says so — a gate is not a delivery mode.
- **Your per-task edits survive by default.** A task whose governance class was set
  explicitly (rather than inherited from its parent) keeps it, and the footer counts how
  many were kept. Clear **Keep explicit governance overrides** to cascade over them.
- **"Overrides kept" is a governance-only number.** Only `governance_class` records
  whether a task inherited its value; `delivery_mode` carries no such flag, so no override
  count exists for it. The popover says that rather than showing a zero that would read as
  "there were none".

After the cascade lands, a receipt names what the **server** actually wrote — not what the
preview predicted — including any rows it skipped.

### When the cascade is refused

A cascade is all-or-nothing: if the server refuses it, nothing is written. The popover
stays open with your choices intact and shows the server's own reason, not a generic
failure — because each of the three reasons points at a different next step.

- **Your role cannot author part of the subtree.** The message names how many of the
  matched tasks you may not edit. Permission here is deliberately all-or-nothing:
  applying a split to only the rows you happen to be assigned would leave the plan
  asserting something that is not true. Narrow the scope to a branch you own, or ask a
  project Admin or Owner to apply it.
- **The subtree is above the row cap.** One cascade may resolve at most 2,000 tasks. The
  message names how many it resolved and what the cap is, so you can clear **Cascade to
  descendants** or start from a lower-level parent rather than guessing.
- **The project's dependency graph is not schedulable.** A cascade writes no dependencies,
  but it does queue a recalculation, so a plan carrying a cycle is refused here rather
  than failing later in the scheduler. Fix the cycle first.

The primary button offers **Retry** only for a failure a retry can actually clear — a lost
connection or a server error. A refusal is a decision the server has already made, so the
button keeps reading **Apply to subtree** and the way forward is to change the scope or the
axis and apply again.

### Undo a cascade

:::note[Ships in 0.4]
Cascade undo ships in **0.4**, alongside the popover and cascade themselves.
:::

The toast that reports what the cascade wrote carries an **Undo** action. Applying it
restores every changed task's prior `governance_class` and `delivery_mode` — but only for
rows nobody has reclassified again since. A row someone else recascaded, or that you
changed again yourself, is left as it is rather than being stomped; the undo toast says
how many it kept. Undo is a single step per cascade — undoing an older cascade once a
newer one has landed on the same subtree is not supported.

## Seeing the split without auditing it

:::note[Ships in 0.4]
The outline gutter and mode chip described here ship in **0.4**. The Gantt's delivery-mode
bar gutter and texture already shipped.
:::

A declared split is only useful if you can see it. On the Schedule outline, a task whose
delivery mode is not the waterfall baseline carries two marks:

- a **3px gutter** at the left edge of the row, and
- a **mode chip** beside the task name — `SCRUM`, `KANBAN`, or `MIXED`.

A summary row reads from its **descendants**, not from its own stored field, so a phase
whose branches disagree reads `MIXED` and gets a gutter split between the modes actually
present. Milestones inside it do not count toward the mix — otherwise nearly every phase
in every plan would read mixed.

Waterfall draws neither mark. That is the same convention the Gantt already uses: the
baseline is silent, so what stands out is the work that departs from it, and a fully gated
plan stays visually calm. On the timeline, the same tasks carry a colored bar gutter and a
fill texture (diagonal hatching for scrum, dots for kanban), with a legend entry naming
each. Color is never the only signal — the chip states the mode in text, and the textures
survive a monochrome print.

The outline and the timeline read the **same** rolled-up value, so they cannot disagree
about a row. A phase that reads `MIXED` on the outline carries a **split gutter** on its
bar: one band per mode actually present, separated by a visible gap. The gap is what does
the work — under a forced-colors theme every delivery hue collapses to a single system
color, so bands that merely differed in color would read as one band, while bands you can
count stay countable. A mixed bar draws no body texture: the three textures each name one
mode, so overlaying two of them would produce a fourth pattern that means neither.

Screen-reader users get the same fact in words. The timeline's bars live on a canvas, so
each one is described by an accessible overlay — and that description names the rolled-up
mode, including the modes a mixed phase is composed of ("…, Mixed delivery — this branch
contains gated and scrum work"). A baseline row says nothing, matching the chip that draws
nothing.

**Nothing forks.** Dependencies cross the boundary freely: a gated 4.1 still drives a
sprint 4.2, on one plan and one timeline.

Where a subtree is driven by a sprint, the Schedule also paints the sprint's **window** as
a band across that subtree's rows — the same violet and the same diagonal hatch, at a
region's scale. So the delivery mode says *how* the work executes and the band says *when*
the cadence puts it, both on the timeline that already carries the gated critical path. See
[Sprint windows](/features/schedule/#sprint-windows).

## Why this matters

The three fields are the seam that lets one task hierarchy serve Waterfall, Agile, and Hybrid teams at once without translation. A program manager can mark a compliance subtree `gated` / `waterfall` while the team next to it runs `flow` / `kanban`, and both roll up into the same program view. Before the editor, that taxonomy could only be set through the seed data or the API; 0.3 puts it in front of the user.

## Related

- [Unified data model](/features/unified-data-model/) — the full Task field set these three fields belong to
- [Methodology preset](/features/methodology-preset/) — the project-level planning model, which delivery mode refines per task
- [Scheduler](/features/scheduler/) — how CPM consumes the schedulable fields (and skips epics)
