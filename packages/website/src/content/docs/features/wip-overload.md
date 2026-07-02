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

## Trend arrow — catching creep before the breach

The at/over chips catch a column that is *already* full. To catch the creep building toward it, 0.4 will add a tiny trend arrow to the column header, next to the breach chip. It reads the column's recent occupancy from the [flow-analytics](/features/flow-analytics/) daily series and shows direction:

- **▲ rising** — the column is filling. It turns amber ("trending up toward WIP limit") once the column is within one card of its limit; below that it stays neutral, purely informational.
- **▼ falling** — the column is draining. Always neutral — recovery needs no alarm.
- No arrow when the trend is flat, no WIP limit is set, or the recent flow series is empty.

Because the trend reads the team-private flow series, it follows the same audience rule as the [flow-analytics charts](/features/flow-analytics/): a viewer who cannot see the flow charts does not see the trend arrow either. The current-state at/over breach chip stays visible to every board member regardless.

Direction is carried by the arrow shape and its screen-reader label, not by color alone, so it reads the same with color vision differences.

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
