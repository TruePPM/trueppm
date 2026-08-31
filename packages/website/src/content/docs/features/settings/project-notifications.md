---
title: Project notifications
description: Per-project notification routing — pick which events reach you on which channel, set quiet hours, or pause everything for one project.
documentedFor: "0.4"
---

:::note[Ships in 0.4]
The default matrix below, and the **not delivered yet** labels beside eight of the
nine events, land in **TruePPM 0.4**. On the latest release those eight rows are
defaulted **on** across in-app, email and Slack and carry no label — but they are
dispatched by nothing either way, so no notification is sent for them on any
release. 0.4 makes the page say so; it does not change what is delivered.
:::

The **Project Settings → Notifications** page controls how a single project's events reach *you*. Every project member owns their own copy of this page: the toggles you set apply only to your account on this project, and there is no admin surface for editing another member's routing. Open it at **Project → Settings → Notifications**.

The page has three parts:

1. A **pause-all** kill-switch that silences every notification for you on this project.
2. An **event × channel matrix** — one toggle per (event, channel) pair.
3. A **quiet-hours** window that holds back transient interruptions overnight.

<!-- TODO(#722): screenshot — Project Settings → Notifications page showing the pause switch, the event × channel matrix, and the quiet-hours card. -->

## Event types

The matrix has one row per event. These are the events a project can notify you about:

| Event | Fires when | Delivered today |
|-------|-----------|:---------------:|
| Mention (@) in a comment | Someone `@`-mentions you (or a group you belong to) in a comment | **Yes** |
| Task assigned to me | A task is assigned to you | Not yet |
| Task I own is overdue | A task you own passes its planned date without completing | Not yet |
| Task moves to another column | A task changes status / board column | Not yet |
| Budget threshold crossed | A project budget threshold is exceeded | Not yet |
| Risk created or escalated | A risk is created or its severity escalates | Not yet |
| Milestone reached | A milestone is reached | Not yet |
| Sprint started | A sprint is activated | Not yet |
| Sprint closed | A sprint is closed | Not yet |

**"Not yet" means exactly that: nothing dispatches these eight events, so no
notification is sent for them on any channel, whatever their toggles say.** The
page marks each one **not delivered yet**, and the API reports it as a server fact
so the label can never drift from the truth. Your setting is still saved and will
apply once the event is wired up — you do not need to come back and re-enable it.

The "Fires when" column above describes what each event will mean once it is
delivered, not something happening today. Only **Mention (@) in a comment** is
routed by this matrix right now.

## Channels

Each event can be routed to four channels:

| Channel | Notes |
|---------|-------|
| In-app | The notification inbox in the app. This is a durable record — see [Quiet hours](#quiet-hours) for why it behaves differently. |
| Email | Sent as an email. Email also depends on your workspace-level preference — see [Relationship to your personal preferences](#relationship-to-your-personal-preferences). |
| Slack | **Not delivered yet.** TruePPM has no Slack notification delivery, and no setting anywhere enables it — a toggle here records your intent for when it ships. To get project events into Slack today, add a Slack-format [webhook](/features/webhooks/): a project-wide feed with its own event list, which does not read this matrix. |
| Mobile push | **Not delivered yet.** TruePPM has no push delivery, and no device setting enables it — a toggle here records your intent for when it ships. |

A toggle in the matrix represents *your intent to be notified*. It does not imply the underlying integration is live: turning on the Slack column for an event does nothing until a Slack channel is wired up in Integrations.

## The default matrix

When you first open the page, the matrix is seeded with defaults rather than
everything-on. **An event defaults on only if it is actually delivered** — a
default of "on" is a promise that something will arrive, and TruePPM will not make
that promise for an event it does not yet dispatch.

| Event | In-app | Email | Slack | Mobile push |
|-------|:------:|:-----:|:-----:|:-----------:|
| Mention (@) in a comment | on | on | on | on |
| Task assigned to me | off | off | off | off |
| Task I own is overdue | off | off | off | off |
| Task moves to another column | off | off | off | off |
| Budget threshold crossed | off | off | off | off |
| Risk created or escalated | off | off | off | off |
| Milestone reached | off | off | off | off |
| Sprint started | off | off | off | off |
| Sprint closed | off | off | off | off |

Each of those rows returns to a sensible on/off default in the same release that
wires up its delivery. If you have used TruePPM before 0.4, whatever you had
stored is kept as-is — these defaults apply to a preference row the first time it
is created, not to one you already have.

Defaults are applied lazily the first time you open the page — there is no per-member backfill when you join a project. If TruePPM adds a new event type later, your saved preferences are merged with the new defaults on read, so a row that predates the new event still routes correctly.

## Quiet hours

Quiet hours hold back **transient** interruptions during a daily window — email, Slack, and mobile push. Quiet hours are **enabled by default**, from **20:00 to 07:00** in the project's timezone.

In-app notifications are deliberately **exempt** from quiet hours. The in-app inbox row *is* the notification: suppressing it would lose the event outright rather than defer a ping. So during quiet hours the durable in-app record is always written, and only the transient channels are silenced. This mirrors how Slack and GitHub do-not-disturb behave — the record persists, only the interruption is held back.

The window is the project's timezone (falling back to the workspace default, then UTC). A zero-width window (from equals until) means "no quiet hours".

### Wrapping past midnight

The window is half-open — it includes the *from* time and excludes the *until* time — and it correctly wraps past midnight when the *from* time is later than the *until* time.

Worked example with the default **20:00 → 07:00** window:

- **22:30** is inside the window (after 20:00) → transient notifications are held.
- **03:00** is inside the window (before 07:00) → transient notifications are held.
- **07:00** is *outside* the window (the end is excluded) → notifications resume.
- **12:00** is outside the window → notifications fire normally.

If you instead set a same-day window such as **09:00 → 17:00** (from earlier than until, no wrap), only times *between* 09:00 and 17:00 are quiet.

:::note
Critical-path slips and risk escalations are surfaced immediately regardless of quiet hours — the quiet window only affects the lower-signal transient channels.
:::

## Pause all notifications

The **Pause all notifications** switch at the top of the page is a one-click opt-out from *every* notification on this project, on every channel, regardless of the matrix. It is useful while you are still dialing in your routing.

Your matrix is preserved while paused — pausing does not clear your toggles. Unpausing restores your previous preferences exactly.

## Relationship to your personal preferences

This page is **project-scoped** and orthogonal to your **workspace-level** notification preferences, which live under **Me → Settings → Notifications**. The workspace-level preferences are a per-user, per-event-type channel toggle for the global `@`-mention inbox feed (the inbox that surfaces mentions across every project you belong to).

The two interact for **email on comment mentions**. A comment mention emails you only when **both** are true:

1. The project matrix has the **Email** cell on for *Mention (@) in a comment* (and it is outside quiet hours), **and**
2. Your workspace-level mention-email preference is on.

The in-app inbox row for a mention, by contrast, is governed by the project matrix alone. This lets you keep mention emails off globally while still routing other project events to email per-project.

## FAQ

**Can a project admin change my notifications for me?**
No. Each member owns their own routing. There is no admin surface to edit another member's preferences — by design, "each user owns their notification contract."

**Why does the in-app inbox still show a notification during quiet hours?**
Because the in-app row is a durable record, not a transient ping. Quiet hours only silence email, Slack, and mobile push. Dropping the in-app row would lose the event entirely.

**I turned on the Slack column but nothing arrives in Slack.**
Nothing is delivered on the Slack channel yet. TruePPM has no Slack notification delivery and there is no setting that enables it, so there is nothing you can configure to make this work today — your toggle is saved and applies once delivery ships. If you want project events in Slack now, add a Slack-format [webhook](/features/webhooks/) under **Project Settings → Integrations**. That is a project-wide feed on its own event list; it does not read this matrix and is not per-person routing.

**Do my preferences carry over to other projects?**
No. This page is per-project. Joining another project starts you on that project's default matrix. Your *workspace-level* mention preferences (**Me → Settings → Notifications**) are the only cross-project notification settings.

**What is the API behind this page?**
`GET` and `PATCH` `/api/v1/projects/{project_id}/notification-preferences/`. Any project member may read and update their own preferences. A `PATCH` accepts a partial matrix — toggling one cell does not require reposting the whole grid.
