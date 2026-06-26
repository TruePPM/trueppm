---
title: Interface & command palette
description: The v2 interface refresh — a unified app-shell bar, the ⌘K command palette, a methodology-adaptive context bar, and grouped view tabs that adapt to how your team works.
---

:::note[Ships in 0.3 (Underway)]
The v2 interface refresh (epic #1163) is part of the 0.3 milestone, which is
still underway. This page describes the interface as built; it is not yet in a
tagged build — see the [roadmap](/overview/roadmap/).
:::

TruePPM's v2 interface is a single, calm workspace shell built on the navy/sage
design system. Everything you need to orient — where you are, what's healthy,
what to do next — lives in **one** top bar, and a keyboard-first command palette
gets you anywhere without reaching for the mouse.

## The unified app-shell bar

The top of every project and program is a single bar (it merges what used to be
two stacked rows). Left to right it carries:

- **Adaptive identity** — a breadcrumb of your current program / project. It
  shows in the bar only when the left rail is collapsed or you're on a phone, so
  wayfinding is never duplicated.
- **View tabs** — the grouped, methodology-adaptive navigation (below). The strip
  scrolls horizontally on narrow screens rather than dropping or clipping labels.
- **The health cluster** — one bordered context read-out (below).
- **Context-aware "+ New"** — a create menu whose default action matches where you
  are (a new task on the board, a new risk on the risk register, and so on).
- **Presence, run status, notifications, and your account menu** — including the
  Light / Dark / Auto theme toggle, which lives only here.

## The command palette (⌘K)

Press **⌘K** (Ctrl+K on Windows/Linux) anywhere to open the command palette. It
is the fastest path to:

- **Jump to any view** — "Go to Board", "Go to Schedule", including views you've
  hidden from the tab bar.
- **Navigate** between your projects and programs.
- **Run actions** in context.

Type to filter; arrow keys move; Enter activates; Escape closes. The palette is a
pop surface with a focus trap, so keyboard and screen-reader users get the same
reach as a pointer.

## The methodology-adaptive context bar

The health cluster is a single bordered unit whose three segments adapt to the
project's methodology, so you always see the right three signals:

- **Agile** — active Sprint · Points (or item count) · Velocity
- **Waterfall** — Forecast (P80) · At-risk · Critical
- **Hybrid** — Sprint · Forecast · Critical

Slots are fixed: a zero or empty segment reads calmly ("0 critical", "—", "No
active sprint") rather than vanishing, so the bar never reflows. At-risk and
critical counts above zero open a task popover; a forecast date is neutral
(informational, not a risk colour); and team-private velocity shows a "kept to
the team" wall rather than a number when the team's privacy policy withholds it.

## Grouped, methodology-adaptive view tabs

The view tabs are grouped into **PLAN · TRACK · PEOPLE** so related surfaces sit
together, and the set adapts to methodology — an agile project doesn't show the
Gantt-centric tabs a waterfall project leads with, and vice-versa. **Overview**
always leads and **Settings** always trails. You can further tailor the bar with
**Customize views** (hide the tabs you don't use); hidden views stay reachable
from the command palette. See [View focus](/features/view-focus/) for the
role-based lens that re-orders and re-points these surfaces for you.

## Role-based landing

Opening a project lands you on the view that matches your **View focus** lens — a
PM lands on the Schedule, a Scrum Master on the Board, and the neutral default
lands on the Overview. The lens is presentation only: it never changes your
permissions or what anyone else sees.

## Light, Dark, and Auto

The whole interface supports Light, Dark, and Auto themes via a single toggle in
your account menu. Chrome and content adapt together — there is never a dark
sidebar stranded on a light app.
