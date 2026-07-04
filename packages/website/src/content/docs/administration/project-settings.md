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
- **Public sharing** and **guest access** — these inherit from the workspace (or the
  project's program) and an Owner/Admin can override them per project. A control with no
  override reads **Inherit (On/Off)**, showing the value that would apply from the parent
  scope. See [Sharing & Access Inheritance](/administration/sharing-and-access/).

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

### Stale-task threshold

A daily background scan nudges the **assignee** of any task that has sat in a
non-terminal status (anything other than *Complete*) longer than the project's
**stale-task threshold** — `stale_task_threshold_days`, default **7 days**. The nudge
lands in the assignee's notification inbox (and, if they opt in, as email) via the
*"When a task you own goes stale"* preference on their personal
[notification settings](/features/settings/project-notifications/). Re-runs dedupe
against the existing unread nudge, so a still-stale task is not notified twice.

The threshold is a board-level setting on the project, editable by a **Project Manager
(Admin)** or **Owner** via `PATCH /api/v1/projects/{id}/` with
`{"stale_task_threshold_days": <1–365>}`. A dedicated settings-page control is planned;
today it is set through the API. Unassigned stale cards are surfaced by the board card's
*stalled* chip rather than a notification, since there is no single owner to nudge.

## Lifecycle

The **Lifecycle** page handles a project's end-of-life:

- **Archive / unarchive** — take a project out of active rotation without deleting it.
- **Transfer ownership** — hand the Owner role to another member.
- **Delete** — remove the project (Owner only). Deleting also removes the project's
  tasks, sprints, risks, and baselines, and the project stops resolving at its URL.
  Deleting a *program* is different: its projects are detached and kept intact rather
  than deleted.

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
