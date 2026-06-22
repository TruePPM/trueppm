---
title: For Agile Coaches
description: How to evaluate TruePPM the way a coach does — for team autonomy, low ceremony, and voluntary adoption, not a feature checklist.
---

You don't evaluate tools by feature count. You evaluate them by what they do to a team. Every "hybrid" tool you've tried is really waterfall with a board bolted on, where the PM still controls the sprint and the PMO turns velocity into a pressure gauge — and within a quarter the team fills in the minimum, data quality rots, and the dashboards become fiction.

So your one question is simple: **does this give teams autonomy, or give management control?** A tool that genuinely delivers both is the thing you've been looking for. This guide is about how to check that here, not a tour of buttons.

## What to look for

### The sprint stays the team's

A board with date columns lets anyone with PM access quietly reshape a sprint. TruePPM treats the sprint as a team-owned container. **Audited, deliberate mid-sprint scope changes ship in 0.3**: a scope injection becomes a recorded decision with a point cost and an epic tag, visible to the team — not a silent edit. The standup **daily-delta panel (also 0.3)** is pull-only and status-level by design: it surfaces what moved, what's blocked, and what scope arrived, but it will **never** show hours, durations, or edit counts, and a Viewer sees only team totals — never a per-person breakdown.

→ See [Sprints workspace](/features/sprints/) and the [roadmap](/overview/roadmap/) for the 0.3 sprint-sovereignty work

### Velocity is a team signal, not a management scoreboard

Velocity is a planning tool for the team. The moment the PMO watches it as a productivity metric, teams game it. In TruePPM, **velocity is team-private by default** — it informs the PM's schedule forecast through the team's own sharing choice, and it is not automatically piped onto a management dashboard. Milestone *health* flows upward; per-team velocity does not, unless the team opens that audience.

→ See [Velocity](/features/velocity/) and [Signal privacy settings](/features/settings/signal-privacy/)

### Retros that don't die in a doc

A retro action item that gets copy-pasted by whoever remembers is a retro action item that dies. In the retrospective panel, an action flagged **promote to backlog** becomes a real task in the next sprint's backlog automatically when the sprint closes, with a chip linking back to the retro that raised it. The pipeline is real, not a checkbox.

→ See [Retrospective panel](/features/retrospective/)

### Health signals for coaches, not pressure for the PMO

WIP overload is a team-health signal: when a column passes its limit, the board turns amber then red — a conversation starter for the team, not a metric reported upward. It's the kind of signal you want a team to see for itself.

→ See [WIP overload detection](/features/wip-overload/)

### Low ceremony, so adoption is voluntary

The fastest way to kill adoption is to add "fill this in for the PMO" steps. The agile surface here is the team's daily working surface — board, sprint, retro — not a reporting form. A team member moves a card and the schedule updates itself; nobody files a status report. That's the difference between a tool teams adopt and a tool teams endure.

## Evaluate it yourself (~10 minutes): the autonomy test

The real test isn't what a feature does — it's what *each role can see and do*. So evaluate it as a contrast. Seed the demo (`seed_demo_project --with-personas`), then sign in as two different people.

**First, as the team — sign in as `maya` (Scrum Master, password `demo`):**

1. Open the **retrospective** on a closed sprint and find an action item promoted to the backlog — confirm the pipeline actually carried it forward.
2. Walk the **board** to the WIP-overload column (amber/red) — the team sees its own pressure without anyone reporting it.

**Then, as management — sign in as `diana` (PMO Director) or `carlos` (Executive):**

3. Confirm what they **cannot** reach: per-person hours, edit counts, or a velocity scoreboard. They see milestone and schedule health; the sprint internals stay with the team.

That contrast — the team owns the sprint, management sees health, and neither can quietly become the other — is the thing you've been hired to protect. If it holds, this is a tool a skeptical senior developer will open *voluntarily*, which is the only adoption that survives.

## Coaching with TruePPM

A few of the signals above double as coaching evidence:

- **WIP overload** is your opening to talk about flow and finishing before starting.
- **Mid-sprint scope injections** (audited from 0.3) give you the record to coach the PM on respecting the sprint boundary — with data, not opinion.
- **The retro-to-backlog pipeline** lets you coach teams that their retros *change something*, because the actions visibly reappear as work.

## Getting started

1. Ask your admin to [set up a TruePPM instance](/getting-started/installation/)
2. Seed the demo and run the autonomy test above — sign in as `maya`, then as `diana`
3. Read the [Scrum Masters guide](/guides/scrum-masters/) — it's the surface your teams live on day to day
4. Check the [roadmap](/overview/roadmap/) for the 0.3 sprint-sovereignty work (audited scope changes, the daily-delta standup, team-owned velocity)
