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
| **Percent complete** | The project's existing percent complete: the average percent complete of its tasks |
| **Earned value (EV)** | budget × percent complete ÷ 100 |
| **Cost variance (CV)** | EV − AC. **Negative means over budget** |
| **Budget utilization** | AC ÷ budget. `1.0` (100 %) means the whole budget has been spent |

Example: a project has a budget of 10,000 and is 50 % complete, so EV is 5,000. Two people have logged 11.5 h at 100/h and 0.75 h at 80.50/h, so AC is 1,150.00 + 60.38 = 1,210.38. CV is 5,000 − 1,210.38 = **3,789.62** (under budget), and utilization is **12 %**.

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
| **Restricted to managers of every project** | You are not Program Manager or above on the program, or not Project Manager or above on every project in it | Nothing; cost is restricted |

Actual cost is still shown while rates are missing, but it covers only the priced hours. The cost breakdown lists the unpriced hours and names the people who have no rate.

## The project cost breakdown

Project Managers can read a project's cost at `GET /api/v1/projects/{id}/cost/`. The response returns:

- the budget, actual cost, percent complete and earned value
- cost variance and budget utilization, each with a reason when it cannot be computed
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

## In the program rollup

When cost data is complete, the program rollup's two cost KPIs compute as program **totals**:

- **Cost variance** is the sum of every project's CV.
- **Budget utilization** is total actual cost ÷ total budget. A large project counts in proportion to its budget; small projects do not each count equally.

Both are unavailable if **any** project in the program is missing a budget or a rate, because a partial total would understate the program. The tile names how many projects or people are missing.

The **Budget-weighted** aggregation policy weights each project by its budget. If any project has no budget, the rollup uses the average instead and says why. Budget weighting is applied only for someone who may see every project's budget, under the same rule as the cost KPIs, because a weighted figure reveals how the budgets compare. Everyone else sees the plain average, with a note that budget weighting is unavailable.

A project that has spent hours but has no remaining tasks earns nothing, so its percent complete is 0 and its whole actual cost shows as negative cost variance. See [Program rollup KPIs](/features/settings/program-rollup/).

## Related

- [Timesheet](/features/timesheet/): logging the time that cost is computed from
- [Program rollup KPIs](/features/settings/program-rollup/)
