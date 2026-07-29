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

## Background task runs

A small badge in the TopBar's right cluster — `role="status"`, reading "N
background operation(s) running" — appears **only** while at least one task is
in flight (a schedule recalculation, an import, an export job); it disappears
the moment the count returns to zero, so the calm shell stays quiet rather than
carrying a permanently-visible, empty run indicator. A spinner and a live count
sit inside it.

The badge is driven by real-time WebSocket events (`task_run_started`,
`task_run_progress`, `task_run_completed`, `task_run_failed`,
`task_run_cancelled`) landing in a small client-side store — it does not poll.
Three read APIs back the same underlying task-run records at different scopes:

| Endpoint | Scope |
|---|---|
| `GET /api/v1/task-runs/{id}/` | A single run by id, from anywhere. |
| `GET /api/v1/task-runs/active/` | Every pending/running run across the projects you belong to — the personal in-flight view this badge summarizes into one count. Not a PMO rollup. |
| `GET /api/v1/projects/{project_id}/task-runs/` | A project's own run history; `POST .../task-runs/{id}/cancel/` (project Admin+) requests cancellation of one still in flight. |
| `GET /api/v1/projects/{project_id}/scheduler-runs/` | The scheduler-recalculation subset of a project's run history, filterable by status and date range — the audit trail behind the Schedule view's "last recalculated" indicator. |

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
- **Find any work item anywhere** — type a name to search across every program and
  project you belong to, without opening each one first. Results arrive in **Epics**,
  **Stories**, **Milestones**, and **Tasks in all projects** groups, each carrying a
  program ▸ project breadcrumb (never a WBS code): pick one to jump to it in the
  schedule, or a backlog item to land on its program backlog. Plain tasks and
  milestones are included by default, so a waterfall project with no epics or stories
  is fully searchable. The search is access-scoped on the server — you only ever see
  work you already have access to.
- **Open a task** — on a project, type to find a task and open it inline. When the
  project has an active sprint, that sprint's tasks get their own **Current sprint
  tasks** group with room for more results, so a search scoped to the sprint you're
  working in isn't cut short.
- **Filter tasks by label** — on a project, type a label's name and a **Labels** group
  offers it with its color swatch and how many tasks carry it. Pick one to land on the
  Board with that label filter already applied, so "show me everything tagged *Rework*"
  is two keystrokes rather than a hunt through the filter menu. Labels belong to a
  project, so the group offers the current project's labels.
- **Jump to a settings section** — start typing and a **Settings** group surfaces the
  exact section you want (type "smtp" for *Email & SMTP*, "oidc" for *Single sign-on*,
  "tokens" for your personal *API tokens*). Workspace sections appear for workspace
  admins; your personal settings appear for everyone, each labeled **Workspace** or
  **Personal** so same-named sections stay clear. Pick one to land right on it.
- **Run actions** in context.

Type to filter; arrow keys move; Enter activates; Escape closes. The palette is a
pop surface with a focus trap, so keyboard and screen-reader users get the same
reach as a pointer.

### Filtering the settings rail

Once you're inside settings, the left navigation rail has a **filter box** at the top.
Type to narrow the section list — it matches synonyms as well as labels, so "smtp"
finds *Email & SMTP* and "oidc" finds *Single sign-on* — and press **Enter** to jump to
the first match. Clearing it (the **✕**, or Escape) restores the full rail. The filter
is on the desktop rail; on a phone the settings header keeps its **Jump to section**
menu.

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

## Pinned projects and programs

Pin the projects and programs you return to daily and they collect in a **Pinned**
group at the top of the sidebar, so the handful you actually work on are one click
away regardless of how many you can see.

Pin from any of these:

- the **pin in the Project Overview header**, beside the project's actions;
- the **pin beside a program's name** on its Overview;
- the **pin in the top corner of a program card** on the Programs directory;
- the **project rows on a program's Projects tab**;
- the **project and program rows** in the sidebar's Browse switcher;
- the command palette — <kbd>Cmd</kbd>+<kbd>K</kbd> (<kbd>Ctrl</kbd>+<kbd>K</kbd> on
  Windows and Linux) opens on your pins, and typing a name offers **Pin** and
  **Unpin** as commands. <kbd>Alt</kbd>+<kbd>P</kbd> pins or unpins the highlighted
  row without closing the palette.

Select the pin again to unpin. Every confirmation carries **Undo** for a few
seconds, so nothing here is a one-way door.

On a touch device the pin is always visible — you do not need to hover to find it.
On a mouse, an unpinned row reveals its pin as you hover, and keyboard focus
reveals it too.

### Where pinned items appear

On the Programs directory, pins are lifted into their own **Pinned** group above
**Everything else**. Each heading names its count and confirms that whichever sort
you chose still applies inside the group — pinning changes the grouping, never the
sort. Turn the **Pinned first** checkbox off for one flat list in pure sort order,
with pinned cards keeping their mark. Searching flattens the groups, so a pin never
outranks a better text match.

A newly pinned card **stays where it is** rather than jumping to the top under your
cursor. It moves into the Pinned group the next time you open the page, or straight
away if you choose **Re-sort now** in the confirmation.

:::note[Ships in 0.4]
Pins are saved to **your account**, so they follow you between your laptop, a
second browser, and any other device you sign in on. Before 0.4 a pin lived only
in the browser that set it. Pins already on a device are moved to your account
automatically the first time you open the app after upgrading — there is nothing
to re-pin.
:::

A pin is **private to you**. It is a personal shortcut, not a signal about the
project: pinning grants no access, changes nothing for anyone else, and no screen,
export, or API response tells another person what you have pinned or how many
people pinned a given project. Teammates cannot see your pins, and you cannot see
theirs.

You can pin up to 100 items. Past that, unpin something before adding another —
the app says so plainly rather than silently dropping the new pin.

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
