---
title: Interface & command palette
description: The v2 interface refresh — a unified app-shell bar, the ⌘K command palette, a methodology-adaptive context bar, and grouped view tabs that adapt to how your team works.
---

:::note[Added in 0.3]
The v2 interface refresh (epic #1163) was added in the 0.3 milestone, available
since the `0.3.0-alpha.1` pre-release (Jun 28, 2026).
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
- **Project switcher** — a compact, searchable dropdown at the left edge of the
  view tabs that lets you jump between the projects you're a member of without
  leaving the project view. Selecting a project keeps you on the same view you
  were looking at (Schedule stays on Schedule), and it's fully keyboard- and
  screen-reader accessible. On a project, it shows the current project's name
  (or, when you belong to just one, plain non-clickable wayfinding). Off a
  project — on My Work, Notifications, or a listing page — the same control
  becomes a **"Jump to project…"** picker so any project you're a member of is
  one hop away from anywhere; it's hidden only when you belong to no projects at
  all.
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
- **Navigate** between your projects and programs — resolve any project or program
  by name from anywhere, not just your current one.
- **Pick up where you left off** — a **Recent** group lists the projects you've
  most recently opened (with their program and a "2h ago" recency hint) the moment
  you open the palette, before you type a thing.
- **Find people** — start typing a name to search across your teammates and jump to
  them.
- **Find an epic or story anywhere** — type a name to search epics and stories across
  every program and project you belong to, without opening each one first. Results
  arrive in **Epics** and **Stories** groups, each labeled in agile terms with a
  program ▸ project ▸ epic breadcrumb (never a WBS code): pick an epic or story to
  jump to it in the schedule, or a backlog item to land on its program backlog. The
  search is access-scoped on the server — you only ever see work you already have
  access to.
- **Open a task** — on a project, type to find a task and open it inline. When the
  project has an active sprint, that sprint's tasks get their own **Current sprint
  tasks** group with room for more results, so a search scoped to the sprint you're
  working in isn't cut short.
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
Gantt-centric tabs a waterfall project leads with, and vice-versa. On agile and
hybrid projects a **Deliver** group co-locates the sprint circuit (Backlog →
Sprints → Board). **Overview** always leads and **Settings** always trails. You can
further tailor the bar with **Customize views** (hide the tabs you don't use);
hidden views stay reachable from the command palette.

**Customize views** also carries an opt-in to *additionally* surface the
**Schedule** under **Deliver**, for hybrid teams who want the plan sitting next to
the sprint cadence. It is off by default — Schedule stays in **Plan** for everyone
who doesn't opt in — and it is purely a placement of the nav tab: it never changes
your rollups, reports, or exports, and it only ever tailors *your own* view, not a
teammate's. See [View focus](/features/view-focus/) for the role-based lens that
re-orders and re-points these surfaces for you.

## Role-based landing

Opening a project lands you on the view that matches your **View focus** lens — a
PM lands on the Schedule, a Scrum Master on the Board, and the neutral default
lands on the Overview. The lens is presentation only: it never changes your
permissions or what anyone else sees.

## Light, Dark, and Auto

The whole interface supports Light, Dark, and Auto themes via a single toggle in
your account menu. Chrome and content adapt together — there is never a dark
sidebar stranded on a light app.

## When your session expires

:::note[Ships in 0.4]
The read-only escape hatch (issue #1922) ships in the 0.4 milestone.
:::

If your session expires while you're working — a timed-out token, a signed-out
tab left open — TruePPM shows a "Your session expired" prompt rather than
silently dropping you onto the login screen with no explanation. From there you
can:

- **Sign in** to re-authenticate immediately, or
- **Continue viewing (read-only)** to keep looking at whatever the app already
  has loaded in this tab — the schedule, a board, a report — without losing your
  place. This dismisses the blocking prompt in favor of a slim banner pinned to
  the top of the screen that stays visible while you browse.

Read-only mode never fetches new data (nothing more can load until you sign in
again) and never sends writes: if you try to save, complete, or otherwise change
anything while read-only, TruePPM blocks the attempt before it reaches the
server and brings the sign-in prompt back rather than failing silently. Sign in
again from either the original prompt or the persistent banner to resume normal
work.
