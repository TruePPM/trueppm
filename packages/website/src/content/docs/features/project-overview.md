---
title: Project overview
description: The project Overview page leads with one forecast finish date, then three supporting figures, and states what it cannot compute in one line instead of an empty tile.
documentedFor: "0.5"
---

:::note[Ships in 0.5]
This page describes the redesigned Overview that ships in 0.5 behind the new shell. In the current release the Overview shows its metrics as equal-weight cards.
:::

This page is for project managers who want to read a project's state in one glance.

## What the page shows

- **One lead figure.** The P80 forecast finish is the only large number on the page. The P50, the commitment and the CPM finish sit beside it at a smaller size, with a chip saying how far the P80 is past (or ahead of) the commitment, and an S-curve showing the spread. The footer gives when the forecast was computed, how many runs it used, and, when the previous run's P80 was a different date, where it moved from. **Why this date?** links to the schedule and names the task the forecast is most sensitive to; **Show the driver chain** opens the chain of driving links through that task, from the earliest task holding it up down to the project finish, as the schedule's last calculation drew it. When the server reports that the forecast is out of date (stale, or the project was edited since the run) or that some runs hit the velocity limit, a line under the figure says so in words, so a stale P80 is never shown bare.
- **Supporting tiles.** Critical tasks, Complete, Over-allocated and Open risks, each with a label. **Over-allocated** counts the people whose load on this project goes over 100% in at least one week of the next 8 weeks, with time off removed. It is per-person capacity, so it shows only to a Scheduler, or to an Admin or Owner once the team shares its capacity signal with the project-manager band in the project's signal privacy settings; otherwise the tile is left out. The lead figure, the P50 and commitment, and all four supporting tiles carry a definition from the server, so their labels are dotted-underlined: hover, focus or tap one to read what the figure measures.
- **Detail last.** The next milestone sits below the tiles, then **Changes since Monday**: the latest five entries from the project's change history since Monday 00:00, with a link to the full list on the Activity tab. Who made each change is not shown here.

On a phone the lead card is laid out for one column: the P50, commitment and CPM dates sit in one row under the figure, the S-curve is drawn at the card's own width so its labels stay readable, and **Why this date?** is a full-width 44px link. The supporting tiles sit in a two-column grid: two by two, or with the third tile on its own row when Over-allocated is left out.

Every figure and every definition on this page comes from the server. The page formats them and never recomputes them, so it cannot disagree with the schedule or the forecast panel.

## When something cannot be computed

A figure that cannot be computed is stated in one line that names the missing input and links the fix, never as an empty tile. For example, **Cost variance** reads "can't be computed: no cost rates are set" with a link to set rates. See [Cost model](/features/cost-model/).

## Empty and error states

- With no saved forecast the lead card reads "No forecast yet".
- If the forecast fails to load, the page says so and keeps the tiles; the CPM date is unaffected.
