---
title: Daily standup — walk the board
description: A focused, per-person walk-the-board mode for running the Daily Scrum, built into the active sprint board.
---

:::note[Added in 0.3]
The daily standup walk-the-board surface was added in 0.3 (the agile team release), available since the `0.3.0-alpha.1` pre-release (Jun 28, 2026).
:::

The **Standup** button on the active sprint board opens a focused walk-the-board mode designed for running the Daily Scrum as a team ceremony. It walks through each teammate one at a time with a clean, distraction-free layout.

This is a **per-person current-state** lens — who has what, who is blocked, and what got done since the last working day. It is distinct from the [team-wide "what changed since yesterday" delta panel](/features/sprints/#what-you-see) on the Sprints view, which shows a chronological stream of status moves and scope changes across the whole team. The two surfaces are complementary: run the walk-the-board mode during the standup ceremony, and use the delta panel for a team-wide view of the last period's activity. The standup footer links to the delta panel.

## Opening standup mode

When a sprint is active, a **Standup** button appears in the sprint panel header above the board lanes. Clicking it enters walk-the-board mode.

- Only **project members** can open it. Viewers and any PMO or portfolio-only roles who are not project members cannot reach this surface.
- Nothing persists from one standup to the next — the mode opens fresh each time, pulling the current board state in real time.

## Walking the team

The mode shows **one teammate at a time**. A stepper along the top lets you move through the roster:

- **Prev / Next** buttons (or the **← / →** arrow keys)
- **Person rail** — a row of dots, one per teammate; click any dot to jump directly to that person
- **"Person N of M"** counter so everyone knows where you are in the roster

Press **Esc** (or the **×** close button) to exit standup mode and return to the normal board view at any time.

The Sprint Goal is pinned at the top of the standup surface for the duration of the ceremony, so the conversation stays anchored to the sprint commitment.

## The three columns

For each teammate, standup mode shows three columns:

### Done since last working day

Cards the teammate completed since the end of the previous working day. The window is **calendar-aware**: if today is Monday, it includes completions from Friday (and any day after, if a non-standard work calendar is configured for the project). Cards that were already in "Done" before the sprint started — carried-over cards from a prior sprint that were already complete — are excluded, so the column shows only genuinely new completions.

### In progress today

The teammate's cards currently in **In Progress** or **Review** status. These are the active commitments: what the person is working on right now.

### Blockers

Cards where the teammate is blocked, grouped by blocker type with a label showing how long the card has been stuck. The **private reason text** a contributor recorded when flagging a blocker is **never shown** on this surface — the shared standup screen only shows the blocker type and duration, so sensitive context stays private to the person who recorded it and their manager.

## Stale cards

A card that has been sitting in its column longer than that column's configured age threshold gets a calm **"stale Nd"** pill — for example, "stale 3d" for a card three days past its threshold. This is the same aging signal visible on the regular board, surfaced here so stale work surfaces naturally during the standup conversation without a separate filter step. Age thresholds are configured per-column in [Workflow & fields](/administration/project-settings/).

## Real-time updates

Standup mode updates in real time over WebSocket. If a teammate moves a card on their device while the team is discussing someone else, the card reflects in the standup view the moment it moves — no refresh needed.

## What standup mode does not do

- **No new data model.** The standup surface derives everything from existing board state, task history, and blocker data. There are no standup-specific records, attendance logs, or notes stored.
- **No notifications.** The mode is pull-only — it does not send any notifications before, during, or after.
- **No editing.** Cards shown in standup mode open the task drawer on click (as they do on the regular board), but the standup surface itself has no controls for moving or editing cards. The team focuses on the conversation; moves happen on the board before or after.

## Relationship to the "what changed since yesterday" panel

The [Daily standup delta panel](/features/sprints/#what-you-see) on the Sprints view shows a **team-wide chronological stream**: moved cards, new blockers, injected scope, burndown swing, and per-person activity counts, with a configurable look-back window (24h, 48h, or "since I last looked"). It answers "what happened to the sprint?"

The walk-the-board mode answers a different question: "where is each person right now?" The two views are complementary. The standup footer carries a direct link to the delta panel so you can move between them without navigating away.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| **→** | Next teammate |
| **←** | Previous teammate |
| **Esc** | Exit standup mode |

## API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/v1/projects/{id}/standup/` | Per-teammate standup payload: done/in-progress/blocker card sets, calendar-aware done window, stale flags |

## Permissions

| Action | Minimum role |
|--------|-------------|
| Open standup mode | Member |
| View standup data | Member |

Viewers and any portfolio or PMO roles who are not project members cannot open standup mode or read the standup endpoint.

## Related

- [Board (Kanban)](/features/board/) — the board lanes that standup mode reads from
- [Board sprint panel](/features/board-sprint-panel/) — the sprint panel where the Standup button lives
- [Sprints workspace](/features/sprints/) — the Sprints view, which hosts the "what changed since yesterday" delta panel
- [Aging cards](/features/board/#aging-cards) — how column age thresholds are configured
