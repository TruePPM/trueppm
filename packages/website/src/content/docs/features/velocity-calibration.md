---
title: Velocity calibration
description: On sprint close, TruePPM uses team velocity to suggest a more accurate most-likely duration for each task — non-destructively.
---

When a sprint closes, TruePPM computes the team's rolling six-sprint velocity (points completed per working day) and, for each task in the closing sprint with story points set, suggests a new **most-likely duration**. The suggestion appears in the Task Detail Drawer's **Estimates** section as a "Revise estimate from Sprint N?" banner. The PM accepts or dismisses it; the underlying value is never overwritten without consent.

This is the agile → CPM half of the [hybrid PM bridge](/the-story/#7-forecast--monte-carlo-across-both-worlds) — sprint reality feeding back into the Monte Carlo forecast.

## Where this lives in the story

After Step 6 ([Execute — daily cadence, two worlds in sync](/the-story/)) closes a sprint, the next CPM recompute carries the team's actual delivery rate forward into the forecast.

## What you see

- **Banner** in the Task Detail Drawer ([Estimates section](/features/scheduler/)) when a pending suggestion exists:

  > 📈 Revise estimate from Sprint 12? Team velocity suggests **4d** for this task (currently **2d**).
  > [Dismiss] [Accept]

- **Accept** writes the new value to `most_likely_duration` and enqueues a CPM + Monte Carlo recompute so the schedule reflects the calibrated estimate immediately.
- **Dismiss** records the PM's decision audit-trail-style; the task estimate is untouched and no further prompts arrive for that (task, sprint) pair.
- The banner is PM-only (role ≥ Project Manager). Lower roles never see it — TruePPM does not surface CPM language to the delivery team.

## When suggestions are generated

A `VelocitySuggestion` row is created when **all** of the following hold:

1. A sprint has just transitioned to `COMPLETED` (via the sprint close drain).
2. The project has at least **three** prior completed sprints. Below that threshold the rolling average is too noisy to trust; no suggestion appears.
3. Rolling team velocity is **non-zero**. A zero-velocity team produces an undefined duration, so suggestions are skipped until the team has delivered something.
4. The task has `story_points > 0` and `most_likely_duration ≠ suggested_duration` (no point prompting the PM to accept the value already in place).

The formula is:

```
team_velocity_per_day = mean(completed_points / sprint_working_days)  # last 6 closed sprints
suggested_duration    = round(task.story_points / team_velocity_per_day)
```

A single working day is the minimum — a suggestion of zero is clamped to 1.

## Governance — estimation_mode

When the project's [estimation mode](/features/scheduler/) is `suggest_approve`, the suggestion is marked `flag_for_review = true`. In `pm_only` and `open` modes the PM may accept directly. The estimate is **never** modified silently — the accept decision is always explicit.

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/api/v1/velocity-suggestions/?task={id}&pending=true` | List pending suggestions for a task |
| `POST` | `/api/v1/velocity-suggestions/{id}/accept/` | Write `most_likely_duration` and enqueue CPM recompute (PM only) |
| `POST` | `/api/v1/velocity-suggestions/{id}/dismiss/` | Audit-only dismissal (PM only) |
| `GET`  | `/api/v1/projects/{id}/velocity/` | Now also includes `team_velocity_per_day` for the project |

`accept` is idempotent on an already-accepted suggestion. Re-accepting after dismiss (or vice versa) returns HTTP 409 to preserve the original decision.

## Related ADRs

- [ADR-0065](/architecture/adr/) — Hybrid Bridge v1.1 (velocity feedback, "My Work", inbound sync)
- [ADR-0032](/architecture/adr/) — Three-point estimates (the input that velocity calibrates)
- [ADR-0037](/architecture/adr/) — Sprint model and close drain

## If you are…

- **Raj (PM)** — read the banner when it appears. Accept when the team's pace genuinely differs from the original estimate; dismiss when the difference is a one-off (Black-Friday-week noise, a contractor onboarding, etc.). Either way, your decision is preserved in the audit trail.
- **Maya (Scrum Master)** — you don't see this surface. Sprint reality is yours; CPM calibration is the PM's.
- **Carlos (Exec)** — calibrated estimates feed Monte Carlo, which feeds your portfolio forecast. The honesty of the forecast depends on the PM keeping up with these suggestions.
