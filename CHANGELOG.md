# Changelog

All notable changes to TruePPM are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

TruePPM is pre-1.0. The 0.1, 0.2, and upcoming 0.3 milestones are all **alpha**
releases — `0.1.0-alpha.1`, `0.2.0-alpha.1`, and the in-flight `0.3.0-alpha.1` —
on the road to the first stable release at 1.0. The release line stays alpha
through 0.3; 0.4 is planned as the first beta. Each release below opens with its
**main part** — the headline change — followed by the detailed entries.

## [Unreleased]

**The upcoming 0.3 alpha (`0.3.0-alpha.1`, “the agile team”) is in progress.**
Main part: making sprints and agile delivery first-class on top of the CPM
schedule. It will ship a real sprint container (goal, capacity, burndown) with
state-aware planning and closed views, auto-computed velocity with a forecast
range, sprint sovereignty (audited mid-sprint scope changes; velocity stays a
team metric, never an auto-exposed management gauge), the sprint-to-milestone
bridge, agile depth (task-type taxonomy, epic/initiative hierarchy, dual
backlog, Product Owner role, acceptance criteria), the hybrid
governance/delivery-mode foundation, universal JSON sample-data import/export,
and the v2 navy/sage interface refresh (epic #1163).

Entries accumulate as fragment files under [`changelog.d/`](changelog.d/) and are
assembled into this section, then dated, when `0.3.0-alpha.1` is tagged. See the
[roadmap](packages/website/src/content/docs/overview/roadmap.md) for the
in-flight scope.

## [0.2.0-alpha.1] — 2026-05-31

**Main part: the settings & administration platform.** A broad consolidation
alpha — the settings/administration platform, program foundations, board and
schedule depth, task collaboration, the hybrid bridge, and the first
import/export migration path. Published to PyPI as `trueppm-scheduler` 0.2.0a1.

### Added

- ADR-0065: Hybrid Bridge v1.1 — design for CPM velocity feedback (auto-suggest `most_likely_duration` from sprint velocity), "My Work" contributor surface (`GET /me/work/`), and inbound task-sync protocol (`POST /projects/{id}/task-sync/`). Tracking issues #498 #499 #500.
- **Task collaboration UI** (#310 #311): in-drawer attachments grid with drag-drop upload and external-link pin; comment thread with composer, `@mention` autocomplete (individuals + auto-groups), 10 000-char limit, and 15-minute edit window; ✅ acknowledgement and 👍 reaction affordances; mention rate-limit error surfacing. New TopBar notification bell with unread badge and slide-out panel; `/me/notifications` route for the full inbox; `/me/settings/notifications/` for the per-(event, channel) preference matrix (auto-saved 300 ms after each toggle). 30-second polling for unread count, paused while the tab is hidden. Feature documentation at `/features/task-collaboration` (ADR-0075).
- **Task collaboration** (#310 #311): task comments with threaded replies (one level), @mention fan-out to project members, emoji reactions, file and external-URL attachments, and per-user notification preferences. Mentions are parsed server-side (code-fence and escape-aware); notifications are created transactionally via bulk_create. Rate-limited to 1 000 mentions/day + 100/hour per user (ADR-0075).
- Schedule view: a CPM cascade now slides collaborators' Gantt bars in real time. After a recalculation the server broadcasts a batched `task_dates_updated` WebSocket event with the moved tasks' dates, and the web client splices them straight into its cache instead of re-fetching every task — so a teammate's edit moves your bars instantly, not on the next poll. See ADR-0091.
- Schedule view: promote a backlog idea onto the timeline in one move. The Unscheduled gutter now has a **Backlog** section below the To Do section — drag a backlog chip onto the timeline and it's promoted to To Do, scheduled at the drop date, and cascaded through CPM. For keyboard users, a **Schedule…** action (on the gutter chip and on Board backlog cards) opens a date picker that does the same. Backlog chips are marked with a dashed edge and readiness label so it's clear a drop promotes them.
- Name EditableCell in build mode now shows an inline autocomplete dropdown (up to 6 suggestions: milestones first, then other task names) that filters as the user types and supports keyboard navigation.
- The Gantt timeline shows a dashed amber ghost bar spanning today + 5 days whenever a task name cell is in edit mode in build mode, giving immediate positional feedback before the scheduler runs.
- Clicking the start date of a milestone row in build mode opens a 220px quick-pick popover with parent-phase chips, an active-sprint end-date chip, and a custom date input.
- After committing a task name in build mode, projects with `agile_features=true` now show a numbered sprint-assignment prompt (current sprint · next sprint · Backlog · Esc later) with keyboard shortcuts 1–3.
- Build mode adds Option+↑/↓ (Mac) / Alt+↑/↓ (Windows/Linux) keyboard reorder among same-level siblings and a ⋮⋮ drag handle (visible on row hover) for pointer-based row reordering, both backed by the existing reorder API. The drag handle tooltip shows the correct modifier key label for the current OS.
- Schedule view: continuous zoom. Zoom smoothly between hour-level detail and a multi-year overview with Ctrl/Cmd+wheel or trackpad pinch (cursor-anchored — the date under your pointer stays put), the toolbar `−`/`+` stepper, or `⌘/Ctrl` with `=`, `-`, and `0` (fit to project). The two-row date header auto-swaps its emphasized tier (day → week → month → quarter → year) as you zoom.
- **Progress-anchor gate**: `PATCH /tasks/{id}/` now returns `400 {"code": "progress_requires_anchor"}` when `percent_complete > 0` is submitted but the task has neither a `planned_start` date nor a sprint assignment. ADMIN+ users are exempt. Prevents "ghost progress" on unscheduled tasks.
- **Auto-promote on first progress**: setting `percent_complete` from 0 to any value between 1–99 on a `NOT_STARTED` task automatically transitions it to `IN_PROGRESS` and sets `actual_start` to today. Team Member+ role required; Viewers are excluded. Skipped when `status` is explicitly included in the payload.
- **Sprint cross-project ownership**: assigning a sprint that belongs to a different project is now rejected with a `400 {"sprint": "Sprint does not belong to this project."}` validation error.
- **MS Project import**: tasks imported from `.mpp` files with `PercentComplete > 0` but no start date are now clamped to `percent_complete = 0` to preserve the progress-anchor invariant.
- Sprint→milestone rollup (ADR-0074): when sprints are linked to a Gantt milestone via `Sprint.target_milestone`, the milestone's `percent_complete` now rolls up live from sprint state and the milestone is read-only against manual writes; the SprintsView "Advancing to milestone" card and the Gantt now show the same number, plus a +Nd / -Nd "sprint plan" variance chip and a scope-changed indicator. Aggregated only — no per-assignee or raw point counts in the WebSocket broadcast (Morgan VoC guardrail).
- Community and documentation: SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md at repo root; README maintainer block and roadmap links; About/Maintainers page on the docs site (MacroDream context, accurate background, Visiban reference); landing page now leads with a quickstart code block and tech-stack strip; roadmap feature pages tagged with target-release caution notices (closes #458, #459, #460, #461, #462, #463, #471).
- **Schedule legend overlay**: a floating legend on the Gantt canvas explains the
  nine visual elements of the schedule — bar variants (summary rollup, task progress
  fill, complete), state markers (critical path, milestone, today line), and lines
  and arrows (planned baseline, finish-to-start, merged-trunk convergence). Visible
  by default, collapsible to a header chip, persisted per browser via localStorage.
  Hidden below the `lg` (1024px) breakpoint so it never obscures the first task row
  on narrow viewports. Architecture: ADR-0064.
- **Schedule canvas — hover to reveal dependency chain** (#475): hovering any task row, bar, or milestone highlights the full predecessor chain in blue and successor chain in green; non-chain rows and arrows dim to 25% / 20% opacity. Works on the task list panel and the canvas timeline; coalesced through `requestAnimationFrame`. Desktop-only (`hidden lg:block`).
- **Schedule canvas — right-click context menu expansion** (#477): adds **Mark complete** (Space toggle on the focused row, optimistic, label flips to *Unmark complete* on COMPLETE rows), **Add predecessor…** / **Add successor…** (lightweight search-driven `ScheduleDependencyPicker` modal with inline cycle-error display), and **Duplicate** (⌘D / Ctrl+D — clones name/duration/parent/sprint with a `(copy)` suffix, never clones dependencies). Sprint-aware: duplicating into an ACTIVE sprint surfaces a transient *"Added to Sprint X · Undo"* toast (ADR-0066 Q2).
- **Behavior change**: Space on a focused schedule row now toggles Mark complete; Enter still opens the task drawer. Previously both Enter and Space toggled the drawer (redundant). Cheatsheet (`?`) updated with the new bindings.
- **Architecture**: ADR-0066 documents the bundle's nine resolution questions (frontend-only Duplicate via existing `POST /tasks/`, optimistic Mark complete via `useToggleComplete`, hover BFS over a precomputed adjacency map, etc.). New `GanttEngine.setHoverChain` API; new `task-hover` event from the canvas; new React hook `useDependencyHover`.
- OSS publish pipeline: `trueppm-api` (PyPI wheel) and `@trueppm/web` (npm) are now built and published as versioned, installable artifacts on each `v*` release tag, alongside the existing Docker image and Helm chart jobs. This makes the full community edition pin-installable from public registries (`pip install trueppm-api==<version>`, `npm install @trueppm/web@<version>`). The web package is now scoped as `@trueppm/web`.
- Sprint planning capacity field (`Sprint.capacity_points`) and Board view sprint panel — surfaces the active sprint goal, dates, burndown chart, velocity sparkline, and planned-vs-committed capacity directly above the Board lanes. SCHEDULER+ users can edit the planning target inline; viewers see a read-only summary. Hidden entirely on WATERFALL projects. (ADR-0073, #482)
- Retrospective action items now promote to the project backlog via an explicit
"Promote to backlog" button per item, never auto-assigned to the next sprint
(ADR-0071). Adds the `RetroVisibility` field on `SprintRetro` for team-only /
project / org content sharing, a `TaskSuggestedAssignee` model that surfaces
soft assignment suggestions on My Work, and a "From last retro" carryover
lane on the Sprint Backlog for PLANNED sprints. `SprintRetro` and
`RetroActionItem` now extend `VersionedModel` so retros participate in
WatermelonDB mobile sync. New endpoints: `POST .../retrospective/action-items/{id}/promote/`,
`POST .../retrospective/action-items/{id}/pull-to-sprint/`,
`GET .../retrospective/prior/`, `GET /projects/{id}/retrospective/carryover/`,
and `POST /tasks/{id}/suggestions/{id}/{accept,decline,revoke}/`. The legacy
`POST .../retro/` `promote=true` flag is silently ignored — sprint sovereignty
is now enforced structurally per ADR-0069.
- Schedule view: drag-to-pan the timeline. Hold Space and drag, or drag with the middle mouse button, to pan the Gantt on both axes — the cursor shows a grab/grabbing hand and task-bar dragging is suspended while panning. A hint in the schedule legend documents the gesture.
- **Schedule canvas pull-to-commit gate** (#492, ADR-0067): drag and resize on a
  task bar no longer commit the change on pointerup. After the gesture, a
  Confirm/Cancel popover anchors above the new bar position. Esc, Cancel, and
  click-outside revert without writing; Confirm fires the PATCH. The popover
  surfaces a "Committed in Sprint *name*" notice when the task is in an ACTIVE
  sprint so a PM cannot quietly retime sprint-committed work. Audit trail is
  unchanged — every confirmed change continues to flow through the existing
  django-simple-history record (ADR-0011) and appears in the Task drawer's
  History tab.
- **Velocity calibration on sprint close** (ADR-0065 gap 1, #498). When a sprint closes, TruePPM now computes the team's rolling six-sprint velocity and, for each task in the closing sprint with story points set, generates a non-destructive `VelocitySuggestion` recommending a new `most_likely_duration`. The PM accepts or dismisses the suggestion from the Task Detail Drawer's Estimates section; the underlying value is never overwritten without consent. Suggestions require ≥3 prior completed sprints, respect the project's `estimation_mode`, and are auditable per (task, sprint).

- New endpoints: `GET /api/v1/velocity-suggestions/`, `POST .../accept/`, `POST .../dismiss/`
- `GET /api/v1/projects/{id}/velocity/` now also returns `team_velocity_per_day`
- New `scheduling.VelocitySuggestion` model with unique (task, sprint) index
- **My Work contributor surface** (#499, ADR-0065 Gap 2). New cross-project endpoint `GET /api/v1/me/work/` returns the authenticated user's assigned tasks across all projects — flat shape, no CPM fields, grouped client-side by active sprint. Companion web page at `/me/work` lists tasks with tap-to-update status chips, distinct empty states for new users vs. unassigned users, and a sidebar entry in a new "Me" section. The `PATCH /api/v1/tasks/{id}/` path now reads an optional `X-Source` request header (lowercase letters and underscores only, max 64 chars, otherwise coerced to `unknown`) and propagates it into the `task.updated` webhook payload so consumers can distinguish a status flip from `/me/work` vs. the schedule canvas. Mobile React Native screen deferred to a follow-up (`packages/mobile/` not yet scaffolded); the endpoint contract is mobile-ready with `LimitOffsetPagination` (default 100, max 200) and a `server_version_high_water` for offline delta sync.
- **Inbound task-sync protocol** (#500, ADR-0068, closes ADR-0065 Gap 3). New project-scoped `POST /api/v1/projects/{id}/task-sync/` endpoint accepts a lightweight authenticated push from Jira, Linear, GitHub Issues, or any custom source. Idempotent upsert by `(project, source, external_id)` on a new `InboundTaskLink` model; default status_map (`todo`/`in_progress`/`done` plus common synonyms) with per-token override; assignee resolved by email with a `pending_assignee_email` fallback that resolves on re-push once the user joins the project; parent attach via `parent_external_id` preserves Jira epic→story hierarchy and is scoped same-source to prevent cross-source downgrade. New `ProjectApiToken` model with `tppm_<64-hex>` token format (SHA-256 hashed at rest, shown once, prefix indexed for audit identification), Admin/PM (role ≥ 3) gated `POST`/`DELETE /api-tokens/` endpoints, and an immutable `status_map` (changes require new-token-plus-revoke so the team sees them via the audit log). Append-only `ApiTokenAuditEntry` model + `GET /api-token-audit/` (member-visible) records every mint/revoke/use with token prefix, actor, source IP, and JSON detail — covers SOC 2 evidence and Morgan's team-visibility concern without building the notifications app. Per-project rate limit: 100 req/min steady state, 1000 req/min for the first 60 minutes after token mint (backfill window for migrating existing data); token-issuance gets a separate 5 req/min per-user limit. Both backed by raw `redis-py` against `settings.REDIS_URL` (no new `django-redis` dependency). Project detail response surfaces `unresolved_assignee_count` (partial-index backed, O(log n)) so PMs have a triage signal. Inbound upserts fire `task_created`/`task_updated` via `broadcast_board_event` + `dispatch_webhooks` + `enqueue_recalculate` on `transaction.on_commit()` — full real-time and CPM integration. Import-only by design: two-way write-back to the external source is Enterprise scope. Sprint-binding from the payload is deferred to a future ADR after the first-class Sprint entity (#482) stabilizes. Documentation at `/features/inbound-task-sync/` covers GitHub Actions, Jira Cloud, and Linear integration patterns plus a chunked-backfill recipe.
- ### Program entity (OSS) — coordinate related projects under one PM (#502, ADR-0070)

A program is a lightweight, named grouping of related projects owned by one PM
or program team. Programs add an OSS coordination layer between standalone
projects and Enterprise portfolio governance — a PM with three to six related
projects can now manage them as one unit with shared membership, a soon-to-ship
shared backlog (#501), and a future combined burndown (0.3).

**New surfaces.** `/programs` lists the programs you belong to.
`/programs/:id` is a tabbed shell with Backlog (stub until #501), Projects,
and Members. The sidebar gains a PROGRAMS section between Me and PROJECTS, and
each project in the sidebar gets a `Program · {name}` badge when grouped.

**Project assignment.** A project can be assigned to a program from the program's
Projects tab. Assignment requires Project Manager role on both sides — the
project's owners and the program's owners both authorize the grouping. Projects
remain fully usable standalone (`program=NULL`) — no existing projects are
migrated.

**Membership.** Program membership is independent of project membership. Adding
someone to a program does not grant them access to its projects, and adding
someone to a project does not put them in the program. The create modal, members
tab, and projects tab each surface a one-line reminder so this is obvious from
the start.

**Delete safety.** Deleting a program cascades atomically — all memberships are
soft-deleted in the same transaction, projects are detached (they become
standalone again), and the program is soft-deleted. The UI requires
type-to-confirm on the program name before the delete button enables.
- Settings UI implementation: workspace, project, and program settings shells with full left-rail navigation, scope switcher, and page content (#509 general/members/groups/roles, #510 methodology, #511 integrations/webhooks, #512 project settings, #513 program settings). Adds `/settings/*`, `/projects/:id/settings/*`, and `/programs/:id/settings/*` routes; wires Settings link into the sidebar Org section.
- **Workspace general settings API**: `GET`/`PATCH /api/v1/workspace/` backs the
  Workspace → General settings page with a singleton config (name, timezone,
  fiscal-year start, work week, default project view, guest and public-sharing
  toggles). Any member can read; workspace Admins can edit. Introduces the
  first-class single-tenant *workspace* entity (ADR-0087).
- **Workspace members & invites API**: list/update/deactivate workspace members
  (`/api/v1/workspace/members/`) with a workspace-level Owner/Admin/Member role
  (separate from project roles) and a last-Owner guard. Email invitations
  (`/api/v1/workspace/invites/`) issue a one-time, hashed token, send via the
  email outbox, and are accepted at a public `POST /workspace/invites/accept/`
  endpoint that provisions or links the account (ADR-0087).
- **Workspace groups & teams API**: full CRUD for workspace groups
  (`/api/v1/workspace/groups/`) with members and a lead. Linking a group to a
  project confers a project role on every member — group/member/role changes
  reconcile `ProjectMembership` rows automatically, and a direct project grant
  always takes precedence over a group-conferred one (ADR-0087).
- **Project settings → General** now persists every field on the page. The
  serializer exposes `code`, `health`, `visibility`, `timezone`, and
  `default_view` alongside the existing `name`, `description`, and
  `calendar`; PATCH `/api/v1/projects/:id/` accepts all of them. The
  General page seeds every field from the API on load, arms the save bar
  on any edit, and submits the consolidated payload in a single PATCH on
  save. `code` is normalized to uppercase client-side and validated
  server-side (uppercase A-Z, digits, and hyphen; ≤12 chars; no leading
  or trailing hyphen). The "pending #520" stub notice on the page is
  removed.
- **Project settings → Workflow & fields** is now wired to real API endpoints.
  Phases (`/api/v1/projects/:id/phases/`) list, add, rename, recolor, and
  drag-to-reorder root WBS tasks; statuses are routed to the existing
  `BoardColumnConfig` endpoint so PMs can relabel, recolor, hide, and reorder
  the five canonical task statuses; custom field definitions
  (`/api/v1/projects/:id/fields/`) support TEXT, NUMBER, DATE, SINGLE_SELECT,
  MULTI_SELECT, USER, and BOOLEAN types with up to 32 fields per project.
  Built-in fields (Phase, Owner, Duration, Risk, Critical-path) are surfaced
  alongside the dynamic custom list. Per-task values for custom fields will
  follow in a 0.3 issue.
- **Project settings → Notifications** is now wired to a real API endpoint.
  `GET/PATCH /api/v1/projects/:id/notification-preferences/` stores the
  per-(project, user) event × channel toggle matrix plus a daily quiet-hours
  window. Channels surfaced: in-app, email, Slack, mobile push. Events
  surfaced: task_assigned, task_overdue, comment_mention, status_change,
  budget_alert, risk_created, milestone_reached, sprint_start, sprint_end.
  The page now optimistically reflects toggle changes and rolls back on API
  error; quiet hours persist on edit. Slack channel routing remains
  configured in Project Settings → Integrations.
- Added `/kaizen` skill for continuous improvement of the development harness. Distinct from `/pre-release` (which audits the codebase), kaizen audits the *process* — agent gate mandates, CI duration, MR cycle-time, override frequency — and files a small ranked list of speed wins against the next minor milestone. Hooked into `/pre-release full` as Step 0.7. Also documents fast-path gate cluster rules in user CLAUDE.md so the pre-MR gate batch (`regression-check`, `security-review`, `rbac-check`, `perf-check`, `broadcast-check`, `migration-check`) runs in parallel. Targets harness speed score 6/10 → 8/10 for 0.2.
- Program Settings → Rollup KPIs is now wired to a real API (`GET|PATCH /api/v1/programs/{id}/rollup-config/`, ADR-0169). Program admins can toggle which of 10 health signals roll up to the program overview (Schedule, Risk, Cost groups) and choose the health aggregation policy (`worst` / `average` / `weighted_by_budget` / `task_weighted`). New programs are seeded methodology-aware defaults (waterfall, agile, or hybrid). All config changes are captured in the existing Program history records for audit.
- Program Settings → Cadence & ceremonies wired to a real API (ADR-0079, #528). Adds program-scoped `CeremonyTemplate` CRUD (`/api/v1/programs/<id>/ceremonies/`) and a singleton `PhaseGateConfig` endpoint (`/api/v1/programs/<id>/phase-gate-config/`). Program admins can configure recurring meeting cadences (weekly / bi-weekly / monthly / on-milestone) and a phase-gate invite template; non-admins see the page read-only. Scrum sprint event names (Sprint Planning, Review, Retrospective, Daily Scrum, Standup) are rejected at the API to keep program-level cadence from absorbing per-sprint events.
- Program Settings → Risk & deps policy is now wired to a real API. The slip-propagation radio (none/warn/block) and the auto-escalation days input (1–30) persist via `GET|PATCH /api/v1/programs/{id}/risk-policy/`; only program admins can edit and every change is audited via the existing program history. The 5×5 risk matrix on the same page remains workspace-scoped and read-only.
- **Project and Program lifecycle actions**: the Project and Program Danger zones
  (`/settings/archive`) are now wired to real API endpoints. Owners can archive /
  unarchive a project, close / reopen a program, transfer ownership or sponsorship,
  and permanently delete with a typed-code confirmation that reads the actual
  project code / program code from the API. Archive marks the project hard
  read-only across all writes (enforced via a new `IsProjectNotArchived` gate on
  every write-capable viewset); close freezes the program shell without
  cascading to its child projects. Hard delete (`DELETE /projects/:id/?force=true`)
  requires the project to already be archived. The `POST /programs/:id/split/`
  endpoint ships as a 501 stub so the UI dialog can render against a stable
  contract while the splitter implementation lands in a follow-up. Workspace
  lifecycle endpoints (transfer-ownership / export / delete) are tracked in #641.
- **Settings save contract**: every settings page now wires a dirty / save /
  discard contract through `SettingsShell`. The save bar appears the first
  time you change a field; **Discard** reverts to the last-saved value;
  navigating away from a dirty page (in-app nav, browser refresh, tab close)
  prompts a confirm dialog before discarding. **Ctrl/Cmd+S** triggers save.
  Project General's name + description fields are wired end-to-end via
  `PATCH /api/v1/projects/:id/`. Every other settings page is rendered as
  a disabled preview until its API ships (#517–#530, #538).
- **Settings preview banner**: every settings page backed by stub data now
  renders a yellow "Preview — your changes will not be saved yet" banner at
  the top, linked to the page's 0.2 API wiring issue. Resolves a VoC concern
  flagged by Marcus (PMO Director, MR !302): stubbed pages were visually
  identical to wired ones, leaving no honest answer when a compliance officer
  asked whether a member list was real. The banner is dismissible per session
  (sessionStorage, keyed per issue) and is automatically absent on Project
  Access and Project General's wired name+description fields. (#538)
- The Workspace → Roles & permissions matrix now marks Enterprise-only capabilities (View audit log, Manage SSO, Manage integrations, Manage billing, Export workspace data) with an "EE" badge that links to the TruePPM Enterprise page. Evaluators can now tell which capabilities are part of the community edition versus Enterprise without leaving the matrix — previously those rows looked like broken or unfinished features. The badges are shown only in the community edition.
- Added `Project → Settings → Integrations` and `Program → Settings → Integrations` pages — read-only summaries of webhooks and inbound API tokens at each scope, served by `GET /api/v1/projects/<id>/integrations-summary/` and `GET /api/v1/programs/<id>/integrations-summary/`. Webhooks and API tokens now carry a polymorphic scope (project XOR program, enforced by DB constraint): a program-scoped webhook fires for events on any project in the program, and a program-scoped token authorizes inbound writes into any project the program contains — eliminating the copy-paste-Slack-URL-into-N-projects friction for program managers. `ProjectApiToken` renamed to `ApiToken` (backwards-compat alias retained until 0.4). The two static workspace stubs (`WorkspaceIntegrationsPage`, `WorkspaceWebhooksPage`) were misclassified per ADR-0076 and have been removed from the OSS bundle; the workspace routes `/settings/integrations` and `/settings/webhooks` now render a project-picker redirect shim so existing bookmarks keep working. The `project_settings.integrations` and `task_detail.external_links` slots were added to the widget registry as Enterprise extension points (per ADR-0029).
- **User → Settings → Connected Accounts** page (`/me/settings/connected-accounts`)
  lets users connect, rotate, and revoke per-user personal access tokens for the
  integration providers registered against ADR-0049's `TASK_LINK_PROVIDERS`
  registry (GitLab, GitHub, and a generic fallback in 0.2). Credentials are
  encrypted at rest with `INTEGRATION_ENCRYPTION_KEY` and never returned to the
  client — even the credential's owner only sees connection metadata. The Project
  → Settings → Integrations page (#569) now deep-links here.
- New `apps/integrations/` Django app exposes the read-only credential surface
  via `/api/v1/me/credentials/` (list) and
  `/api/v1/me/credentials/<provider>/` (upsert / retrieve / delete). The three
  ADR-0049 provider registries (`TASK_LINK_PROVIDERS`,
  `OUTGOING_CHANNEL_PROVIDERS`, `NOTIFICATION_CHANNELS`) are reserved by this
  release so #637 / #638 / #639 register cleanly without restructuring.
- New `user_settings.connected_accounts` slot in `widget-registry.ts` for
  Enterprise to register additional provider cards (Jira, ServiceNow, Bitbucket,
  Azure DevOps) against the OSS shell.
- The project and program Integrations settings pages now show a "Coming soon" connector roadmap listing in-flight OSS connectors (Jira/Linear/GitHub task-sync, calendar export, Drive/Box/Dropbox previews, meeting links, personal connected accounts) with links to their tracking issues, so the page signals "this is coming" rather than reading as unsupported.
- Project Settings → Notifications: added a per-user-per-project **Pause all notifications** kill-switch at the top of the page. While paused, no in-app or email notifications fire for that user on that project; the routing matrix is preserved unchanged so unpausing restores prior preferences exactly. Addresses Priya's (Team Member persona) VoC hard-NO: an opt-out path for members who haven't dialed in their event × channel matrix yet (#589).
- Project Access — each member row now shows when they joined the project and, when their role has changed since, the date of the last role change. These per-project access timestamps are also exposed on the membership API (`joined_at`, `role_changed_at`) as minimum-viable compliance evidence for "who has access and since when".
- The "Export matrix" button on Workspace → Roles & permissions now works, downloading the capability matrix as a CSV (useful as compliance-questionnaire evidence). The button is enabled even while the rest of the page is a preview, since the matrix data is static.
- **Settings: copy-link affordance**: A small copy-link button now sits next to
  the context name in the settings left rail. Clicking it copies the current
  settings URL to the clipboard, so deep-links into a specific project's
  Access, Methodology, etc. can be pasted into runbooks without leaving the
  page.
- **Settings: "Saved [time]" confirmation**: After a successful save, the
  settings shell shows a persistent footer with a relative timestamp ("Saved
  just now", "Saved 5m ago"). Gives admins a stale-vs-current signal when
  revisiting a settings page later in the session.
- The Webhooks and API tokens sections on the project and program Integrations settings pages now carry a one-line explanation of what each is for, so the page reads as intentional context rather than a raw inventory.
- Project → Settings → Access now shows an "on N other active projects" badge per member row, giving assigners a resource-load signal at a glance. Hovering reveals the project names you have visibility into (projects you own). Backed by a new `other_active_project_count` / `other_active_project_names` field on the membership API.
- Project → Settings → Integrations and Program → Settings → Integrations now manage webhooks and API tokens inline, replacing the read-only "manage via API" placeholder. Webhooks support create/edit/delete/test with a format picker (Slack or generic JSON), an event picker covering all task/dependency/schedule/project events, a signing secret, a live Slack preview, and a recent-delivery log. API tokens support create — with a one-time secret reveal — and revoke. Webhooks and tokens can be scoped to a program (firing/authorizing across every project in it) via new `/api/v1/programs/{id}/webhooks/` and `/api/v1/programs/{id}/api-tokens/` endpoints. (#600)
- **Git-aware task links.** Paste a GitLab or GitHub merge-request, PR, or issue URL onto a task and see its live status — open, draft, merged, or closed — on an "External links" section in the task detail panel. The provider is detected automatically from the URL (self-hosted GitLab/GitHub Enterprise hosts route by your connected account's host); status is fetched on demand with an explicit refresh button (no background polling) using your connected personal access token, through an SSRF-guarded, 5-second egress path. Links add/remove/refresh sync to the mobile client. Any other URL is accepted as a generic link. If the provider needs a token you haven't connected, refresh points you to Connected Accounts. Adding and removing links follows task-edit permission; refreshing follows task-read. Closes the OSS external-integrations epic (#302).
- Outbound webhooks can now render their payload in a provider-specific format. A new per-webhook `format` field selects the renderer (`generic` — the existing JSON envelope, unchanged — or `slack`, a Slack incoming-webhook message that also works with Discord and Mattermost). Four new task event types are subscribable: `task.assigned`, `task.assignee_changed`, `task.mentioned`, and `task.due_date_changed`. The format is validated against a runtime provider registry so editions can add channels without a migration. (#638)
- You can now get email (and in-app) notifications for your own-task events — when a task is assigned to you, when its planned date changes, and when someone comments on your task — alongside the existing @mention notifications. Toggle each event per channel on User → Settings → Notifications; email is off by default and strictly opt-in. A read-only Email & SMTP status page under Workspace Settings shows the configured mail transport and From identity. (#639)
- Workspace lifecycle actions are now wired in **Settings → Archive / Delete**: transfer workspace ownership to another member, export a full archive of all workspace data (emailed when ready), and permanently delete the workspace. All three are Owner-only and the export/delete are guarded by typed confirmation. (#641)
- The status bar now shows a truthful live-connection indicator instead of a permanently-green dot. The pill reflects five states — Connecting, Live (with the online count), Reconnecting, Connection lost, and Disconnected — so you can always tell whether your recent edits are reaching the server. The state is conveyed by label text and an accessible description, not color alone, and only the transient "Reconnecting…" state animates (and only when reduced-motion is off).
- Add the durable workflow execution engine (ADR-0080) — an internal `trueppm_api.workflows` interface plus a default Celery + transactional-outbox backend that runs declarative multi-step workflows with once-and-only-once activities, saga-style compensation on failure, durable sleep timers, and at-least-once step delivery with drain-based recovery. No public REST surface yet; the first real workload migrates onto it in a later release.
- Dead-letter alerting: permanently failed background tasks now emit a structured warning log and a `celery_task_permanently_failed` signal (enterprise extension point for PagerDuty/Slack), plus an admin-only Prometheus endpoint `GET /api/v1/health/dead-letter/` exposing the `trueppm_task_dead_letter_parked{task_name}` gauge.
- **Webhook delivery retention purge**: a nightly job now deletes terminal
  (`SUCCESS`/`FAILED`) `WebhookDelivery` rows older than `TRUEPPM_WEBHOOK_RETENTION_DAYS`
  (default 7). The existing MS Project import purge is now configurable via
  `TRUEPPM_IMPORT_RETENTION_DAYS` (default 7) instead of a hardcoded window. Set either
  to empty/`None` to disable. See `docs/administration/retention.md`.
- **Celery Beat liveness heartbeat**: TruePPM now records a Beat heartbeat every 30 s and
  exposes `GET /api/v1/health/beat/` (admin-only) returning `{last_heartbeat, stale}` —
  `200` when fresh, `503` when stale — so single-pod deployments can detect a dead Beat
  process before drains silently stall. A worker also logs a `WARNING` when the heartbeat
  exceeds `TRUEPPM_BEAT_STALE_SECONDS` (default 120). See `docs/administration/durability.md`.
- Added client-driven idempotency: send an `Idempotency-Key` header on any `POST`/`PUT`/`PATCH`/`DELETE` to make retries safe — a retry with the same key replays the original response instead of re-applying the write. Stored atomically with the mutation and retained for 24 hours. See `docs/api/idempotency.md`.
- **Webhook delivery sequence numbers**: every outgoing webhook delivery now carries an
  `X-TruePPM-Webhook-Sequence` header — a monotonic, contiguous, per-subscription number that is
  stable across retries and never reused (even after delivery-history pruning). Consumers can use it
  to detect gaps and reorder events that arrive out of order. The value is also exposed as
  `sequence_number` on the delivery-history API. Ordering remains a hint, not a strict-order or
  exactly-once guarantee.
- Mobile sync upload (`POST /api/v1/projects/{id}/sync/`) — the offline store can now push a WatermelonDB delta of task changes back to the server. Each batch carries a `client_batch_id` for **all-or-nothing** transactional apply and **idempotent retry**: a connection that drops mid-commit leaves nothing partially applied, and re-uploading the same batch replays the original response instead of double-applying (ADR-0082). Conflict resolution is last-writer-wins for now (richer field-level merge is tracked in #322). Per-row permissions mirror the REST task path exactly. A new `TRUEPPM_SYNC_BATCH_RETENTION_HOURS` setting (default 24h) bounds the idempotency table.
- The Program → Rollup KPIs settings page now includes a live "Preview" panel that shows how the current KPI selection and aggregation policy roll up against the program's real project data — the same computation the program overview renders. KPI toggles save automatically and the preview refreshes; a policy change shows a hint to save before it is reflected. Deferred KPIs appear with a muted value rather than being hidden.
- **Preference-aware notification delivery**: notification dispatch now consults each member's per-project Notifications settings. Comment @mentions are routed through the `comment_mention` matrix — the in-app inbox honors the per-channel toggle, and email is suppressed inside the member's quiet-hours window (interpreted in the project's timezone, falling back to the workspace default). The durable in-app record is never dropped by quiet hours, only transient channels are. The pause kill-switch and quiet-hours window on Project → Notifications are now live rather than write-only.
- **MS Project import/export in the UI**: the project Schedule toolbar's
  **Project actions** (`···`) menu now exposes **Import from MS Project…** and
  **Export to MS Project (.xml)**. Import accepts `.mpp`/`.xml` files via a
  drag-and-drop modal (Project Admin only); the schedule refreshes when the
  import finishes. Export downloads the schedule as MS Project XML for any
  project member. Previously these capabilities were API-only. The import
  upload cap is now configurable via the `MSPROJECT_MAX_UPLOAD_MB` setting
  (default 50 MB, raised from 10 MB).
- System Health operator console at Settings → Workspace → System health (workspace-admin only). A live overview dashboard surfaces the durable-execution layer — outbox dispatcher, Celery Beat heartbeat + configured schedule, dead-letter alerting, notification dispatcher, and retention configuration — and a read-only dead-letter inspector lets operators filter permanently-failed background tasks and inspect their error, attempt summary, and payload. Backed by a new `GET /api/v1/health/system/` aggregation endpoint and filter parameters on the failed-task list (ADR-0172). Tracking issues #691 #692 #694.
- **Retention & purge policy editor**: workspace admins can now tune retention windows,
  enable/disable purges, configure the purge schedule (daily/weekly/off, UTC time of day,
  on-failure behavior), and run a purge now or dry-run it — all from **Settings → System
  health → Retention & purge**, without editing settings or restarting pods. A recent-runs
  log records each run's outcome, rows deleted, and space freed, and the System health
  overview's "Retention purge" card now reports real state instead of "unknown". The five
  per-table nightly purges are consolidated into one scheduled coordinator. Lowering a
  window shows how much data becomes purge-eligible before you save. Compliance-grade
  retention governance remains an Enterprise feature. See `docs/administration/retention.md`.
- **Ungrouped projects on the Programs directory**: the `/programs` page now lists your standalone projects (those not in any program) below the program cards, each with its health, progress, and member count, plus a one-click "Move to program" action. Backed by a new `?program__isnull=true` filter on the projects list endpoint (ADR-0171).
- Programs can now have an accent color — pick one of six swatches on the program General settings page to tint the program's identity square in the programs list (falls back to a health-tinted neutral when unset).
- Program overview now renders a computed KPI rollup. The new Overview tab (the program's default landing) shows a program health dot plus a strip of the enabled KPIs aggregated across the program's projects, honoring the configured aggregation policy (worst-case / average / task-weighted). Counts and risk exposure roll up as program totals. `cost_variance`, `budget_utilization` (pending the cost/EVM model, #754) and `p80_completion` (pending a persistent Monte Carlo store, #753) display a "needs data" reason rather than a fabricated value; budget-weighted aggregation falls back to average until the cost model ships. This consumes the rollup config shipped in #527 — the shipped KPI set is ratified as canonical, replacing #527's originally-named list.
- Program backlog intake pool (ADR-0069). New `BacklogItem` model at the program level with a `proposed → pulled → archived` lifecycle and epic/feature/story/task item types, offline-sync ready via `VersionedModel`. REST endpoints under `GET/POST /api/v1/programs/{id}/backlog-items/` (filter by `item_type`/`status`/`tags`, fuzzy `?q=` trigram search on title) plus a `POST .../{item}/pull/` action that converts a proposed item into a project-backlog `Task` (`status=BACKLOG`, never a sprint) in any project of the program. Requires Team Member+ on both the program and the target project. Tracking issues #733 #737 #739.
- **Recurring tasks (backend)**: tasks can now carry a recurrence rule (daily / weekly / monthly / custom, with day-of-week and day-of-month selectors, time-of-day, and Never / On-date / After-N end conditions). An hourly generator lazily spawns upcoming occurrences within a configurable look-ahead window (`TRUEPPM_RECURRENCE_HORIZON_DAYS`, default 14), inheriting the template's assignee and attachments per the rule's toggles. Recurring templates and their occurrences are excluded from CPM and Monte Carlo inputs — they are parallel, calendar-driven activities, not nodes in the schedule's logical network (ADR-0090). New `recurrence-rules` API endpoint; the setup UI ships with #738.
- **Recurring tasks (setup UI)**: a Recurrence section in the task detail drawer lets a Scheduler+ turn a task into a calendar-cadence series — pick daily / weekly / monthly / custom, the weekdays or day-of-month, a time and timezone, and an end condition (Never / On date / After N). A live "Next 4 occurrences" preview updates as you edit, and a banner makes clear the task is excluded from the critical path and Monte Carlo while it recurs. The "inherit subtasks" and "notify the morning of" toggles are present but labeled "Not active yet" (stored for a future release per ADR-0090). Members see a read-only summary. Pairs with the #736 backend; completes recurring tasks (#312).
- **Program backlog UI** (`/programs/:id/backlog`): the program-backlog tab is now a working two-pane workspace (#742), wired to the ADR-0069 API (#737/#739). A sortable, filterable item list with status/type/tag facets and title search, an inline detail/edit pane, and the **pull-down** flow that promotes a backlog item into a project's backlog (single target, optimistic with rollback on failure). Includes a distinct mobile layout (card list + bottom-sheet detail/pull/create/filter), drag-to-reorder for proposed items, empty/no-results/error states, and full keyboard + screen-reader support. Create/edit/pull/archive require program Admin; hard delete requires Owner.
- Pulling a program backlog item into a project now fires the `task.created` outbound webhook, so external integrations see backlog pulls like any other task create. The payload carries `source: "backlog_pull"` to distinguish the origin.
- **Fiscal quarters in the Schedule timeline.** At quarter/year zoom the header tiers now follow the workspace fiscal year by default — a workspace whose fiscal year starts in April shows Q1 = Apr–Jun, labeled `Q1 FY27`, with boundaries on fiscal (not calendar) quarters. A **Quarters: Fiscal / Calendar** toggle next to the zoom control switches the view per user; the choice is remembered in the browser. The toggle is hidden when the workspace fiscal year starts in January (fiscal and calendar quarters are then identical).
- Import a project from a file: create a new project directly from a Microsoft Project XML (MSPDI) export. A new "Import a project" action in the sidebar opens a dialog with a format picker (MS Project `.xml` supported today; `.mpp`/`.mpx` show inline guidance for saving as XML), and the project appears immediately while its tasks import in the background. Parse failures now stop cleanly instead of retrying a bad file (ADR-0092).
- MS Project (MSPDI) import and export now round-trip three-point / PERT
estimates via the `Duration1`–`Duration4` ExtendedAttribute convention
(aliased Optimistic / Most Likely / Pessimistic / PERT Expected). On import
the three values are written to `Task.optimistic_duration` /
`most_likely_duration` / `pessimistic_duration` with `estimate_status`
set to `accepted`; on export the four ExtendedAttribute definitions are
emitted at project level (including Duration4's PERT formula) and per-task
values are written for leaf work tasks. All-or-none: partial three-point
data is dropped with a warning. Summary tasks and milestones are skipped
in both directions. Design recorded in ADR-0093. (#798)
- Project Overview now shows a "Project history" section listing recent file
imports (filename, date, who initiated it, status, and task count) when
the project has any. Backed by `GET /api/v1/projects/{pk}/imports/`
(Member+ read) — answers Marcus's PMO audit ask on the #796 epic without
needing the enterprise audit overlay. Rows are purged after 7 days, so
this is a recent-activity surface, not a durable audit log. (#799)
- Vendored `cloud_migration.xml` MSPDI fixture (28 tasks with three-point/PERT estimates) into the MS Project importer test fixtures. Produced by the standalone `mpp-sample-generator` tool (`mpp-sample build --three-point`), with provenance and the verified PERT `Duration1`–`Duration4` FieldIDs documented in `fixtures/README.md`. Unblocks the PERT mapping importer/exporter work (#798). (#801)
- Real-time collaboration: comment reactions and acknowledgements now sync live to everyone viewing a task thread instead of appearing only after a reload. The acknowledgement broadcast is body-less — it never reveals who acknowledged or an aggregate count, preserving team-only ack visibility (ADR-0075).
- Sprint/phase/WBS guardrails (ADR-0101) — completing the web surface: inline build-mode sprint assignment now surfaces the warn/override/block flow under the SprintPrompt, the Sprints workspace shows read-only Tier-3 health badges (orphan tasks, phase-span, summary-in-sprint), Project Settings → Sprint guardrails lets Owners escalate composition rules warn→block (sovereignty-gated; advisory rules pinned to warn), and the board surfaces a dismissible mid-sprint scope-injection banner. Backend in 0.2.0-alpha.1 (#875).
- When you add a summary, phase, recurring, or out-of-window task to a sprint, an inline non-blocking notice now explains the impact ("this double-counts in velocity") with a one-tap **Keep it here** or **Undo** — and where a project Owner has set a rule to block, the assignment is refused with a clear, actionable message. Mid-sprint scope additions that affect the Sprint Goal are now flagged in the task drawer.
- Sprint/Phase/WBS guardrails: assigning a summary, phase, recurring, or out-of-window task to a sprint now surfaces a non-blocking warning with a one-tap override, and project Owners can escalate any sprint-composition rule to a hard block from a new per-project Guardrails settings page.
- Mid-sprint scope-injection approve-gate (ADR-0102): a task linked to an ACTIVE sprint after activation now enters a pending-acceptance state (`task.sprint_pending`) — visible on the board and in My Work but excluded from commitment, burndown, and milestone-rollup math until a team member with the sprint-lifecycle gate (role ≥ Project Manager + project membership) accepts it into the commitment or rejects it (removing it from the sprint). New endpoints: `POST /api/v1/scope-changes/{id}/accept/` and `/reject/` (single) plus `POST /api/v1/sprints/{id}/scope-changes/accept/` and `/reject/` (bulk, `{ids:[…]}`). Sprint payloads carry `pending_count`; `SprintScopeChange` carries a `status` (pending/accepted/rejected) audit field. Sprint close is never blocked by pending items — it surfaces a non-blocking advisory and a `pending_disposition` (`carry` default re-flags carried tasks pending in the next sprint; `reject` removes them). Accept/reject are team-owned and management-inert: there is no auto-accept path and no policy/extension input to the status transition.
- **Monte Carlo documentation**: added `docs/features/monte-carlo.md` covering
  the full PERT-Beta simulation model — mean and standard deviation formulas,
  Beta method-of-moments parameterisation, vectorised CPM forward pass, and why
  the Central Limit Theorem compresses spread on long critical paths. Documents
  OSS tier caps (1 000 runs / 500 tasks), the independence assumption (no
  correlated risk factors), the absence of resource-constraint modelling, and
  guidance on interpreting P50 / P80 / P95 output for stakeholder commitments.
- Added `/voc-audit` skill: persona-level review of shipped surfaces with GitLab issue cross-reference. Runs on demand against a recently-merged surface, and as Step 0.8 of `/pre-release full` (one parallel pass per user-visible surface shipped since the last release tag).
- Added `scripts/wt`, a git worktree helper for parallel multi-issue development. `scripts/wt new <issue>` creates a worktree at `../trueppm-wt/<branch-leaf>/` with symlinked `packages/api/.venv` and `packages/web/node_modules` (so dev deps aren't duplicated) and an `.envrc` that exports `COMPOSE_PROJECT_NAME=trueppm` so the worktree reuses the Docker stack from the main checkout. Includes `list`, `remove`, and `doctor` subcommands plus a soft WIP cap at 5 active worktrees. Docs: `docs/getting-started/parallel-worktrees.md`.

### Changed

- **WebSocket event names for task collaboration** are now namespaced under `task_` and per-action past-tense: `task_comment_created`, `task_comment_updated`, `task_comment_deleted`, `task_attachment_created`, `task_attachment_deleted`. The earlier `*_changed` shape with an `action` discriminator field has been removed, and the un-namespaced `comment_created` / `attachment_created` shape from the M-1 refactor collided with RiskComment's pre-existing `comment_created` event (ADR-0044). Clients listening to the old combined events must update their handlers — no compatibility shim. Payload shape is unchanged otherwise (`id`, `task_id`, and `parent_id` for comments) (ADR-0075 §D, M-1 + collision fix).
- **Programs — create projects from inside a program**: the Program shell's
  Projects tab now offers two distinct buttons — **New project** (opens the
  project creation wizard prefilled with the current program) and **Add
  existing** (the cross-program picker). Replaces the single ambiguous
  `+ Add project` button that only opened the picker. The `POST /projects/`
  endpoint accepts an optional `program` field at creation time; the server
  enforces ADMIN on the target program (ADR-0070 cross-permission gate).
- **ADR-0070**: clarified the OSS/Enterprise boundary in the Status section —
  the data model is 1 Program → N Projects; users may belong to multiple
  programs (navigation only); no shipped feature aggregates across programs
  (portfolio aggregation remains Enterprise).
- Docs site: fix admonition contrast failures in both light and dark modes, establish light-as-default theme, and rewrite the landing page to lead with TruePPM's waterfall/agile/hybrid positioning.
- **BREAKING — Role ordinals re-spaced for Enterprise extension point** (ADR-0072,
  issue #508): the 5 OSS role ordinals are now `VIEWER=0`, `MEMBER=100`,
  `SCHEDULER=200`, `ADMIN=300`, `OWNER=400` (previously `0/1/2/3/4`). The OSS edition
  continues to ship the same 5 named roles with identical user-visible behavior —
  the re-spacing opens 99-unit slot bands between OSS tiers so the Enterprise
  edition can register custom roles (e.g., a "Senior Scheduler" at `250`) without
  forcing an OSS renumber.

  **External API consumers must migrate.** The `role` and `my_role` fields on
  `/api/v1/projects/{id}/members/*`, `/api/v1/programs/{id}/members/*`, and the
  membership sync payload return the new numeric values. Hardcoded comparisons
  like `role >= 3` (Admin-or-above) must become `role >= 300`. The recommended
  migration is to compare against band ordinals, not equality on intermediate
  values — see ADR-0072 §"The band-boundary contract" for the contract that
  governs how custom roles inherit OSS-tier capabilities.

  The data migration multiplies existing rows by 100 atomically across
  `ProjectMembership.role` and `ProgramMembership.role` in a single transaction
  (`apps/access/migrations/0006_role_ordinal_spacing.py`) and is reversible.
  Two raw-integer permission checks (`role < 1` in the WebSocket sync and
  workshop consumers) have been migrated to symbolic `< Role.MEMBER` form so
  the gates stay correct under any future renumber. A new shared module
  `packages/web/src/lib/roles.ts` exposes named constants
  (`ROLE_VIEWER`, `ROLE_MEMBER`, `ROLE_SCHEDULER`, `ROLE_ADMIN`, `ROLE_OWNER`)
  — frontend code should import these instead of writing numeric literals.

  **Deployment guidance**: this is a breaking-change migration that updates
  every membership row. The recommended deployment order is migrate-before-
  traffic (the default in our Helm chart's pre-install hook): run
  `python manage.py migrate` to commit `access/0006_role_ordinal_spacing.py`
  before routing traffic to the new code. Operators on simpler setups (single-
  pod docker-compose) should schedule a brief maintenance window — the
  migration itself takes seconds, but mixing old-code/new-data or new-code/
  old-data during the rollout window can produce transient permission errors
  on active WebSocket sessions and admin API calls.
- **Program settings → General** is now wired to the real
  `/api/v1/programs/:id/` endpoint. Name, description, code, health,
  visibility, methodology, and program lead all round-trip through a real
  PATCH. The page is wired to the `SettingsShell` save bar contract
  (dirty detection, Ctrl/Cmd+S, discard) and the stub banner is removed.
  The `Program` model gains four fields (`code`, `health`, `visibility`,
  `lead`) with safe defaults; the migration is non-destructive and
  reversible. Lead assignment is restricted to existing program members.
- **Program settings → Projects** is now wired to the real
  `/api/v1/programs/:id/projects/` endpoint. The page surfaces loading,
  empty, and populated states, and the "Preview — not yet saved"
  stub banner is removed. The `+ Add project` button opens the existing
  picker modal (admin/owner only).
- **Program settings → Access** is now wired to the real
  `/api/v1/programs/:id/members/` endpoint. Members render from the API,
  inline role changes PATCH immediately, and remove flows route through
  an inline confirm before the DELETE fires. The "+ Add member" panel is
  Owner-gated and reuses the existing program invite form with username
  / email search. The stub banner is removed.
- **Toolbar responsive collapse**: Schedule, Board, and Resource view toolbars
  now follow consistent breakpoint rules. At ≥1024px every control shows its
  full label; between 768–1023px secondary toggles render icon-only; below
  768px the secondary toggles collapse into a shared overflow popover
  (`⋯ More options`). Primary actions (Today, Add task, Group/Sort/Density,
  view-mode switcher, period nav) stay visible at every supported width.
  Toolbars no longer wrap to a second row at narrow widths.
- **CI / harness speed wins (kaizen #640, part 2 — custom ci-api image)**:
  - New `.gitlab/ci-images/api.Dockerfile` pre-bakes libpq-dev, gcc, git and
    the full dev-dep wheel tree of `packages/scheduler` and `packages/api`.
    Published to `registry.gitlab.com/trueppm/trueppm/ci-api:py3.11`.
  - New `ci:build-api-image` job rebuilds and pushes the image when the
    Dockerfile or either pyproject.toml changes, plus on a weekly scheduled
    pipeline as a safety net against transitive dep drift.
  - `.api` and `.api-no-db` job templates now pull the custom image; the
    runtime `pip install -e` is a fast editable re-link instead of a cold
    wheel-download. Saves ~3 minutes off each of the six affected
    `api:*` jobs.
  - `api:type-check` no longer redefines `before_script`; the template's
    `api[dev]` install gives it the mypy stubs it needs.
  - `license:check` `changes:` filter narrowed to dep-manifest files only
    (lock files, `pyproject.toml`, `Cargo.toml`) — previously triggered on
    every MR touching source. Main pushes and weekly scheduled pipelines
    still run it for transitive-drift coverage. Also switched to the
    `ci-api` image so the apt-get + pip-install setup is no longer paid
    per run.
- **CI / harness speed wins (kaizen #640, part 1)**:
  - `web:e2e` Playwright runs with 4 workers in CI (was single-worker); mocked
    specs are stateless so worker isolation is safe.
  - `api:test` runs `pytest -n auto` via `pytest-xdist`, fanning out across the
    4-core runners.
  - `web:e2e` vite preview stdout/stderr are suppressed in CI so the trace is
    no longer flooded with `ECONNREFUSED 127.0.0.1:8000` from the proxy
    attempting to reach a backend that the mocked job intentionally does not run.
  - `api:migration-check` now runs on every MR pipeline (no `changes:` filter)
    — cheap insurance against inter-MR migration drift that the per-MR filter
    missed.
  - `make pre-push` fans its subtargets out across cores (`-j 4`) and warns
    (non-blocking) when HEAD is behind `origin/main`, catching the schema /
    migration drift class that the post-merge pipeline used to catch.
  - The pre-commit pre-push hook now records wall-clock duration to
    `.git/pre-push.log` (rotated to the last 100 lines) so we have a signal
    when the local gate silently grows past its 60s target.
- The disabled project-level working-calendar override on Project → Settings → General now shows a one-line workaround (set the work week per task) instead of a dead button, so users aren't left without a path forward until the picker ships.
- **Workflow engine query & index polish**: the nightly workflow retention
  purge now deletes terminal outbox rows and expired history in bounded chunks
  (`WORKFLOW_PURGE_BATCH_SIZE`, default 500) instead of one unbounded statement,
  so its first run on a mature install can't hold a long lock over a large slice
  of the table. Dropped the redundant `(workflow, seq)` history index (the
  unique constraint already serves the ordered lookup and `Max(seq)` aggregate),
  removing write amplification on the every-step-written history table. Workflow
  completion no longer re-scans activity executions a second time — it reuses the
  results already aggregated for the step context.
- **Webhook delivery sequence in the body**: the per-subscription delivery
  sequence number is now included in the delivered webhook payload under a
  reserved `_meta` object (`_meta.sequence`) — in every format (`generic` and
  `slack`), alongside the existing `X-TruePPM-Webhook-Sequence` header. Consumers
  can now detect gaps and reorder events from the body alone without parsing
  headers. The two always carry the same value (completes the #664 acceptance
  criterion; see ADR-0089).
- Python dependency constraints now carry explicit upper bounds (capped at the next major) instead of bare `>=` floors, so a fresh install can no longer silently pull a breaking major release. As part of this, the API standardizes on **Django 5.2 LTS** (`>=5.2,<6.0`). The JavaScript dependencies were already bounded by npm's `^`/`~` ranges. (#718)
- **Workspace fiscal year is now a structured month + day** instead of free text. Workspace Settings → General offers quick presets (Jan 1, Apr 1, Jul 1, Oct 1) plus a **Custom** month/day picker for oddball fiscal starts such as the UK tax year (April 6). Existing free-text values (`"January 1"`, `"April"`, `"4/1"`, …) are parsed into the structured form automatically on upgrade; anything unrecognized falls back to January 1.
- Eliminate N+1 queries and unbounded scans from the 0.2 perf audit: read prefetch caches in `TaskCommentSerializer` and `SprintRetroSummarySerializer`, scope `_me_work_retro_action_items` to member projects, add `select_related("target_milestone")` to `SprintViewSet` and `select_related("calendar")` to the program projects action, convert `MeActiveSprintsView` per-sprint burndown queries to a single `Prefetch`, and cap the `/utilization/` default window to ±8 weeks from today. Closes #772
- **Schedule view real-time perf**: The dependency-links query now paginates through every page (previously capped at the first 50, silently dropping arrows and CPM edges on larger projects); the 30 s fallback poll is gated on the WebSocket being down instead of always running; and a burst of live mutation events is coalesced into a single trailing refetch. Part of #773.
- Hardened the `trueppm-scheduler` public surface: Monte Carlo now consumes the RNG in a version-independent lexicographic topological order so seeded P50/P80/P95 are stable across networkx versions and task insertion order; replaced TruePPM tier wording in `SimulationCapExceeded` with neutral, actionable messages; documented that CPM free float covers finish-to-start successors only; fixed the README quick-start expected `early_finish` (2026-01-23); and the Python and Rust conformance harnesses now assert `total_float`/`free_float` against the shared fixtures. Closes #774
- **Program navigation moved to the top bar, with a Settings tab**: a program's `Overview · Backlog · Projects · Members` tabs now live in the global top bar — the same place project tabs do — and a new **Settings** tab makes program settings reachable directly (previously you could only get there via the settings scope switcher). The redundant in-program header is gone; the program name shows in the sidebar and each view, and program delete remains under Settings → Archive/Close.
- Workspace settings: placeholder buttons that were never wired are now disabled rather than dead-but-clickable. The OSS gaps (logo replace, add holiday calendar, member CSV export, resend invite) link to #791; the workspace lifecycle actions (export / transfer / delete) link to #641. "View change history" and "Sync from directory" are Enterprise capabilities (audit trail, directory sync) and now carry an Enterprise upsell badge instead of doing nothing.
- Creating a project-shared board saved view now requires the Member role or above; a Viewer can still use shared views but can no longer add to the shared set (#820). This aligns board-view creation with the rest of the write-permission matrix (`IsProjectMemberWrite`). Reading shared views remains open to any project member.
- Monte Carlo is now available for large projects: the OSS task cap (`MC_TASK_CAP`) is raised from 500 to 5,000, so projects up to the 10k-task scaling target no longer get an HTTP 402 from the simulation endpoint (#823). Operators on constrained hardware can lower the cap.
- `trueppm-scheduler` public-surface decisions ahead of 1.0 (#826): Monte Carlo percentiles (P50/P80/P95) now use the standard `numpy.percentile` convention (linear interpolation) instead of an undocumented in-house nearest-rank, so values may shift by a day; `Project.from_dict`/`from_json` and `DateRange.from_dict` now raise the documented `InvalidScheduleInput` on malformed input instead of leaking `KeyError`/`ValueError`; `ScheduleResult` defensively copies its task and critical-path lists; and the engine-unused public fields (`Task.planned_finish`, `Task.percent_complete`, `Calendar.hours_per_day`, `Calendar.timezone`) are documented as reserved (round-tripped but not yet consumed by CPM/Monte Carlo). The `monte_carlo()` docstring now notes the default `max_runs=1000` cap so the 10,000-run example doesn't trip `SimulationCapExceeded`.
- Helm: the bundled dev/demo PostgreSQL and Valkey are now first-party vendored subcharts (official `postgres:16` / `valkey/valkey:8` images) committed under `charts/`, replacing the deprecated Bitnami charts. The chart no longer depends on the Bitnami repository and resolves offline (`helm lint`/`helm template` need no `helm dependency build`). Production is unchanged — it disables both and points `DATABASE_URL`/`REDIS_URL` at managed services (CloudNativePG recommended for self-hosted HA Postgres).
- WebSocket event-name convention is now uniformly `snake_case`: the presence events, previously dot-namespaced (`presence.join` / `presence.leave`), are now `presence_join` / `presence_leave` to match every other board event (#828). The deliberate WebSocket (`snake_case`) vs webhook (dot-namespaced, e.g. `task.created`) naming distinction is now documented in `docs/api/websockets.md`. Wrapping the webhook payload in a versioned envelope is tracked for 1.0 (#852).
- Documentation: new-feature pages (programs, recurring tasks, task collaboration, webhooks, workspace settings, system health, retention, durability, email, dead-letter alerting) now carry a "0.2 — in progress" callout, and the configuration reference documents the new retention/durability/recurrence env vars plus the not-yet-wired `EMAIL_*` settings.
- OpenAPI documentation is substantially expanded (#846): list endpoints now document their query parameters (`/tasks/`, `/dependencies/`, `/recurrence-rules/`, `/projects/?program__isnull`, `/sprints/?state`, velocity-suggestions, utilization, resource-allocation, resources/heatmap, burn, project-resources `?force`, resource-skills/task-skill-requirements); custom report endpoints (monte-carlo incl. the 402 cap response, burn series, attention, overview, my-tasks, me/work, import provenance, edition) now carry response schemas; and the parameterless ghost `tasks/{id}/suggestions/{accept,decline,revoke}/` routes — which 404'd at runtime because they lacked the `suggestion_pk` segment — are removed from the router (the real routes with `suggestion_pk` are unchanged). Expands the #781 summary pass.
- Scheduling a task before the project start date no longer silently clamps. Dragging or typing a task to a date earlier than the project start now opens a prompt to snap the task to the project start, move the project start earlier (Project Admin/Owner only), or cancel. The API rejects a `planned_start` before the project start with a `planned_start_before_project_start` error code, keeping the value honest for direct API consumers too (#868).
- Adopted the TruePPM Brand v1.0 identity across the web app (Design System v2.0, ADR-0103): the True Navy / Truth Sage palette, the duotone dependency-arrow logo and two-color wordmark, and Space Grotesk as the display typeface. All surfaces re-themed from the previous green palette with WCAG 2.1 AA preserved; dark mode reverses navy ink to pale while sage holds.
- The published `trueppm-scheduler` package description and module docstring no longer claim "resource-leveling". The engine performs critical-path method (CPM) scheduling — all four dependency types, calendar-aware lag, cycle detection, summary-task expansion — and Monte Carlo schedule-risk analysis (P50/P80/P95), but it does not level resources. The PyPI metadata and the scheduler feature docs now describe the actual scope, and the CPM output reference documents the `free_float` field (computed across finish-to-start successors today).
- Improve `seed_demo_project` demo data to tell a complete, realistic project story: COMPLETE phases (Discovery + Build) with `percent_complete=100`, overdue IN_PROGRESS tasks (Pilot data sync at 60% past its due date), Dan Ortiz over-allocated at 150% across two parallel Migration tasks, baseline variance showing original vs. current dates (up to 26-day slip visible on Gantt), correct FS dependency network (including parallel Pilot + Comms tracks), software-domain sprint stories replacing hardware placeholders, and updated retro notes/action items to match the migration narrative.

### Fixed

- DependencySerializer now rejects predecessor/successor FKs that point at soft-deleted tasks (returns 400), preventing orphaned edges that corrupt the CPM graph and cause sync conflicts.
- Dependency create/update now runs membership checks on both predecessor and successor before the same-project check, so non-members always receive 403 regardless of project pairing (defense-in-depth hardening).
- Fixed Monte Carlo finish dates being one working day later than CPM — the offset-to-date converter now correctly maps exclusive EF offsets to inclusive CPM-style dates.
- Monte Carlo simulation now converts dependency lag from calendar days to working-day offsets using the project calendar, matching CPM lag semantics (previously lag was treated as working days, diverging from CPM by ~20% on a standard calendar).
- Fixed `project_start` being reported as a later date than work actually begins when multiple parallel root tasks exist — now correctly uses `min(early_start)` across all tasks instead of the first topological-order entry.
- Sprint capacity now accounts for each task's actual duration overlap with the sprint window, so a 1-day task no longer consumes the same committed hours as a 10-day task.
- Schedule variance now computes against the active baseline finish date instead of `early_finish`, preventing CPM recomputes from silently eroding the reported variance.
- Project Health "Most-slipped critical tasks" panel now returns the tasks with the largest schedule drift first (was showing least-slipped).
- Burn chart baseline overlay now uses story points (not task count) when `metric=points`, so the Y-axis units are consistent between the actual and planned series.
- Sprint carry-over (backlog and next-sprint) now bumps `server_version` on each moved task so mobile sync clients see the close-out mutations.
- Summary task `percent_complete` rollup now aggregates leaf descendants at any depth instead of only direct children, fixing incorrect rollup on WBS trees deeper than two levels.
- Project SPI now uses baseline finish dates as the planned-by-today denominator (not CPM early_finish), preventing SPI from drifting to 1.0 on each scheduler run. SPI > 1.0 is now reported correctly when the project is ahead of schedule.
- Monte Carlo P50/P80/P95 date chips now render the correct calendar date for users west of UTC (was showing one day early after ~16:00 local time).
- SPI chip on board cards now appears for tasks with a 1-day baseline (where start date equals finish date); was silently hidden for this common case.
- Schedule today-line and sprint Day-N-of-M ribbon now advance at local midnight instead of UTC midnight, fixing premature day rollover for users west of UTC.
- Board backlog "+ Capture idea" button is now wired to create a BACKLOG task; shows "Adding…" and disables while the mutation is in flight.
- **Gantt dependency arrows** (ADR-0063): FS arrows now follow the consolidated routing rules — 5-segment canonical Manhattan path with three branches (collapsed 3-segment L for forward-clear corridors, R12 gutter dogleg for stacked-sequential targets, left-detour around any non-source/non-target bar blocking the V drop). Merge junctions render for ANY target with 2+ FS predecessors (not just milestones); the junction marks the single point of convergence with a charcoal dot + white halo, and the trunk arrow has a straight ≥ 8px shaft into the arrowhead. Merge junction marker bumped from 4/3 to 6/5 (halo/dot radii) — the original spec sizing was visually subordinate to the 2-px arrow stroke and easy to miss on dense charts. Split T-junctions where one source has multiple outgoing arrows now render as plain corners (no dot) — visually a T is one line passing through plus one branching off, indistinguishable from any other Manhattan corner, so a dot read as noise. ADR-0063 Rule 15 added: four intersection types (crossing / T-junction / merge / near-miss) each get a distinct visual treatment; crossings get a bridge hop (10-px arc on the "over" segment), T-junctions get a smaller 5/4 dot, merges keep the 6/5 dot. Rule 15 Type A (bridge hops) is fully implemented — `drawDependencyArrows` was refactored to a 4-phase collect-then-draw pipeline (paths collected → orthogonal crossings detected → paths stroked with quadratic Bézier arcs lifting horizontal segments over verticals → junction dots drawn last). The arrowhead approach was also fixed in this MR: the polyline now terminates at the arrowhead BASE (tipX − arrowSize), giving every arrow a visible APPROACH_STUB (8 px) of straight horizontal shaft into the arrowhead instead of attaching the head directly to a corner. Two additional decluttering fixes (overrides 4 and 5 in ADR-0063): (a) ancestors of an arrow's target are now transparent obstacles, so an arrow from outside a phase into one of its descendants descends straight through the summary rollup instead of doing a chart-spanning U-detour around the entire phase bar; (b) redundant FS edges are suppressed at render time — when a source has FS to both a summary and one or more of that summary's descendants, only the summary edge renders (the descendant edges are implied because a summary's earliest start is gated by its first child's start). Schedule semantics are unchanged; only the visual is decluttered. Type B (T-junction-on-path) implementation is still deferred to ADR follow-up #9. Summary rollups remain valid arrow endpoints (override of spec R11 — waterfall PMs use phase-to-phase dependencies). All arrows render in charcoal `#444441` regardless of critical-path state; selected-task arrows highlight in brand-primary. SS/FF/SF unchanged (Bézier).
- Hide **Duration (working days)** in the task form modal for pure-agile projects (`methodology = AGILE`). Agile teams size work in story points; velocity-to-calendar translation belongs at the program level, not per task. Fixes browser "value must be ≥ 1" validation tooltip on backlog idea tasks with `duration = 0`.
- Overview KPI cards no longer clip long values (long milestone names, multi-word health labels) at narrow card widths. The primary value now scales fluidly with the card's own width via container-query units and wraps as a last resort, so the six-card strip at `lg`+ breakpoints stays legible when the sidebar is open. (#506)
- **Workspace Members search and Role filter now work**: the search field on
  Settings → Members was a `<span>` placeholder and the filter chips were
  unconnected. Replaced the placeholder with a real `<input type="search">`,
  wired a client-side filter against name and email, and made the Role filter
  a real `<select>`. Renders an empty state ("No members match …") when nothing
  matches. The filter survives unchanged when the page swaps to live API data
  (#518). (#537)
- **Project → Settings → General**: extended fields (Health, Visibility, Timezone, Working calendar, Default view) now display an inline notice linking to #520, explaining why the controls are visible but disabled. Previously the mixed live/disabled state was indistinguishable from broken — clicking "At risk" did nothing with no feedback (VoC 2026-05-21, #591).
- **Settings preview banner**: dismissals now persist across browser sessions (`localStorage`) instead of resetting on every new tab. With 14 of 19 settings pages currently stubbed, sessional dismissal hit users on nearly every visit and eroded trust in the surface (VoC 2026-05-21, #592).
- **CI: docs-only openapi-regen pipelines failed at creation.** `api:schema-drift`
  had `needs: [api:lint]` but its `changes:` filter included
  `docs/api/openapi.json`, so a docs-only MR that regenerated the schema would
  match `schema-drift` without matching `api:lint` and GitLab refused to create
  the pipeline ("'api:schema-drift' job needs 'api:lint' job, but 'api:lint'
  does not exist in the pipeline"). The need is now `optional`.
- Single-key keyboard shortcuts are now consistently suppressed while typing. A shared `isTypingInInput()` guard covers inputs, textareas, selects, `contenteditable` regions, and ARIA comboboxes across the board and schedule shortcut handlers — so a `?` typed into the resource-search combobox no longer opens the cheatsheet, and pressing Enter to submit a filter field no longer starts a keyboard reschedule on the selected Gantt task.
- The Export / Transfer ownership / Delete workspace buttons on Workspace → Settings → Archive / Delete are now disabled (with an explanation linking the tracking issue) until their backing endpoints ship — previously they looked live but did nothing, a foot-gun next to an irreversible delete action.
- Project and program Settings forms now refresh their fields when you switch to a different project or program; previously the form stayed on the first one you opened.
- **Settings navigation jumped when switching scope**: opening **Program** settings used to push the Scope switcher and the whole settings menu ~100px down the page (the program header and Overview/Backlog/Projects/Members tabs were drawn above it), so switching between Workspace, Program, and Project settings relocated the very controls you use to switch — you had to re-scan the page to find them. Program settings now opens as a focused view, like Workspace and Project, so the settings menu stays in the same place across all three scopes.
- **Switch which program or project you're editing from settings**: the context pill in the settings sidebar is now a switcher — click it to jump straight to another program's (or project's) settings without leaving the settings area. It keeps you on the same sub-page (e.g. Cadence → Cadence), and the chevron only appears when there's actually somewhere to switch to. The dropdown includes a search box so you can filter by name instead of scanning the list. Previously the chevron was decorative and there was no way to reach a second program's settings.
- **Scope switcher landed on a blank page**: switching the settings Scope to **Program** (or Project) could open a blank/irrelevant page — from a project it jumped to an arbitrary program, and when the workspace had no programs it fell back to a non-settings page. Now the Program scope opens **the project's own parent program** settings; the Workspace scope always opens workspace settings; and when there are no programs (or no projects) that scope is shown disabled with a "No programs/projects yet" hint instead of going blank.
- **Settings layout shift**: the shared settings shell now reserves a stable scrollbar gutter on its content panel and sidebar, so a scrollbar appearing on a taller sub-page (e.g. Program General) no longer nudges the page sideways when you move to a shorter one (e.g. Projects or Integrations).
- **Helm deploy crash-loop**: the default chart set `DJANGO_SETTINGS_MODULE` to a non-existent `trueppm_api.settings.production` module, crash-looping every fresh deploy. Corrected to `trueppm_api.settings.prod` and added a `helm template` smoke check to CI so a settings-module typo can no longer pass `helm lint` silently.
- **Documented previously-undocumented production env vars**: `INTEGRATION_ENCRYPTION_KEY` (required once integrations are used), `TRUEPPM_DEFAULT_FILE_STORAGE` / `TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE` (attachments are ephemeral on the local default), and `CSRF_TRUSTED_ORIGINS` (split-origin deploys) are now in `.env.example` and the configuration reference.
- **Design-system polish from the 0.2 audit**: fixed a phantom `text-status-danger` class that rendered the project-notifications error banner in black instead of the critical color; replaced an invisible white focus ring on the Schedule error-retry button with the brand-primary ring (WCAG 2.4.7); made the workspace/project/program name and description inputs responsive (`w-full max-w-…`) so they no longer overflow at tablet widths; removed prohibited sub-10px text (`text-[9px]` / inline `fontSize: 9`); and removed drop shadows from modals, panels, dropdowns, toasts, and toggle thumbs in favor of borders (design-system rule 1). Also retired "Team tier" wording on the resource-leveling upsell in favor of "TruePPM Enterprise".
- **Accessibility fixes from the 0.2 audit (WCAG 2.1 AA)**: the Schedule/Gantt grid is now reachable by Tab on first load (the first task row is the initial roving-tabindex stop); added a "Skip to main content" link (2.4.1); gave the workspace guest-access and public-sharing toggles descriptive accessible names instead of just "Enabled"/"Disabled" (4.1.2); the workflow color swatches now announce a color name ("Set phase color to Forest green") rather than a raw hex; the Schedule column-visibility dropdown carries the `role="menu"` its trigger promises; the login "Forgot?" link has an accessible name of "Forgot password?"; and the mobile project drawer no longer double-announces "Projects".
- **Real-time gaps after sprint close, roster changes, and project lifecycle events**: closing a sprint with carry-over now broadcasts a `tasks_bulk_mutated` event so connected clients update the carried-over tasks instead of showing them under the closed sprint until a refetch; adding a resource to a project roster now broadcasts `roster_changed` (matching the removal path); and the Schedule/board clients now handle the `project_archived`, `project_unarchived`, `project_transferred`, and `project_hard_deleted` events the backend already emitted (a project changing under a viewer previously went unnoticed until reload).
- **Critical-path dependency arrows render red again**: the Schedule view read an `is_critical` field off the dependency API response that never existed, so every dependency link was treated as non-critical and critical-path arrows lost their highlight. Link criticality is now derived from the two endpoint tasks (an edge is critical when both endpoints are on the critical path).
- **Notification preferences page crash**: the per-user notification preferences page (`/me/settings/notifications/`) no longer crashes with "preferences is not iterable". The `useNotificationPreferences` hook now unwraps the paginated DRF list envelope (`results`) instead of treating it as a bare array.
- **MS Project import preserves the WBS hierarchy**: importing a `.xml`/`.mpp`
  file whose tasks express their hierarchy via `OutlineLevel` with a flat,
  sequential `OutlineNumber` (common in third-party and generated MSPDI files)
  no longer flattens every phase and sub-task into one top-level list. The
  importer now reconstructs the WBS from the outline-level sequence when the
  outline numbers are not dotted, so phases correctly own their sub-tasks.
- Schedule view: right-click no longer freezes after deleting a row. Deleting a task (especially one on the critical path) used to leave the hovered-row id pinned to the now-deleted task, which kept every other row in dimmed/`pointer-events-none` state, and could also orphan the row's context-menu portal when cache invalidation unmounted the row. The result was that subsequent right-clicks on every other row were silently swallowed until a full page refresh. The row now gets the in-flight treatment during delete, the open menu auto-closes, the right-click handler is suppressed for the row being deleted, and the hover-chain id is cleared the moment its target task leaves the list.
- Sync scaling: mobile delta pull now has composite `(project, server_version)` covering indexes on every synced table, turning a near-high-water-mark resync from a full-project row scan into a single index seek (#810); and a sync upload batch now issues one bulk existing-row fetch and one coalesced `tasks_bulk_mutated` broadcast instead of one SELECT and one channel-layer round-trip per row, so a reconnect storm no longer overflows the WebSocket inbox (#809).
- **`trueppm-scheduler` PyPI wheel ships with `LICENSE`**: the wheel previously
  carried only the SPDX string `license = "Apache-2.0"` with no `LICENSE` file,
  putting any redistribution out of compliance with Apache 2.0 §4(a) from the
  first PyPI download. Added `packages/scheduler/LICENSE` and the
  `license-files = ["LICENSE"]` glob to `pyproject.toml`. (Closes #811.)
- **Project status summary collapses to a single aggregate query**:
  `GET /projects/{pk}/status-summary/` previously fired three separate `COUNT`
  queries (task count, at-risk, critical) on the same base queryset, hitting
  the database on every dashboard mount. Folded into one `aggregate()` with
  conditional `Count(filter=…)` expressions — same response shape, two fewer
  round-trips per call. (Closes #812.)
- Query hygiene across the projects/history/resources apps (#821): task-comment and attachment lists no longer issue a redundant per-request membership `.exists()` (already enforced by the permission layer) and prefetch their parent task; the project-detail unresolved-assignee count is folded into the row as a subquery annotation instead of a live `COUNT()`; retro action items prefetch their assignee (removing an N+1 on `assignee_username`); the resource-assignment create reuses a single resource fetch for both the overallocation and skill-fit checks; and the project history summary caps each object type at 5,000 most-recent rows with a `count_truncated` flag so a busy 90-day window can't load unbounded history into memory.
- Developer experience: `packages/web/src/api/types.ts` no longer carries a misleading "Generated by openapi-typescript — run generate:types" header. The file is hand-maintained; the header now says so and warns that running the codegen script would overwrite and break it.
- Accessibility: notification and task-drawer controls now use `focus-visible` rings (no stray focus ring on pointer click), the Schedule task-list row and ARIA grid focus rings are now visible on both light and dark surfaces, and Schedule-view toolbar controls show a visible focus ring in dark mode (WCAG 1.4.11/2.4.7).
- Accessibility: a global offline banner (`role="status"`) now warns you're offline *before* a write fails (#834); the task-detail drawer announces `aria-modal="true"` to match its active focus trap (#838); the over-allocated chip is no longer mis-announced as a button (#838); and the Schedule task-list panel splitter is now keyboard-resizable (Arrow / Home / End) with proper `aria-valuenow`/`min`/`max` semantics (#838).
- Schedule view: critical-path task rows now show a plain-English tooltip explaining the schedule impact, and the board toolbar is pinned to a single fixed-height row.
- Real-time collaboration: task external links, promoted retro suggestions, project API token mint/revoke, and project custom-field changes now refresh live for all connected collaborators instead of requiring a page reload.
- Accessibility (WCAG 2.1.1 / 2.4.3 / 4.1.2): the desktop task form now traps focus, sets initial focus, and restores focus to its trigger on close (via a new shared `useFocusTrap` hook generalized from the mobile sheet); the board card overflow menu and its "Move to…" submenu are now keyboard-navigable (Arrow / Home / End to move, Escape to close and return focus to the trigger); the dirty-discard prompt now uses the ARIA-managed `ConfirmDiscardDialog` instead of an unmanaged `window.confirm`; the Assignees/Predecessors search results are a plain list (not a mislabeled `listbox`); and the Assignees/Predecessors sections are programmatically labelled via `role="group"` + `aria-labelledby` (#838).
- Board: the card actions (⋯) menu trigger now meets the 44×44px minimum touch-target size on mobile.
- Program members now carry `joined_at` and `role_changed_at` access-evidence timestamps, matching project members. Previously `ProgramMembership` was missing these fields despite ADR-0070 stating it mirrors `ProjectMembership` exactly, so the program members view could not answer "who has access and since when".
- Project-start floor now respects working days: when a project starts on a weekend or holiday, the "Schedule before the project start?" prompt and its **Snap to project start** action target the first working day (e.g. the following Monday) instead of the non-working start date — so snapping no longer re-trips the guard. The dialog names the working-day floor when it differs from the literal start date.
- Fixed the app failing to load data after a page reload or deep-link. Since the access token is now held in memory only, a fresh page load began unauthenticated and recovered only via per-request 401 retries — a 401 storm that did not reliably rehydrate the page. The app now mints an access token from the refresh cookie on startup, before rendering, restoring instant data load on reload.
- **Board view scroll**: the active-sprint summary (burndown chart + velocity
  sparkline) at the top of the board now scrolls with the cards instead of
  staying pinned above them. The panel previously consumed permanent vertical
  space, leaving the phase grid short and difficult to scroll on smaller
  viewports. The toolbar, workshop banner, and "My tasks" filter chip remain
  fixed above the scroll region.
- Design system: semantic badge/card fills now use the dark-mode-correct `-bg` tokens instead of the `bg-semantic-*/N` opacity modifier (#830); program backlog text is raised to the 12px floor (#831); and disabled controls in Settings use the accessible disabled treatment instead of half-opacity text that failed WCAG 1.4.3 (#833).
- Documentation: corrected the risk-register "CSV import" claim (it is CSV export), fixed 22 broken `/architecture/adr/` links to `/architecture/decisions/`, aligned the baselines roadmap reference (0.5), and fixed a present-tense Helm note for the unshipped 0.2 release.
- Fix docs site legibility (aside text invisible in dark mode), add `/api/schema/swagger-ui/` URL alias for drf-spectacular standard path, and add v0.1.0-alpha.1 version to the docs version selector.
- Corrected the **Email & SMTP** settings page so it no longer states that SMTP transport is configured via environment variables / Helm values — that binding is not yet wired (tracked in #764).
- **Homepage layout**: "Why TruePPM?" feature cards were vertically staggered, causing right-column cards to render offset lower than left-column cards. Removed the `stagger` prop to restore a uniform 2×2 grid.
- Made the incremental CPM benchmark test deterministic by asserting on the number of rows passed to `Task.objects.bulk_update` instead of a wall-clock budget. The previous wall-clock assertion was flaky on shared CI runners (sustained-slow phases defeated best-of-N sampling); the new assertion is immune to runner noise and gives a sharper regression signal — a regression to the full-write path is now caught by an order-of-magnitude row-count increase rather than a single millisecond threshold.
- Resolved conflicting `projects` migration leaves on `main` after `#521` and the `#520`/`#528` merge migration both landed at `0042`. Adds an empty `0043` merge migration that depends on both leaves so `makemigrations --check` passes.
- Program → Projects: the "Add existing", "New project", and "Remove" controls are now correctly limited to program Admins and Owners (they were previously shown to all members, whose actions then failed server-side).
- **Schedule: open task details by double-clicking a bar**: double-clicking a task
  bar, milestone, or summary rollup on the Schedule timeline now opens its detail
  drawer. The engine already emitted a `task-open` event on double-click, but the
  Schedule view never subscribed to it, so the only affordance over a bar was the
  `grab` cursor for dragging — there was no way to reach a task's details from the
  timeline. A quiet "Double-click a task to open its details" hint was added to the
  schedule legend for discoverability. Single-click still selects (ring +
  dependency-chain highlight) without opening the drawer.
- Fix `seed_demo_project` command so superusers automatically receive project memberships in both seeded projects, making the demo immediately usable when logged in as admin without needing to use a persona account.

### Security

- **Inbound sync IDOR guard now structurally enforced**: the project-ID/token mismatch check on `POST /api/v1/projects/{id}/task-sync/` is enforced by a new `IsTokenForProject` DRF permission class rather than by view-body ordering. A token issued for project A cannot be used to upsert tasks into project B regardless of URL; mismatches return 401 to avoid leaking project existence.
- **Audit log `source_ip` restricted to Project Manager+**: the `GET /api-token-audit/` endpoint now redacts `source_ip` for callers below the Project Manager (Admin) role. Integration system IP addresses are infrastructure metadata; exposing them to Viewer-level members was an unintended information leak.
- **`SECRET_KEY` length enforced at boot** — production settings now refuse to start when `SECRET_KEY` is shorter than 32 characters or carries the Django `django-insecure-` placeholder prefix. Mitigates PYSEC-2025-183 for self-hosters who would otherwise sign JWTs (via SimpleJWT, which inherits `SECRET_KEY` as its `SIGNING_KEY`) with a trivial HMAC key. A new Django system check tagged `security` also surfaces the same error under `manage.py check --deploy`. See `docs/administration/secret-key.md` for the generator command and verification recipe.
- **Project notification preferences reject and purge unknown keys**: a one-shot migration strips any invalid event-type or channel keys persisted into a preference matrix before key validation shipped, and the read path now filters them out so attacker- or typo-supplied keys can never leak into the API response or mislead the delivery router (e.g. by colliding with a real event key or raising on lookup).
- **Integration PATs are now verified against the provider before they are stored.** Connecting or rotating a credential on `POST /api/v1/me/credentials/<provider>/` previously encrypted and stored any non-empty string without checking it. The GitLab and GitHub providers now ping their `/user` endpoint with the token before persisting; a wrong, expired, wrong-scope, or wrong-host token (e.g. a github.com PAT pasted into the GitLab slot) is rejected with `422 provider_verification_failed` and the row is never written. A new SSRF-guarded egress helper (`apps/integrations/http.py`) resolves the target host and refuses any URL that resolves to a private, loopback, link-local, or cloud-metadata address, so a self-hosted `base_url` cannot be used to probe internal services. The `generic` provider keeps a no-op verifier (accepted, unverified).
- Hardened `trueppm-scheduler` against a degenerate calendar whose `exceptions` blanket the schedule. `monte_carlo()` previously walked its working-day index past the representable date range and raised an uncaught `OverflowError` (a synchronous-request DoS), while `schedule()` rejected the same input cleanly — the two entry points have been reconciled. `_validate_project` now probes calendar reachability from the project start (matching the Rust WASM engine's `validate_project`), and the inner working-day walks are individually guarded, so every path raises a documented `InvalidScheduleInput` instead of spinning. Added regression coverage on both `schedule()` and `monte_carlo()` for full-blanket and single-working-day-then-blanket calendars, and the cross-engine invalid-fixture conformance suite now exercises `monte_carlo()` as well as `schedule()`. Both engines also now reject duplicate task IDs at validation instead of emitting a corrupt result in which the shadowed task carries all-`None` CPM dates.
- Hardened the `trueppm-scheduler` engine against adversarial input. Degenerate calendars (no working day, or holiday exceptions blanketing the schedule), out-of-range or negative task durations and dependency lag, an excessive cumulative project span, non-positive Monte Carlo run counts, cyclic summary-task hierarchies, and non-finite JSON literals (`NaN`/`Infinity`) are now rejected eagerly with a clear `InvalidScheduleInput`/`ValueError` instead of spinning the CPU for millions of iterations and raising an uncaught `OverflowError`/`RecursionError`. The same bounds are enforced at the API edge (`Task.duration`, `Dependency.lag`, `Calendar.working_days`), and the Monte Carlo endpoint maps any residual date-range overflow to a 400, so a crafted project can no longer tie up the synchronous simulation request path. The WASM scheduler validates the same inputs up front so a degenerate or oversized project returns a catchable error rather than panicking the engine in the browser.
- Outbound webhook deliveries are now validated against the SSRF guard: a webhook URL that resolves to a private, loopback, or link-local address (e.g. cloud metadata at `169.254.169.254`) is rejected at registration and blocked at delivery time. Closes #768.
- Editing a project's settings (name, description, color, dates, calendar) now requires the Project Manager role or above. Previously any project member — including read-only Viewers — could modify project-level settings. Closes #769.
- The JWT login endpoint (`POST /api/v1/auth/token/`) is now rate-limited per client to bound password-guessing attacks; excess attempts receive HTTP 429. Closes #770.
- MS Project XML import now parses with `defusedxml`, rejecting entity-expansion / XXE payloads in uploaded files. Production deploys also gain `SECURE_CONTENT_TYPE_NOSNIFF`, `SECURE_REFERRER_POLICY`, an opt-in `SECURE_SSL_REDIRECT` (with the `/health/` and `/edition/` probes exempt), and configurable `CSRF_TRUSTED_ORIGINS`. Closes #771.
- Production now refuses to boot when task attachments would be stored on ephemeral local disk (which loses uploads on container/pod restart). Point `TRUEPPM_DEFAULT_FILE_STORAGE` at a remote object-storage backend (S3/MinIO), or set `TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true` when local storage is backed by a persistent volume. Closes #775.
- **Webhook delivery follows redirects (SSRF bypass)**: outbound webhook
  delivery in `webhooks/tasks.py` re-used the default `urllib` opener, which
  follows 3xx redirects. A malicious receiver returning `302 Location:
  http://169.254.169.254/...` (cloud metadata) or an RFC1918 host would re-fetch
  the request without re-running the `assert_url_allowed` SSRF guard — and on a
  307/308 the original signed HMAC payload would replay against the internal
  target. Delivery now uses a no-redirect opener shared with the integrations
  egress chokepoint. (Closes #808.)
- Real-time sessions are now evicted the moment a project membership is revoked: soft-deleting a `ProjectMembership` or demoting a member below the Member role pushes a `connection.evict` to the project's board and workshop WebSocket groups, closing that user's live sockets (code 4003) instead of letting them keep receiving CPM/task/presence updates until they disconnect (#813 — the active-connection analog of the reconnect-time fix #419).
- **JWT refresh endpoint throttle**: `POST /api/v1/auth/token/refresh/` was
  wired bare — the login endpoint had a 10/min throttle (#770) but refresh did
  not. A leaked refresh token could be exchanged for access tokens at unlimited
  rate. Added `ThrottledTokenRefreshView` with a `60/min` scoped throttle,
  mirroring the login pattern. (Closes #814.)
- `GET /users/search/` no longer returns user email addresses (it still matches on email so invite-by-email works), now requires active workspace membership, and is throttled per user at 60/min — closing a PII-harvesting surface where any single authenticated account could paginate the typeahead to dump every workspace email (#815, ADR-0061 amended).
- **MS Project uploaded filename is sanitized on write**: `UploadedFile.name` is
  attacker-controlled (multipart `Content-Disposition`), and the provenance
  endpoint added in #799 surfaces this field in the API response. Names with
  path components, HTML metacharacters, header-injection sequences, or control
  characters are now stripped at write time so downstream renderers can rely on
  the stored form. (Closes #816.)
- **Local-dev attachments dir gitignored**: `packages/api/attachments/` and
  `packages/api/media/` are now excluded from the working tree. A distracted
  `git add -A` could previously land developer-machine PII blobs in a commit.
  (Closes #817.)
- **Soft-deleted memberships no longer leak read access on velocity and task-run
  list endpoints**: `VelocitySuggestionViewSet.get_queryset` and
  `GlobalTaskRunViewSet.get_queryset` both built their scoping subqueries from
  `ProjectMembership.objects.filter(user=user)` without `is_deleted=False`. A
  user whose membership was soft-deleted could still read velocity suggestions
  and task-run history for projects they were removed from via the list
  endpoints; the write paths (accept/dismiss, cancel) were already gated
  through `_membership_role()` which filters soft-deleted. Closing the
  sibling leak in `taskruns` while the audit pattern is fresh — surfaced by
  the pre-MR security-review pass. (Closes #819.)
- Hardened the Helm chart for secure-by-default installs: auto-generated PostgreSQL and Valkey passwords persisted in a chart-owned connection Secret, Valkey auth on by default, `DATABASE_URL`/`REDIS_URL` injected via `secretKeyRef` (never rendered in plaintext), restricted container security contexts (`readOnlyRootFilesystem`, dropped capabilities, seccomp), default resource limits, `automountServiceAccountToken: false`, and an opt-in NetworkPolicy restricting datastore ingress to the API and worker pods.
- Fixed a cross-project IDOR in the mobile sync upload: a `created`-bucket row whose client-generated id collided with a task in another project could be mutated under the caller's role on the URL project. The upsert lookup is now scoped to the target project, and a cross-project id collision returns 409 (regenerate the id).
- The project board and workshop WebSocket consumers now resolve the authenticated user with `is_active=True`, so a deactivated account holding a still-valid JWT can no longer keep receiving real-time events until its token expires.
- Enforce the configured password policy when accepting a workspace invite, so weak passwords can no longer be set on the unauthenticated invite-accept path.
- Prevent a workspace Admin from deactivating or changing the role of a peer Admin or an Owner; you can now only modify members ranked below your own role.
- Resource emails are no longer exposed to non-admin callers on the resource catalog, and the list endpoint is now per-user rate-limited, preventing org-wide email harvest.
- Task attachment filenames are now sanitized on upload, preventing stored XSS and HTTP header injection via crafted file names.
- Webhook signing secrets now require at least 32 characters (auto-generated when omitted) and are returned only once on creation, hardening delivery signature verification.
- Sync upload batches are now deduplicated per actor: `SyncBatch` gained an `actor_user` foreign key and uniqueness is scoped to (project, actor, client_batch_id), so a member reusing another user's `client_batch_id` can no longer replay and read back that user's stored response (task ids, server_versions, watermark).
- The workshop WebSocket relay no longer forwards arbitrary client payloads verbatim: `receive_json` now drops frames over 4 KB, enforces a per-user message-rate limit, and only relays an allowlist of known event types, closing a denial-of-service amplification vector.
- CPM `cpm_complete`, `task_dates_updated`, and `cpm_error` board broadcasts are now deferred with `transaction.on_commit` and wrapped with their database writes in a single transaction, so clients can no longer receive schedule dates from a recompute whose persistence subsequently rolled back.
- JWT refresh tokens now ride in an httpOnly, Secure, SameSite=Strict cookie (read from the cookie at the refresh endpoint, never localStorage), the access token is held in memory only, and a strict Content-Security-Policy header (including frame-ancestors 'none') is sent on every response.
- Block `javascript:`/`data:` and malformed URLs in task external links and pinned attachments so they can no longer execute or crash the row render.
- Validate the login `next` redirect parameter as a same-origin relative path to prevent open-redirect attacks.
- Reject invite acceptance for a deactivated workspace member (no silent reactivation) and clear the raw invite token when email delivery fails terminally.
- Refresh-token rotation and logout now actually revoke the previous refresh token. The `token_blacklist` app ships in `INSTALLED_APPS` by default, so a rotated or logged-out refresh token is rejected on replay instead of remaining valid for its full 7-day TTL. A nightly Celery Beat job (`flushexpiredtokens`) keeps the blacklist tables bounded. Completes the httpOnly refresh-cookie security control from #897.

## [0.1.0-alpha.1] — 2026-05-12

**Main part: the scheduling-first foundation.** The first OSS alpha — the
foundation for self-hosted, scheduling-first PPM: the CPM engine, Monte Carlo,
the canvas Gantt, board/sprints, the risk register, MS Project import/export,
5-role RBAC, real-time sync, and the Helm chart.

### Added

- **Idempotent task framework** (issue #63): reusable `@idempotent_task` decorator in
  `trueppm_api.core.idempotent` that wraps `@shared_task` with Redis distributed locking.
  Supports three contention strategies (`retry`, `skip`, `queue`), automatic lock extension
  via daemon thread with Lua compare-and-extend script, and an import-time lock key registry
  that catches accidental collisions. `recalculate_schedule` migrated from hand-rolled Redis
  lock to `@idempotent_task(on_contention="queue")`; `purge_old_history_records` now uses
  `@idempotent_task(on_contention="skip")` for global lock protection. ADR-0018.
- **Resource utilization hook wired to API** (issue #14): replaced stub
  `useResourceUtilization` with a real TanStack Query hook that calls
  `GET /api/v1/projects/{pk}/utilization/`. Handles 409 (schedule not run) and
  403 (permission denied) responses with distinct status values. The backend
  models (`Resource`, `TaskResource`), `compute_utilization()` function, and full
  frontend component tree were already implemented — this wires the last connection.
- **Board / Kanban view** (issue #21): four-column drag-and-drop board view (To Do,
  In Progress, On Hold, Done) built with @dnd-kit. Cards can be dragged between columns
  to update task status via API PATCH. Keyboard move alternative via overflow menu
  "Move to..." submenu (WCAG 2.1.1). Mobile horizontal snap scroll with dot indicator.
  `TaskStatus` type added to frontend `Task` interface. Wired into ProjectShell view
  switcher and BottomNav. ADR-0013.
- **Celery task hardening** (issue #62): all Celery tasks now have retry policies
  (exponential backoff + jitter for transient errors), time limits (CPM: 480s/600s,
  purge: 300s/360s), and dead-letter tracking via new `FailedTask` model. Admin API
  at `/api/v1/admin/failed-tasks/` for list/retry/dismiss. Task lifecycle Django
  signals (`celery_task_started`, `celery_task_succeeded`, `celery_task_failed`,
  `celery_task_retried`) bridged from Celery framework signals — enterprise extension
  point. Re-queue loop in `recalculate_schedule` capped at 5 attempts. Beat schedule
  format fixed (was malformed dict, now proper `crontab` object). ADR-0017.
- **MS Project import/export** (issue #10): new `msproject` Django app supporting
  `.xml` import/export and `.mpp` import (via MPXJ subprocess). Parses tasks with
  full WBS hierarchy (`OutlineNumber` → `wbs_path`), all four dependency types
  (FS/SS/FF/SF + lag), milestones, percent complete, notes, resources (case-insensitive
  name matching, creates new if unmatched), and resource assignments. Export produces
  standards-compliant MS Project XML with sequential UIDs, predecessor links, resources,
  and assignments. Async import via Celery with TaskRunTracker progress reporting and
  CPM recalculation on completion. REST endpoints:
  `POST /api/v1/projects/{id}/import/msproject/` (Admin+, multipart file upload, 10 MB max),
  `GET /api/v1/projects/{id}/export/msproject.xml` (Viewer+). Import summary includes
  counts of tasks, dependencies, resources matched/created, assignments, and warnings.
  Round-trip tested: import → export → verify. ADR-0021.
- **Outbound webhooks** (issue #13): per-project webhook subscriptions for external system
  integration. New `webhooks` Django app with `Webhook` and `WebhookDelivery` models.
  Event types: `task.created`, `task.updated`, `task.deleted`, `dependency.created`,
  `dependency.deleted`, `schedule.recalculated`, `project.created`. Delivery via Celery
  with exponential backoff retry (max 5 attempts). HMAC-SHA256 signature in
  `X-TruePPM-Signature` header. CRUD endpoints at
  `GET/POST /api/v1/projects/{pk}/webhooks/`, detail at `/{id}/`, delivery log at
  `/{id}/deliveries/`, test ping at `/{id}/test/`. Admin+ role required for
  create/update/delete; Viewer+ for listing. Secret field is write-only. ADR-0019.
- **Long-running task progress tracking** (issue #64): new `taskruns` Django app with
  `TaskRun` model tracking every Celery operation's lifecycle (PENDING → RUNNING →
  SUCCESS / FAILED / CANCELLED). `TaskRunTracker` context manager wraps any Celery task
  body and reports progress via `tracker.update(pct, msg)`, debounced to 1 write/second.
  REST endpoints: `GET /api/v1/projects/{id}/task-runs/` (Viewer+), `GET /api/v1/task-runs/{id}/`,
  `POST /api/v1/task-runs/{id}/cancel/` (Admin+), `GET /api/v1/task-runs/active/` (personal
  in-flight view across user's projects). WebSocket events `task_run_started/progress/completed/
  failed/cancelled` broadcast on the project channel. `recalculate_schedule` migrated to use
  `TaskRunTracker`; CPM lifecycle now surfaces as `task_run_*` events in addition to
  `cpm_complete` (kept for compatibility). `TaskRunIndicator` added to `TopBar` — a subtle
  spinner badge visible while any run is active. `ProgressBar` component for inline use in
  import dialogs. `useTaskRun(id)` hook for subscribing to a specific run's events. Nightly
  purge controlled by `TASK_RUN_RETENTION_DAYS` setting (default 30 days). ADR-0020.
- **WASM CPM engine** (issue #39): Rust + petgraph scheduling engine compiled to
  WebAssembly via wasm-pack. Exposes `compute_schedule()` and `incremental_update()`
  for in-browser Gantt drag simulation and future offline mobile scheduling. Shared
  JSON fixture suite enforces Python ↔ Rust parity in CI. 184 KB raw / 81 KB gzip
  bundle. ADR-0015.
- **Task status field** (issue #58): `Task.status` field with four values —
  `NOT_STARTED` (default), `IN_PROGRESS`, `ON_HOLD`, `COMPLETE`. Exposed on all task
  list and detail endpoints; writable via `PATCH /api/v1/tasks/{id}/`. Filter tasks by
  status using `?status=<value>` on the task list. Status is included in the offline
  sync pull endpoint so mobile clients receive it in delta pulls. A
  `task_status_changed` Django signal is emitted whenever the value changes (with
  `old_status` and `new_status` kwargs); Enterprise can attach receivers without
  modifying OSS code. ADR-0013.
- **Monte Carlo simulation API** (issue #54): new synchronous endpoint
  `POST /api/v1/projects/{pk}/monte-carlo/` returns P50/P80/P95 completion dates.
  OSS tier is capped at 1 000 simulations and 500 tasks per run (configurable via
  `MC_SIMULATION_CAP` / `MC_TASK_CAP` settings; set to `None` for Team tier unlimited).
  Exceeding the cap returns HTTP 402 with `{"error": "simulation_cap_exceeded", "tier": "team",
  "message": "..."}`. Requires project Viewer role or above. No database writes; results are
  returned directly. `SimulationCapExceeded` exception added to `trueppm-scheduler` public API.
  ADR-0012.
- **Risk Register** (issue #52): per-project risk tracking with probability × impact severity
  scoring. New `Risk` model (`RiskStatus` choices: OPEN / MITIGATING / RESOLVED / ACCEPTED /
  CLOSED) with soft-delete and `django-simple-history` audit trail. REST endpoints:
  `POST /api/v1/projects/{pk}/risks/` (create, Member+), `GET` (list/retrieve, Viewer+),
  `PATCH`/`PUT` (update, Member+), `DELETE` (soft-delete, Owner only). `severity` is computed
  as `probability × impact` (1–25, never stored). Risks may link to up to 10 tasks in the same
  project via a many-to-many through table (`RiskTask`). Ordering by severity supported via
  `?ordering=-severity`. Status filter via `?status=OPEN`. WebSocket events
  (`risk_created`, `risk_updated`, `risk_deleted`) broadcast on commit.
  `Risk` is included in the offline sync pull endpoint
  (`GET /api/v1/projects/{pk}/sync/`) with task IDs serialized as a flat UUID list
  (`task_ids`) on the risk payload — mobile clients receive risk changes in the same
  delta pull as tasks and memberships. A `risk_changed` Django signal is emitted on
  every probability, impact, or status change and on soft-delete; Enterprise can attach
  portfolio rollup receivers without modifying OSS code.
- **Risk Register web UI** (issue #52): `Risks` tab added to the project view switcher
  (ViewTabs desktop + BottomNav mobile). The register shows a sortable table with
  WCAG-compliant severity chips (CRITICAL/HIGH/MEDIUM/LOW/MINIMAL), status badges, and a
  5×5 probability × impact matrix that highlights occupied cells. Desktop: risk detail
  opens in a 480px right-side drawer. Mobile: 85vh bottom sheet with drag handle.
  Create/edit form; mobile FAB above the nav rail. All rules 86–90 from
  `packages/web/CLAUDE.md` are enforced.
- **Web authentication**: JWT login page (`POST /api/v1/auth/token/`), `RequireAuth`
  route guard (redirects to `/login?next=` when unauthenticated), and single-flight
  token refresh interceptor (coalesces concurrent 401s, retries originals, dispatches
  `auth:sessionExpired` on refresh failure). All routes except `/login` are protected.
  Dead placeholder routes (`/board`, `/list`, `/calendar`, `/resources`) removed; `*`
  catch-all redirects to `/gantt`. `useGanttTasks` and `useProjects` now call the live
  API (fixture stubs removed).
- **Object change history** (issue #51): every user-initiated mutation to `Task`, `Project`,
  and `Dependency` is now recorded via `django-simple-history` with field-level diffs (old
  value, new value, who changed it, when). CPM output fields (`early_start`, `early_finish`,
  etc.) are excluded. New endpoints: `GET /api/v1/projects/{pid}/tasks/{task_id}/history/`,
  `GET /api/v1/projects/{pid}/history/`, and `GET /api/v1/projects/{pid}/history/summary/`
  (mutation counts by field and object type, 5-minute Redis cache with `?refresh=1` bust).
  `history_user` details visible to Owner/Admin only; Viewer/Member receive null. Nightly
  Celery purge task controlled by `HISTORY_RETENTION_DAYS` setting (default 90 days; `None`
  disables purging for enterprise unlimited retention). Closes issue #12 (superseded).
  Enterprise extension point: `history_record_created` Django signal fires after each record
  save for cold-storage archiving without OSS modification.
- **Calendar view** (issue #55): a month/week calendar overlaid with fragment chips for each
  task. Tasks that span multiple weeks are split into contiguous chip fragments per row so
  no task is ever truncated mid-week. Milestones render as ◆ diamond chips (using the
  explicit `is_milestone` field — never inferred from `duration == 0`). Critical-path tasks
  use `semantic-critical` color; complete tasks use `semantic-on-track`; normal tasks use
  `brand-primary`. Up to 4 chip lanes per week row via greedy interval scheduling; overflow
  shows "+N more". Month and week toggle stored in `?calView=` URL param. Prev/Next/Today
  navigation with anchor stored in `?calAnchor=`. Accessible: chips are `<button>` elements
  with `aria-label` carrying name + CP + milestone status; focus rings WCAG 2.1 AA.
- `Task.is_milestone` field (`BooleanField(default=False)`) on the Task model and serializer.
  Explicit flag preserved from MS Project `<Milestone>` / Primavera P6 `task_type=TT_Mile`
  imports. Inferring milestone status from `duration == 0` is rejected — a 1-day gate
  meeting is a valid milestone without zero duration, and inference breaks round-trip
  fidelity with import sources.
- **`[Gantt · WBS · Table]` view-mode switcher** extended to five tabs:
  `[Gantt · WBS · Table · Calendar · Resources]` — both Calendar and Resources are live views.
- **WBS Tree view** (issue #40): a collapsible hierarchy panel, accessible from the
  `[Gantt · WBS · Table]` view-mode switcher. Rows show WBS number, task name, progress
  bar, duration, and a critical-path (CP) badge. Summary rows use +/− expand/collapse
  toggles (MS Project convention). Tasks can be reordered within a parent via drag-to-
  reorder (`@dnd-kit`); sibling-only constraint enforced client-side. Inline rename via
  double-click or F2. Keyboard accessible: `aria-level`, `aria-expanded`, WCAG 2.1 AA.
- **Task Table view** (issue #40): a virtualized flat-list table (via
  `@tanstack/react-virtual`) of all tasks, sortable by WBS, name, start, finish, duration,
  or progress. Supports bulk-select with checkboxes, a "My tasks" filter toggle, and
  inline rename via double-click or F2. Critical-path rows get a subtle red tint and a CP
  badge matching the WBS view.
- **`[Gantt · WBS · Table]` view-mode switcher** is now fully functional — previously the
  WBS and Table buttons were disabled placeholders. Active view is tracked in the `?view=`
  URL search param so links are shareable and the TanStack Query cache is stable across
  view switches.
- `RecalculatingBadge` in the project toolbar is now live — driven by WebSocket
  `cpm_queued` / `cpm_complete` events so the spinner appears automatically when the
  CPM engine is running and dismisses when recalculation finishes.
- **WebSocket project channel** (`/ws/v1/projects/{id}/?token=…`): the frontend
  establishes a persistent connection for the active project and dispatches incoming
  events to the TanStack Query cache and Zustand scheduler store. Reconnects with
  exponential backoff (1 s → 30 s cap) on drop.
- `schedulerStore` Zustand slice: tracks `isRecalculating`, `cpmError`, and
  `recalculatedAt` state driven by WebSocket CPM lifecycle events.
- CPM engine now broadcasts a `cpm_queued` event to connected clients immediately
  after acquiring the scheduling lock, so the frontend can show the in-progress
  indicator without polling.
- CPM engine broadcasts `cpm_error` with `error: "cyclic_dependency"` (including
  the offending cycle) or `error: "internal_error"` so the frontend can surface a
  meaningful error message rather than a silent stale schedule.
- `useGanttTasks` now fetches tasks and dependencies from the live API
  (`GET /api/v1/tasks/?project=…` and `GET /api/v1/dependencies/?project=…`)
  instead of returning fixture data.
- Playwright E2E test scaffold (`packages/web/e2e/`) with smoke and Gantt tests
- **Baselines** (issue #9): snapshot the current schedule for comparison against actuals.
  `POST /api/v1/projects/{pk}/baselines/` creates a named snapshot of all task
  start/finish dates; auto-names as "Baseline 1", "Baseline 2", … when no name is
  supplied (custom names accepted). Baselines are immutable once created — task rows
  cannot be mutated after snapshot. `POST …/activate/` marks a baseline as the active
  reference; only one baseline can be active per project at a time (enforced at the
  DB level). `DELETE …/{id}/` soft-deletes a baseline (Owner only).
- `GET /api/v1/tasks/` now returns `baseline_start` and `baseline_finish` date fields
  annotated from the active baseline (or an explicit `?baseline=<id>` override).
  Both fields are `null` when no baseline is active or the task was not present in the
  snapshot. Gantt bar rendering uses these fields to draw the 6px baseline ghost bar.
- `Baseline.has_cpm_dates` flag: `false` when the snapshot was taken before the CPM
  engine has run (early start/finish are null). Creation still succeeds — the flag lets
  the UI warn the user that date comparison will be meaningless until the scheduler runs.
- WebSocket project channel now dispatches `baseline_created`, `baseline_activated`, and
  `baseline_deleted` events to all connected clients; the frontend invalidates the
  baselines and tasks cache on receipt.
  that run against the production build in CI; covers shell landmarks, view-mode
  switcher state, task list accessibility, and Gantt legend. New `web:e2e` CI job
  uses the official Playwright Docker image and saves reports as artifacts on failure.
- Test coverage for the Gantt drag CPM preview feature (issue #19): 51 new test cases
  across `dragStore`, `useDragCpm`, `PreviewOverlay`, `MilestoneDeltaTooltip`, and
  `ganttUtils` — covering the full drag state machine, CPM worker seq guard, offline drop
  guard, Escape-key cancellation, CP badge timing (400 ms delay), overflow cap label,
  keyboard instruction strip, origin ghost bar, and `nudgeWorkingDays` edge cases.
- **Resource utilization view** (issue #22): new `Resources` tab in the project view
  switcher shows per-resource daily load as percentage-filled bars, color-coded green
  (< 85%), amber (85–100%), and red (overallocated > 100%). Capacity is calendar-driven
  (`resource.calendar.hours_per_day × max_units`) — part-time workers are represented
  correctly. Default window is ±4 weeks from today; a "Fit to project" toolbar button
  expands to the full project span. A mismatch tooltip (ⓘ) appears on any resource whose
  calendar differs from the project calendar. Permission-gated to Scheduler and above.
- REST endpoint `GET /api/v1/projects/{id}/utilization/` returning per-resource daily
  load hours, contributing task IDs, and `unassigned_task_count` for tasks with CPM
  dates but no resource assignment. Accepts `?start=` and `?end=` date filters; returns
  409 when no CPM dates exist. Permission gate: SCHEDULER (role ≥ 2) and above.
- `Task.hours_per_day` is now included per resource in the utilization response,
  enabling the frontend to compute load percentages without additional API calls.
- Composite database index `task_utilization_window_idx` on `(project, early_start,
  early_finish)` — cuts the utilization window filter from a full project-task scan to
  an index range scan; critical for projects with hundreds of tasks.

- **Short hex object IDs** (issue #50, ADR-0016): Tasks and Risks now receive a
  human-readable 8-character hex identifier (e.g. `000A3F`) on creation, scoped
  per project. Exposed as read-only `short_id` on `TaskSerializer`,
  `RiskSerializer`, and their sync counterparts. Filterable via
  `?short_id=000A3F` on task and risk list endpoints. Existing objects are
  backfilled via data migration.
- `Task.planned_start` field (SNET — start no earlier than): PMs can now set a
  constraint date on any task via `PATCH /api/v1/tasks/{id}/`. The CPM forward
  pass applies it as a floor (`early_start = max(CPM-computed, planned_start)`),
  so constrained tasks cascade correctly to successors. Included in the mobile
  sync delta payload (`SyncTaskSerializer`) so on-device CPM respects the
  constraint offline.
- REST endpoint `POST /api/v1/projects/{pk}/tasks/reorder/` — atomically reorders
  sibling tasks within a WBS level; accepts `parent_path` + `ordered_ids`, recomputes
  `wbs_path` server-side, and returns updated paths so clients can invalidate caches
  without a full refetch. Triggers CPM recalculation and real-time broadcast on commit.
- REST endpoint `POST /api/v1/projects/{pk}/tasks/bulk/` — atomically creates, updates,
  and deletes tasks in a single request; returns `{ created, updated, deleted }` lists.
  Uses `SELECT FOR UPDATE` row-locking to prevent concurrent soft-delete races. Triggers
  CPM recalculation once after all operations commit.
- UI harmonization sprint (issue #44): sidebar, toolbar, and Gantt panel now share a
  consistent dark surface (`#0F1117`). Changes include:
  - Sidebar background migrated from brand-green to the same dark token as the Gantt
    task-list panel; project health labels now use dark-surface semantic color variants
    that meet WCAG 1.4.3 (previously 1.02–1.09:1 contrast — invisible).
  - Sidebar active project row gains a 2px left border as a non-color selection indicator
    (WCAG 1.4.1). "PROJECTS" section header added (rule 36).
  - Gantt toolbar gains a `[Gantt · WBS · List]` view-mode switcher. WBS and List are
    disabled placeholders until those panels ship in a follow-up branch.
  - `ShellStats.recalculatedAt` field: StatusBar now displays a separate
    "Recalculated: N min ago" indicator for the CPM engine, distinct from "Last saved"
    (the data-entry save timestamp).
- `gantt.*` Tailwind token group in `tailwind.config.ts` — `gantt-surface`,
  `gantt-text-primary/secondary`, and `gantt-semantic-critical/at-risk/on-track` now
  emit real CSS. All prior references were silent no-ops.

- Keyboard rescheduling for the Gantt chart (WCAG 2.1.1 gap, issue #34): selecting a task
  and pressing Enter enters keyboard reschedule mode. Arrow keys nudge by 1 working day;
  Shift+Arrow nudges by 5. 'd' opens a date-input popover for precise entry. Enter confirms
  (PATCH), Escape cancels. Preview bars, the CP-flip badge, and milestone delta tooltip all
  render identically to the pointer drag. An origin ghost bar (dashed outline) marks the
  task's pre-nudge position. Screen reader support via separate assertive + polite aria-live
  regions. Offline guard prevents PATCH when `navigator.onLine` is false. Closes #34.
- `nudgeWorkingDays(isoDate, days)` utility in `ganttUtils.ts` — advances or retreats an
  ISO date by N working days (Mon–Fri), skipping weekends.
- `DateInputPopover` component — `role="dialog"` focus-trapped modal for direct date entry
  during keyboard reschedule. Derives finish from start + task duration.
- Design rules 51–53 in `packages/web/CLAUDE.md`: keyboard instruction strip, origin ghost
  bar, and assertive aria-live region requirements for keyboard rescheduling.
- Canvas Gantt renderer Phase 1 (issue #19): replaces `@svar-ui/react-gantt` with a
  purpose-built HTML5 Canvas 2D renderer. Delivers feature parity with the previous SVAR
  widget plus new capabilities: 3-layer dirty-rect canvas stack (row bands/grid/today line,
  task bars/arrows, drag interaction chrome), row virtualisation for smooth performance at
  500+ tasks, snap-to-day dragging with Shift to suspend snap, resize-handle drag to extend
  task duration, Pointer Events API throughout for unified mouse/touch/stylus support on
  iPad, and a `GanttEngineImpl` class that satisfies the stable `GanttEngine` API contract.
  The `GanttAriaOverlay` transparent DOM layer provides a fully virtualised WCAG 2.1 AA
  `role="grid"` structure with roving tabindex and canonical aria-labels over the canvas.
  New UX: timeline loads with today at 25% from the left edge; a "Today" button in the
  toolbar scrolls back to the current date; zoom level changes preserve the viewport center
  date; empty project state shows a prompt instead of a blank canvas; canvas init failure
  shows a plain HTML task table fallback. `ZoomLevel` union now includes `'year'`.
- Canvas Gantt renderer Phase 0 (issue #19): public `GanttEngine` interface and
  `GanttScaleData` coordinate system replacing SVAR's private `_scales` API. Includes
  `dateToLeft`, `leftToDate`, `parseUTCDate`, and `buildScaleData` utilities (DST-safe,
  UTC-only arithmetic). `GanttEngineStub` test double provides compile-time interface
  verification and a no-op implementation for unit tests. Design rules 54–77 added to
  `packages/web/CLAUDE.md` covering canvas architecture, dirty-rect invalidation, row
  virtualisation, drag FSM, Pointer Events API, ARIA grid overlay, and performance budgets.
- Monte Carlo tooltip plain-language summary: "8 in 10 simulations finish by **[date]**"
  appears at the top of the histogram tooltip (P80 as anchor). Closes #31.
- At-risk and critical count badges in TopBar are now clickable buttons — click opens a
  popover listing affected tasks (WBS · name); clicking a task selects and scrolls to it
  in the Gantt. `BadgePopover` component with `role="menu"` / `role="menuitem"`. Closes #32.
- Mobile Monte Carlo confidence: P80 chip ("P80: Mon D") added to `StatusBar` for `< md`
  viewports; `MonteCarloLabel` cell shows persistent P80 chip at `md+`; MC confidence bars
  increased to 8px height (was 6px). Closes #33.

- Gantt task list resizable columns (`useColumnWidths` hook): task/duration/start/progress
  columns can be dragged to resize, widths persisted to localStorage. MC label cell
  tracks task list width so the vertical border stays aligned. Closes #44 (column layout).
- Design rules 35–50 in `packages/web/CLAUDE.md`: sidebar dark surface token
  (`gantt-surface`), section header sizing floor, ViewTabs underline vs pill, TopBar
  badge outlined style, dark-surface semantic token overrides (`gantt-semantic-*`),
  GanttToolbar ARIA, StatusBar legend/copy, focus rings on dark surface, Monte Carlo
  RBAC gate, export/print mode, critical-path tooltip, and `text-[10px]` prohibition.
  Derived from five-review design sprint (UX design, architect, UX review, accessibility,
  VoC) for issue #44.
- Monte Carlo confidence display (`packages/web/src/features/gantt/`): P50/P80/P95
  vertical confidence lines below the Gantt split pane, aligned to the SVAR timeline
  date axis via `useSvarScale` (reads `getState()._scales` + `scrollLeft`). Histogram
  tooltip on hover/focus shows the full weekly-bucketed distribution as an SVG
  bar chart with percentile rules. P80 badge in the top bar updated to use
  `semantic-at-risk` tokens and display at `md` breakpoint (was `xl`).
  Hidden on mobile (`< md`). `prefers-reduced-motion` respected.
  Closes #20.
- `useMonteCarloResult` stub hook and `FIXTURE_MC_RESULT` fixture (pre-bucketed
  weekly distribution, ready to swap for a real `useQuery` call).
- `useSvarScale` hook — bridges SVAR's internal scroll/zoom reactive state into
  React state for date-aligned DOM overlays.
- `MonteCarloResult` and `McBucket` types added to `src/types/index.ts`.
- `MC_ROW_HEIGHT = 44` constant added to `ganttConstants.ts`.
- SVAR test stub (`src/test/mocks/svar-gantt.tsx`) extended with `getState`,
  `getReactiveState`, `getStores`, `getTable`, `getTask`, `detach`, `serialize`.
- Monte Carlo design rules added to `packages/web/CLAUDE.md` (rules 17–22).
- Gantt drag CPM preview (`packages/web/src/features/gantt/`, `src/hooks/`, `src/workers/`):
  dragging a task bar spawns a Web Worker that runs an incremental CPM forward pass and
  renders translucent preview bars for all downstream-impacted tasks before the drop is
  committed. Milestone slip delta is shown in a tooltip. Escape cancels the drag.
  Offline guard prevents PATCH when `navigator.onLine` is false. aria-live region
  announces critical-path changes without triggering re-renders.
  Closes #19.
- `buildSubgraph` — extracts the affected task subgraph for incremental CPM.
- `ganttUtils` — shared date↔px math (`dateToLeft`, `dateFromCanvasLeft`) used by both
  PreviewOverlay and MonteCarloTimeline.
- `dragStore` (Zustand) — drag phase, preview results, overflow count.
- `ghost-fill` / `ghost-border` Tailwind tokens (design rules 23–25).
- Drag preview design rules added to `packages/web/CLAUDE.md` (rules 23–34).

- Root `.gitignore` covering Python, pytest, mypy, ruff, Docker override files, and editor
  artifacts. Previously the repo had no root ignore file.
- CI pipeline restructured to 4 stages (lint → analyze → test → security) with a
  per-package DAG (`needs:`). Test jobs now start as soon as their own package's
  analysis passes rather than waiting for all packages to complete.
  New jobs: `web:lint`, `web:type-check`, `web:build`, `web:test`, `web:security`
  (npm audit), `website:build`, npm license check in `license:check`.
  `security:bandit` moved from security stage to analyze stage (it is static analysis
  and does not need test results). `changelog:check` moved to lint stage.

- Gantt view (`packages/web/src/features/gantt/`): split-pane task list (280px, virtualized
  via @tanstack/react-virtual) + SVAR React Gantt timeline. All 6 bar types (normal/critical/
  complete/summary/milestone/baseline ghost). All 4 dependency types (FS/SS/FF/SF). Zoom
  control (Day/Week/Month/Quarter). Scroll sync via SVAR IApi (scroll-chart exec/on).
  Adapter layer (toSvarTasks, toSvarLinks) maps TruePPM types to SVAR ITask/ILink shapes.
  gantt.css scoped to .gantt-root with Design System v1.0 color tokens. Bar labels use
  #1A1917 dark text (WCAG). `readonly={true}` until WASM CPM drag (issue #19). jsdom
  test mock for SVAR canvas component. Closes #18.
- Application shell (`packages/web/`): top bar (48px), collapsible sidebar (220px→60px,
  200ms ease-out), status bar (28px), bottom nav rail at <768px, mobile drawer overlay.
  React Router v7 `createBrowserRouter`, Zustand shell store, stub hooks with fixture data.
  Custom Tailwind breakpoints for Design System v1.0 §7 (xs=320px, sm=375px, 2xl=1440px).
  WCAG 2.1 AA focus rings, aria landmarks, keyboard-navigable sidebar toggle. Closes #17.
- `packages/web/CLAUDE.md` — frontend design rules (no shadows, focus rings, health token
  encoding, touch targets, color dot a11y pattern).
- React 19 + Vite 6 + TypeScript 5 web frontend scaffold (`packages/web/`): TanStack Query v5,
  Zustand v5, Tailwind CSS v3 with TruePPM Design System v1.0 tokens (WCAG-corrected
  `text-secondary: #6B6965`), ESLint 9 flat config with jsx-a11y, vitest, axios API client with
  JWT interceptor, Zustand auth store, placeholder router, nginx Dockerfile, and Docker Compose
  `web` service.
- Rewrote `README.md` for the full monorepo: structure, Docker Compose quickstart, per-package dev commands, CI job table, and contributing guide.
- Docusaurus v3.7 documentation site (`packages/website/`) with getting-started guides, architecture
  overview, feature docs (CPM/Monte Carlo, RBAC, real-time, offline sync), API index, and ADR-0003.
- Nested membership CRUD at `/api/v1/projects/{pk}/members/`: Owner-only create/update/delete with
  role-escalation guard (callers cannot assign roles ≥ their own), last-Owner atomic guard, Viewer self-removal,
  and `member_added` / `member_role_changed` / `member_removed` WebSocket broadcasts.
- Offline delta sync pull endpoint `GET /api/v1/projects/{pk}/sync/?since={server_version}` returning
  WatermelonDB-compatible `changes` + `timestamp`. Snaps the high-water mark before delta queries to
  eliminate TOCTOU gaps. Soft-deleted rows appear as tombstones in `deleted` arrays.
- Soft-delete on `VersionedModel` (`is_deleted`, `deleted_version`): all `perform_destroy` hooks now
  call `soft_delete()` instead of hard-deleting, so mobile clients receive tombstones on the next pull.
- `Dependency` promoted to extend `VersionedModel` (gains `server_version`, `is_deleted`,
  `deleted_version`) so dependency changes are visible to the sync protocol.
- 5-role RBAC (`access` app): `ProjectMembership` through-table with Owner/Admin/Scheduler/Member/Viewer roles;
  `ProjectScopedViewSet` mixin for IDOR prevention; `IsProject*` permission classes wired into all ViewSets.
  Project creators are auto-assigned Owner on creation.
- Auto-scheduling Celery task (`recalculate_schedule`) triggered on every Task/Dependency write via
  `transaction.on_commit`. Idempotency enforced via Redis SET NX lock; lock collisions re-queue with 10s countdown.
- Real-time WebSocket support (`sync` app): `ProjectConsumer` with JWT `?token=` auth; Viewers (role=0) rejected
  with close code 4003; `broadcast_board_event()` helper broadcasts mutation and CPM completion events to all
  connected project clients.
- CI pipeline expanded with `api:type-check` (mypy strict), `api:migration-check`,
  `api:openapi-check`, `changelog:check` (MR-only), `license:check`,
  `security:bandit`, and `security:pip-audit` (MR + main). Coverage thresholds
  enforced: scheduler ≥ 80%, api ≥ 65%. Minio-backed caches keyed on
  pyproject.toml file hash per package. `workflow:rules` prevents duplicate
  branch + MR pipelines.

- CPM scheduling engine (`schedule()`) with forward/backward pass, float calculation,
  and critical-path identification. Supports all four dependency types (FS, SS, FF, SF)
  with calendar-day lag, calendar-aware working-day arithmetic, weekend skipping, and
  holiday exceptions.
- Monte Carlo probabilistic simulation (`monte_carlo()`) using PERT-Beta distributions
  (method-of-moments parameterisation). Vectorised with numpy; 10 000 runs on a
  200-task chain completes in well under 5 seconds. Returns P50/P80/P95 completion
  dates and the full sorted distribution.
- `CyclicDependencyError` exception with the offending cycle exposed as `.cycle`.
- `ScheduleResult` and `MonteCarloResult` dataclasses with `to_dict()` serialisation.
- CLI entry point `trueppm-scheduler` with `schedule` and `monte-carlo` subcommands.
  Supports `--json` output and `--distribution` flag for the full MC distribution.
- 45 unit and integration tests covering CPM correctness, calendar arithmetic,
  all dependency types, float/critical-path computation, cycle detection, and MC
  statistical properties including a performance benchmark.
- Django 5.1 REST API package (`trueppm-api`) scaffolded with src-layout, django-environ
  settings split (base/dev/prod), uvicorn ASGI server, Celery 5.4 task queue, and
  Django Channels 4 WebSocket support.
- Core Django models: `Calendar`, `CalendarException`, `Project`, `Task`, `Dependency`,
  `Resource`, `TaskResource`. All extend `VersionedModel` (UUID PK + atomic
  `server_version` increment) for offline-sync support. `Task.wbs_path` uses a custom
  `LtreeField` with PostgreSQL `ltree` extension and GiST index for hierarchy queries.
- Initial database migration including `CREATE EXTENSION IF NOT EXISTS ltree` and
  GiST index on `wbs_path`.
- REST CRUD endpoints for all core entities at `/api/v1/`: calendars, projects, tasks,
  dependencies, resources, task-resources. Powered by DRF `ModelViewSet` with pagination,
  search, ordering, and field-level filters (project, is_critical, dep_type).
- CPM output fields (`early_start`, `early_finish`, `late_start`, `late_finish`,
  `total_float`, `is_critical`) are read-only on the Task API — set only by the
  scheduling engine.
- `server_version` is read-only on the Project API — enforced at the serializer layer.
- OpenAPI 3.1 schema via drf-spectacular at `/api/schema/`.
- 25 API and model tests using `pytest-django` with testcontainers for local PostgreSQL
  (falls back to `DATABASE_URL` env var in CI).
- Helm 3 chart (`packages/helm/`) with Bitnami sub-charts for PostgreSQL and Redis;
  separate `values-dev.yaml` and `values-prod.yaml` overlays.
- Docker Compose dev environment (`docker-compose.yml`) with db, redis, api, and
  celery-worker services; non-root `trueppm` user in the API Dockerfile.
- GitLab CI jobs for API lint, API tests (with PostgreSQL + Redis service containers),
  and Helm lint.

- `Task.assignee` field (nullable FK to the user model) — Team Members can now be
  assigned to tasks via `PATCH /api/v1/tasks/{id}/` with `{ "assignee": "<uuid>" }`.
  The field is included in all task list and retrieve responses.
- `role_label` field in membership list/retrieve responses (`GET /api/v1/projects/{pk}/members/`)
  — returns the human-readable role name (e.g. `"Project Manager"`) alongside the integer
  `role` ordinal. Display-only; not accepted on write.

### Changed

- Web UI polish: replaced emoji nav icons with inline SVG icon set (`GanttIcon`,
  `BoardIcon`, `ListIcon`, `CalendarIcon`, `ResourcesIcon`); added geometric logo
  mark; top bar alert badges use `WarningIcon`/`CriticalDotIcon` instead of raw
  Unicode; task list rows show a mini progress bar instead of plain percentage text;
  status bar uses 1px vertical dividers instead of · dots; Monte Carlo histogram
  tooltip formats ISO dates as "Mon D"; MC confidence bars increased 4px → 6px with
  even vertical spacing; placeholder views show a blueprint grid SVG.

- Scheduler moved from repo root (`src/trueppm_scheduler/`, root `pyproject.toml`) into
  `packages/scheduler/` — all packages now live under `packages/`. Updated everywhere:
  `packages/api/Dockerfile`, `.gitlab-ci.yml`, `.pre-commit-config.yaml`, `CLAUDE.md`,
  `README.md`, and `packages/website/docs/architecture/overview.md`.
- Duplicate `docs/adr/0003-rbac-auto-scheduling-websockets.md` removed — canonical copy
  is `packages/website/docs/adr/0003-rbac-auto-scheduling-websockets.md`.
- Design System HTML moved from `docs/design/` to `packages/website/static/design/` so
  Docusaurus serves it at a stable URL.
- Mobile references removed from `CLAUDE.md`, `README.md`, and `docs/architecture/overview.md`.
  Mobile is not yet started; dead references erode doc trust. Will be re-added when
  `packages/mobile` is scaffolded.
- `README.md` web section updated to clearly state what is built vs what is not yet built.
- `docs/architecture/overview.md` system diagram updated to show current client topology
  (web only; offline-first sync protocol noted as designed for future clients).
- Gantt view added to Docusaurus sidebar (`features/gantt`).

- Role labels updated to PM-standard terminology (integer ordinals are unchanged — no data
  migration required): `"Member"` → `"Team Member"`, `"Scheduler"` → `"Resource Manager"`,
  `"Admin"` → `"Project Manager"`, `"Owner"` → `"Project Admin"`.
- Task write permissions now enforce the full 5-role model (issue #11): Team Members may
  only edit tasks where they are the assignee; Resource Managers cannot edit task content
  (read-only for task fields); Project Managers and above can edit any task.
- Dependency create/update/delete now requires Resource Manager role or above — previously
  any Team Member could modify scheduling dependencies.

### Fixed

- **Auth 401-retry race on login**: after logging in, TanStack Query retried stale 401 errors before the new token was stored, causing a persistent "Failed to load projects" screen. Fixed by gating renders on Zustand hydration, clearing the query cache on login, suppressing 401 retries at the query level, and redirecting to `/login` on session expiry via a custom event.
- **Sidebar blank on API failure**: when the projects API returned an error (e.g. 401 while unauthenticated), the sidebar rendered completely blank with no message. Now shows "Failed to load projects" in the error state.
- **Risk register: add risk fails silently**: `POST /api/v1/projects//risks/` 404 when `projectId` was empty string — `RiskRegisterView` now returns early with a "Select a project" prompt instead of rendering the broken form. API errors (400, 403, 404) are now surfaced in the form as a visible error banner.
- **Gantt blank rendering on unscheduled tasks**: tasks with null `early_start`/`early_finish`
  dates produced `Invalid Date` / NaN canvas coordinates, causing both the task list and
  timeline panels to render as blank boxes. Engine now filters unscheduled tasks from
  range calculation and rendering; task list shows duration without a start date.
- Switching view tabs (Gantt / WBS / Table / Calendar / Resources) no longer drops the
  `?project=` URL search param, which previously caused the active project to be lost on
  every view switch.
- Celery worker container failed to start in Docker Compose — `packages/api/Dockerfile`
  used `ENTRYPOINT` for uvicorn, causing docker-compose `command` overrides to be
  appended as uvicorn arguments instead of replacing the command. Changed to `CMD`
  so `docker compose run` and `command:` overrides work correctly for celery, migrations,
  and any other management commands.
- **Gantt canvas rendering** (issue #19 follow-up): four visual bugs fixed.
  Task bars were painted 28 px too high (no `HEADER_HEIGHT` offset), alternating row
  bands drifted away from their rows on vertical scroll (`drawRowBands` ignored
  `scrollTop`), dependency arrows disconnected from bars on scroll (`drawDependencyArrows`
  ignored `scrollTop`), and no date labels were shown on the timeline. A two-row
  timeline header (major unit / minor unit) is now drawn in the top 28 px of the
  canvas on every full repaint, matching the task-list header height so rows
  align correctly.

- Badge borders (`at-risk`, `critical`) in TopBar and StatusBar were at 40% opacity
  (1.92–2.04:1 contrast), failing WCAG 1.4.11. Raised to 80% opacity (~4.25:1+).
- Hamburger menu touch target increased from 32×32px to 44×44px (WCAG 2.5.5).
- StatusBar online-user count was gated behind the `2xl` (1440px) breakpoint; changed
  to `lg` (1024px) per design spec.
- Gantt task-list column layout: separate Duration and Start columns merged into a single
  "Dur · Start" column (`{n}d · {MMM D}`, 100px). Mini progress bar removed from the `%`
  column — text percentage only.
- Two runnable Jupyter notebooks for `trueppm-scheduler` (issue #38):
  `01-cpm-quickstart.ipynb` covers project definition, CPM run, float table,
  custom calendar with holiday, SS dependency with lag, cycle detection, and
  JSON round-trip; `02-monte-carlo.ipynb` covers PERT three-point tasks, P50/P80/P95
  output, matplotlib histogram with percentile lines, and scenario comparison.
  Also corrects the scheduler API reference in `docs/features/scheduler.md` —
  the previous doc used constructor signatures that do not exist
  (`Calendar(id=, name=, working_days={set})`, `schedule(project, tasks, deps, cal)`).
- PyPI publish pipeline for `trueppm-scheduler` (issue #37): pushing a git tag
  `scheduler-vX.Y.Z` triggers a new `publish` stage that builds an sdist + wheel
  via `python -m build` and uploads to PyPI via `twine`. A version-consistency
  guard fails fast if the tag version does not match `pyproject.toml`. Requires
  a `PYPI_TOKEN` CI/CD variable (masked + protected). Built artifacts are kept
  as GitLab CI job artifacts for 7 days.

- Gantt task list expand arrow was pointing backwards — disabled SVAR's built-in task list
  panel (`columns={false}`) so only our custom panel renders. Closes #47.
- Gantt task list columns (Task / Dur / Start / %) are now drag-to-resize with widths
  persisted to localStorage (`useColumnWidths` hook). Closes #48.
- Gantt bar grid columns were misaligned with the header row — root cause was SVAR rendering
  a duplicate header; fixed by the same `columns={false}` change. Closes #49.
- `text-[10px]` and `fontSize={9}` violations in `MonteCarloTimeline` and `MonteCarloHistogram`
  replaced with `text-xs` / `fontSize={12}` (design rule 50 — 12px floor). Fixes WCAG 1.4.3.
- `StatusBar` legend items now use semantic Tailwind tokens (`bg-semantic-on-track` etc.)
  instead of hardcoded hex colors (design rule 8). Legend updated to match rule 44 (Complete /
  In progress / Critical path / ◆ Milestone). Last-saved format corrected to `"min"` not `"m"`
  (design rule 45).
- Rule 39 in `packages/web/CLAUDE.md` corrected: at-risk/critical badge buttons use
  `aria-haspopup="menu"` not `"listbox"` (listbox implies value-selection; these navigate).
- Gantt task list panel was rendering with a white background against the dark canvas
  timeline, creating a jarring split. `TaskListPanel`, `TaskListHeader`, and `TaskListRow`
  now use `gantt-surface` tokens throughout: `bg-gantt-surface` background,
  `text-gantt-text-primary/secondary` labels, `text-gantt-semantic-critical` for critical
  path tasks, `bg-white/10` selection highlight, and `bg-gantt-semantic-critical` progress
  fill. Also fixes a `fontSize:10px` inline style to `text-xs` (design rule 50).

- `scheduling/tasks.py` `bulk_update` comment expanded to explain WHY `server_version` is
  intentionally not incremented for CPM field writes (prevents spurious mobile sync deltas).

- `VersionedModel.save()` no longer overwrites the atomically-incremented
  `server_version` via `super().save()`. The subsequent `UPDATE` now excludes
  `server_version` via `update_fields`, preserving the F()-expression increment.
  Without this fix, `server_version` was always 0 on update — breaking the mobile
  sync protocol entirely.
- `DependencySerializer` now validates that predecessor and successor belong to the
  same project. Cross-project edges produced undefined CPM behaviour; they now return
  HTTP 400.
- `scheduling` and `sync` app URL modules are now included in the root URL conf.
  Previously, any endpoint added to either app would silently 404.

### Security

- Added `IsProjectMember` permission class (Phase 1 stub) to all ViewSets. Every
  endpoint now requires authentication; object-level project-scoping will be enforced
  in Phase 2 once the `ProjectMembership` model exists.
- Non-member users could create tasks in any project by supplying a known project
  UUID — `TaskViewSet.perform_create` now calls `check_object_permissions` before saving
  (DRF does not call it automatically on create actions).
- Non-member users could create dependencies by supplying known task UUIDs —
  same `check_object_permissions` guard added to `DependencyViewSet.perform_create`.
- Soft-deleted project memberships were incorrectly treated as active in all
  permission checks — `is_deleted=False` filter is now applied consistently to every
  `ProjectMembership` query in the RBAC layer.
- `partial_update` role-change was vulnerable to a TOCTOU race where a
  concurrent demotion of the actor could allow assigning a role equal to or higher than
  the actor's effective role at save time — fixed with `SELECT FOR UPDATE` inside
  `transaction.atomic()`.

