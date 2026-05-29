---
title: Plan Sprint dialog
description: Single-step modal for creating the next sprint — name + dates + optional goal.
---

The smallest credible sprint creation flow. Triggered by the "Plan next sprint" button in the Sprints view header, opens a single-step dialog with name + start/finish dates + optional goal, and POSTs to the existing sprint endpoint.

## Where this lives in the story

Step 5 ([Sprint planning](/the-story/#5-sprint-planning--the-team-pulls-work)) of the [hybrid PM flow](/the-story/). The action that opens the next iteration after the current one closes.

## What you see

- **Name** (required) — `Sprint N — short description`
- **Start / Finish dates** (required) — start defaults to today (or last planned sprint's finish for next-sprint continuity); finish seeds 13 days later for a 2-week iteration
- **Goal** (optional) — the narrative the team commits to for the iteration

Inline validation on `finish ≤ start`. Submit creates the sprint in `PLANNED` state — activate it later from the timeline strip.

## Where to find it in the app

- Trigger: **Plan next sprint** button in the [Sprints workspace](/features/sprints/) header
- Trigger: `+ Plan next sprint` slot at the end of the [Sprint Cadence timeline](/features/sprints/) when no PLANNED sprint exists yet

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/v1/projects/{id}/sprints/` | Create a planned sprint |

## Why this is intentionally minimal

The richer sprint planning wizard described in ADR-0037 (with milestone picker, capacity preflight, Jira ingest) lands later. This dialog ships the smallest credible flow that unblocks manual sprint creation today.

The capacity preflight runs at *activate* time, not creation, so a planning-time preflight is a separate scope.

## Related ADRs

- [ADR-0037](/architecture/decisions/) — Sprint model: data, API, and board integration

## If you are…

- **Maya** — fires this dialog to open the next iteration. After closing a sprint, the "Plan next sprint" slot appears at the end of the timeline strip.
- **Tom** — rarely; Maya creates sprints. You'll see the sprint appear in the timeline once she creates it.
- **Raj** — sprint start/finish dates here need to fit within the milestone window you set on the Schedule view.
