---
title: View focus
description: A per-user lens that organizes each project around the hat you're wearing — PM, Scrum Master, or both — without changing anyone's access.
---

:::note[0.3]
View focus will ship in 0.3.
:::

If you wear two hats — running the waterfall program **and** facilitating the agile
team — **View focus** lets you tell TruePPM which one you're wearing right now. The app
then leads with the surfaces that hat cares about. Nothing about your data, your
permissions, or what your teammates see changes — it is purely how *your* view is
arranged for *you*.

There are three focuses, and **Unified Today** is the default:

| Focus | Opens a project on | Leads the view bar with |
|---|---|---|
| **Unified Today** (default) | Overview | the standard order |
| **PM** | the Schedule | Schedule, then Grid |
| **Scrum Master** | the Board | Board, then Sprints |

## What it does

- **Picks your default project view.** Open any project and you land on the surface your
  focus cares about — the Schedule in PM focus, the Board in Scrum Master focus, the
  Overview in Unified Today. You can still navigate anywhere; this only changes where you
  *start*.
- **Emphasizes your view tabs.** Your focus moves its priority tabs to the front of the
  project view bar, so the views you reach for most are first. Nothing is hidden or
  removed — the same tabs are all there, just reordered. Unified Today keeps the standard
  order.

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
