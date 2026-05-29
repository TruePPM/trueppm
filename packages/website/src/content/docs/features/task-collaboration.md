---
title: Task collaboration — attachments, comments, mentions
description: Per-task attachments, threaded comments, @mention notifications, and a per-user inbox bring the conversation onto the work. Powered by ADR-0075.
---


:::note[0.2 — in progress]
This page documents functionality that ships in **TruePPM 0.2** (target Jun 8, 2026). It is not available on the current 0.1 release.
:::

Every task has its own attachment grid and comment thread inside the detail
drawer. Comments support `@user` and `@group` mentions; mentioned recipients
get an in-app notification on the TopBar bell within ~30 seconds, with an
optional email opt-in. Acknowledgements (✅) and reactions (👍) are
structurally distinct so coaches can read team health without polluting it
with chatter.

This page is the user-facing reference for the cluster shipped under #310
(attachments) and #311 (comments + mentions). The architecture lives in
[ADR-0075](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0075-task-comments-attachments-mentions-notifications.md);
the Enterprise overlays (governance audit trail, SCIM provisioning, portfolio
Decision rollup) are filed in `trueppm-enterprise`.

## Attachments

Open any task in the schedule drawer; scroll to the **Attachments** section.
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

Pinned URLs render with a per-host icon when the host is recognised:
Google Docs / Drive, SharePoint / OneDrive / Office, Confluence,
Notion, Figma, Jira, GitHub, GitLab, Miro, Dropbox, and Slack. Anything
else falls back to the generic link glyph. The full host is also shown in
the meta line below the title so the icon is decorative — colour and glyph
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

Below the attachments grid sits the comment thread. The composer is always
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

The 0.2 reaction allow-list (shipping Jun 8, 2026) is `{"👍"}` only; the full
emoji picker lands in 0.3.

## Notifications

### The bell

The TopBar bell tracks your unread mention count. A filled bell with a
brand-coloured count badge means you have unread mentions; a quiet outline
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
channel sub-rows. The two mention events landing in 0.2 — each with an in-app and an email toggle — are:

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
- Comment `Decision` toggle + per-author Notes entries — #476, deferred
  feature that reuses this notification infrastructure
