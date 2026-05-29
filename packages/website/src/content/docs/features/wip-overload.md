---
title: WIP-limit overload detection
description: Three-band column tinting + move-to-over-limit confirmation prompt.
---

The board's silent-WIP-creep alarm. Per-column WIP limits drive a three-band visual escalation, and moving a task into a column that would push it past its limit triggers a confirmation prompt.

## Where this lives in the story

Step 6 ([Execute](/the-story/#6-execute--daily-cadence-two-worlds-in-sync)) of the [hybrid PM flow](/the-story/). Companion to the [Capacity preflight](/features/capacity-preflight/) panel: capacity catches over-commitment at *plan* time; this catches WIP creep at *execution* time.

## What you see

Three column states:

| State | Condition | Visual |
|---|---|---|
| Under | `count < limit` | neutral chip `{N}/{limit}` — no special chrome |
| At    | `count == limit` | semantic-at-risk chip `{N}/{limit} WIP` + amber column header band |
| Over  | `count > limit`  | semantic-critical chip `{N}/{limit} — over WIP limit` + red column header band |

Moving a task into a column that would push it past its limit:

> **This column is at its WIP limit (3/3). Move anyway?**
> [ Cancel ] [ OK ]

Both drag-and-drop and the keyboard "Move to…" menu route through the same guard. Declining cancels; accepting proceeds with the existing status mutation.

## Where to find it in the app

- Route: `/projects/:projectId/board`
- Configure WIP limits in board settings (board column config panel)

## Backwards compatibility

Columns with `wip_limit=null` render the unchanged neutral count chip. The default board ships with WIP limits on `IN_PROGRESS=5` and `REVIEW=3`; everything else is unlimited.

## Related ADRs

- [ADR-0039](/architecture/decisions/) — Board column config (where `wip_limit` lives)

## If you are…

- **Tom (engineer)** — the over-limit chip says "this column is full." Don't pile on; finish what's in flight first.
- **Maya** — the at-limit / over-limit chips are your standup signal. If REVIEW is over-limit two days running, something downstream is blocked.
