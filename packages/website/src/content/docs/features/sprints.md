---
title: Sprints workspace
description: Sprint header, goal, milestone link, and the cadence timeline strip.
---

The Sprints workspace is the agile-side surface — Maya the Scrum Master and Tom the engineer live here. It composes five panels (header, goal, milestone link, timeline, backlog) into a single route at `/projects/:id/sprints`.

:::note[Ships in 0.3]
Three of the capabilities below — the read-only **closed-sprint review**, the per-sprint **WIP limit** chip, and **Exclude from velocity** — ship in 0.3. They are merged but not yet in a tagged build — see the [roadmap](/overview/roadmap/).
:::

## Where this lives in the story

Step 5 ([Sprint planning](/the-story/#5-sprint-planning--the-team-pulls-work)) and Step 6 ([Execute](/the-story/#6-execute--daily-cadence-two-worlds-in-sync)) of the [hybrid PM flow](/the-story/).

## What you see

- **Sprint header** — H1 (`Sprint N — name`), state pill, Filter / Plan next / Close sprint actions
- **Sprint goal card** — narrative + day-N-of-M + task count + points committed
- **Advancing-to-milestone card** — milestone WBS, target date, days-out chip, deep-link to the Schedule view at the milestone task
- **Sprint Cadence timeline** — Closed sprints (grayed) → Active (sticky-left, ringed) → Planned cards. Each card leads with the sprint **name**, and its points bar makes over-commitment visible: a sprint that finishes **over** its committed points shows the overage as a distinct segment past a capacity marker with a `+N over` flag, rather than a "full" bar that reads as simply done. The strip is also a **selector**: click any card to load that sprint in the workspace (the selected card carries a navy ring).
- **Reviewing a past sprint** — selecting a **closed** sprint shows a read-only review: a five-card outcome row (goal verdict, committed/completed points, rolled-over, velocity Δ), the frozen historical burndown, the retrospective, and a **"what didn't ship"** list (each unfinished task with whether it carried to another sprint or was dropped). All of it reads from the consolidated sprint-outcome API; velocity figures stay team-private for readers outside the velocity audience.
  - **Sprint Review breakdown** *(ships in 0.3, ADR-0118)* — the review surface also shows an acceptance breakdown derived from each story's acceptance criteria. Stories fall into three states: **accepted** (all criteria met), **criteria incomplete** (has criteria, not all met), and **criteria not set** (no criteria — a muted coverage-hygiene state, never counted as accepted). These are framed as coverage states, not grades. Acceptance can be ticked live during the review — the review *is* the acceptance ceremony. Counts are always visible; story points follow the same team-private velocity gate, so the PM can read the review without seeing per-team throughput.
  - **Committed → shipped line** *(ships in 0.3)* — the review opens with a plain count line, *"N committed → M shipped, K carried over"*, drawn from the sprint's at-activation commitment snapshot. These counts are **always visible to the whole team**, never behind the velocity/points gate — the team already knows what it committed.
  - **Demo curation** *(ships in 0.3)* — a one-tap ★ toggle marks each shipped story for the stakeholder walkthrough, and Members can **drag the demo-flagged stories into walkthrough order** and name a **presenter** for each. Read-only viewers see the curated order and presenter without the controls.
  - **Criteria click-through, contributor notes, and carry-forward** *(ships in 0.3)* — a *criteria incomplete* story discloses exactly which criteria are unmet on click; a *criteria not set* badge offers an inline **Add criteria** jump to the story's acceptance editor. Contributors can leave an **optional** note ("visible to reviewers") — never required — and **flag the story for the backlog in one tap**, carrying its title and points forward into the project backlog (idempotent, so a second tap never duplicates).
- [Burndown chart](/features/sprint-burndown/), [Capacity preflight](/features/capacity-preflight/), [Velocity panel](/features/velocity/), and [Sprint backlog](/features/sprint-backlog/) populate the rest of the page when an active sprint is selected.
- **Daily standup — "what changed since yesterday"** *(ships in 0.3, ADR-0121)* — the active sprint shows a team-facing delta for the Daily Scrum: moved cards (status changes), new blockers (anything moved to *On hold*), scope added since yesterday, the burndown swing, and a per-person at-a-glance of what each teammate touched. It is **pull, not push** — you open it at standup; there are no notifications — and it is **team-private by membership**: a portfolio/PMO viewer who is not a project member cannot reach it, and it shows only status-level changes, never hours or keystroke-level detail. The window defaults to the last 24 hours. Computed live from existing history — no new tracking. (Distinct from the PM milestone-confidence digest, which is the close-time bridge surface.)
- **WIP limit** *(optional)* — set a per-sprint ceiling on in-flight work (tasks in *In progress* or *Review*) and the Board's [sprint panel](/features/board/) header shows a `WIP {count} / {limit}` chip that turns amber once the count exceeds the limit. Editable by Scheduler+ on planned and active sprints; locked once completed or canceled. Distinct from per-column board WIP limits.
- **Exclude from velocity** *(optional)* — a Scheduler+ toggle that holds a setup or ramp-up sprint (a "Sprint 0") out of the team's velocity average, forecast band, and milestone forecast, so its low throughput doesn't skew the numbers. Unlike the WIP limit it stays editable **after the sprint closes** (teams often realize the skew in hindsight). The sprint stays visible in your history, marked rather than dropped. See [Setup work & Sprint 0](/features/velocity/#setup-work--sprint-0).

## Planning a sprint — the unified planning surface (ships in 0.3)

:::note[Ships in 0.3]
The unified planning surface, the planning bridge banner, and the incoming-carryover preview described below ship in 0.3 (the agile team release). They are not yet in a tagged build — see the [roadmap](/overview/roadmap/).
:::

Selecting a **planned** sprint in the cadence strip switches the workspace into a planning layout — everything the team needs to pull a sprint together lands on one screen instead of being scattered across tabs:

- **Backlog (left)** — the project [backlog](/features/sprint-backlog/) of sprint-less tasks, ready to pull into the planned sprint.
- **Capacity gauge** — the [Capacity preflight](/features/capacity-preflight/) panel, including the points chip and footer (0.3), so the team sees committed-vs-ceiling as they pull work in.
- **Incoming-carryover preview** — see below.
- **Planning bridge banner** — see below.

### Planning bridge banner

A planned sprint shows its draft **goal** next to the schedule **milestone it advances** — the milestone diamond, its name, and its target date — so the team can see *which contract date this sprint moves* before they commit a single point. Beneath it: **"N of M predecessor tasks land in this sprint"**, the count of the milestone's predecessor tasks that are already pulled into the sprint.

An inline **milestone picker** lets the team bind or change the advancing milestone without leaving the planning screen. Binding here sets `Sprint.target_milestone`, which is the same link that drives the live [sprint → milestone rollup](/features/sprint-milestone-rollup/) once the sprint activates.

### Incoming-carryover preview

A read-only sidebar lists the unfinished tasks from the **previous closed sprint** that rolled forward into this planned sprint, with the points each carried. It answers "what came in before we even started planning?" so the team plans on top of the real remaining commitment rather than a clean slate. It is backed by the `incoming_carryover` endpoint (see [API endpoints](#api-endpoints)).

> _Screenshot of the unified planning surface (backlog · capacity gauge · carryover · bridge banner) to be added once 0.3 ships._

## Where to find it in the app

- Route: `/projects/:projectId/sprints`
- Tab: **Sprints** (visible by default for HYBRID and AGILE projects per [methodology preset](/features/methodology-preset/))

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/api/v1/projects/{id}/sprints/` | List every sprint for a project |
| `POST` | `/api/v1/projects/{id}/sprints/` | Create a planned sprint (see [Plan Sprint dialog](/features/plan-sprint/)) |
| `GET`  | `/api/v1/sprints/{id}/` | Sprint detail with `target_milestone_detail` nested |
| `GET`  | `/api/v1/sprints/{id}/incoming_carryover/` | Unfinished tasks that rolled forward from the previous closed sprint, with points carried (ships in 0.3) |
| `POST` | `/api/v1/sprints/{id}/activate/` | PLANNED → ACTIVE; returns capacity warnings |
| `POST` | `/api/v1/sprints/{id}/close/` | Async close via outbox; returns 202 + request id |
| `POST` | `/api/v1/sprints/{id}/cancel/` | PLANNED → CANCELLED |
| `GET`  | `/api/v1/sprints/{id}/outcome/` | Consolidated review read — commitment, goal, velocity, the "didn't ship" list, and the review breakdown (ships in 0.3) |
| `POST` | `/api/v1/sprints/{id}/demo-list/reorder/` | Reorder the demo walkthrough (Member+; full ordered outcome-id list, ships in 0.3) |
| `POST` | `/api/v1/sprint-task-outcomes/{id}/toggle-demo/` | Flag/unflag a shipped story for the demo (Member+, ships in 0.3) |
| `POST` | `/api/v1/sprint-task-outcomes/{id}/set-presenter/` | Set the demo presenter for a story (Member+, ships in 0.3) |
| `POST` | `/api/v1/sprint-task-outcomes/{id}/set-note/` | Set the optional contributor review note (Member+, ≤200 chars, ships in 0.3) |
| `POST` | `/api/v1/sprint-task-outcomes/{id}/flag-for-backlog/` | Carry a not-shipped story forward to the backlog in one tap (Member+, idempotent, ships in 0.3) |

## Related ADRs

- [ADR-0036](/architecture/decisions/) — Hybrid PM philosophy and sprint model
- [ADR-0037](/architecture/decisions/) — Sprint model: data, API, and board integration
- [ADR-0041](/architecture/decisions/) — Methodology preset (drives tab visibility)

## If you are…

- **Maya (Scrum Master)** — the Sprint header is your home. Set a goal at planning, watch the day-of-N counter during execution, fire Close sprint at retro time. From 0.3, selecting a planned sprint gives you the whole planning screen — backlog, capacity, carryover, and the milestone bridge — in one place.
- **Tom (engineer)** — you'll mostly see the [Sprint backlog table](/features/sprint-backlog/) below. The header tells you which sprint you're in and how many days are left.
- **Raj (PM)** — the Advancing-to-Milestone card links directly into the Schedule view scrolled to the milestone task. The bridge between sprint cadence and contract dates lives there.
