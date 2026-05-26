# Workspace Settings

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
| `fiscal_year_start_month` | integer (1–12) | `1` | Fiscal-year start month. Drives quarter labels across the workspace, including the [Schedule timeline](../features/schedule-toolbar.md#fiscal-quarters). |
| `fiscal_year_start_day` | integer (1–31) | `1` | Fiscal-year start day, validated against the month (year-agnostic: February caps at 28; 30-day months reject 31). |
| `fiscal_year_start_display` | string | `"January 1"` | **Read-only.** Human label derived from month + day, e.g. `"April 6"`. |
| `work_week` | array of 7 booleans | Mon–Fri `true`, Sat–Sun `false` | Working-day flags, Monday through Sunday. Controls which days the CPM engine treats as working days when no project calendar overrides. |
| `default_project_view` | string | `"board"` | The view tab that opens by default when a user opens a project (`"board"`, `"schedule"`, etc.). |
| `allow_guests` | boolean | `true` | Whether users with `guest` status may be added to projects. |
| `public_sharing` | boolean | `false` | When `true`, certain read-only project views may be shared without authentication (feature flag for future link-sharing). |

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
[Fiscal quarters](../features/schedule-toolbar.md#fiscal-quarters).

> **Upgrade note.** This setting replaced the earlier free-text
> `fiscal_year_start` string. The upgrade migration parses existing values
> (`"January 1"`, `"April"`, `"4/1"`, …) into the structured month/day pair;
> anything unrecognized falls back to January 1 and is logged.

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

These role ordinals are distinct from the five project-scoped roles (Owner/Admin/
Scheduler/Member/Viewer — see [Roles and Permissions](/administration/rbac/)).
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
these fields are placeholders for Enterprise identity features and their values
carry no functional meaning in OSS.

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
   delivery failures are retried up to 3 times; at exhaustion the invite
   remains `pending` and the admin can re-send by revoking and re-creating.
4. The recipient clicks the link, which navigates to the accept flow. They
   `POST` to `/api/v1/workspace/invites/accept/` with `{token, username,
   password}`. This endpoint:
   - is **publicly accessible** (no authentication required),
   - hashes the submitted token and looks up a non-expired pending invite,
   - provisions a new `User` account **or** links the invite to an existing
     account if the invite email matches an existing user's email,
   - creates a `WorkspaceMembership` at the invited role,
   - marks the invite `accepted`.
5. Error responses are **generic** ("invalid or expired token") to prevent
   token enumeration.

### Token security

- Tokens are generated with `secrets.token_urlsafe(32)` (256 bits of entropy).
- Only the SHA-256 hash is stored permanently.
- The raw token is held transiently in `email_token` until the drain sends the
  email (then cleared), so a database snapshot taken after delivery contains
  only the hash.
- The accept endpoint is rate-limited to 20 requests/minute per IP address.

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

### Email transport

Invite emails use the **same SMTP outbox** as notification emails. SMTP must be
configured for invites to be delivered. See [Outbound Email (SMTP)](/administration/email/)
for transport configuration.

### Invite endpoints

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/v1/workspace/invites/` | Admin+ | List pending invites. |
| `POST` | `/api/v1/workspace/invites/` | Admin+ | Create an invite (email queued asynchronously). |
| `DELETE` | `/api/v1/workspace/invites/{id}/` | Admin+ | Revoke a pending invite. |
| `POST` | `/api/v1/workspace/invites/accept/` | Public | Accept an invite with a one-time token. |

---

## Groups & teams (`/settings/groups`)

Groups let workspace Admins grant multiple users access to multiple projects in
one operation. A group has a name, an optional description, an optional lead, and
an ordered list of members.

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

Group-conferred memberships are tagged with `source_group`. If a user already has
a **direct** `ProjectMembership` on a project (one not sourced from a group), that
direct grant is never overwritten or revoked by group reconciliation. The direct
grant always wins. Group membership is additive: it only removes the rows it
created.

### Owner cap

A group can never confer the **Owner** project role. The `GroupProject.role` field
is validated to reject `Owner` at write time. This preserves the meaning of the
project last-Owner guard — ownership must always be explicitly granted.

### Group endpoints

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/v1/workspace/groups/` | Any member | List all groups. |
| `POST` | `/api/v1/workspace/groups/` | Admin+ | Create a group. |
| `GET` | `/api/v1/workspace/groups/{id}/` | Any member | Retrieve a group. |
| `PATCH` | `/api/v1/workspace/groups/{id}/` | Admin+ | Update name, description, or lead. |
| `DELETE` | `/api/v1/workspace/groups/{id}/` | Admin+ | Delete group (removes group-conferred memberships). |
| `POST` | `/api/v1/workspace/groups/{id}/members/` | Admin+ | Add a member to the group (triggers cascade). |
| `DELETE` | `/api/v1/workspace/groups/{id}/members/{user_id}/` | Admin+ | Remove a member from the group (triggers cascade). |
| `POST` | `/api/v1/workspace/groups/{id}/projects/` | Admin+ | Link the group to a project with a conferred role (triggers cascade). |
| `DELETE` | `/api/v1/workspace/groups/{id}/projects/{project_id}/` | Admin+ | Unlink the group from a project (removes group-conferred memberships). |
