---
title: Project Settings
description: Configure a project's identity, membership, board workflow, notifications, and lifecycle from the project settings pages.
---

Every project has a **Settings** area (under `/projects/:id/settings`) where Admins
configure the project's identity, who can access it, how its board works, and its
lifecycle. This page covers the settings that are available today.

:::note[Edition]
Project settings are part of the **Community (OSS)** edition.
:::

## General

The **General** page edits the project's identity:

- **Name**, **description**, and **code**
- **Health** indicator and **visibility**
- **Time zone** and **default view** (which view opens when you enter the project)

Changes are staged and committed with a save bar, so you can review edits before
applying them. (A calendar picker on this page is planned; calendars are managed
separately for now — see [Calendars](/features/calendars/).)

## Access

The **Access** page manages project membership using the 5-role model (Owner, Admin,
Scheduler, Member, Viewer). From here you can invite members, change a member's role,
and remove members. Inviting is restricted to the project **Owner**. See
[Roles & Permissions](/administration/rbac/) for what each role can do.

## Workflow & fields

The **Workflow & fields** page configures how the board behaves for this project:

- **Board columns** — the column configuration the board renders.
- **Custom fields** — define task custom fields (add, edit, remove) that appear on
  cards and task detail.

## Notifications

The **Notifications** page sets **per-member notification preferences** — each member
controls which project events notify them. Preferences are stored per membership, not
as a single project-wide switch.

## Lifecycle

The **Lifecycle** page handles a project's end-of-life:

- **Archive / unarchive** — take a project out of active rotation without deleting it.
- **Transfer ownership** — hand the Owner role to another member.
- **Delete** — permanently remove the project (Owner only).

The **Integrations** page provides full management of outbound webhooks and
inbound API tokens — add, edit, test, and delete webhooks (with a format picker
and delivery log) and mint and revoke API tokens. See [Webhooks](/features/webhooks/) and
[Inbound task sync](/features/inbound-task-sync/) for details.

## Sprint guardrails

The **Sprint guardrails** page configures the per-project guardrail policy as a
rule-by-rule matrix: each sprint/phase composition rule is either **Warn**
(default — the team sees a warning and may override) or **Block** (no override).
Only the project **Owner** may escalate a composition rule to Block — sprint
composition stays team-owned. The `subtasks_split` rule is advisory-only and
cannot be escalated. When the policy was supplied externally (an Enterprise
resolver), the page shows a banner naming who set it, and composition Blocks
stay inert until the team toggles acknowledgement.

## Not yet available

One page exists in the UI but is not yet functional:

- **Methodology** — agile defaults (sprint length, story-point scale, velocity
  lookback) are planned.

## Backing API

The functional pages map to these endpoints:

| Page | Endpoint(s) |
|------|-------------|
| General | `PATCH /api/v1/projects/{id}/` |
| Access | `GET`/`POST`/`PATCH`/`DELETE /api/v1/projects/{id}/members/…` |
| Workflow & fields | `GET`/`PUT /api/v1/projects/{id}/board-config/`, `…/custom-fields/…` |
| Lifecycle | `POST /api/v1/projects/{id}/archive/`, `…/unarchive/`, `…/transfer/`, `DELETE /api/v1/projects/{id}/` |
| Integrations | `GET`/`POST`/`PATCH`/`DELETE /api/v1/projects/{id}/webhooks/…`, `…/api-tokens/…` |
| Sprint guardrails | `GET`/`PATCH /api/v1/projects/{id}/guardrail-policy/` |
