---
title: Cost model
description: Give a project a budget and each resource an hourly rate, and TruePPM computes actual cost from logged time, earned value, cost variance, and budget utilization.
documentedFor: "0.5"
---

:::note[Ships in 0.5]
Everything on this page ships in 0.5. In the current release there is no budget on a project and no rate on a resource. The program rollup's **Cost variance** and **Budget utilization** KPIs are locked with the reason "needs project cost data", and the **Budget-weighted** aggregation policy always falls back to the average.
:::

This page is for project managers who need to know what a project has cost so far and whether it is running over budget, and for workspace admins who set the rates that cost is computed from.

TruePPM computes cost from data you already keep:

- the **budget** you set on a project,
- the **hourly rate** on each resource, and
- the **time entries** people log against the project's tasks.

Nothing is entered twice. A contributor logs time the way they always have, and the cost follows from it.

When 0.5 lands, the budget, rates and currency are set through the API, as shown below, and the program overview shows the rolled-up cost KPIs. Screens for editing rates and budgets come with a later cost UI.

## The three inputs

| Input | Where it lives | Who can set it | Who can see it |
|---|---|---|---|
| **Budget** (budget at completion, BAC) | Project | Project Manager (project Admin) or Owner | Project Manager or Owner |
| **Hourly rate** | Resource | Workspace Admin or Owner | Workspace Admin or Owner. A Project Manager also sees the rate of each person who logged time on their project, in that project's cost breakdown. |
| **Currency** | Workspace settings | Workspace Admin or Owner | Everyone |

A rate is a stand-in for what a person costs the organization, so it is **never** shown to a Member or a Viewer. That holds everywhere a rate or a cost figure could travel: the resource catalog, the project roster, the project's activity history, exports, share links, agent (MCP) reads, and the program rollup. In the program rollup, the cost KPIs show a number only to someone who is Program Manager or Owner on the program **and** Project Manager or Owner on every project in it. Everyone else sees **Restricted to managers of every project**.

### One rate per resource, no history

Each resource has **one current rate**. There is no rate history, and no rate takes effect from a date. Actual cost is always computed at the rate as it is now, so **changing a rate re-costs every hour that resource has ever logged**, including last month's.

That is deliberate, and it is why every rate change goes through a preview first (see [Changing a rate](#changing-a-rate)). Date-effective rate cards, where a new rate applies only from a given date, are an enterprise-edition feature.

A rate of `0` is a real rate, for a volunteer or a donated resource, and counts as set. A resource with **no** rate is unrated.

Rates belong to resources, not user accounts, so equipment and other non-human resources can carry one too. Only people log time, so only people produce cost. Non-labor costs such as equipment, cloud spend and agent spend are planned for a later release.

### One currency, no conversion

All amounts are in the workspace currency. Set it with the `currency` field on `PATCH /api/v1/workspace/` (workspace admins), as a three-letter ISO 4217 code, for example `USD`, `EUR` or `GBP`. The default is `USD`. It is a label, not a converter: changing it re-labels every existing amount and converts nothing.

## How cost is computed

| Figure | Formula |
|---|---|
| **Actual cost (AC)** | For each person who logged time on the project: hours × the current hourly rate of their resource, summed |
| **Percent complete** | Each task's percent complete weighted by its duration: Σ(percent × duration) ÷ Σ(duration), over the project's leaf tasks (see [What earned value means](#what-earned-value-means)) |
| **Earned value (EV)** | budget × percent complete ÷ 100 |
| **Cost variance (CV)** | EV − AC. **Negative means over budget** |
| **Budget utilization** | AC ÷ budget. `1.0` (100 %) means the whole budget has been spent |

### What earned value means

Earned value is the share of the budget that the work done so far is worth, if the budget is spread over the work in proportion to each task's duration. A 100-day task counts 100 times as much as a 1-day task. For example, with a budget of 10,000, a 1-day task at 100 % and a 100-day task at 0 % give a percent complete of 100 ÷ 101 = 0.99 %, so EV is 99. A plain average of the two percents would say 50 %, and EV would be 5,000.

Only **leaf tasks** count: the scheduled work the project is made of.

- **Phases are left out.** A phase's percent complete is a rollup of its children, so counting it would count the same work twice. Only children that are scheduled work make a task a phase: a task whose only children are backlog items or epics still counts as a leaf task.
- **Subtasks are left out** as tasks of their own. Their work is inside the duration of the task they belong to, and that task counts at the percent complete its subtasks roll up to: the figure the task shows, counting only its subtasks, not backlog or epic items filed under it, and not a percent stored on it earlier. A task with a backlog item under it can therefore show a different percent from the one earned value uses.
- **Backlog items, epics and recurring tasks are left out**, the same set the schedule leaves out.
- **Milestones and other zero-duration tasks add nothing.** They plan no work, so they carry no share of the budget. Reaching a milestone earns nothing beyond the work that led to it.

What earned value does **not** mean:

- **It is not measured output.** It uses the percent complete people enter on tasks. If a percent is optimistic, EV is too.
- **It is not the percent complete on the project list.** That figure is a plain average of every task's percent, so the two can differ.
- **It does not use a baseline.** Durations are the current ones, so re-estimating a task re-weights it, and EV can change with no work done. Budget is not allocated to individual tasks either: each task's share is its duration.

When the project's leaf tasks have no duration in total (the project has no leaf tasks, or only milestones), there is nothing to weight by. Earned value, cost variance and the forecasts then report `no_planned_duration` instead of a number. Budget utilization does not need earned value, so it still computes.

### Forecast measures

:::note[Ships in 0.5]
The forecast measures and the `provenance` block described here ship in 0.5, like the rest of this page.
:::

From the same inputs the cost breakdown also reports the standard earned value forecasts. These are the commonly published definitions, and they have not yet been confirmed against the PMI Practice Standard for EVM; the forecast uses the **typical variance** method, which assumes the cost efficiency so far continues for the rest of the work.

| Figure | Formula | Reads as |
|---|---|---|
| **Cost performance index (CPI)** | EV ÷ AC | Above `1.0`, the work done cost less than budgeted |
| **Estimate at completion (EAC)** | budget ÷ CPI | Forecast total cost at the current efficiency |
| **Estimate to complete (ETC)** | EAC − AC | Forecast cost of the remaining work |
| **Variance at completion (VAC)** | budget − EAC | Negative means a forecast overrun |
| **To-complete performance index (TCPI)** | (budget − EV) ÷ (budget − AC) | The efficiency the remaining work needs to finish exactly on budget |

**Budget utilization is not CPI.** Utilization (AC ÷ budget) says how much of the budget is spent; CPI says how much work that money bought. The `budget` field is the budget at completion (BAC), the total planned cost, not the money remaining. At program level, utilization is total actual cost ÷ total budget, a ratio of sums, not an average of project ratios.

A forecast is never shown as `0` or infinity when it cannot be computed. It reports `available: false` with a reason:

| Reason | Applies to | Why |
|---|---|---|
| `no_budget`, `missing_rates`, `no_planned_duration` | all | Same as the other figures |
| `no_actual_cost` | CPI, EAC, ETC, VAC | No cost yet, so CPI (EV ÷ AC) is undefined |
| `no_earned_value` | EAC, ETC, VAC | Cost with no progress gives CPI 0, so EAC would be infinite |
| `budget_exhausted` | TCPI | Actual cost has reached the budget, so the denominator is 0 |

The `provenance` block names what computed each figure: the computing function, a contract version, the rate source (the resource's **current** rate, with no rate history, so a rate change re-costs past hours and `as_of` is the only datum saying when a figure was true), the percent-complete basis (each leaf task's percent complete weighted by its **current duration**, with phases, subtasks and zero-duration tasks left out), the EAC method, and for each figure whether it was `computed` or `restricted` with its reason. Rate-change history is not recorded, by design: a resource has one current rate (see [One rate per resource, no history](#one-rate-per-resource-no-history)). The program rollup's cost KPIs do not carry this block: they already report `available`/`reason` per KPI with the missing-budget and missing-rate counts, and their inputs are the per-project figures described here.

Example: a project has a budget of 10,000 and three 1-day tasks at 50 %, 100 % and 0 %, so it is 50 % complete and EV is 5,000. Two people have logged 11.5 h at 100/h and 0.75 h at 80.50/h, so AC is 1,150.00 + 60.38 = 1,210.38. CV is 5,000 − 1,210.38 = **3,789.62** (under budget), and utilization is **12 %**.

Each line is rounded to the cent and the lines are then added together, so the breakdown always adds up to the total.

What counts as actual cost:

- **Only time logged on this project's tasks.** Time a person logs on another project belongs to that project.
- **Time off is never cost.** Holidays and PTO are calendar exceptions, not time entries.
- **A running timer is not cost** until it is stopped and becomes a time entry.
- **Deleted time entries do not count.** Time logged on a task that was later deleted still counts, because the money was spent.
- **A deactivated resource still prices its past hours.** Off-boarding someone does not erase what their work cost.

When a person has more than one resource, TruePPM uses the one on the project's team roster. When a person's account is not linked to any resource, TruePPM uses a resource with no linked account and the same email address.

## When a figure cannot be computed

A cost figure that is missing an input says which input is missing instead of showing a misleading number.

| What you see | Why | What to do |
|---|---|---|
| **N projects have no budget** | A project, or one of the program's projects, has no budget, or a budget of 0 | A Project Manager sets `budget` on the project with `PATCH /api/v1/projects/{id}/` |
| **N people have no rate** | Someone who logged time on the project, or who is assigned to one of its tasks, has no rate. Their hours cannot be priced | A workspace admin sets each person's rate with `POST /api/v1/resources/{id}/rate/`. This works for a deactivated resource too. If the person has **no resource at all** (their entry in the breakdown has no `resource_id`), first create one with their email address (`POST /api/v1/resources/`), then rate it. TruePPM matches a resource with no linked account to the person by email |
| **No task durations** (`no_planned_duration`) | The project has no leaf tasks, or only milestones and other zero-duration tasks, so earned value has nothing to weight by. Cost variance and the forecasts are unavailable; budget utilization still computes. In the program rollup, cost variance leaves the project out of its total and counts it as not yet scheduled | Add the project's tasks with their durations |
| **Restricted to managers of every project** | You are not Program Manager or above on the program, or not Project Manager or above on every project in it | Nothing; cost is restricted |

Actual cost is still shown while rates are missing, but it covers only the priced hours. The cost breakdown lists the unpriced hours and names the people who have no rate.

## The project cost breakdown

Project Managers can read a project's cost at `GET /api/v1/projects/{id}/cost/`. The response returns:

- the budget, actual cost, percent complete and earned value
- cost variance, budget utilization, CPI, EAC, ETC, VAC and TCPI, each with a reason when it cannot be computed
- a `provenance` block naming the inputs and method behind each figure
- `cost_computable`, which is false when anyone in scope has no rate, and `missing_rate_count`
- the people with no rate
- logged, priced and unpriced hours
- one line per person: hours, rate and cost
- a one-sentence definition of every figure

Amounts are decimal strings in the workspace currency.

## Changing a rate

Workspace admins set rates with `POST /api/v1/resources/{id}/rate/`, with a body of `{"cost_rate": "85.00", "dry_run": true}`. The same endpoint handles the preview and the save:

- with `dry_run: true` (the default), it returns what every affected project's actual cost **would** become, without saving anything;
- with `dry_run: false`, it saves the rate and returns the same shape, recomputed from the saved data.

The preview and the save use the same computation, so the numbers you approve are the numbers you get. Each affected project shows its hours, actual cost before and after, the change, and whether its cost is computable before and after. Set `cost_rate` to `null` to clear a rate.

Saving records a **Resource rate changed** entry in the workspace audit log, with the old and new rate. Saving the rate a resource already has records nothing.

A rate can only be changed from a signed-in session, not with an API token, because a change re-costs history. Sending `cost_rate` on `PATCH /api/v1/resources/{id}/` is rejected with a pointer to this endpoint.

## Reading cost from an MCP client

An assistant connected through the [MCP server](/features/mcp-server/) reads the same breakdown with the read-only `get_project_cost` tool. It returns the payload described above, including `definitions`, `cost_computable` and `missing_rate_count`.

Below Project Manager the tool answers `cost_restricted` with a reason and no figure; it never returns a budget, rate or cost value, and it is not an error.

**Parity commitment.** Every cost figure the web app shows is reachable through an MCP tool: the project breakdown through `get_project_cost`, and the program rollup's cost KPIs through `get_program_health`, which returns the rollup, cost KPIs included. A cost figure added to the UI without an MCP route is a gap to be filed, not an accepted difference.

## In the program rollup

When cost data is complete, the program rollup's two cost KPIs compute as program **totals**:

- **Cost variance** is the sum of every project's CV, leaving out projects that are not yet scheduled (below).
- **Budget utilization** is total actual cost ÷ total budget. A large project counts in proportion to its budget; small projects do not each count equally.

Both are unavailable if **any** project in the program is missing a budget or a rate, because a partial total would understate the program. The tile names how many projects or people are missing.

A project whose leaf tasks have no duration in total has no earned value, so it has no cost variance to add. Cost variance **leaves it out** of the total and **counts** it: the tile shows the total, for example "-$1,500", with "over budget · 2 projects not yet scheduled" beneath it (`projects_without_planned_duration`). Cost variance is unavailable (`no_planned_duration`) only when **every** project in the program is in that state. Such a project's spend still counts in budget utilization, which does not need earned value.

The **Budget-weighted** aggregation policy weights each project by its budget. If any project has no budget, the rollup uses the average instead and says why. Budget weighting is applied only for someone who may see every project's budget, under the same rule as the cost KPIs, because a weighted figure reveals how the budgets compare. Everyone else sees the plain average, with a note that budget weighting is unavailable.

A project that has spent hours but has no remaining tasks has no earned value: with no leaf tasks there is nothing to weight by, so its cost variance reports `no_planned_duration` rather than a figure computed from an assumed 0 %. The program's cost variance therefore leaves that spend out and counts the project as not yet scheduled; the spend still shows in budget utilization. See [Program rollup KPIs](/features/settings/program-rollup/).

## In the weekly digest

The weekly [program-health digest](/features/notifications/#the-weekly-digests-and-their-schedule) gives each program a cost line, so a sponsor finds out about an overrun without waiting for the PM to report it. The line is a band, worked out from the program rollup's two cost KPIs:

- **over budget**: budget utilization is above 1 (100%)
- **spending ahead of progress**: cost variance is below 0, but utilization is not above 1
- **within budget**: neither

The digest shows the band only if a cost KPI is turned on for the program, and only to someone who could read the cost KPIs on the program overview: Program Manager or above on the program, and Project Manager or above on every project in it. Everyone else is told why there is no cost band. Even an allowed reader never gets an amount, a ratio or a count in the digest, because a digest can be kept and forwarded after the reader's access is gone. A program that is over budget or spending ahead of progress is listed even when its schedule is on track.

## Related

- [Timesheet](/features/timesheet/): logging the time that cost is computed from
- [Program rollup KPIs](/features/settings/program-rollup/)
