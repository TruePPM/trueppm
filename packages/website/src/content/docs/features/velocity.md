---
title: Velocity panel
description: Last-8 closed sprints with rolling avg ± stdev and a forecast range chip.
---

A bar chart of the last 8 closed sprints, colour-coded by completion ratio, with rolling average ± standard deviation and a forecast range chip. The footer links to ADR-0036 — the velocity ↔ CPM feedback decision.

## Where this lives in the story

Step 7 ([Forecast — Monte Carlo across both worlds](/the-story/#7-forecast--monte-carlo-across-both-worlds)) of the [hybrid PM flow](/the-story/) — the velocity history that turns sprint cadence into a defensible probability for Carlos's exec view.

## What you see

- **Primary stat:** `{avg} ± {stdev} pts (last N)` using `.tppm-mono`
- **Forecast chip:** `Forecast {low}–{high} pts` right-aligned (range is `avg ± 1 stdev`, rounded to int)
- **Bar chart:** 8 bars (or as many closed sprints as exist), coloured by completion ratio:
  - ≥ 0.85 → `semantic-on-track`
  - 0.6–0.85 → `semantic-at-risk`
  - < 0.6 → `semantic-critical`
- **Footer:** `Velocity feeds CPM duration estimates · ADR-0036` link

## On the Board sprint panel

The active-sprint panel at the top of the **Board** carries a compact version of the same data:

- **History chart with a range band:** the 8-sprint bars sit behind a shaded **min–max band** with a dashed **P50 (median)** line, so the typical throughput reads at a glance.
- **Delivery forecast line:** a one-line answer to "when does it ship?" —
  - if the active sprint is bound to a milestone, the milestone's reforecast **P50 / P80 dates** (from the sprint-close reforecast bridge, ADR-0106);
  - otherwise the remaining committed backlog re-paced into "~N–M more sprints to clear X pts (by ~date)";
  - falling back to "Need at least 3 closed sprints to forecast delivery" until there is enough history.
- **Team-private by default:** velocity is gated by the team-signal privacy ladder (ADR-0104). When the reader's tier is below the velocity audience, the card shows a "Velocity is team-private" state and the forecast is not fetched — never a misleading empty chart.

## Where to find it in the app

- Route: `/projects/:projectId/sprints` (right column of the metrics row, bottom half)
- Board: top sprint panel → **Velocity** card (history band + forecast line)

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/v1/projects/{id}/velocity/` | Last-8 closed sprint points/tasks (each with `exclude_from_velocity`) + rolling stats + forecast range + `team_velocity_per_day` + `excluded_count` |

The `team_velocity_per_day` field is the same rolling per-day average used by [velocity calibration](/features/velocity-calibration/) suggestions on sprint close. The response also carries an `excluded_count` and a per-sprint `exclude_from_velocity` flag (see [Setup work & Sprint 0](#setup-work--sprint-0)).

## Setup work & Sprint 0

A **setup or ramp-up iteration** — what agile teams often call a "Sprint 0" — is the period before real delivery begins: standing up the environment, forming the team, building the initial backlog, spiking the architecture. Its throughput is low or zero, so if it is run as a sprint and closed, it drags the rolling average down and widens the forecast band until it ages out of the window — and that contamination flows into the milestone delivery forecast too.

TruePPM is scheduling-first, so it has an opinion about where this work belongs:

- **Model mobilization as schedule tasks, not a sprint.** Setup work is real work with durations and dependencies — put it on the schedule (the waterfall side of the hybrid bridge), where it shows up in the critical path and the Gantt rather than as a misleading zero-velocity sprint. This keeps your velocity baseline clean from the start.
- **If you do run a ramp-up sprint, exclude it from velocity.** A Scheduler (or above) can flag any sprint **Exclude from velocity** from the sprint workspace. An excluded sprint is held out of the rolling average, the forecast band, and the [milestone reforecast](/features/sprint-milestone-rollup/) — but it stays fully visible in your history.

### How an excluded sprint reads

- In the velocity chart the bar is **muted and hatched** (and hollow in the Board sparkline), labelled `excl`, so it is marked rather than silently dropped — you can always see what was excluded and why.
- The panel shows an **`⌀ N excluded`** chip and the rolling-average label counts only the sprints that still feed velocity.
- The flag is **team-owned**: it is set by the team's Scheduler-and-above, with no PMO override, and every change is recorded in the sprint's history audit trail. It can be set **after a sprint closes** — teams usually realize a sprint skewed their numbers only in hindsight.

The exclusion is honored everywhere velocity is consumed: the panel, the Board sparkline, the delivery forecast, and the CPM velocity-calibration source — a single rule, applied once.

## Why ± stdev, not a point estimate

Stakeholders trust a range more than a single number. A forecast that says "5–8 sprints remaining" defends itself against the team's natural variance; a point estimate is brittle.

The terminology is **forecast range**, not "velocity confidence band" — confidence band has a specific statistical meaning we are not claiming here. Velocity is XP-origin (not part of core Scrum) but real-world standard practice; we surface it as a practice-layer tool, not a process mandate.

## Related ADRs

- [ADR-0036](/architecture/decisions/) — Hybrid PM philosophy: how velocity feeds CPM duration estimates
- [ADR-0037 §Q3](/architecture/decisions/) — Velocity storage decision (snapshot on close, not computed from history)

## If you are…

- **Carlos** — read the forecast range chip. The footer ADR link explains why this is defensible.
- **Raj** — the rolling avg drives the work package re-forecast on the Schedule view at Step 6.
- **Maya** — own the trajectory. If the bar colour is shifting amber over multiple sprints, the team is signalling something.
