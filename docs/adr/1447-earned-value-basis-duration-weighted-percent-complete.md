# ADR-1447: Earned value basis — duration-weighted percent complete of leaf work

- **Status:** Accepted
- **Date:** 2026-11-21
- **Issue:** #4853
- **Amends:** ADR-1324 §3 (the EV formula and the "no live tasks earns 0" rule)

## Context

ADR-1324 §3 defined earned value as `BAC × project percent complete / 100`, reusing the
project list's percent complete verbatim: `Avg(percent_complete)` over every non-deleted
task (ADR-0171). It named the cost of that choice itself. The mean is unweighted, so a
1-day task counts as much as a 6-month one, and it includes phase rows, whose percent is
already a rollup of their children (ADR-0293), so their work is counted twice. Percent
complete is also the figure a PM hand-corrects each week, so EV takes on that noise
directly. The #4852 forecasts (CPI, EAC, ETC, VAC, TCPI) are all ratios over EV, so a
skewed EV skews every one of them.

The concern came from research and a simulated persona panel, not from a user report.
The decision below is the owner's (#4853). This ADR records the formula, the edge cases
and the trade-offs.

Options considered in #4853:

1. Keep the unweighted mean and label it.
2. **Duration-weighted** percent complete.
3. Effort-weighted (Σ assigned hours) percent complete.
4. Cost-weighted percent complete (each task's budget share).
5. Per-task earning rules (0/100, 50/50, milestone weights, units complete).

## Decision

**EV is BAC × the duration-weighted percent complete of the project's leaf work.**

```
leaf work   = Task.committed (not deleted, not BACKLOG, not EPIC, not recurring)
              AND NOT is_subtask
              AND NOT a phase (no committed structural child;
                               task_has_committed_child_expr)
              AND duration > 0
pct(t)      = t's subtask rollup when it has live subtasks, else t.percent_complete
              (the value the task API shows for t; task_percent_complete_rollup_expr)
pc_EV       = Σ(pct × duration) / Σ(duration)                  over leaf work, 0–100
EV          = BAC × pc_EV / 100
```

`pc_EV` is served as `percent_complete` on `GET /projects/{id}/cost/`, rounded half-up to
two places before EV is computed (the same rounding ADR-1324 already applied). CV, CPI,
EAC, ETC, VAC and TCPI keep their ADR-1324 formulas. They change only because EV does.

### Rows the sums leave out, and why

- **Phases.** A phase's percent is a rollup of its children (ADR-0293). With the phase
  counted next to its leaves, the same work would carry weight twice. Phase detection
  is the ltree probe the program rollup's leaf counts use (`task_is_phase_expr()`,
  #4238, #4276), narrowed to children in `Task.committed`
  (`task_has_committed_child_expr()`). A committed task whose only children are BACKLOG
  or EPIC rows is still leaf work: none of those children is in the sums, so treating
  the parent as a phase would drop its work with nothing standing in for it.
- **Subtasks.** A subtask is a drawer item inside its parent leaf (ADR-0060). The
  parent's dates span its subtasks and its progress is their weighted average, so the
  subtask's work is already in the parent row. "Leaf" here is the same set the phase
  status and percent rollups read: non-subtask rows with no live structural descendant
  (`scheduling.services.rollup_phase_statuses_detailed`, `percent_complete_rollup`).
  Counting the subtask as well would count the work twice. The parent is weighted at
  the percent the task API shows for it, which for a row with live subtasks is the
  subtask rollup, not the stored column. Nothing writes that rollup back to the row, so
  the stored value can be stale (a parent left at 0 % whose subtasks are all done).
  The rollup SQL is one helper shared with the task API's annotation, so the two
  cannot drift.
- **BACKLOG, EPIC, recurring.** These are the rows `Task.committed` already leaves out
  of every committed-delivery aggregate. The CPM output columns are non-null only on
  that set (ADR-1152), so a "planned duration" exists only there. A backlog item is
  uncommitted scope, an epic is a grouping node (ADR-0105), and a recurring task is a
  calendar-driven parallel activity (ADR-0090). None of them is a slice of the work the
  budget pays for.
- **Zero-duration tasks, including every milestone.** A task with `duration = 0` adds
  0 to both sums whatever its percent, so the formula already ignores it. It is still
  filtered out explicitly, for two reasons. The intent is then stated in the query
  rather than left to arithmetic, and the degenerate case below can be seen as "no row
  with a duration". A milestone plans no work and so carries no share of the budget.
  Reaching it earns nothing beyond the work that led to it. Under the old mean, a
  completed milestone added a full row at 100 %.

### Degenerate case: Σ duration = 0

When no leaf work row has a duration (no live tasks, or only milestones), the weighting
has no denominator. `percent_complete` is then **null**. EV is unavailable, and CV and
every forecast report the new stable reason **`no_planned_duration`**, never 0. This
follows the cost module's convention that a value with a missing input says which one
is missing rather than show a confident number (ADR-1324 §3; the forecast reasons of
#4852). The reason order is `cost_restricted` → `no_budget` → `missing_rates` →
`no_planned_duration`. EV alone needs a budget but no rates, so its own reason is
`no_budget` → `no_planned_duration`.

Budget utilization (AC / BAC) does not use EV, so it still computes. Its preconditions
are now separate from CV's (`ProjectCost.utilization_reason()`). On the program rollup,
a project with no basis is **left out** of the `cost_variance` total and **counted** in
a new `projects_without_planned_duration` field, which the tile shows as "N projects
not yet scheduled". `cost_variance` is unavailable with `no_planned_duration` only when
*every* contributing budgeted project is in that state. `budget_utilization` stays a
real total over all of them.

This is a different rule from `no_budget` and `missing_rates`, which still make the
program total unavailable when any one project is affected. A missing rate hides real
spend, so a partial total would understate an overrun. A project with no planned
duration has no work yet to have earned a share of its budget: it has not been
scheduled. Blanking the whole program's CV for it would blank the tile every time a
project is added, and its spend still reaches `budget_utilization`. The count travels
with the total, so a reader knows what the total does not cover.

The name is distinct from the program rollup's existing `no_planned_work`
(schedule health: "nothing planned by today") on purpose. One string meaning two
situations would make every caller describe one of them wrongly.

**This supersedes one ADR-1324 rule.** ADR-1324 (round-2 gap 1) set a project with no
live tasks to percent complete 0. A spent-but-abandoned project would then show its
whole AC as negative CV, and the program total would not silently drop it. Under a
weighted basis, a 0 there would be an invented number: there is no work to have earned
a share of. The overrun is not hidden. Utilization still reports the spend (AC / BAC
reaches 1.0 for an abandoned project that spent its budget), and the program CV tile
counts the project as not yet scheduled instead of summing an assumed −AC into the
total.

### Which duration is "planned": current `duration`, not a baseline

The weights are each task's **current** `duration` (integer working days, the value the
engine schedules). A baseline duration is not used. In textbook EVM the weights are
frozen at baseline, so this is a real departure, taken for these reasons:

- **Baselines are optional and partial.** Many projects never set one. A task added
  after the baseline has no baselined duration. A baseline-only basis would make EV
  unavailable for most projects, or silently drop new scope from the denominator.
- **BAC is not baselined either.** `Project.budget` is one editable number with no
  per-task allocation (ADR-1324 §1). Freezing the weights while the total stays mutable
  buys no stability that the inputs actually have.
- **Planned value needs the baseline.** PV, SPI and the time-phased curve are what a
  baseline is for, and that is #2139's scope (below).

The cost is stated in the definitions and docs: **re-estimating a task's duration
re-weights it**, so EV can move without any progress being recorded. The `provenance`
block says so. Its `percent_complete_source` is
`duration_weighted_leaf_task_percent_complete`.

`COST_CONTRACT_VERSION` stays `"1"`. The version exists so a figure someone quoted can
be traced to the contract that produced it, and the cost summary has not shipped in a
release (it lands in 0.5, which is underway). No figure was ever quoted under the
unweighted basis, so there is nothing to tell apart, and a bump would present an
unreleased draft as a released contract. The first change to the contract after 0.5
ships bumps it.

### Why duration rather than effort or cost

- **Cost-weighted (option 4)** is the textbook answer, but it needs a budget on each task.
  TruePPM has one project budget (ADR-1324) and cost loading is #1444. It cannot be
  computed from data that exists.
- **Effort-weighted (option 3)** needs assignments. Unassigned tasks (common early in a
  plan, and on any project not using resources) would weigh 0, so EV would follow
  staffing rather than scope.
- **Duration** is set on every schedulable task, is the engine's own input, and never
  depends on whether resources or rates are configured. It is the closest proxy for
  "share of the work" that every project already has.
- **Per-task earning rules (option 5)** are a refinement of how a task's percent is
  read, not a choice of weights. They compose with this basis and are left to #2139.
- **Keeping the mean (option 1)** leaves the phase double count, a defect rather than a
  trade-off.

### Not the project list's percent complete

The project list's `percent_complete` (ADR-0171) stays an unweighted mean. It is
displayed everywhere and is out of scope for a cost decision. The two figures can
therefore differ, and both the `definitions` text and the docs say so. ADR-1324's test
that pinned the two as equal is replaced by tests that pin the weighting.

## Interaction with #2139 (EV-lite, 0.8)

#2139 adds PV and SPI from baselines, plus parent-level rollups via #957. This ADR fixes
the **EV** half of that work in 0.5, so #2139 should reuse `project_percent_complete()`
for EV rather than define a second one. A project then reports one EV, and the SPI
that #2139 adds (EV / PV) and the CPI here (EV / AC) share a numerator. Three questions
are left open for #2139 to decide:

- whether PV's weights come from **baseline** duration while EV's stay on current
  duration. If they differ, re-estimating a task moves EV and not PV, which is visible
  as SPI drift. #2139 must either accept and document that, or move EV to baselined
  weights when a baseline exists (and fall back to current duration when it does not).
- per-task earning rules (option 5), if PMs ask for them.
- a parent-level (phase) EV, which is a rollup of this same leaf set and must not
  re-introduce the phase row as a weighted member.

## AI readiness (ai-review)

- **First-class server fact:** `percent_complete` (the weighted basis), `earned_value`,
  and the reason when either is unavailable are on `GET /projects/{id}/cost/` and the
  read-only MCP `get_project_cost` tool. An agent never needs to recompute them from
  tasks, and the MCP docstring tells it not to.
- **Explainable:** `definitions.percent_complete` / `definitions.earned_value` state the
  formula, the excluded rows and what EV does not mean. `provenance.inputs` names the
  basis. `provenance.figures.earned_value` carries `no_planned_duration` when there is
  no value.
- **No new write path.** This changes a read-only derived value. There is nothing for
  an agent to mutate, and no new extension point. OSS (ADR-1324's classification is
  unchanged; this is one project's cost, not portfolio EVM).

## Consequences

- EV, CV and the forecasts change for any project whose leaf tasks have unequal
  durations, or that has phases or milestones. A project of equal-duration leaf tasks
  with no phases reads the same as before.
- A budgeted project with no leaf work (new, or abandoned) reports
  `no_planned_duration` for CV and the forecasts rather than `EV = 0`. The program
  `cost_variance` total leaves such projects out and shows how many
  (`projects_without_planned_duration`, "N projects not yet scheduled"). It goes
  unavailable only when every contributing budgeted project is in that state. An
  abandoned project's spend is therefore absent from the program CV total, and is
  visible in `budget_utilization` and in the count.
- Response shape: `percent_complete` on the cost summary is nullable. The KPI `reason`
  enum gains `no_planned_duration`. The program rollup KPI gains
  `projects_without_planned_duration`. All of these are additive, or a widening of a
  field that was documented as never null.
- Performance: still one grouped query for the percent (now a `Sum(pct × duration)`
  and a `Sum(duration)` per project, with a committed-child ltree `EXISTS` for the phase
  test and the task API's correlated rollup subquery for each leaf's percent). `project_cost_facts` stays at a fixed six queries for any number of
  projects.

## Alternatives considered

See options 1, 3, 4 and 5 under **Why duration rather than effort or cost**. A baseline
duration basis is covered under **Which duration is "planned"**.
