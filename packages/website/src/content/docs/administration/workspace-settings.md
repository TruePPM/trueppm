---
title: Workspace Settings
description: Configure the TruePPM workspace — general settings, workspace roles, email invites, and groups with project-access cascade.
documentedFor: "0.4"
---


:::note[Added in 0.2 (alpha)]
This page documents functionality added in **TruePPM 0.2**, available since the `0.2.0-alpha.1` pre-release (May 31, 2026). 0.2 is an alpha release; the first beta is planned for 0.4.
:::

TruePPM's workspace is the installation itself — a single-tenant configuration
row that backs the pages under **Workspace → Settings**: General, Members,
Invites, Groups & teams, and Programs, plus workspace archive/delete actions
(#517/#518/#519, ADR-0087). ADR-0087 scoped the original three — General,
Members, and Groups & teams — and the section has grown since.

Multi-tenancy is an Enterprise feature. In the community edition there is exactly
one workspace per deployment.

---

## In-product help

:::note[Ships in 0.4]
The contextual-help affordance described here ships in **0.4**, the first beta. It
is not part of the 0.3 alpha line.
:::

Settings help comes at two altitudes: a link on **every section**, and a **ⓘ** on
individual fields that need it.

### Section help: "Learn more →"

Every section in Workspace, Program, and Project settings ends its description with a
**Learn more →** link to the page documenting that section. It sits at the tail of the
sentence under the section title, opens in a new tab, and — like the field-level ⓘ
below — is **not permission-gated**: someone who cannot change a setting can still read
what it does.

The link is announced to screen readers by section ("Learn more about General, opens in
a new tab"), not as a bare "Learn more", so the several dozen of them stay
distinguishable when tabbing or listing links.

Section help answers *"what is this page and where is it documented"*. Field help,
below, answers *"what are my choices for this input"*. They are complementary, and most
sections carry both.

### Field help: the ⓘ popover

Settings fields that carry jargon, a policy choice, or an inheritance cascade also
carry a contextual-help affordance — a circled **ⓘ** in the field's label row.
Opening it explains the setting in plain language and, where a deeper guide exists,
deep-links to it via **Learn more →**.

The ⓘ *supplements* the always-visible hint beneath each field rather than replacing
it. The hint answers "what does my current pick mean"; the popover answers "what are
all my choices".

Three behaviors are worth knowing:

- **It is a non-modal dialog, not a tooltip.** The panel contains a link, and a link
  inside an `aria-describedby` tooltip cannot be reached, so the affordance is a
  `role="dialog"` with `aria-modal="false"`. Focus moves into the panel on open,
  **Tab** reaches the **Learn more →** link, and **Esc** closes the panel and returns
  focus to the ⓘ. Opened from inside a settings modal, **Esc** peels one layer at a
  time — the popover first, the modal second.
- **There is no permission gate.** The help renders regardless of role, so a member
  with read-only access can understand a setting without the rights to change it.
- **Its screen-reader name is the field.** The trigger announces as "About the
  *&lt;field&gt;* options" rather than as an unlabeled icon button.

On the General page the ⓘ appears on these fields:

| Field | Learn more → |
|---|---|
| Default timezone | [Timezone & date format](/features/timezone-and-date-format/#timezone) |
| Fiscal year starts | [Fiscal year start](#fiscal-year-start) |
| Work week | [Working calendars](/administration/working-calendars/) |
| Default project view | This page |
| Iteration terminology | [Methodology preset](/features/methodology-preset/#iteration-terminology) |
| Allow guests | [Sharing & access](/administration/sharing-and-access/) |
| Public sharing | [Sharing & access](/administration/sharing-and-access/) |
| Keep Monte Carlo run history | [Forecast history](/features/monte-carlo/#forecast-history) |
| Run history limit | [Forecast history](/features/monte-carlo/#forecast-history) |
| Run attribution visible to | [Forecast history](/features/monte-carlo/#forecast-history) |
| Story picker shows Ready stories only, by default | [Sprint backlog table](/features/sprint-backlog/#story-picker) |
| Duration change → percent complete | This page |
| Program & project overrides | This page |
| Forecast-history overrides | [Retention](/administration/retention/#forecast-snapshots) |

The same affordance appears throughout the
[program](/administration/program-settings/) and
[project](/administration/project-settings/) settings pages.

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
| `sprint_picker_ready_only_default` <br/>*(ships in 0.4)* | boolean | `true` | Whether the [sprint story picker](/features/sprint-backlog/#story-picker) starts filtered to Definition-of-Ready stories. This is the **workspace default**; programs and projects inherit it and may override it per scope (Shape A: `null` override = inherit). Advisory only — the picker's own "Show all" toggle always reveals a not-ready story, and committing one is never blocked. There is no override policy / enforcement seam for this field. |

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

The **Workspace logo** control lets an Owner or Admin upload a square logo
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

#### Off-boarding also revokes long-lived credentials

:::note[Ships in 0.4]
Credential revocation on deactivate/remove ships in **TruePPM 0.4**. In
`v0.3.0-alpha.3` (the latest release), deactivation disables the account but
leaves the member's personal access tokens live — revoke them by hand from their
token list before treating an off-boarding as complete.
:::

Deactivating a member — and removing one, which is a deactivation here — also, in
the same transaction:

- **revokes every personal access token they own**, so a script still holding one
  starts failing with `401` on its next request; and
- **signs out every device**, by blacklisting all of their outstanding refresh
  tokens.

Without this, disabling the account would terminate only the session and JWT
path. A personal access token is a separate, long-lived bearer of the same
authority, and one minted without an expiry never retires on its own — so an
off-boarded member would keep full API access at their pre-departure permissions
indefinitely.

Revocation is **durable**: setting the member back to `active` restores their
login but does not un-revoke their tokens. A returning member creates new ones.

Project- and program-scoped API tokens are org assets rather than personal
credentials. They are neither revoked nor rejected, and keep authenticating even
when the member who minted them is deactivated — a token's authority comes from
its own project or program scope, not from that person's account, so off-boarding
one person never breaks a team's CI integration.

### Last-Owner guard

The workspace must always have at least one user with the Owner role. Attempting
to demote, deactivate, or remove the last Owner returns `HTTP 400`:

```json
{"detail": "Cannot demote the last Owner of the workspace."}
```

### Display-only fields (`sso`, `two_fa`)

Member list responses include `sso: false` and `two_fa: false` in the community
edition. These fields report *governed* SSO and two-factor **enforcement** —
whether a member is provisioned and policy-controlled from a directory of record
— which is an Enterprise feature; the fields are placeholders and carry no
functional meaning in OSS.

They do **not** describe basic login federation. Pointing TruePPM at your own
identity provider so your team logs in via OIDC / OAuth2 ships in the OSS core at
0.4 — that is login-only federation, not directory governance. For the full
carve-out (log in via your own IdP → OSS; provision/deprovision/govern from a
directory → Enterprise) and a dated comparison against the open-core competition,
see [SSO Is Not an Enterprise Feature](/overview/sso-is-not-enterprise/).

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

### Managing a group

Each group card has a **Manage** button that opens a management panel (a side
drawer on desktop, a bottom sheet on mobile). From there an Admin can:

- **Add or remove members** — pick any workspace member from the searchable list;
  removing a member revokes the access the group conferred on them.
- **Grant or revoke project access** — pick a project, choose the role to confer
  (Viewer, Team Member, Resource Manager, or Project Manager), and grant it; each
  grant shows its conferred role and can be revoked.

Every change takes effect immediately (there is no separate save step) and runs
the project-access cascade described below. Directory (LDAP/AD) sync of group
membership is a TruePPM Enterprise capability.

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

## Demo data (`/settings/demo-data`)

The **Demo data** page (Settings → System → Demo data) lists every sample
program bundled with this instance — the same catalog the **Load demo
data** picker on the Programs page offers — with, for each one, its entity
counts (projects / tasks / resources), file size, and a SHA-256 of the exact
bytes the download serves. A **Download** button lets you read the raw JSON
fixture before trusting it, and a **Load** button builds the sample program
in one click, same as the Programs-page picker. See
[Sample projects & JSON import/export](/getting-started/sample-projects/) for
what each bundled sample contains and the full load/import/export walkthrough,
and [Inspect before you import](/getting-started/try-it/#inspect-before-you-import)
for verifying a download's hash from the command line.

Two of the bundled programs build their data procedurally in Python rather
than from a file — the page says so explicitly rather than letting a reader
believe they have audited every sample once they have checked the
downloadable ones.

### Not admin-gated — on purpose

Unlike every other page under Workspace → Settings, Demo data carries **no**
workspace-admin requirement — any authenticated user can open it, and any
authenticated user can already call the underlying load endpoint (they become
the new program's owner). The reasoning: this page only ever discloses
**public, Apache-2.0-licensed files already committed to the OSS repository**,
so gating the page would block a non-admin from following the demo loader's
own **Inspect files ↗** link — a link any authenticated user can already
see — into a page they suddenly cannot open. The mutation this page exposes
(loading a sample) is gated the same way it always was: by the API's own rate
limit, not by a role check on this page.

### Endpoints

| Method | Path | Access | Notes |
|---|---|---|---|
| `GET` | `/api/v1/programs/samples/` | Any authenticated user | The catalog: key, title, description, size, SHA-256, and entity counts per bundled sample. |
| `GET` | `/api/v1/programs/samples/{key}/download/` | Any authenticated user | The exact bytes of one fixture, rate-limited per account. |
| `POST` | `/api/v1/programs/load-sample/` | Any authenticated user | Builds the sample program; the caller becomes its owner. Rate-limited (six loads per minute per account). |

## Archive / Delete

The **Archive / Delete** section holds the workspace-wide actions that cannot be undone.
Each requires an explicit confirmation before it runs.

### Export all data

Builds a full archive (JSON plus attachments) of everything in the workspace — members,
groups, programs, projects, tasks, baselines, and history. The export runs in the
background and TruePPM emails a download link when it is ready; the link expires after a
few days. Take an export before either of the destructive actions below. See
[Data export](/administration/data-export/).

### Transfer ownership

Hands workspace ownership to another **active** member. The transfer demotes you to
Admin in the same operation, so it is not a way to add a second Owner — a workspace has
exactly one. Only an active member can receive ownership; invited-but-unaccepted users
do not appear in the picker. See [Roles & permissions](/administration/rbac/).

### Delete workspace

Permanently deletes the workspace and **all** of its data: every program, project, task,
baseline, group, and member. This cannot be undone, and every member loses access
immediately. Confirmation requires typing the workspace name exactly.

This is not the same as deleting a project. A deleted *project* passes through
[Trash](/administration/retention/#trashed-projects-are-hard-deleted-after-the-window)
and can be restored inside the retention window; a deleted *workspace* does not.
