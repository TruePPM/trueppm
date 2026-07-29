---
title: Notifications
description: The unified notification inbox — the TopBar bell, the panel and full-screen route, per-user preferences, snooze, mute, Do Not Disturb, and the weekly digests.
---

:::note[Added in 0.2, expanded through 0.3]
The notification inbox, the bell, and the @-mention preference matrix were
added in 0.2 (#311, ADR-0075). The project-delete notification, the
stale-task nudge, and the weekly digests described below were added since.
Do Not Disturb, per-notification snooze, inline mute, and the category filter
are called out individually below — they ship in the 0.4 beta.
:::

TruePPM has one notification system, reachable from one place — the bell in the
TopBar — regardless of *why* a notification exists: someone @-mentioned you, a
task you own changed state, a scheduled digest fired. This page is the single
reference for how it works. If you arrived here from a narrower page — the
mention and comment mechanics of [Task collaboration](/features/task-collaboration/)
or a single project's [Notification routing](/features/settings/project-notifications/)
— this page ties those together into the one inbox they both feed.

## The bell

The **TopBar bell** (`NotificationBell`) shows your unread count as a badge.
The bell is **always the same active glyph** — a resting, zero-unread bell
never swaps to a muted or "off"-looking icon, so a calm inbox is never
mistaken for notifications being disabled. The badge caps its *display* at
"99+"; the underlying count is exact. Once Do Not Disturb ships (below), a
small crescent-moon mark on the bell signals it is on — driven by the real
`dnd_enabled` setting, never inferred from the unread count.

- **Desktop (≥ md):** clicking the bell opens a right-anchored slide-out
  panel, 380–420px wide, that never traps the page's focus (it is a
  non-modal dialog — `aria-modal="false"`).
- **Mobile (< md):** the bell navigates to a full-screen route,
  `/me/notifications`, instead.

The unread count refreshes on a **30-second poll** while the tab is in the
foreground; a backgrounded tab pauses the poll.

## The inbox

The slide-out panel (`NotificationPanel`) and the full-screen route
(`NotificationListPage`) render the **same list** — one component,
`NotificationRow`, shared between them — so what you see from the bell and
what you see at `/me/notifications` never disagree.

Every row shows who or what triggered it (a mentioner's name, or the event's
own subject), a relative timestamp, and a preview: a mention row previews the
comment snippet; an event-sourced row (a task assignment, a blocked flag, and
so on) previews its own body. Clicking a row's body marks it read and
navigates to where it happened — the source task, a settings section for a
[signal-visibility proposal](/features/settings/signal-privacy/), or the app
root for a notification about a project that was itself deleted (its
board/schedule routes no longer resolve).

### Read-state tabs

A tab strip — **All / Unread / Archived / Snoozed** — decides which
server-side list loads (`?unread_only=`, `?archived=`, `?snoozed=`). Every tab
that has no rows shows its own friendly empty copy — "Nothing snoozed",
"Nothing archived yet", "No unread mentions right now" — rather than a blank
list.

### Per-row actions

Each row carries **Mark read / unread** and **Archive**, also available in
bulk via the header's **Mark all read**.

:::note[Ships in 0.4]
Per-notification **Snooze**, inline **Mute notifications like this**, and the
**category** filter below all land in the **0.4 beta**. They surface the noise
controls inline in the panel and the mobile route, so you never have to leave
your inbox to turn a noisy type down.
:::

- **Snooze** defers the row **1 hour**, **3 hours**, or **Tomorrow** (9am in
  the workspace timezone). A snoozed row drops out of every other view —
  including the unread badge count — until its time passes, then reappears
  on its own; no background job is involved, it is a pure query-time
  comparison. The **Snoozed** tab lists what is currently deferred, and each
  row there offers **Un-snooze** to bring it back immediately.
- **Mute notifications like this** *(event rows only — a mention has no mute,
  since a mention is a person addressing you, not a recurring type)* turns
  off the **in-app** channel for that event type from here on. Email is
  untouched, which is why the confirmation reads "Muted in your inbox" with
  an **Undo**. This is a shortcut for flipping the same cell the preferences
  matrix below controls — it never opens a second, separate setting.

### Category — a second, orthogonal filter

A second selector — **All / Mentions / Tasks / Signals / Project** — narrows
*within* whichever read-state tab is active (`?category=`), classifying each
row by its underlying event type. Category is a radio group, not a second tab
strip, so its own "All" never collides with the read-state tab of the same
name. Filtering by category keeps whichever read-state tab you are on.

## Preferences: `/me/settings/notifications`

`NotificationPreferencesPage` is the per-`(event_type, channel)` toggle
matrix — one row per event, one column per channel (**In-app**, **Email**).
On desktop it renders as a table; on mobile each event becomes its own card
with a channel sub-row per column, so the same data has two layouts rather
than one being a cut-down version of the other. A toggle click debounces
300ms before saving, with a "Saved." indicator that fades after a few
seconds — there is no separate Save button.

The matrix derives its rows and columns from whatever the server returns, so
when Enterprise registers an additional channel (Slack DM, Teams DM, SMS)
against the `NOTIFICATION_CHANNELS` extension point, it appears as a new
column automatically — this page needs no change to support it.

### What's on the matrix

| Event | In-app default | Email default |
|---|---|---|
| You're @-mentioned individually | ON | OFF |
| A group you're in is @-mentioned | ON | OFF |
| A task assigned to you | ON | OFF |
| The planned date of your task changes | ON | OFF |
| A task you own is blocked | ON | OFF |
| Someone comments on your task | ON | OFF |
| A team signal-visibility proposal opens | ON | OFF |
| A signal-visibility proposal resolves | ON | OFF |
| A project you belong to is deleted | ON | OFF |
| A task you own goes stale | ON | OFF |
| A task you own is carried to another sprint | ON | OFF |
| Weekly program health digest | OFF | OFF |
| Weekly resource overallocation digest | OFF | OFF |

Email defaults to off across the board — a deliberate flip from the V2 Voice
of Customer pass so a new account is never opted into a second push channel
without asking. The two weekly digests are the only rows off on **every**
channel, including in-app, because a recurring send is traffic you have to
actually want; every other row is on in-app by default so nothing in your own
work goes unseen from day one.

A contributor with no admin access anywhere sees a simplified **Signal-only**
card first, with two choices: **Use signal-only** (in-app on for exactly
"blocked" and "due date changed", everything else off — one click instead of
auditing the grid cell-by-cell) or **Show all notification types** to expand
the full matrix. Workspace/project admins skip the card and land on the full
matrix directly.

### Do Not Disturb

:::note[Ships in 0.4]
The account-wide Do Not Disturb switch lands in the **0.4 beta**.
:::

A single account-wide **Do Not Disturb** switch, at the top of the
preferences page and mirrored as a quick toggle inside the bell panel. It
pauses **email and push only** — your in-app inbox and unread count keep
receiving everything, so nothing is lost while it is on. A handful of
critical signals — a blocked task, a signal-visibility proposal, a milestone
forecast shift — are never held back regardless of the switch.

Do Not Disturb reads and writes through `GET`/`PATCH /api/v1/me/notification-settings/`
— the same account-wide fact surfaces read-only on `/auth/me` so the web
client's current-user query carries it with no second request, and the same
endpoint serves mobile and MCP clients identically.

### The weekly digests and their schedule

The two digest rows above are the only notifications that arrive **on a
clock** rather than in response to an event: a program-health digest (which
programs are at risk or critical, and what is driving it) and a
resource-overallocation digest (who is booked over 100% next week, for the
callers who are Resource Manager or above on the relevant projects). Neither
computes anything of its own — each links to the same rolled-up numbers the
program overview and the resource heat map already show, so a digest line and
the screen it points to can never disagree. A week with nothing to report
still sends, with a subject line saying so, rather than going silent.

Turning on either digest reveals a **Digest schedule** card — a day and hour
picker, evaluated in your own timezone, that governs both digests together
(there is one schedule per user, not one per digest).

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/v1/me/notifications/` | Your inbox. `?unread_only=`, `?archived=`, `?snoozed=`, `?category=mentions\|tasks\|signals\|project` (category, ships in 0.4). Every view except `?snoozed=true` excludes currently-snoozed rows, including the unread-count read, so a deferred notification never lights the bell. |
| `GET` | `/api/v1/me/notifications/{id}/` | Retrieve a single row. |
| `PATCH` | `/api/v1/me/notifications/{id}/` | `{ is_read, is_archived }`. |
| `POST` | `/api/v1/me/notifications/{id}/snooze/` | `{ preset: "1h"\|"3h"\|"tomorrow" }` or `{ until: "<iso>" }`; `{ until: null }` un-snoozes. Ships in 0.4. |
| `POST` | `/api/v1/me/notifications/mark-all-read/` | Bulk mark-read; returns `{ updated: N }`. |
| `GET` | `/api/v1/me/notification-preferences/` | The matrix; defaults are backfilled on first read per user. |
| `PATCH` | `/api/v1/me/notification-preferences/{id}/` | `{ enabled }` on one `(event_type, channel)` row. |
| `POST` | `/api/v1/me/notification-preferences/apply-preset/` | `{ preset: "signal_only"\|"everything" }` — bulk-rewrites the whole matrix atomically. |
| `GET`/`PATCH` | `/api/v1/me/notification-settings/` | Do Not Disturb (`dnd_enabled`, ships in 0.4) and the digest schedule (`digest_weekday`, `digest_hour`). |
| `GET`/`PATCH` | `/api/v1/projects/{id}/notification-preferences/` | Per-project routing — see [Project notifications](/features/settings/project-notifications/). |

All reads and writes on `/me/notifications*` are scoped to the authenticated
user by construction (the queryset filters on `recipient=request.user`) —
there is no cross-user access and no admin surface to edit another member's
routing; each person owns their own notification contract.

## See also

- [Task collaboration](/features/task-collaboration/) — how a comment becomes
  an @-mention notification in the first place, and the acknowledge/react
  signals that deliberately never notify
- [Project notifications](/features/settings/project-notifications/) — the
  per-project routing matrix, quiet hours, and the pause-all switch, which sit
  alongside (not instead of) the account-wide preferences on this page
