---
title: Workspace Settings
description: Configure the TruePPM workspace — general settings, workspace roles, email invites, and groups with project-access cascade.
---


:::note[Added in 0.2 (alpha)]
This page documents functionality added in **TruePPM 0.2**, available since the `0.2.0-alpha.1` pre-release (May 31, 2026). 0.2 is an alpha release; the first beta is planned for 0.4.
:::

TruePPM's workspace is the installation itself — a single-tenant configuration
row that backs the three pages under **Workspace → Settings**: General, Members,
and Groups & teams (#517/#518/#519, ADR-0087).

Multi-tenancy is an Enterprise feature. In the community edition there is exactly
one workspace per deployment.

---

## General (`/settings/general`)

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | `"TruePPM Workspace"` | Display name shown in the nav header and email footers. |
| `subdomain` | string | `""` | **Read-only via the API.** Reserved for a future hosted edition; self-hosted installs leave this blank. |
| `timezone` | string (IANA) | `"UTC"` | Default timezone used for display and for interpreting dates without explicit timezone info. |
| `fiscal_year_start_month` | integer (1–12) | `1` | Fiscal-year start month. Drives quarter labels across the workspace, including the [Schedule timeline](/features/schedule-toolbar/#fiscal-quarters). |
| `fiscal_year_start_day` | integer (1–31) | `1` | Fiscal-year start day, validated against the month (year-agnostic: February caps at 28; 30-day months reject 31). |
| `fiscal_year_start_display` | string | `"January 1"` | **Read-only.** Human label derived from month + day, e.g. `"April 6"`. |
| `work_week` | array of 7 booleans | Mon–Fri `true`, Sat–Sun `false` | Working-day flags, Monday through Sunday. Controls which days the CPM engine treats as working days when no project calendar overrides. |
| `default_project_view` | string | `"board"` | The view tab that opens by default when a user opens a project (`"board"`, `"schedule"`, etc.). |
| `allow_guests` | boolean | `true` | Whether users with `guest` status may be added to projects. This is the **workspace default**; programs and projects inherit it and may override it per scope. See [Sharing & Access Inheritance](/administration/sharing-and-access/). |
| `public_sharing` | boolean | `false` | When `true`, designated read-only views may be shared via link so anyone with the link can view without signing in. This is the **workspace default**; programs and projects inherit it and may override it per scope. See [Sharing & Access Inheritance](/administration/sharing-and-access/). |
| `public_sharing_override_policy` | string | `"suggest"` | Whether downstream scopes may override the workspace sharing values. `"suggest"` (default) lets programs/projects override; `"enforce"` makes the workspace value a hard ceiling. **`enforce` is an Enterprise capability — in the community edition it degrades to `suggest` (no lock).** |

### Access

- **Any active workspace member** can `GET /api/v1/workspace/`.
- **Workspace Admin or Owner** is required to `PATCH /api/v1/workspace/`.

The workspace row is created lazily on first access — no seed migration is needed
on a fresh installation.

### Fiscal year start

The **Fiscal year starts** control offers four quick presets (Jan 1, Apr 1,
Jul 1, Oct 1) plus a **Custom…** option that opens a month + day picker for
arbitrary starts such as the UK tax year (April 6). The value is year-agnostic —
it stores only month and day — so the day is validated against the month
(February is capped at 28; 30-day months reject 31), enforced server-side on
`PATCH`.

This anchor controls how quarters are labeled across the workspace. On the
Schedule timeline a fiscal year that starts in April shows Q1 = Apr–Jun, labeled
`Q1 FY27` (fiscal years are named by the calendar year in which they end). See
[Fiscal quarters](/features/schedule-toolbar/#fiscal-quarters).

> **Upgrade note.** This setting replaced the earlier free-text
> `fiscal_year_start` string. The upgrade migration parses existing values
> (`"January 1"`, `"April"`, `"4/1"`, …) into the structured month/day pair;
> anything unrecognized falls back to January 1 and is logged.

### Workspace logo

:::note[Added in 0.3]
The Workspace logo control was added in 0.3, available since the
`0.3.0-alpha.1` pre-release (Jun 28, 2026).
:::

The **Workspace logo** control will let an Owner or Admin upload a square logo
that surfaces in the top bar beside the workspace name. When no logo is set, the
top bar falls back to a letter-mark derived from the workspace name.

- **Formats:** PNG or WebP only. SVG is rejected — an SVG can carry embedded
  script, so accepting one would open a stored-XSS vector.
- **Size:** 2 MB maximum. Larger files return `HTTP 413`.
- **Dimensions:** at least 256×256 is recommended. The browser warns below that
  size but still allows the upload; the server does not enforce a minimum.
- **Validation:** the server identifies the image by its **magic bytes**, not the
  declared `Content-Type`, so a mislabeled or disguised file is rejected with
  `HTTP 415`.

The logo is served from a **public** endpoint (`GET /api/v1/workspace/logo/`)
with `X-Content-Type-Options: nosniff` and `Content-Disposition: inline` — branding
is non-sensitive, and a public URL keeps it usable in an `<img>` tag without
attaching a bearer token. Replacing the logo deletes the previous blob; **Remove**
(`DELETE /api/v1/workspace/logo/`) clears it and restores the letter-mark.

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/v1/workspace/logo/` | Public | Serve the current logo (`404` when unset). |
| `POST` | `/api/v1/workspace/logo/` | Admin+ | Upload/replace the logo (multipart `file`). |
| `DELETE` | `/api/v1/workspace/logo/` | Admin+ | Clear the logo. |

The General settings response exposes `logo_url` (a cache-busting public URL) or
`null` when no logo is set.

---

## Members (`/settings/members`)

### Workspace role model

Workspace roles are **separate from per-project roles** and use a coarser
three-level hierarchy:

| Role | Ordinal | Description |
|---|---|---|
| **Member** | 100 | Default for all workspace users. Can read workspace-level data and access projects they are invited to. |
| **Admin** | 300 | Can manage members (invite, change roles, deactivate), manage groups, and edit workspace-level settings. |
| **Owner** | 400 | Same capabilities as Admin. At least one Owner must exist at all times (last-Owner guard). |

These role ordinals are distinct from the five project-scoped roles
(Owner/Admin/Scheduler/Member/Viewer — see [Roles and Permissions](/administration/rbac/)).
A workspace Member may hold any project role; a workspace Admin is not
automatically an admin on any project.

### Member status

`status` is orthogonal to role — it tracks account lifecycle, not permission tier:

| Status | Meaning |
|---|---|
| `active` | Normal — the user can authenticate and access their projects. |
| `guest` | External collaborator. Permitted only when `allow_guests` is enabled on the workspace. |
| `deactivated` | The user's Django account is disabled (`is_active=false`) and they cannot authenticate. Deactivation does **not** delete the user or their data. |

Deactivating a user sets `auth.User.is_active = false` atomically inside the same
database transaction — the user is immediately locked out of authentication. To
restore access, set their status back to `active`.

### Last-Owner guard

The workspace must always have at least one user with the Owner role. Attempting
to demote, deactivate, or remove the last Owner returns `HTTP 400`:

```json
{"detail": "Cannot demote the last Owner of the workspace."}
```

### Display-only fields (`sso`, `two_fa`)

Member list responses include `sso: false` and `two_fa: false` in the community
edition. SSO and two-factor authentication enforcement are Enterprise features;
these fields are placeholders and carry no functional meaning in OSS.

### Export members as CSV

The Members page provides an **Export CSV** action that downloads the member
list as a CSV file. The export is generated entirely in the browser — it
requires no server endpoint and never leaves the client until you save it.

- The file is named `trueppm-workspace-members.csv`.
- Columns are **Name**, **Email**, **Role**, **Status**, and **Groups** (a
  member's groups are joined into one semicolon-separated cell).
- The export reflects the **currently visible rows** — if a search term or role
  filter is active, only the matching members are exported. Clear the filters to
  export the full roster.

This feature was added in 0.3.

### Access

- **Workspace Admin+** can list all members and perform role/status changes.
- **Non-admin members** see only their own membership row.
- A user cannot assign a role above their own (`HTTP 403` if attempted).

---

## Invites (`/settings/members` → invite flow)

Workspace Admins send email invitations to bring new users into the workspace.

### How invites work

1. An Admin `POST`s to `/api/v1/workspace/invites/` with `{email, role}`.
2. The API creates a pending invite row and sets `email_pending=true`. The
   **raw token is emailed** to the recipient, never stored in the database
   (only its SHA-256 hash is persisted).
3. The `drain_invite_emails` Celery Beat task dispatches the email every 30 s
   (5-minute orphan window to avoid racing the create transaction). Email
   delivery failures are retried up to 3 times; at exhaustion the invite is
   marked `failed`, and an admin can re-send it (see [Resend an invite](#resend-an-invite))
   without revoking and re-creating it.
4. The recipient clicks the link to reach the accept flow. They `POST` to
   `/api/v1/workspace/invites/accept/` with `{token, username, password}`.
   This endpoint:
   - is **publicly accessible** (no session required),
   - hashes the submitted token and looks up a non-expired pending invite,
   - provisions a new `User` account **or** links the invite to an existing
     account if the invite email matches,
   - creates a `WorkspaceMembership` at the invited role,
   - marks the invite `accepted`.
5. Error responses are **generic** ("invalid or expired token") to prevent
   token enumeration.

### Token security

- Tokens are generated with `secrets.token_urlsafe(32)` (256 bits of entropy).
- Only the SHA-256 hash is stored permanently.
- The raw token is held transiently in `email_token` until the drain sends the
  email, then cleared — a database snapshot taken after delivery contains only
  the hash.
- The accept endpoint is rate-limited to **20 requests/minute** per IP address.

### Invite TTL and statuses

Invites expire **7 days** after creation. Statuses:

| Status | Meaning |
|---|---|
| `pending` | Awaiting acceptance (or email delivery). |
| `accepted` | Accepted; membership created. |
| `revoked` | Canceled by an Admin before acceptance. |
| `expired` | TTL elapsed without acceptance. |

Accepted, revoked, and expired invites older than 30 days are purged by a nightly
`purge_stale_invites` Beat task.

### Resend an invite

A `pending` or `failed` invite can be re-sent without revoking and re-creating
it. The Members page offers a per-row **Resend** action and a **Resend all**
button that re-queues every outstanding invite in one request. This was added in 0.3.

Resending **re-issues the token**: a fresh raw token is generated and emailed, so
any earlier link the recipient still holds stops working. The invite's 7-day TTL
is reset from the resend, and the email re-enters the same outbox drain described
above. A resend on an invite whose email is still in flight is an idempotent
no-op — it will not send twice.

| Method | Path | Access | Description |
|---|---|---|---|
| `POST` | `/api/v1/workspace/invites/{id}/resend/` | Admin+ | Re-issue and re-queue one invite. Returns `202 {"queued": true}`. |
| `POST` | `/api/v1/workspace/invites/resend-all/` | Admin+ | Re-queue every `pending`/`failed` invite. Returns `202 {"requeued": <count>}`. |

Only `pending` and `failed` invites are resendable — resending an `accepted`,
`revoked`, or `expired` invite returns `HTTP 409`. The per-invite endpoint is
rate-limited to **5 requests/minute**; the bulk endpoint bundles every invite
into a single throttle bucket so it cannot be used to flood recipients with email.

### Email transport

Invite emails use the **same SMTP outbox** as notification emails. SMTP must be
configured for invites to be delivered. See [Outbound Email (SMTP)](/administration/email/)
for transport configuration.

---

## Groups & teams (`/settings/groups`)

Groups let workspace Admins grant multiple users access to multiple projects in
one operation. A group has a name, an optional description, an optional lead, and
a list of members.

### Project access cascade

Linking a group to a project (via `POST /api/v1/workspace/groups/{id}/projects/`)
confers a **project role** on every current group member. This reconciliation
(`reconcile_group_access`) runs **synchronously** in the request transaction and
creates or updates `ProjectMembership` rows for all affected (member × project)
pairs. Board-presence events are broadcast to affected project WebSocket consumers
after the transaction commits.

The same reconciliation runs when:
- a member is **added to** or **removed from** the group,
- the **conferred role** for a project link is changed,
- the group is **deleted** (all group-conferred memberships are removed).

### Direct grant wins

Group-conferred memberships are tagged internally (`source_group`). If a user
already has a **direct** `ProjectMembership` on a project (one not sourced from a
group), that direct grant is never overwritten or revoked by group reconciliation.
Group membership is additive: it only removes the rows it created.

### Owner cap

A group can never confer the **Owner** project role. The conferred role is
validated to reject `Owner` at write time. This preserves the project last-Owner
guard — ownership must always be explicitly granted to an individual.

### Group endpoints

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/v1/workspace/groups/` | Any member | List all groups. |
| `POST` | `/api/v1/workspace/groups/` | Admin+ | Create a group. |
| `GET` | `/api/v1/workspace/groups/{id}/` | Any member | Retrieve a group. |
| `PATCH` | `/api/v1/workspace/groups/{id}/` | Admin+ | Update name, description, or lead. |
| `DELETE` | `/api/v1/workspace/groups/{id}/` | Admin+ | Delete group (removes group-conferred memberships). |
| `POST` | `/api/v1/workspace/groups/{id}/members/` | Admin+ | Add a member (triggers cascade). |
| `DELETE` | `/api/v1/workspace/groups/{id}/members/{user_id}/` | Admin+ | Remove a member (triggers cascade). |
| `POST` | `/api/v1/workspace/groups/{id}/projects/` | Admin+ | Link the group to a project with a conferred role (triggers cascade). |
| `DELETE` | `/api/v1/workspace/groups/{id}/projects/{project_id}/` | Admin+ | Unlink the group from a project (removes group-conferred memberships). |

## Programs (`/settings/programs`)

The **Programs** section is a bulk-edit matrix over every program in the workspace.
It is the workspace-scoped counterpart of the program's own **Projects → bulk-edit**
surface: instead of editing one program at a time, an admin sets a single field across
a selection of programs in one atomic call.

### How it works

1. Check the programs you want to change (or **select all**).
2. Pick **one** field to set:
   - **Methodology** — the default delivery model new projects in each program inherit.
     Under a workspace `inherit` methodology lock this column is read-only (display-only).
   - **Iteration label** — the program's iteration-container label; **Reset to inherited**
     clears the override so the program inherits the workspace default again.
   - **Slip propagation** — what each program does when a cross-project dependency slips:
     **No action**, **Warn only**, or **Block & escalate**.
   - **Escalation days** — how long a cross-project slip may persist before escalation
     (1–30 days).
3. Apply. The change is **all-or-nothing** across the selected rows and bumps each
   program's `server_version`. A selection can touch at most **200** programs per call.

Inherited values are shown distinctly from explicit overrides. Methodology and the two
risk-policy fields are always-set columns (no "inherit" state).

### Access

- **Any active workspace member** can read the program list (the matrix is visible
  read-only, without the edit action bar).
- **Workspace Admin or Owner** is required to apply a bulk change.

### Endpoints

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/v1/programs/` | Any member | List programs (the matrix reads `methodology`, `iteration_label`, `risk_slip_propagation`, and `risk_escalation_days`). |
| `POST` | `/api/v1/programs/bulk-fields/` | Admin+ | Set one field across the selected programs in one atomic call. |
