---
title: For Scrum Masters
description: How TruePPM supports sprint facilitation, WIP management, velocity tracking, and hybrid delivery — without forcing you to learn CPM.
---

You run sprints. You care about the board, velocity, and whether your team is healthy. You don't want to learn CPM, and you shouldn't have to. TruePPM is built so your agile surface is fully native — and the translation to the PM's Gantt happens automatically, behind the scenes.

This is your guide. The PM's Gantt exists. You don't have to open it.

## Sprint lifecycle

TruePPM sprints have three states: **Planned → Active → Closed**. Only one sprint per project can be active at a time.

### Planning a sprint

Open the Sprints workspace and use the **Plan next** button to create the next iteration. Set the name, start date, finish date, and an optional sprint goal. The default cadence is two weeks — adjust to match your team's rhythm.

Stories in the backlog carry over automatically unless the previous PM baselined them out of scope. Sprint planning happens on the board: drag stories from the backlog column into the sprint, discuss, split, estimate.

→ See [Plan Sprint dialog](/features/plan-sprint/) for field details.

### Activating a sprint

When the team is committed, activate the sprint. Activation locks the sprint scope for burndown tracking — subsequent scope adds are marked as scope change events on the burndown chart so you can see what arrived mid-sprint vs. what was committed.

Capacity preflight runs automatically at activation: it checks whether the sprint's estimated story points are within the team's available hours. If anyone is over-allocated, you see it before you start — not on day 8 when it's too late.

→ See [Capacity preflight](/features/capacity-preflight/)

### Closing a sprint

At the end of the sprint, use the **Close** action. TruePPM prompts you to choose what to do with unfinished stories: carry them over to the next sprint or return them to the backlog. Velocity is recorded from completed story points.

The retrospective panel is attached to the sprint. Action items you mark with "promote to backlog" become real tasks in the next sprint automatically.

→ See [Retrospective panel](/features/retrospective/)

## The board

The board is your daily view. Five columns: **Backlog → Not Started → In Progress → Review → Done**. Each column has a WIP limit — when a column exceeds its limit, it turns amber (warning) or red (over limit). The default limits are IN_PROGRESS: 5, REVIEW: 3.

### What you see on each card

- Task name and assignees (up to 3 avatars)
- Story points
- Sprint chip (which sprint this story belongs to)
- Critical-path indicator (if the story is on the project's critical path — rare for sprint stories, but possible for baselined work packages)
- Blocked indicator (red border if the task has an unresolved dependency)
- Progress ring

### Daily standup flow

1. Filter to the active sprint using the sprint filter in the toolbar
2. Walk the board right-to-left: Review → In Progress → Not Started
3. Flag any blocked cards (red border = unresolved dependency or impediment)
4. Check the WIP overload panel if any column is red — this is the conversation starter

→ See [WIP overload detection](/features/wip-overload/)

## Velocity

TruePPM tracks velocity across all closed sprints. The velocity panel shows a bar chart of the last 8 sprints with a rolling average and standard deviation. This is the number that feeds the PM's forecast — no manual export, no spreadsheet.

### What velocity drives

Your team's velocity automatically updates the CPM duration estimate for the work packages your stories roll up into. When sprint 4 closes and you delivered 34 points instead of the 40 the schedule assumed, the PM's Gantt re-forecasts the work package's finish date automatically. **You didn't do anything. The math updated itself.**

This is the core hybrid benefit: your team's actual delivery rate becomes the PM's schedule input without any intermediate sync.

→ See [Velocity panel](/features/velocity/), [Velocity calibration](/features/velocity-calibration/)

## Burndown

The burndown chart shows actual vs. ideal burn across the sprint. Key elements:

- **Solid line**: actual remaining story points (updates in real time as tasks complete)
- **Dashed line**: ideal linear burn from sprint start to zero
- **Amber dots**: scope additions (stories added after sprint activation)
- **Vertical dashed line**: today
- **Forecast chip**: extrapolated close date based on current burn rate

If the forecast chip shows a date after the sprint end, the conversation to have is "what do we cut?" — not "can everyone work this weekend?"

→ See [Sprint burndown](/features/sprint-burndown/)

## Retrospective → next sprint

The retrospective panel lives inside the sprint workspace. It has two sections:

1. **Notes** — free-form text for the retro discussion (what went well, what didn't, puzzles)
2. **Action items** — structured list with assignee, story points, and a "promote to backlog" checkbox

Action items with the promote checkbox selected become real tasks in the project backlog when you close the sprint. They show up in the next sprint's planning session with `→ T-XXXXXX` chips linking back to the originating retro action.

→ See [Retrospective panel](/features/retrospective/)

## Multi-team support

If you're the Scrum Master for more than one team, the multi-team lens aggregates your active sprints across projects. You see per-project summary cards: day N of the sprint, remaining story points, capacity %, trend, and forecast close date — sorted by most-behind first.

→ See [Multi-team Sprints lens](/features/multi-team-lens/)

## The hybrid handshake

The most important thing to understand about TruePPM's hybrid model: **you and the PM are not looking at two different tools that sync.** You're both looking at two views of the same data.

When the PM builds the schedule, they create work packages with CPM dependencies. Your team's stories are child tasks of those work packages. Your sprint work and the PM's schedule are structurally linked — not via integration, not via export, not via a Monday morning sync.

This means:
- You never have to update a "status report" for the PM. Your burndown is their forecast input.
- The PM never has to interrupt your sprint to ask "how confident are you?" — they can see your velocity trend.
- When scope changes happen inside the sprint, the PM sees them as variance on their Gantt immediately.

Your job is still just: run good sprints, protect the team, facilitate retrospectives, track velocity. The hybrid side takes care of itself.

→ Read the full walkthrough in [The Story](/the-story/)

## Getting started

1. Ask your admin to [set up a TruePPM instance](/getting-started/installation/)
2. Walk through the [Quickstart](/getting-started/quickstart/) — seed the demo project and log in as `alex` (Scrum Master persona)
3. Explore the [Sprints workspace](/features/sprints/) — the full feature reference
4. Review the [Board](/features/board/) for WIP configuration details
