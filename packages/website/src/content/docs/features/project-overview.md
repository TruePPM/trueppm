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

- **One lead figure.** The P80 forecast finish is the only large number on the page. The P50, the commitment and the CPM finish sit beside it at a smaller size, with a chip saying how far the P80 is past (or ahead of) the commitment, and an S-curve showing the spread. The footer gives when the forecast was computed, how many runs it used, and, when the previous run's P80 was a different date, where it moved from. **Why this date?** links to the schedule and names the task the forecast is most sensitive to. When the server reports that the forecast is out of date (stale, or the project was edited since the run) or that some runs hit the velocity limit, a line under the figure says so in words, so a stale P80 is never shown bare.
- **Supporting tiles.** Critical tasks, Complete and Open risks, each with a label. Where the server supplies a definition (the lead figure, the P50 and commitment, and Open risks), the label is dotted-underlined: hover, focus or tap it to read what the figure measures. The other labels are plain text.
- **Detail last.** The next milestone sits below the tiles.

Every figure and every definition on this page comes from the server. The page formats them and never recomputes them, so it cannot disagree with the schedule or the forecast panel.

## When something cannot be computed

A figure that cannot be computed is stated in one line that names the missing input and links the fix, never as an empty tile. For example, **Cost variance** reads "can't be computed: no cost rates are set" with a link to set rates. See [Cost model](/features/cost-model/).

## Empty and error states

- With no saved forecast the lead card reads "No forecast yet".
- If the forecast fails to load, the page says so and keeps the tiles; the CPM date is unaffected.
