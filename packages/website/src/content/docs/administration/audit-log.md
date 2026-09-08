---
title: Audit log
description: Review the workspace operational audit log — what administration events are recorded, who can read it, and how the OSS log relates to the Enterprise immutable audit trail.
documentedFor: "0.4"
---

:::note[Added in 0.3 (alpha)]
The operational audit log was added in **TruePPM 0.3**, available since the
`0.3.0-alpha.1` pre-release (Jun 28, 2026). 0.3 is an alpha release; the first
beta is planned for 0.4.
:::

:::note[Ships in 0.4]
Several things on this page ship in **0.4** and are not in the latest release
(`v0.3.0-alpha.3`):

- the three **invite** event types (`invite_sent`, `invite_accepted`,
  `invite_revoked`) and the `?status=` filter on the invite list — on 0.3 the log
  records no invite verb, and an invite disappears from the Members page the
  moment it is accepted or revoked;
- the five **SSO** event types (`sso_provider_created`, `sso_provider_updated`,
  `sso_provider_deleted`, `sso_secret_rotated`, `sso_account_linked`) and the
  `auth.login_succeeded` log line — on 0.3 there is no single sign-on at all;
- the `role` key on `member_added` rows written by an SSO join.

Everything else on this page describes 0.3.
:::

The **operational audit log** is a chronological record of who changed what in
your workspace administration. It answers questions like "who removed this
member?", "when was that project deleted?", and "who last changed the workspace
settings?" (#859, ADR-0157).

It is **Owner/Admin-visible only**. A plain Member cannot read the log — the
events it records (role changes, removals, ownership transfers) are
administration concerns, not team-visible activity.

## What is recorded

Every entry captures an actor, an event type, an optional target, and a
structured `metadata` object. The following workspace administration events are
recorded:

| Event type | When it fires | Target | Metadata |
|---|---|---|---|
| `member_added` | A user accepts an invite and joins the workspace | The new member | `role`, `source` |
| `member_role_changed` | An Owner/Admin changes a member's workspace role | The member | `old_role`, `new_role` |
| `member_status_changed` | An Owner/Admin deactivates or reactivates a member | The member | `old_status`, `new_status`, `credentials_revoked` |
| `member_removed` | An Owner/Admin removes a member from the workspace | The member | `role` |
| `ownership_transferred` | The Owner transfers workspace ownership | The new owner | `new_owner_user_id` |
| `project_created` | A project is created | The project | — |
| `project_deleted` | A project is deleted (soft or hard) | The project | `mode` (`soft`/`hard`) |
| `project_restored` | A soft-deleted project is restored from Trash | The project | — |
| `template_published` | A project is published as a workspace template | The template | — |
| `workspace_settings_changed` | Workspace General settings are saved | The workspace | `fields` (the names of the fields that changed) |
| `workspace_export_triggered` | A workspace export is started | The export job | — |
| `invite_sent` *(0.4)* | An Owner/Admin invites an email address | The invite | `role` |
| `invite_accepted` *(0.4)* | An invited person joins the workspace | The invite | `role`, `invited_by`, `invited_by_id`, `invited_at` |
| `invite_revoked` *(0.4)* | An Owner/Admin revokes a pending invite | The invite | `role`, `invited_by` |
| `calendar_changed` | A shared working-time calendar is edited | The calendar | `fields` |
| `sso_provider_created` *(0.4)* | An Admin adds a single sign-on provider | The provider | `config`, `secret_set`, `actor_kind` |
| `sso_provider_updated` *(0.4)* | An Admin changes a provider's configuration | The provider | `changed` (per-field before/after), `actor_kind` |
| `sso_provider_deleted` *(0.4)* | An Admin removes a provider | The provider | `linked_accounts`, `locked_out_accounts`, `confirmed_lockout`, `config`, `actor_kind` |
| `sso_secret_rotated` *(0.4)* | An Admin supplies a new client secret for a provider | The provider | `actor_kind` |
| `sso_account_linked` *(0.4)* | A single sign-on identity binds to an **existing** local account | The user | `via`, `provider`, `issuer`, `subject`, `role` |

:::note[Why `invite_accepted` exists alongside `member_added`]
They look redundant and are not. The invite-accept endpoint is **unauthenticated** —
the token in the link is the credential, and the invitee provisions their own
account — so the `member_added` row's actor is the **person joining**. It can say
*"X joined via invite"* and never who sent it.

`invite_accepted` carries the inviter, denormalized to a label as well as an id so
the answer survives the inviter's own off-boarding. If you are auditing account
provisioning, this is the row that answers *who let them in* (#2911).
:::

:::caution[Deactivation is irreversible for credentials]
Deactivating a member revokes their refresh tokens and Personal Access Tokens,
and that revocation is **durable** — reactivating the account does not restore
them, and a returning member mints new ones. `member_status_changed` records
`credentials_revoked: true` on the deactivation so the log answers the question a
later support conversation will actually ask: *the account is enabled again, so
why is their integration still 401-ing?*
:::

On a soft delete, the project's members also receive an in-app
[project-delete notification](/features/task-collaboration/#project-delete-notification)
so a project never simply vanishes from under the team.

## Auth events: some are rows, login success is a log line

Single sign-on administration is recorded as **audit rows**; a successful **login** is
recorded as a **log line** on the `trueppm.auth` logger. The split is deliberate
(ADR-1120), and knowing which is which is the difference between finding an event and
concluding it never happened.

| Question | Where to look |
|---|---|
| Who widened the allowed email domains, and to what? | `?event_type=sso_provider_updated` |
| Who rotated the client secret, and when? | `?event_type=sso_secret_rotated` |
| Which accounts got a federated credential? | `?event_type=sso_account_linked` |
| Who signed in, from where, just now? | `trueppm.auth` in your log pipeline |
| Who *failed* to sign in? | `trueppm.auth` (`auth.login_failed`, since 0.3) |

Login success is not a row because its rate is set by user traffic rather than by
administrative action, and the community audit table has no retention or pruning (see
[Retention](#retention)) — a verb that fires per login would grow that table without
bound. It also has no before and after to record. Both auth log lines therefore land on
one logger, so an operator correlating "somebody was hammering this account, did they get
in?" reads one channel:

```
auth.login_failed username_hash=<sha256> client_ip=<ip>
auth.login_succeeded user_id=<id> method=password|sso:<provider> client_ip=<ip> remember=<bool>
```

The success line is emitted at **INFO**, so it requires `DJANGO_LOG_LEVEL=INFO` — which is
the default. It carries the user **id**, never the email or username; the failure line
hashes the submitted identifier for the same reason.

:::caution[Successful logins put a client IP in your logs]
Before 0.4 `trueppm.auth` recorded a client IP only for *failed* sign-ins.
`auth.login_succeeded` attaches one to every successful session. That is personal data
in a stream TruePPM does not own — it goes to your log pipeline, and TruePPM cannot
prune it, redact it, or honor an erasure request against it. Set your retention on that
pipeline accordingly.

As with the failure line, `client_ip` is best-effort: it prefers the left-most
`X-Forwarded-For` hop and is spoofable behind a proxy that does not normalize that
header. It is for correlation, never for a security decision.
:::

:::note[Why a refused login is never an audit row]
Every write on this page happens on a path that **succeeded**. That is not incidental.
Every API request runs inside a transaction, and a refusal (`400`, `403`, `409`) rolls
that transaction back — so an audit row written while refusing a request is issued and
then silently discarded. Refusals are therefore recorded as log lines, where no
transaction can take them back. If you are looking for evidence of a *rejected* action,
look in `trueppm.auth` (or `trueppm.sso` for single sign-on), not in the audit log.
:::

:::caution[The log records field names, not values]
`workspace_settings_changed` records **which** settings changed (the field
names), never the values. This keeps the log free of large or sensitive payloads
(for example, branding blobs). To see the current values, read the
[workspace settings](/administration/workspace-settings/).
:::

### The actor is denormalized

Each entry stores a human-readable `actor_label` (the actor's name or email) at
the moment the event is recorded, in addition to a nullable foreign key to the
user. If the user is later deleted, the foreign key becomes `null` but the label
remains — the log stays readable. System-initiated events have a blank label and
no actor.

## Reading the log

```
GET /api/v1/workspace/audit-events/
```

The endpoint is cursor-paginated (newest first). The response is an **object**,
not a bare array — and unlike the page-number
[envelope](/api/reference/#pagination) used elsewhere it carries no `count`,
because a cursor never computes one:

```json
{"next": "…?cursor=cD0yMDI2…", "previous": null, "results": [ … ]}
```

Follow `next` until it is `null`. It supports filtering:

| Query parameter | Description |
|---|---|
| `event_type` | One of the event types above. Unknown values return `400`. |
| `actor` | A user id. Returns only events performed by that user. |
| `since` | ISO 8601 date or datetime. Returns events at or after this time. |
| `until` | ISO 8601 date or datetime. Returns events at or before this time. |
| `page_size` | Page size (default 50, maximum 200). |

### Access

- **Owners and Admins** can read the log.
- **Members, Schedulers, Viewers, and unauthenticated callers** receive `403`
  (or `401` when not signed in).

## Retention

The community edition applies **no retention or pruning** — entries accumulate
for the life of the deployment. They are stored in a single indexed table and
cursor-paginated, so read performance does not degrade as the log grows, but the
table itself is unbounded. Operators who need a retention policy should plan for
table growth or upgrade to the Enterprise edition.

## OSS vs. Enterprise

The community log is **mutable and operational** — a convenience record for
day-to-day workspace administration. It makes **no immutability, signing, or
tamper-evidence guarantees**.

The Enterprise edition layers a **compliance-grade, immutable, signed audit
trail** on top of the same events, with retention policy, cross-workspace
aggregation, and SOC 2-aligned export. It does this by registering a receiver
against the OSS `audit_event_created` signal — the community core never imports
Enterprise code. If you need a defensible audit trail for compliance, that is an
Enterprise capability.
