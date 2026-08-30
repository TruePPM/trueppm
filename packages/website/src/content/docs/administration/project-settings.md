---
title: Project Settings
description: Configure a project's identity, membership, board workflow, notifications, and lifecycle from the project settings pages.
documentedFor: "0.4"
---

Every project has a **Settings** area (under `/projects/:id/settings`) where Admins
configure the project's identity, who can access it, how its board works, and its
lifecycle. This page covers the settings that are available today.

:::note[Edition]
Project settings are part of the **Community (OSS)** edition.
:::

Fields carrying jargon, a policy choice, or an inheritance cascade also carry a
circled **ⓘ** contextual-help affordance that explains the setting and deep-links to
the relevant guide. See [In-product help](/administration/workspace-settings/#in-product-help)
for how it behaves.

## What the Start sheet sets at creation

:::note[Ships in 0.4]
The one-screen Start sheet described in this section ships in **TruePPM 0.4**, the
first beta. `v0.3.0-alpha.3`, the latest release, still opens a three-step wizard
(name and description, then schedule dates, then template) with no way-in cards and
no working-calendar field at creation.
:::

The **New project** Start sheet — one screen, no step navigation — collects only
what changes what happens next. It opens with the way in: one choice among three
peer ways to start (Template, Blank, or Import). Below that come the project's own
fields — name, program, and start date — and the **working calendar** sits in the
pinned footer above the actions, where it stays in view however long the template
list gets. Planning model is derived from the way you choose and shown read-only,
never asked for directly.
See [Creating a project under a program](/features/programs/#creating-a-project-under-a-program)
for the full field list and [Project methodology preset](/features/methodology-preset/)
for how the derived line resolves.

Nothing is created until you press the sheet's commit button — which is what the
footer tells you, naming whichever button is on screen (it reads **Create &
import spreadsheet** on the Import way). The sheet does not create a draft as you
type, so closing it leaves no project behind and no notification, webhook, or
rollup sees anything until you commit. Note that it does not preserve your entries
either: there is no autosave today, so a closed sheet starts fresh.

Everything else on this page — default view, board cadence, visibility, the
[default role for new members](/features/settings/project-members/#default-role-for-new-members),
and the sharing, attachment, and Monte Carlo policies — starts on the program or
workspace default (inherited, not copied) and is set here, in project settings,
immediately after creation. There is no create-time "copy settings from another
project" step: a new project always starts on live inheritance from its program
or workspace, which you can override per setting whenever you choose.

## General

The **General** page edits the project's identity:

- **Name**, **description**, and **code**
- **Health** indicator and **visibility**
- **Time zone** and **default view** (which view opens when you enter the project)
- **Public sharing** and **guest access** — these inherit from the workspace (or the
  project's program) and an Owner/Admin can override them per project. A control with no
  override reads **Inherit (On/Off)**, showing the value that would apply from the parent
  scope. See [Sharing & Access Inheritance](/administration/sharing-and-access/).

:::note[Ships in 0.4]
The **Sprint planning** section below — the story picker's "Ready only" default —
ships in **TruePPM 0.4**, the first beta. It is not present in `v0.3.0-alpha.3`,
the latest release.
:::

- **Sprint planning** — whether the [sprint story picker](/features/sprint-backlog/#story-picker)
  starts filtered to Definition-of-Ready stories for this project. Inherits the program or
  workspace default unless you override it here (Scheduler role or above may set it — PO/team
  territory, alongside estimation scale). Advisory only: the picker's own "Show all" toggle
  always reveals a not-ready story, and committing one is never blocked.

Changes are staged and committed with a save bar, so you can review edits before
applying them. The **General** page also carries the project's **Working calendar**
override, which inherits the program or workspace default unless you set one — see
[Working calendars](/administration/working-calendars/).

## Access

The **Access** page manages project membership using the 5-role model (Owner, Admin,
Scheduler, Member, Viewer). From here you can invite members, change a member's role,
and remove members. Inviting is restricted to the project **Owner**. See
[Roles & Permissions](/administration/rbac/) for what each role can do.

The page also sets the **default role for new members** — the role someone receives when
added without one chosen, overridable per person at any time — and the project's
**mention groups**, custom `@groups` that notify a curated set of project members from a
comment. See [Project members](/features/settings/project-members/).

## How this team works

**Methodology**, **Workflow & fields** and **Sprint guardrails** are one section in
the settings rail — *How this team works* — not three. They are one decision: the
planning model a team uses, the stages its work moves through, and the rules it
holds itself to. Splitting them across the rail meant a delivery lead standing a
team up had to find all three before they could see the shape of what they had
configured.

:::note[Ships in 0.4]
The consolidation ships in **TruePPM 0.4**, the first beta. On `v0.3.0-alpha.3`,
the latest release, these are three separate rail rows — **Methodology** and
**Workflow & fields** under Setup and Configuration respectively, and **Sprint
guardrails** below them.
:::

The section opens with a plain restatement of the preset — what this team runs, and
how its work is paced — followed by a jump strip to the three blocks below, in
order:

| Block | What it sets | Detail |
| --- | --- | --- |
| Methodology | The planning model, and which surfaces lead | [Methodology](#methodology) |
| Workflow & fields | Board cadence, phases, statuses and their lanes and WIP limits, custom fields | [Workflow & fields](#workflow--fields) |
| Sprint guardrails | Which composition mistakes warn and which the Owner blocks | [Sprint guardrails](#sprint-guardrails) |

Board columns appear here as the **Statuses** list, with each column's WIP limit and
its lane expander — the same editor described under
[Workflow & fields](#workflow--fields). There is no second column editor.

**The preset communicates; it does not enforce.** It decides which planning
surfaces a project *leads with* — the ones it leaves out are hidden, not
withdrawn, and changing the preset brings them straight back. Note that
[Surfaces](#surfaces) is a different control: it toggles the four optional
surfaces (Reports, Time tracking, Baselines, the Monte-Carlo forecast), not Board
/ Schedule / Sprints.

Two things on this page *can* stop an action, and neither is the preset:

- **[Sprint guardrails](#sprint-guardrails)** — a project Owner may escalate a
  composition rule from **Warn** to **Block**, and a Block has no override. That
  is a deliberate, Owner-only, per-rule decision, which is the opposite of a
  preset silently deciding for a team.
- **A phase committed to a sprint** is rejected unconditionally by the API — a
  data-integrity rule, not a preset consequence. See
  [Sprint guardrails](#sprint-guardrails).

Everything else here configures what a team *does*, not what it may do.

### Old settings links keep working

The three addresses these sections used to answer on still resolve, in both forms:

| Old address | Now resolves to |
| --- | --- |
| `/projects/:id/settings/methodology` | `/projects/:id/settings#how-this-team-works` |
| `/projects/:id/settings/workflow` | `/projects/:id/settings#how-this-team-works` |
| `/projects/:id/settings/guardrails` | `/projects/:id/settings#how-this-team-works` |
| `/projects/:id/settings#methodology` | `/projects/:id/settings#how-this-team-works` |
| `/projects/:id/settings#workflow` | `/projects/:id/settings#how-this-team-works` |
| `/projects/:id/settings#guardrails` | `/projects/:id/settings#how-this-team-works` |

The address in the bar becomes the section's, but the page scrolls to the **block**
the old link named — `…#guardrails` still lands on the guardrail matrix, not on the
top of a section three blocks tall. A settings URL in a runbook, a bookmark, or a
link someone mailed a colleague does not break, and does not land short, because
the navigation was tidied.

## Methodology

A block within [How this team works](#how-this-team-works).

The **Methodology** block picks the project's planning methodology (its delivery model).
The choice drives which planning surfaces appear — Board, Schedule, Sprints — so a
predictive project does not carry sprint chrome it never uses, and an agile one does not
lead with a Gantt. See [Methodology preset](/features/methodology-preset/).

Surfaces switched off by the methodology can still be re-enabled individually on
[Surfaces](#surfaces); the methodology sets the default, not a hard limit.

## Team

The **Team** page assigns facilitation and ownership. Roles control who can manage the
team; **facets** separately mark the Scrum Master and Product Owner. The two are
independent — a Scrum Master is not required to be a project Admin, and marking someone
as Product Owner grants no extra permission by itself. See
[Project team](/features/settings/project-team/).

The page appears only for methodologies that have a team ceremony model; a purely
predictive project does not show it.

## Workflow & fields

A block within [How this team works](#how-this-team-works).

The **Workflow & fields** block configures how the board behaves for this project:

- **Board columns** — the column configuration the board renders.
- **Custom fields** — define task custom fields (add, edit, remove) that appear on
  cards and task detail.

:::note[Ships in 0.4]
Named lanes land in **0.4**. On `0.3.0-alpha.3` the **Statuses** list has exactly the
five canonical columns and no **Lanes** control.
:::

Each status row carries a **Lanes** expander. Adding a lane splits that one column into
named tracks on the board — Review into *Peer review* and *QA*, say — up to six per
column. Requires the **Resource Manager** role or above, the same gate as the rest of
the board column configuration.

A lane is a board-presentation split, not a sixth status: a card in the QA lane still
carries `status = REVIEW`, so burndown, throughput rollups, MS Project export and every
API integration are unaffected. Lane names must be unique across the whole project.
Removing a lane never deletes or hides a card — anything left in it reappears in the
column's first lane.

## Labels

The **Labels** page manages the project's colored labels. A label categorizes tasks
across the board and the schedule independently of status, sprint, or WBS position, so
it is the right tool for a cross-cutting concern ("needs design", "customer-committed")
that does not fit the workflow columns. See [Labels](/features/labels/).

## Working calendars

The **Working calendars** page manages the calendars this project can schedule against —
working days, working hours, and holiday exceptions. The calendar a task uses determines
how CPM converts a duration into dates, so a change here moves dates. The project
inherits the program or workspace calendar unless it defines its own. See
[Working calendars](/administration/working-calendars/).

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

### Project end-date shift threshold

When a schedule recompute moves the project's overall finish date by more than the
project's **end-date shift threshold** — `end_date_shift_threshold_days`, default
**5 days** — the project's **Project Manager (Admin)** and **Owner** members are
notified. The comparison is against the project's most recently recorded forecast
snapshot (a background record of the project's schedule finish over time, captured on
every recompute), so a slip is reported once, not once per recompute — a recompute
that leaves the finish unchanged produces no repeat notification. Notifies only
PM/Owner-role members; Scheduler, Member, and Viewer roles do not receive this digest.

The threshold is a board-level setting on the project, editable by a **Project Manager
(Admin)** or **Owner** via `PATCH /api/v1/projects/{id}/` with
`{"end_date_shift_threshold_days": <1–365>}`. A dedicated settings-page control is
planned; today it is set through the API, the same way as the stale-task threshold
above.

## Lifecycle

The **Lifecycle** page handles a project's end-of-life:

- **Archive / unarchive** — take a project out of active rotation without deleting it.
- **Transfer ownership** — hand the Owner role to another member.
- **Delete** — remove the project (Owner only). Deleting also removes the project's
  tasks, sprints, risks, and baselines, and the project stops resolving at its URL.
  Deleting a *program* is different: its projects are detached and kept intact rather
  than deleted.

## Sprint guardrails

A block within [How this team works](#how-this-team-works).

The **Sprint guardrails** block configures the per-project guardrail policy as a
rule-by-rule matrix: each sprint/phase composition rule is either **Warn**
(default — the team sees a warning and may override) or **Block** (no override).
Only the project **Owner** may escalate a composition rule to Block — sprint
composition stays team-owned. The `subtasks_split` rule is advisory-only and
cannot be escalated. When the policy was supplied externally (an Enterprise
resolver), the page shows a banner naming who set it, and composition Blocks
stay inert until the team toggles acknowledgement.

**Phase in a sprint is a hard block, not a policy toggle.** Committing a *phase*
— a task that rolls up one or more real child tasks — to a sprint always double-counts
velocity, so it is rejected unconditionally regardless of this policy: the API returns
`400` with the stable error code `phase_in_sprint_forbidden`, and the sprint picker does
not offer a phase as a target. This block is not owner-escalatable and cannot be relaxed
to Warn. The `phase_in_sprint` matrix row therefore has no effect on phases; the softer
Warn/Block matrix still governs the summary, out-of-window, and recurring rules. Assign the
tasks *inside* the phase to the sprint instead. (A leaf task decomposed into drawer
subtasks is not a phase and remains a legitimate, warn-only `summary_in_sprint` case.)

## Signal privacy

The **Signal privacy** page controls how far each team signal — the health and flow
readings the team generates — may travel. The team owns the ceiling; a Scrum Master
moves the dial below it but cannot raise it past what the team set. The page appears
only for methodologies that produce team signals. See
[Signal privacy](/features/settings/signal-privacy/).

## Attachments

The **Attachments** page controls whether task file uploads are allowed on this project
and which file types are accepted. It inherits the program or workspace policy unless
you override it here. External links are always allowed regardless of the policy — the
setting governs uploaded files, not references. See
[Attachment policy](/administration/attachment-policy/).

## Surfaces

The **Surfaces** page turns optional surfaces on or off for this project. Each inherits a
default from the project's [methodology](#methodology) unless overridden here.

Hiding a surface removes its chrome only — **the data stays computed and reachable by
direct link.** Turning off the Schedule surface does not stop CPM from running or make
the schedule private; it removes the navigation entry. Treat this as decluttering, not
as an access control. Use [Access](#access) for permissions and [Sharing](#sharing) for
external exposure.

## Sharing

The **Sharing** page generates public, read-only links to this project's schedule or
board. Anyone holding a link can view it with no login, so a link is a credential —
revoke it here when it should stop working. Whether this page is available at all
depends on the workspace (or program) public-sharing policy, which an Owner or Admin may
override per project. See [Sharing & access](/administration/sharing-and-access/).

## Integrations

The **Integrations** page manages this project's outbound webhooks and inbound API
tokens: add, edit, test, and delete webhooks (with a format picker and delivery log),
and mint and revoke API tokens. Per-user credentials are not configured here — those
live under User → Connected Accounts.

See [Webhooks](/features/webhooks/),
[Personal access tokens](/features/personal-access-tokens/), and
[Git-event automation](/administration/git-event-automation/). A program-scoped
equivalent, firing across every project in a program, is documented at
[Program settings → Integrations](/administration/program-settings/#integrations).

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
