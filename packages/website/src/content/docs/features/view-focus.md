---
documentedFor: "0.4"
title: View focus
description: A per-user lens that organizes each project around the hat you're wearing — PM, Scrum Master, or both — without changing anyone's access.
---

:::note[Added in 0.3]
View focus was added in 0.3.
:::

If you wear two hats — running the waterfall program **and** facilitating the agile
team — **View focus** lets you tell TruePPM which one you're wearing right now. The app
then leads with the surfaces that hat cares about. Nothing about your data, your
permissions, or what your teammates see changes — it is purely how *your* view is
arranged for *you*.

There are three focuses, and **Unified Today** is the default:

| Focus | Opens a project on | Leads the view bar with |
|---|---|---|
| **Unified Today** (default) | the **Today** split view | the standard order |
| **PM** | the Schedule | Schedule, then Grid |
| **Scrum Master** | the Board | Board, then Sprints |

## What it does

- **Picks your default project view.** Open any project and you land on the surface your
  focus cares about — the Schedule in PM focus, the Board in Scrum Master focus, the
  **Today** split view in Unified Today. You can still navigate anywhere; this only
  changes where you *start*.
- **Emphasizes your views.** Your focus moves its priority views to the front of the
  navigation rail, so the views you reach for most are first. Nothing is hidden or
  removed — the same views are all there, just reordered. Unified Today keeps the
  standard order.

## The Today view

Unified Today focus opens each project on a purpose-built **Today** split screen — one
place for the dual-hat PM + Scrum Master, so you stop bouncing between the Schedule and
the Board:

- **A schedule pulse on top** — a compact, read-only strip showing the project's
  schedule health (On track / At risk / Critical), its SPI, percent complete, the count
  of critical and late tasks, and the next milestone. It reads the same numbers as the
  project Overview, so the two never disagree.
- **The active sprint's progress, right on the pulse** — the strip carries a small chip
  for the active sprint with a live progress bar. That progress is read straight from the
  board below (how many committed tasks are done), so the agile team's delivery shows up
  on the schedule view without anyone copying a number across. The link is one-way: the
  board feeds the pulse, never the reverse, and nothing about the sprint can be edited
  from the pulse.
- **The sprint board below** — the full board you already use, unchanged, filling the
  rest of the screen. Its [sprint panel](/features/board-sprint-panel/) starts
  collapsed, so on a typical laptop screen the first several rows of cards are visible
  without scrolling.

`Today` is also a regular **Today** tab in the project view bar (in the *Track* group),
so anyone can open it — Unified Today focus just makes it your starting point. On a
project with no active sprint, the pulse simply reads "No active sprint" and the board
shows its own empty state.

### How the pulse measures schedule health

Schedule health is a count-based SPI: the tasks due by today that are done, divided by
all the tasks due by today.

- **With an active baseline that has real schedule dates** (captured after the schedule
  was first computed), "due by today" means the baseline's finish dates. Work finished
  early still counts as done, so the ratio can go above 1.00.
- **With no baseline — or an active baseline captured before the schedule was ever
  computed**, so it has no reliable finish dates to compare against — "due by today"
  means the current plan's finish dates. Both counts come from the same tasks, so the
  ratio tops out at 1.00, and a task finished outside that window can't hide a late one.
- **Unknown** means nothing is due yet under whichever of those two references applies.

Phase rows are left out of the **Late** count and the no-baseline ratio. A phase's
status is rolled up from its children, so a phase whose children are all done never
counts as late.

### On a phone

In the Queue layout, each row shows the task name on its own line. The phase, status,
duration and owner sit on a second line below it. A task with no owner says
**Unassigned**. A task with no estimate shows **—**, except a milestone. The list
leaves room at the bottom so the last row can scroll above the **Add task** button.

On the hosted read-only demo, the board shows no **Add task** button, lane **+**, or
quick capture, because the demo would refuse the create. You can still drag cards; the
board keeps each move on screen and tells you nothing was saved.

## What it does not do

View focus is a presentation preference, not a role. Switching it **never grants or
removes any access** — a project's permissions are the same whether you're in PM, Scrum
Master, or Unified Today focus. It also changes nothing for anyone else: it's your own
view, invisible to your teammates.

## Where to find it in the app

- The **View focus** control in the user menu (the avatar dropdown, top right) — switch
  focus in one click.
- The **General preferences** page (**Settings → General**, `/me/settings/general`),
  alongside your **Default landing screen** and **Customize views** preferences.

Your choice is remembered and applies the next time you sign in, so the app always opens
the way your current hat expects.

:::note[Mobile]
View focus applies on the web app. Native mobile parity will come in a later release.
:::
