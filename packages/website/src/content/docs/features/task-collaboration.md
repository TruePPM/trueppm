---
title: Task collaboration — notes, attachments, comments, mentions
description: A per-author decision log, per-task attachments, threaded comments, @mention notifications, and a per-user inbox bring the reasoning and the conversation onto the work. Powered by ADR-0075 and ADR-0143.
---


:::note[Added in 0.2 (alpha)]
This page documents functionality added in **TruePPM 0.2**, available since the `0.2.0-alpha.1` pre-release (May 31, 2026). 0.2 is an alpha release; the first beta is planned for 0.4. The **Notes** section below ships separately in 0.3 — see its callout.
:::

Every task has its own decision log, attachment grid, and comment thread
inside the detail drawer. **Notes** capture the *why* behind the work — a
flat, per-author, append-only log of decisions and reasoning, distinct from
the back-and-forth of comments. **Comments** support `@user` and `@group`
mentions; mentioned recipients get an in-app notification on the TopBar bell
within ~30 seconds, with an optional email opt-in. Acknowledgements (✅) and
reactions (👍) are structurally distinct so coaches can read team health
without polluting it with chatter.

This page is the user-facing reference for the cluster shipped under #310
(attachments) and #311 (comments + mentions). The architecture lives in
[ADR-0075](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0075-task-comments-attachments-mentions-notifications.md);
the Enterprise overlays (governance audit trail, SCIM provisioning, portfolio
Decision rollup) are filed in `trueppm-enterprise`.

## Notes

:::note[Ships in 0.3 (Underway)]
The notes log is part of the **0.3 "agile team"** milestone, which is still
underway. This section describes the feature as designed; it is not yet in a
tagged build — see the [roadmap](/overview/roadmap/).
:::

Notes are a task's **decision log** — a flat, per-author record of *why* the
work went the way it did. Where comments are a conversation, a note is a
durable statement: "Chose option B because the vendor SLA covers the
quarter," "Descoped the export pane — moved to next sprint," "Confirmed with
finance that the budget code is correct." The log lives in the task drawer's
**Notes** section, ahead of comments, so the reasoning is the first thing you
see when you open a task.

Each note is an **immutable, timestamped row** showing who wrote it. New
notes do not overwrite old ones — every save is its own entry, so the history
of decisions on a task is never clobbered by the last person to type.

### Adding a note

Members and above type into the composer at the top of the section and post.
There is no thread, no reply, no formatting ceremony — one author, one entry,
one timestamp. The flow is deliberately low-friction: the goal is that
recording a decision costs less than skipping it.

### The 15-minute edit window

After you post, you can edit **your own** note's body for **15 minutes** to
fix a typo or finish a thought. After the window closes, the note locks and
its body is read-only — the immutability guarantee that makes the log
trustworthy. A note that was edited within the window shows a small
**"edited"** marker so readers know the text changed after it was first
posted.

You can only edit your *own* notes, and only within the window. No one — not
even a project admin — can rewrite another person's note; the only
administrative action on someone else's note is removal (below).

### Pinning

Any team member (Member role and up) can **pin** or unpin any note, not just
its author. Pinned notes sort to the top of the log; everything else sorts
newest-first beneath them. Pin the decision the team keeps coming back to so
it doesn't scroll away under day-to-day entries. Pinning is separate from the
edit window — you can pin a note long after it has locked.

### Removing a note

A note's **author**, or a project **Admin or Owner**, can remove a note. The
removal is a soft delete: the entry leaves the visible log but is not
hard-erased. Everyone else sees no delete control on notes they didn't write.

### Searching the log

A search box above the log filters the notes already on the card by **text or
author**. It is a card-scoped filter, not a project-wide search: matching
notes stay **bright** while non-matches **dim** (they stay readable — dimmed,
not hidden), and a live **"N of M notes"** count tells you how much the
filter is catching. Press **Esc** to clear the search and restore the full
log.

### The freshness signal

So you can tell at a glance when a task last gained a decision, a 📝 marker
with the **latest note's time** appears on the **board card face** and on the
**schedule (Gantt) row**. A task that just picked up a note reads as recently
reasoned-about; a stale one stands out. The marker reflects the most recent
note only — open the task to read the full log.

### Notes vs. the task description

This collaborative log is **separate** from the task's free-text **notes**
field. That older field is the task's description / scratch text — it is what
MS Project import/export round-trips, what the seed schema and inbound sync
write into, and what the offline sync protocol treats as an editable task
scalar. It is **unchanged** by this feature. The decision log described here
is a distinct, authored, per-entry surface; the description field stays a
single machine-and-human-editable blob. (Naming aside: the design calls the
log entries `TaskNote` and keeps the description as `Task.notes` —
[ADR-0143](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0143-task-notes-sub-resource.md)
has the rationale.)

### Permissions

| Role | Read log | Add | Edit own (≤15 min) | Pin / unpin | Remove |
|---|---|---|---|---|---|
| Viewer | ✅ | — | — | — | — |
| Member, Scheduler | ✅ | ✅ | ✅ | ✅ | own only |
| Admin, Owner | ✅ | ✅ | ✅ | ✅ | any note |

Viewers see the **full** notes log — every author, every timestamp — but no
add, edit, pin, or remove controls.

## Attachments

Open any task in the schedule drawer and switch to the **Files** tab, where
the **Attachments** section lives alongside external links.
Two add affordances sit above the grid: **+ Attach file** (native file picker)
and **+ Pin link** (modal for external URLs). Files can also be dropped
directly onto the section — the drop zone is hidden until you start dragging.

Allowed file types: PDF, JPG, PNG, WebP, XLSX, CSV, DOCX. The size cap is
**100 MB** per file. Anything outside the allow-list or over the cap gets a
friendly inline error before the upload runs, so you don't burn a multipart
round-trip on a rejected file.

External-URL attachments require `http(s)` schemes only. Pinning a Figma,
Confluence, or Notion link is a one-shot — title is optional and defaults
to the URL host.

Pinned URLs render with a per-host icon when the host is recognized:
Google Docs / Drive, SharePoint / OneDrive / Office, Confluence,
Notion, Figma, Jira, GitHub, GitLab, Miro, Dropbox, and Slack. Anything
else falls back to the generic link glyph. The full host is also shown in
the meta line below the title so the icon is decorative — color and glyph
are never the only signal.

### Downloads

Click any file row's **⬇ Download** button. The signed URL is short-lived
(15 minutes by default, 60 minutes max in OSS) so a leaked link can't be
re-played indefinitely. External-URL attachments open in a new tab directly —
no signed URL is involved.

### Deleting

Click **Delete** to soft-delete an attachment. Only the uploader or a project
admin can delete; everyone else sees the option grayed out with a tooltip.
A second confirmation click commits the delete; **Cancel** backs out.

Soft-deleted attachments are removed from the grid but **comments that
reference them still render with a "(deleted attachment)" placeholder** so
the thread's context survives.

## Comments

The comment thread lives in the task drawer's **Activity** tab, alongside the
activity timeline and field history. The composer is always
visible at the bottom. Top-level comments support a single level of inline
replies — click **↩ Reply** on any top-level row to open a scoped reply
composer beneath it.

### Mentions

Typing `@` opens an autocomplete popover with two sections:

- **Groups** — `@admins`, `@schedulers`, `@members`, `@viewers`, `@all`,
  `@scrum-team`. These resolve at write time to whoever currently matches
  the criteria; the people who joined the project *after* a mention was
  posted are not retroactively notified.
- **Individuals** — project members whose username matches your typed prefix.

`@all` is restricted to **Admin and Owner roles** to prevent accidental
high-volume mentions. The autocomplete shows it as disabled with an "Admin+
only" hint for Viewer/Member/Scheduler users; the server enforces the same
gate. There is also a hard cap of **200 users** for `@all` resolution —
larger projects will need a more targeted group key.

To render a literal `@name` without triggering a mention, escape it with a
backslash: `\@name`. Mentions inside fenced code blocks or inline backticks
are also left alone.

### Attachment references

You can reference an attachment inline in a comment by typing
`[[attachment:<uuid>]]`. The composer doesn't yet auto-insert this for you —
a future enhancement (#310 phase 2b.5) will add an attach button to the
composer itself that uploads + inserts in one step. For now, the renderer
shows a chip when the attachment is found and a "(deleted attachment)"
placeholder when it isn't.

### Body length and edit window

Comments are capped at **10 000 characters**. The composer's counter turns
amber at 9 000 and red at the cap.

After posting, the comment is editable for **15 minutes**. After that, the
body is read-only; you can still delete your own comment as the author, and
project admins can delete anyone's.

### Reactions vs acknowledgements

Two structurally distinct signals sit on every comment:

- **✅ Acknowledge** is an active "I'm on it" / "I've seen this" stance. The
  count is visible to the team but **not** to the PMO (Morgan-Lee blocker
  from the V2 VoC pass). Members and above can acknowledge; viewers cannot.
- **👍 React** is a lightweight social signal. The count is visible to anyone
  with project access. Neither reactions nor acknowledgements ever trigger a
  notification — they're soft signals, not pings.

The 0.2 reaction allow-list is `{"👍"}` only; the full
emoji picker will land in 0.3.

## Notifications

### The bell

The TopBar bell tracks your unread mention count. A filled bell with a
brand-colored count badge means you have unread mentions; a quiet outline
bell means you're caught up. The count caps at "99+" in the badge but the
underlying value is exact.

On desktop, clicking the bell opens a 380–420 px slide-out panel anchored to
the right of the topbar. On mobile, it navigates to `/me/notifications` as a
full-screen route.

The unread count refreshes every **30 seconds** while the tab is in the
foreground. Background tabs pause the poll to save battery and API calls.

### The inbox

The panel and the full route share the same shape: a tab strip (**All /
Unread / Archived**), a list of `NotificationRow`s, and a **Mark all read**
bulk action. Each row shows:

- Who mentioned you (or "mentioned `@group`")
- A truncated snippet of the comment body
- Relative time
- Per-row **Mark read / unread** and **Archive** buttons

Clicking the row body navigates to the source task and marks the
notification read on the way.

### Preferences

`/me/settings/notifications/` exposes the per-`(event_type, channel)`
preference matrix. On desktop it renders as a `<table>` — one row per event,
one column per channel. On mobile each event becomes its own card with
channel sub-rows. The two mention events added in 0.2 — each with an in-app and an email toggle — are:

| Event | In-app | Email |
|---|---|---|
| When you're @-mentioned individually | ON | **OFF** |
| When a group you're in is @-mentioned | ON | **OFF** |

Email is OFF by default for both events — this is Priya Patel's explicit
flip from the V2 VoC pass (she didn't want yet another push channel without
opting in). Changes save automatically 300 ms after each toggle click, with a
subtle "Saved." indicator that auto-dismisses.

When Enterprise registers additional channels (Slack DM, Teams DM, SMS via
ADR-0049's `NOTIFICATION_CHANNELS` registry), they appear as additional
columns/rows automatically — the matrix derives its axes from the
preferences list.

## API

The full REST surface is documented in [docs/api/](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/api/openapi.json).
Brief tour of the new endpoints:

- `GET /api/v1/projects/{project_id}/tasks/{task_id}/attachments/` — list
- `POST /api/v1/projects/{project_id}/tasks/{task_id}/attachments/` — multipart
  upload OR JSON `{ external_url, external_title }`
- `DELETE /api/v1/projects/{project_id}/tasks/{task_id}/attachments/{id}/` —
  soft-delete; uploader OR Admin+ only
- `GET .../attachments/{id}/signed-url/?ttl=900` — issue a short-lived
  download URL
- `GET /api/v1/projects/{project_id}/tasks/{task_id}/comments/` — list
- `POST .../comments/` — create with `{ body, parent }`
- `PATCH .../comments/{id}/` — author only, 15-min window
- `DELETE .../comments/{id}/` — author OR Admin+
- `POST/DELETE .../comments/{id}/acknowledge/` — toggle ack
- `POST/DELETE .../comments/{comment_pk}/reactions/[{id}/]` — toggle reaction
- `GET /api/v1/me/notifications/` — your inbox; `?unread_only=true`,
  `?archived=true`
- `PATCH /api/v1/me/notifications/{id}/` — `{ is_read, is_archived }`
- `POST /api/v1/me/notifications/mark-all-read/`
- `GET /api/v1/me/notification-preferences/` — defaults are backfilled
  on first request per user
- `PATCH /api/v1/me/notification-preferences/{id}/` — `{ enabled }`

## WebSocket events

On the existing `project_{id}` channel, the new mutations broadcast:

- `task_comment_created` / `task_comment_updated` / `task_comment_deleted` —
  payload `{ id, task_id, parent_id? }`
- `task_attachment_created` / `task_attachment_deleted` — payload
  `{ id, task_id }`

All payloads are aggregated metadata only — no body, no scope-sensitive
fields. Clients refetch via REST after a broadcast and the serializer
enforces visibility scope (relevant for the future TEAM_ONLY scope that
#476 introduces).

## What's not here yet

- Comment composer auto-attach (one-click upload that inserts the
  `[[attachment:uuid]]` reference at the cursor) — #310 phase 2b.5
- Attachment pin/unpin toggle — needs a small backend `PATCH` addition
- IndexedDB offline write queue for comments + attachments — #311 phase 2c
- Real-time per-user notification push via a `user_{id}` WebSocket channel —
  deferred to 0.3 if the 30 s polling proves too laggy in practice
- Portfolio-level Decision rollup, audit-trail immutability, and the
  executive weekly digest — all filed in `trueppm-enterprise` as paid-tier
  overlays (#108–#113)
- A **Decision** flag on a note plus a project/sprint Decisions view — the
  sprint-bound half of the notes work — is a fast-follow (#748); the notes
  log above lands first in 0.3 without it
