---
title: Task collaboration — notes, attachments, comments, mentions
description: A per-author decision log, per-task attachments, threaded comments, @mention notifications, and a per-user inbox bring the reasoning and the conversation onto the work. Powered by ADR-0075 and ADR-0143.
---


:::note[Added in 0.2 (alpha)]
This page documents functionality added in **TruePPM 0.2**, available since the `0.2.0-alpha.1` pre-release (May 31, 2026). 0.2 is an alpha release; the first beta is planned for 0.4. The **Notes** section below was added separately in 0.3 — see its callout.
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

:::note[Added in 0.3]
The notes log was added in the **0.3 "agile team"** milestone, available since
the `0.3.0-alpha.1` pre-release (Jun 28, 2026).
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

The default allowed file types are PDF, JPG, PNG, WebP, XLSX, CSV, and DOCX, but a
workspace, program, or project Admin can **enable/disable attachments and change the
allowed types per scope** — see [Attachment Policy](/administration/attachment-policy/).
When uploads are disabled for a project the **+ Attach file** control is replaced by a
short note (existing files stay viewable). A built-in security denylist (HTML, SVG,
XHTML) is permanently blocked and cannot be enabled. The size cap is **100 MB** per
file. Anything outside the resolved allow-list or over the cap gets a friendly inline
error before the upload runs, so you don't burn a multipart round-trip on a rejected
file.

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

Issuing a real signed URL requires an object-storage backend that supports
signing (S3/MinIO, GCS, or Azure Blob via `django-storages`) — see
[Attachment storage](/administration/configuration/#optional--advanced-settings).
On the default `FileSystemStorage` backend, Download returns an error instead
of a link, because that backend has no way to produce a URL that actually
expires.

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
- **Program groups** — when the project belongs to a **program**, the
  autocomplete also offers `@program-pms` (every Owner/Admin across the
  program's projects), `@program-schedulers`, `@program-stakeholders` (the
  view-only audience), and `@program-all` (everyone in the program). They
  resolve to the combined membership across all of the program's projects, so
  you can reach a program-wide role band with a single mention. Standalone
  projects (not in a program) don't show these.
- **Individuals** — project members whose username matches your typed prefix.

`@all` is restricted to **Admin and Owner roles** to prevent accidental
high-volume mentions. The autocomplete shows it as disabled with an "Admin+
only" hint for Viewer/Member/Scheduler users; the server enforces the same
gate. There is also a hard cap of **200 users** for `@all` resolution —
larger projects will need a more targeted group key. `@program-all` carries
the same Admin gate and 200-user cap.

Because a program mention can reach members of *sibling* projects, the inbox
shows the comment preview only to recipients who are members of the source
project; everyone else sees the notification (they know they were pinged) but
not the comment body, so one project's content never leaks to another's team.

To render a literal `@name` without triggering a mention, escape it with a
backslash: `\@name`. Mentions inside fenced code blocks or inline backticks
are also left alone.

### Custom mention groups

Beyond the automatic role-based groups, you can hand-curate your own
workflow-shaped groups — `@subcontractors`, `@inspectors`, `@tech-leads` — and
mention them as a plain `@name`:

- **Project groups** — a project **Admin** creates them in **Project
  Settings → Members → Mention groups**. Members are drawn from the project's
  team; a project **Scheduler** or above edits the roster.
- **Program groups** — a program **Owner** creates them in **Program
  Settings → Access → Mention groups**. Members are selectable across **every
  project in the program**, so one group can reach people working on different
  projects; a program **Admin** or above edits the roster.

When you mention a name, it resolves in order of specificity: a real project
member first, then a project custom group, then a program custom group — so a
project group shadows a same-named program group. Each group has a per-group
**email default** (off unless the manager turns it on) and any member can
**mute** a group to stop its mentions reaching them, while still receiving
direct `@you` mentions. Like the automatic groups, membership is snapshotted at
write time, and names are unique within their scope and can't shadow an
automatic group key.

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
emoji picker landed in 0.3.

## Notifications

### The bell

The TopBar bell tracks your unread mention count. The bell keeps the **same
active shape in every state** — unread is signalled by a brand-colored count
badge and accent, never by swapping to a muted or "off"-looking glyph, so the
resting (caught-up) state never reads as *notifications turned off*. The count
caps at "99+" in the badge but the underlying value is exact.

On desktop, clicking the bell opens a 380–420 px slide-out panel anchored to
the right of the topbar. On mobile, it navigates to `/me/notifications` as a
full-screen route.

The unread count refreshes every **30 seconds** while the tab is in the
foreground. Background tabs pause the poll to save battery and API calls.

### Do Not Disturb

:::note[Ships in 0.4]
The account-wide Do Not Disturb switch lands in the **0.4 beta**.
:::

Do Not Disturb is a personal, account-wide quiet switch. Turn it on from
**Settings → Notifications** (or the quick toggle in the bell panel) to pause
notification **emails and push** — your in-app inbox and unread count keep
receiving everything, so nothing is lost. While it is on, the bell shows a small
crescent-moon indicator; because it is driven by a real setting, that indicator
means *you chose quiet*, not *notifications are broken*.

Critical alerts always come through even while muted — a task of yours being
**blocked**, a team **signal-visibility proposal** opening or resolving, and a
**milestone forecast shift** are never silenced. Do Not Disturb only holds back
the interrupting channels; it can never swallow the signals that need you.

Do Not Disturb is a single on/off switch today. It reads and writes through
`GET`/`PATCH /api/v1/me/notification-settings/`, so it is identical for web,
mobile, and MCP clients. It is distinct from per-notification **Snooze** (which
defers one item) and inline **Mute** (which turns down one *type*) below.

### The inbox

The panel and the full route share the same shape: a tab strip (**All /
Unread / Archived / Snoozed**), a list of `NotificationRow`s, and a **Mark all
read** bulk action. Each row shows:

- Who mentioned you (or "mentioned `@group`")
- A truncated snippet of the comment body
- Relative time
- Per-row **Mark read / unread** and **Archive** buttons

Clicking the row body navigates to the source task and marks the
notification read on the way.

### Snooze, mute, and category filter

:::note[Ships in 0.4]
Per-notification snooze, inline mute-a-type, and the category filter land in
the **0.4 beta**. They surface the noise controls inline in the panel and the
mobile route, so you never have to leave your inbox to turn a noisy type down.
:::

**Snooze** defers a single notification. The row's **Snooze** menu offers
**1 hour**, **3 hours**, and **Tomorrow**; a snoozed row drops out of the
All/Unread views — and out of the bell count — until its time passes, then
reappears (still unread) on its own. No background job is involved; the row is
simply hidden by a time comparison at read time. The **Snoozed** tab lists what
you have deferred, and each snoozed row offers **Un-snooze** to bring it back
immediately.

**Mute notifications like this** turns off *future* in-app delivery of a
notification *type* from the row where you feel the noise. It flips the in-app
channel for that event's [preference](#preferences) off — email is untouched
(its control stays in settings), which is why the confirmation reads "Muted in
your inbox" and offers an **Undo**. Mention rows have no mute action: you mute a
*type*, and a mention is a person addressing you.

**Category** is a second, orthogonal selector — **All / Mentions / Tasks /
Signals / Project** — alongside the read-state tabs. It classifies each
notification from its event type (mentions, task events, schedule signals, and
project-lifecycle events) so a busy feed stays scannable. Filtering by category
keeps whichever read-state tab you are on.

Every empty view — each category, the Snoozed tab, the mobile route — shows a
friendly empty state ("You're all caught up", "Nothing snoozed") rather than a
blank list.

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

### Project-delete notification

The same inbox also carries a **project-delete** notification: when a project is
deleted, every other member gets an in-app row naming who deleted it, with
guidance to restore the project from Trash while it is still in the retention
window. It is in-app only — never a push — and email is opt-in off by default,
toggleable from the same preference matrix ("When a project you belong to is
deleted"). The deleter is not notified of their own action, and permanent
(hard) deletes send no notification because there is nothing left to restore.
Who deleted which project, and when, is also recorded in the
[workspace audit log](/administration/audit-log/).

### Stale-task nudge

A nightly scan reminds you about your own work that has stopped moving. If a task
**assigned to you** has sat in the same non-terminal status — anything other than
*Complete* — longer than the project's stale-task threshold (default **7 days**), you
get an in-app *"When a task you own goes stale"* notification. A card in **Review**
awaiting sign-off is the flagship case: it's the "task I forgot in Review" slip that
otherwise only surfaces at Friday standup. In-app is ON by default; email is opt-in
off, toggleable from the same preference matrix. Repeat runs dedupe against your
existing unread nudge, so a still-stale task is not notified twice — read or act on it,
and only then does a later run nudge again. The threshold is a per-project setting an
admin configures; see [Project settings → Notifications](/administration/project-settings/).

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
  `?archived=true`, `?snoozed=true`, `?category=mentions|tasks|signals|project`.
  Every view except `?snoozed=true` excludes currently-snoozed rows — including
  the unread-count query — so a deferred notification never lights the bell.
  Each row carries a derived read-only `category` and its `snoozed_until` (ships
  in 0.4)
- `PATCH /api/v1/me/notifications/{id}/` — `{ is_read, is_archived }`
- `POST /api/v1/me/notifications/{id}/snooze/` — `{ preset: "1h"|"3h"|"tomorrow" }`
  or `{ until: "<iso>" }`; `{ until: null }` un-snoozes (ships in 0.4)
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
  log above landed first in 0.3 without it
