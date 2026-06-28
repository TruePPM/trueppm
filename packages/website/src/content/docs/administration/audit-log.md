---
title: Audit log
description: Review the workspace operational audit log — what administration events are recorded, who can read it, and how the OSS log relates to the Enterprise immutable audit trail.
---

:::note[Added in 0.3 (alpha)]
The operational audit log was added in **TruePPM 0.3**, available since the
`0.3.0-alpha.1` pre-release (Jun 28, 2026). 0.3 is an alpha release; the first
beta is planned for 0.4.
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
| `member_removed` | An Owner/Admin deactivates a member | The member | `role` |
| `ownership_transferred` | The Owner transfers workspace ownership | The new owner | `new_owner_user_id` |
| `project_created` | A project is created | The project | — |
| `project_deleted` | A project is deleted (soft or hard) | The project | `mode` (`soft`/`hard`) |
| `workspace_settings_changed` | Workspace General settings are saved | The workspace | `fields` (the names of the fields that changed) |
| `workspace_export_triggered` | A workspace export is started | The export job | — |

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

The endpoint is cursor-paginated (newest first) and supports filtering:

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
