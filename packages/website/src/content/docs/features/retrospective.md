---
title: Retrospective panel
description: Notes + action items with one-click promotion into the next sprint backlog.
---

The retrospective surface that closes the sprint loop. Notes textarea + per-item promote checkbox + story points. Items checked "Add to next sprint" become real tasks in the next planned sprint at save time, and the resulting task UUID surfaces back as a `T-XXX` chip on the action item.

## Where this lives in the story

Step 8 ([Close — retro, lessons learned, baseline variance](/the-story/#8-close--retro-lessons-learned-baseline-variance)) of the [hybrid PM flow](/the-story/). Closes the loop on Maya's switching criterion: *"Retro action items get logged and forgotten."*

## What you see

- **Notes** — free-text capture of the meeting summary
- **Action items list** — text + assignee + optional story points + promote checkbox (default **on**)
- **Save retro** — POSTs notes + items; promoted items become tasks in the target sprint
- **`→ T-XXXXXX` chip** — appears next to action items whose `promoted_task_id` was set on save

## Where to find it in the app

- Route: `/projects/:projectId/sprints` (panel below the timeline / backlog)
- Renders for the active sprint, falling through to the most-recent closed sprint when no active sprint exists.

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/api/v1/sprints/{id}/retro/` | Current retro (404 if none) |
| `POST` | `/api/v1/sprints/{id}/retro/` | Upsert notes + replace action item set |

`POST` payload may include a `promote_to_sprint_id` to override the default (next planned sprint). Promotion is single-project — the target must be a sprint in the same project. `IsProjectMember` for read; `IsProjectMemberWrite` for write.

## Promotion semantics

Items with `promote: true` are created as tasks in the target sprint with:

- name = action item text (truncated to 255 chars)
- sprint = target (default: next planned sprint by `start_date`)
- assignee = action item's assignee (optional)
- story_points = action item's points (optional)
- status = `BACKLOG`

The created task's UUID is recorded on the action item's `promoted_task_id` field, so subsequent reads render the link chip back to the source.

## Related ADRs

- Implementation tracked in issue #231

## If you are…

- **Maya** — own this. Action items that get promoted become real tasks; action items that don't will be forgotten by Friday.
- **Tom (engineer)** — the promoted action items show up in the next sprint's backlog assigned to whoever owns them.
