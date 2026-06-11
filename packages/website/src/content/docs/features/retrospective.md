---
title: Retrospective panel
description: Notes + action items with explicit per-item promotion into the project backlog, a team-visibility gate, and prior-retro context.
---

The retrospective surface that closes the sprint loop. Notes textarea + action items with optional story points. Each saved action item carries an explicit **Promote to backlog** button — promoting creates a real task in the project backlog, and the resulting task surfaces back as a `T-XXX` chip on the action item.

## Where this lives in the story

Step 8 ([Close — retro, lessons learned, baseline variance](/the-story/#8-close--retro-lessons-learned-baseline-variance)) of the [hybrid PM flow](/the-story/). Closes the loop on Maya's switching criterion: *"Retro action items get logged and forgotten."*

## What you see

- **Notes** — free-text capture of the meeting summary
- **Action items list** — text + optional story points
- **Save retro** — upserts notes and replaces the action-item set; saving never promotes anything
- **Promote to backlog** — an explicit per-item action; the created task lands in the project backlog (`BACKLOG`, no sprint)
- **`→ T-XXXXXX` chip** — appears next to action items whose `promoted_task_id` is set
- **Prior retro** — a context section showing the most recent prior completed sprint's retro, so last sprint's lessons are in view while you write this one
- **Visibility toggle** — the retro author or a Project Manager can switch `team_visibility` between team-only and project-wide

## Live retro board

The single-author notes-and-action-items panel above grows a **real-time, multi-writer board** where the whole team adds, edits, and drags sticky notes during the live ceremony — seeing each other's input as it happens rather than refreshing to catch up. This board surface (ADR-0117) ships in 0.3. It is merged but not yet in a tagged build — see the [roadmap](/overview/roadmap/).

- **Three columns** — *What went well*, *What to improve*, *Ideas & discussion*.
- **Concurrent editing** — every team member adds and edits stickies at once; updates fan out over the existing project WebSocket (`retro_item_created` / `_updated` / `_moved` / `_deleted`), and presence shows who is in the retro. Concurrency is last-write-wins per sticky; a superseded edit is offered back via an undo, never silently lost.
- **Convert to action item** — one click turns a discussion sticky into a retro action item, which then uses the same explicit **Promote to backlog** flow below. Discussion → action → backlog is one continuous path.
- **Editable window** — the board is live while the sprint is **Active** and stays editable after close (**Completed**); a **Canceled** sprint's board is read-only.

The action items, notes, and visibility toggle described elsewhere on this page are sections within this board surface — the promote-to-backlog behavior is unchanged.

## Team-health pulse

A one-tap **mood / energy / (optional) confidence** pulse answered during the retro, with a trend across sprints (ADR-0117 / ADR-0104). The pulse ships in 0.3. It is merged but not yet in a tagged build — see the [roadmap](/overview/roadmap/).

- **One tap per dimension** — a re-tap updates your answer; there is no submit button.
- **Trend** — per-sprint averages with a response count, and an early-warning flag when team energy falls two sprints running.
- **Team-private by default** — the pulse trend is governed by the same signal-privacy posture as team velocity (see [Velocity](/features/velocity/)): visible to the team and their coach only. The PM/PMO band sees **nothing** — not a redacted aggregate, not a response count — until the team explicitly shares it upward, and there is **no cross-team or PMO rollup**. Cross-team mood aggregation is an enterprise-edition concern, intentionally not built in the community edition.

## Visibility model

Each retro has a `team_visibility` setting (ADR-0071):

- **Team only** (default) — members with at least the Team Member role see the full retro. Viewers receive a **counts-only summary** (number of action items, number promoted) — never the raw notes or item text.
- **Project** — every project member, including Viewers, sees the full retro.

Changing visibility is gated to the retro's creator or a Project Manager and above; lower roles get 403.

## Where to find it in the app

- Route: `/projects/:projectId/sprints` (panel below the timeline / backlog)
- Renders for the active sprint, falling through to the most-recent closed sprint when no active sprint exists.

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET`  | `/api/v1/sprints/{id}/retro/` | Current retro, visibility-aware (404 if none; counts-only summary below the visibility threshold) |
| `POST` | `/api/v1/sprints/{id}/retro/` | Upsert notes + replace action item set (never promotes) |
| `PATCH` | `/api/v1/sprints/{id}/retro/` | Update `team_visibility` (creator or Project Manager+) |
| `GET`  | `/api/v1/sprints/{id}/retrospective/prior/` | Most recent prior completed sprint's retro (404 if none) |
| `POST` | `/api/v1/sprints/{id}/retrospective/action-items/{itemId}/promote/` | Promote one action item into the project backlog |
| `POST` | `/api/v1/sprints/{id}/retrospective/action-items/{itemId}/pull-to-sprint/` | Atomically promote + assign an item to a planned sprint (Resource Manager+) |

`IsProjectMember` for read; `IsProjectMemberWrite` for write. `promoted_task_id` is read-only — only the promote endpoints set it.

## Promotion semantics

Promotion is **explicit, per item** — saving the retro never creates tasks (sprint sovereignty per ADR-0071; the pre-0.3 auto-promote-at-save behavior was removed).

- **Promote** creates a task with name = the action item text, the item's story points, and unconditionally `status = BACKLOG` with **no sprint** — the request body cannot smuggle a `sprint_id`. The created task's UUID is recorded on the item's `promoted_task_id`, so subsequent reads render the link chip. Promoting an already-promoted item returns 409 with the existing `task_id` (safe to retry).
- **Pull to sprint** is the only path that puts a retro action item directly into a sprint: it atomically promotes the item and assigns the task to a target sprint in the same project. The target must be in the **Planned** state, and the caller needs the Resource Manager role or above.

## Related ADRs

- ADR-0071 — Retro visibility, explicit promotion, and carryover (supersedes the original auto-promote design from issue #231)

## If you are…

- **Maya** — own this. Action items you promote become real backlog tasks; items you don't will be forgotten by Friday. The prior-retro section keeps last sprint's lessons in view.
- **Tom (engineer)** — promoted action items show up in the project backlog; your Scrum Master or PM pulls them into a planned sprint when the team commits to them.
