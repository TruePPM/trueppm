---
title: For Agile Coaches
description: How to evaluate TruePPM the way a coach does — for team autonomy, low ceremony, and voluntary adoption, not a feature checklist.
---

You don't evaluate tools by feature count. You evaluate them by what they do to a team. Every "hybrid" tool you've tried is really waterfall with a board bolted on, where the PM still controls the sprint and the PMO turns velocity into a pressure gauge — and within a quarter the team fills in the minimum, data quality rots, and the dashboards become fiction.

So your one question is simple: **does this give teams autonomy, or give management control?** A tool that genuinely delivers both is the thing you've been looking for. This guide is about how to check that here, not a tour of buttons.

## What to look for

### The sprint stays the team's

A board with date columns lets anyone with PM access quietly reshape a sprint. TruePPM treats the sprint as a team-owned container. **Audited, deliberate mid-sprint scope changes arrived in 0.3**: a scope injection becomes a recorded decision with a point cost and an epic tag, visible to the team — not a silent edit. The standup **daily-delta panel (also 0.3)** is pull-only and status-level by design: it surfaces what moved, what's blocked, and what scope arrived, but it will **never** show hours, durations, or edit counts, and a Viewer sees only team totals — never a per-person breakdown.

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

The real test isn't what a feature does — it's what *each role can see and do*. So evaluate it as a contrast: run the same instance as two different people and compare. Run these steps in order — they start from a machine with nothing running.

1. **Start the stack and seed the demo.** From your TruePPM checkout (if you have not installed yet, start with [Installation](/getting-started/installation/)):

   ```bash
   make up
   docker compose exec api python manage.py load_sample_project --with-personas
   ```

   The command prints the sample's persona logins (`atlas-alex`, `atlas-priya`, …) and their shared password when it finishes. On a local Docker stack (`DEBUG=True`) that password is `demo`; anywhere else it is `$TRUEPPM_DEMO_PASSWORD` if you set it, otherwise a random token printed once — copy it before you clear the terminal.

**First, as the team.** Sign in at `http://localhost:5173` as **`maya`** — the Scrum Master, seeded with the **Member** role:

2. Open **Deliver → Sprints** in the left navigation rail (`/projects/:id/sprints`), select a closed sprint, and scroll to the **retrospective** panel below the timeline. Find an action item promoted to the backlog and confirm the pipeline actually carried it forward — it appears in the next sprint with a `→ T-XXXXXX` chip back to the retro.
3. Open **Deliver → Board** and walk to the WIP-overload column (amber or red). The team sees its own pressure without anyone reporting it.
4. Open **Settings → Signal privacy** and note that velocity's audience is the team's own choice — it is not published upward by default.

**Then, as management.** Sign out and sign back in as **`diana`** (PMO Director, **Admin**) or **`carlos`** (Executive Sponsor, **Viewer**):

5. Retrace steps 2–4 and confirm what management **cannot** reach: per-person hours, edit counts, or a velocity scoreboard. They see milestone and schedule health; the sprint internals stay with the team. `carlos` in particular is read-only everywhere — a sponsor who cannot quietly reshape a sprint.

That contrast — the team owns the sprint, management sees health, and neither can quietly become the other — is the thing you've been hired to protect. If it holds, this is a tool a skeptical senior developer will open *voluntarily*, which is the only adoption that survives.

## Coaching with TruePPM

A few of the signals above double as coaching evidence:

- **WIP overload** is your opening to talk about flow and finishing before starting.
- **Mid-sprint scope injections** (audited from 0.3) give you the record to coach the PM on respecting the sprint boundary — with data, not opinion.
- **The retro-to-backlog pipeline** lets you coach teams that their retros *change something*, because the actions visibly reappear as work.

## Where to go next

- [Installation](/getting-started/installation/) — stand up an instance, or send this to whoever will
- [Scrum Masters guide](/guides/scrum-masters/) — the surface your teams live on day to day
- [Evaluation guide](/getting-started/evaluation-guide/) — the Aurora and Helios samples, where a scope injection is accepted in one program and rejected in another
- [Signal privacy settings](/features/settings/signal-privacy/) — who can see velocity, and who decides
- [Roadmap](/overview/roadmap/) — the 0.3 sprint-sovereignty work (audited scope changes, the daily-delta standup, team-owned velocity)
