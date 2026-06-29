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

_Nothing yet._

## [0.3.0-alpha.1] — 2026-06-28

**0.3.0-alpha.1 — “the agile team.”** This release makes sprints and agile delivery first-class on top of the CPM schedule: a real sprint container (goal, capacity, burndown) with state-aware planning and closed views, auto-computed velocity with a forecast range, sprint sovereignty (audited mid-sprint scope changes; velocity stays a team metric, never an auto-exposed management gauge), the sprint-to-milestone bridge, agile depth (task-type taxonomy, epic/initiative hierarchy, dual backlog, Product Owner role, acceptance criteria), the hybrid governance/delivery-mode foundation, universal JSON sample-data import/export, and the v2 navy/sage interface refresh (epic #1163).

### Added
ADR-0065: Hybrid Bridge v1.1 — design for CPM velocity feedback (auto-suggest `most_likely_duration` from sprint velocity), "My Work" contributor surface (`GET /me/work/`), and inbound task-sync protocol (`POST /projects/{id}/task-sync/`). Tracking issues #498 #499 #500.
Add MS Project import/export — upload `.mpp` or `.xml` files to import a schedule into an existing project, and export any project as MS Project XML.
- **API reference coverage**: documented the Monte Carlo run/latest/history
  endpoints, the sprint–milestone binding endpoints (promote-to-milestone /
  unbind-milestone), and the program seed endpoints (samples, load-sample,
  import, export) in the API reference page.
- **API reference**: documented the program `rollup-config`, `risk-policy`, and
  `resource-contention` config endpoints, the project resource roster
  `?force=true` cascade-delete behavior, and the planned program `split`
  endpoint (returns `501` until implemented).
Product backlog grooming drawer (#1043, #731): clicking a story on the project Product Backlog opens a slide-in detail drawer (bottom sheet on mobile) for inline editing of title, description, an acceptance-criteria checklist (add/tick/edit/remove), the active model's scoring inputs (WSJF/RICE/Value-Effort) with a live score preview, epic reparent, story points, and Definition of Ready — with a readiness gate that re-enables "Ready" as criteria are met. Stories now show an epic/story type badge.
Added a numeric progress input alongside the slider in the task drawer's Overview section, so you can set an exact percentage (e.g. 83%) instead of being limited to the slider's coarse steps. The slider now also moves in 1% increments, and both controls stay in sync.
Board cards now show entry stamps ("Entered at 72% · 3d ago"), stall detection, and priority rank badges sourced from the new `status_changed_at` and `priority_rank` Task fields. Cards at 100% that haven't been moved to Done display a quiet "Move to Done?" nudge.
- **Promote-to-milestone is now reachable from the board, and the delivery forecast gives new teams a next step (#1052)**: the active sprint's panel on the Board shows a "Link to milestone" action (Scheduler+) so the bridge's keystone promote action no longer lives only on the Sprints tab. Below the velocity floor, the delivery-forecast line replaces its old "Need at least 3 closed sprints" dead-end with a "Sprint N of 3 toward your first forecast" progress nudge plus links to the two inputs it depends on — story points on the backlog and the sprint's capacity.
- **Demo on-ramp guidance**: after loading a bundled sample, a dismissable
  "Start exploring" callout shows a couple of suggested first steps keyed to the
  sample you chose, so an evaluator has an obvious next move instead of a sparse
  page.
- **My Work demo-load lands on your work**: loading a demo from the My Work empty
  state now assigns the sample's first open sprint to you and drops you on that
  project's Board, so your assigned tasks are visible immediately (instead of a
  PM-facing program overview with nothing assigned to you).
Added `create_admin` Django management command and `make admin` Makefile target for non-interactive superuser bootstrapping in dev, CI, and Kubernetes post-install hooks.
**Per-column WIP breach verdict** (#1071, ADR-0130): the board-config read (`GET /api/v1/projects/{id}/board-config/`) now annotates each column with a server-computed `current_count` (live count of non-deleted tasks in that status) and `breach` (`"ok"` | `"at"` | `"over"` | `null` when no limit is set), so the WIP-limit breach state is a server fact rather than a client computation. The verdict is passive and visible to all project members — the API still does not reject mutations that breach a limit.
**Flow metrics endpoint** (#1072, ADR-0130): `GET /api/v1/projects/{id}/flow-metrics/?window=<days>` returns methodology-neutral flow analytics computed-on-read from task history — cycle-time and lead-time P50/P80/P95 distributions, a cumulative flow diagram (CFD), and a weekly throughput series — plus an aggregate-only `data_integrity` advisory block (bulk-moved / backdated / missing-transition counts). The historical distributions are team-private by default under a new `flow_metrics` signal-privacy ladder key (ADR-0104): a reader below the team audience gets the payload with the distribution arrays emptied and `flow_metrics_suppressed: true`, never a 403.
- **Sprint lifecycle webhook events**: webhooks can now subscribe to
  `sprint.activated`, `sprint.closed`, and `sprint.scope_changed` so external
  dashboards, Slack, and CI can observe the sprint cadence. `sprint.scope_changed`
  fires only when a mid-sprint injection is *accepted*, never on a silent injection
  or a reject. The `sprint.closed` completion snapshot (velocity) is emitted to an
  external consumer only when the team has explicitly shared the velocity signal
  outward (ADR-0104 audience `program_shared`); otherwise the fields are `null` and
  `velocity_suppressed` is `true`.
Sample/demo programs now import as a program that has *run*, not a snapshot. A new seed schema v2 (ADR-0114) authors dates as offsets from an import-day anchor (so the bundled demo never looks stale) and an ordered event timeline that the importer replays with backdated history: tasks show dated status transitions by named people, closed sprints show real burndown curves and a velocity trend, scope injections leave an audit row, and completed work carries actuals for baseline-vs-actual variance. The flagship Atlas Platform Launch sample ships on v2. v1 seeds continue to load unchanged.
- **Inbound CI acceptance-result ingestion**: a CI job can POST acceptance-test
  verdicts to `/api/v1/projects/{id}/acceptance-results/` (authenticated with an
  existing project- or program-scoped API token) to flip the matching
  `AcceptanceCriterion.met` flags, stamping the review trail to the human who minted
  the token. Flipping the last unmet criterion satisfies the Definition-of-Ready gate
  (reported as `dor_ready` in the response) but never auto-transitions the task to
  READY — the team keeps the deliberate Mark-ready step. Criteria outside the token's
  project are reported as `unknown` and left untouched.
- **Tech-debt task type**: tasks can now be classified as **Tech Debt**, a
  first-class work-item type alongside Story, Bug, Task, Spike, and Epic
  (ADR-0178). Debt is scheduled like a Task and **counts toward velocity** — it
  is deliberately not excluded from committed-delivery aggregates the way an
  epic is, because hiding remediation work would understate a team's real
  throughput. Its distinct treatment is visibility: a tech-debt card shows a
  **Tech Debt** badge on its board face, the board toolbar gains a quiet **Tech
  debt** filter, and the task-list endpoint accepts `?type=tech_debt` so any
  client can chart debt versus feature capacity.
Sprints can now be excluded from velocity (ADR-0113). A team-owned "Exclude from velocity" toggle (Scheduler+) holds a setup or ramp-up sprint — a "Sprint 0" — out of the rolling velocity average, the forecast band, and the milestone delivery forecast, so its low throughput no longer skews the team's numbers. Excluded sprints stay visible in the velocity chart, marked rather than dropped, and the panel surfaces an "N excluded from this forecast" callout. The flag is settable after a sprint closes, is captured in the sprint history audit trail, and is honored by the CPM velocity calibration source.
Discoverable **Backlog** tab on the project view-tab strip (#1096), between Board and Sprints, methodology-gated to Agile/Hybrid projects. The product-backlog grooming view was previously reachable only by typing its URL.
The closed-sprint outcome card now shows the realized schedule consequence of the sprint in one line — "Rolled over N pts → milestone {name} now +Xd vs baseline" — pairing the points miss with the bound milestone's days-of-slip against its baseline, so the schedule cascade no longer requires a trip to the Schedule view. The slip is a server-computed schedule fact (`milestone_slip` on `GET /sprints/{id}/outcome/`) and stays visible even when velocity is team-private (#1098).
Iteration terminology can now be set once at the **Workspace** (or per **Program**) and inherited by projects — relabel "Sprint" to "Iteration", "PI", or a custom term across the whole workspace, with per-program and per-project overrides and a clear "inherit" option. The effective label is resolved on the server so every surface (web, mobile, API) shows the same word. Locking the term workspace-wide (ENFORCE) is a TruePPM Enterprise capability.
- **Cross-project dependencies within a program** (ADR-0120, #1117): a task can now
  depend on a task in a *different project of the same program*. Cross-program edges
  stay rejected (the portfolio boundary is unchanged). Each cross-project edge is
  **consent-gated** — it binds immediately only when the creator can already schedule
  the downstream (successor) project; otherwise it is created pending and a Resource
  Manager on the successor's project accepts or rejects it (`POST /dependencies/{id}/accept`
  and `/reject`). Cycle detection now spans the whole program, and a minimal
  cross-boundary "external task" card (title, project, milestone flag, CPM dates,
  criticality — no private task data) answers "what is blocking me" across a project
  you cannot otherwise open. The program-scoped scheduling pass that makes these edges
  drive a program-true critical path lands in a follow-up slice; until then a
  cross-project edge is a recorded, consented, visible coordination link.
Cross-project dependencies now drive a **persisted program-scoped schedule pass**: when a program has an accepted edge between two of its projects, recalculating either project escalates to one merged CPM run that writes program-true floats and criticality back to every member project — so a cross-project handoff is honest on each project's own schedule, not only the program schedule view. A **sprint-boundary firewall** records a cross-project slip conflict (`GET /api/v1/slip-conflicts/`, `POST .../acknowledge/`) when an upstream slip pushes a committed task in an active sprint past its boundary, without ever moving the sprint or its commitment math — the downstream team acknowledges and resolves it their own way (ADR-0120 D3/D4, #1117).
- **Program schedule endpoint**: `GET /api/v1/programs/{id}/schedule/` returns the program-true critical path across a program's projects — every member project's tasks and every accepted cross-project dependency merged into one CPM run, computed on read. Tasks in projects you can read come back in full; tasks in projects you can't are redacted to a minimal card (title + forecast dates only). This is the server-computed source the upcoming program schedule view renders from (ADR-0120).
- **Per-task calendars in the scheduling engine** (`trueppm-scheduler`): a task can
  schedule on its own working week via `Task.calendar_id` plus a `Project.calendars`
  registry, so one schedule can mix work that follows different calendars. Duration
  arithmetic uses the task's own calendar; lag on a dependency is counted on the
  successor's calendar. Fully backward compatible — a project with no registry
  schedules exactly as before. This is the engine substrate for cross-project
  dependencies within a program (ADR-0120, #1117).
Program schedule view: a new read-only **Schedule** tab on a program renders the merged, program-true cross-project critical path across project lanes in the canvas Gantt, with cross-project dependencies drawn as dashed arrows, limited-view bars for tasks in projects you can't access, and live updates from each member project (#1118, ADR-0120 §D6).
Daily delta panel — session-local window control (#1123): the active-sprint "what changed since yesterday" panel gains a 24h / 48h / "Since I last looked" selector. "Since I last looked" replays the gap since you last opened the panel for this sprint (remembered locally per sprint, on your device only), and the "Scope added" section gets a one-click link into the mid-sprint scope audit.
Daily delta panel — click-through rows (#1124): moved cards, new blockers, and injected scope rows open the task in an in-context side drawer instead of navigating away. Rows with no underlying task stay inert.
Daily delta panel — scope cost and load (#1127): mid-sprint scope items now show their point cost and epic grouping, and the panel adds a sprint-load indicator (committed vs current points, delta, and "now X% loaded"). Point figures honor the team's velocity-signal privacy setting.
Sprint Review now opens with a committed-at-planning → shipped count line (#1129): "N committed → M shipped, K carried over". These counts are always visible to the whole team — they are never behind the velocity/points privacy gate (the team already knows what it committed; only story points stay gated).
Sprint Review demo curation now supports a walkthrough order and a per-story presenter (#1130). Members can drag the demo-flagged stories into the order they'll be shown, and name who is presenting each one. Read-only viewers see the curated order and presenter without the controls.
Sprint Review stories with incomplete acceptance criteria now disclose exactly which criteria are unmet on click, and a criteria-not-set badge offers an inline "Add criteria" jump to the story's acceptance editor (#1131). Contributors can leave an optional note ("visible to reviewers") on these stories — never required.
One-tap "Flag for backlog" on a Sprint Review story that didn't fully meet its acceptance criteria (#1132): Members can carry the unfinished work forward into the project backlog in a single tap, with the story's title and points carried over. The action is idempotent — a second tap never creates a duplicate backlog item.
Blocked tasks now route to the people who clear impediments (ADR-0124): the `task.blocked` notification reaches the assignee plus the project's Scrum Master(s) and PM(s), each gated by their own notification preference. New read-only roll-up endpoints `GET /projects/{id}/blocked/` and `GET /sprints/{id}/blocked/` list flagged tasks (oldest-blocked first) with type, age, actor, assignee, and the blocking-task link — never the private reason text. Closes #1134.
Structured blocker fields on tasks (ADR-0124): a `blocker_type` classification (dependency / resource / vendor / decision / other), a soft `blocking_task` link (not a CPM edge), an auto-stamped `blocked_since` age, and the `blocked_by` actor. The type, age, actor, and link are team-shareable triage signals; the free-text `blocked_reason` stays private to the task's assignee and any user @-mentioned on it (it is dropped from the API response for everyone else). The My Work blocked badge now shows the blocker type and a "Xd Yh blocked" age. Closes #1135.
Opt-in email delivery for the `task.blocked` notification (ADR-0124): a recipient who enables the email channel for blocked-task alerts now gets an off-device email carrying the blocker type and age — never the free-text reason. Push/FCM delivery is deferred to a later release. Closes #1136.
- **Sprint board container chrome (ADR-0123)**: the board, when scoped to a sprint, now reads as a container rather than a filter — a header bar with the date range, a "Day N of M" timebox, the sprint goal, and a compact burndown (#1138); a neutral drop toast when a card is dragged into an active sprint as pending scope (#1140); and a pruned sprint switcher ("Recent" group + "Show all sprints" disclosure), a smart default that pre-selects a project's single active sprint (a shared `?sprint=` link always wins), and a read-only banner that disables drag-to-assign on closed sprints (#1141).
- **Server-derived task edit capabilities + complete read-only task drawer for Viewers (#1144, #1142, #1143)**: the task API now returns authoritative `can_edit` / `can_delete` flags per task for the requesting user (ADR-0133), computed from the same predicate the server enforces — so the web client no longer re-derives a parallel permission rule that drifted (it previously showed edit controls to Resource Managers and to Team Members on tasks they aren't assigned to, both of which silently 403'd). The task detail drawer now gates **every** write control (status, progress, assignee, sprint, blocker, comments, recurrence, subtasks, attachments, links, name, description) off this verdict, so a Viewer sees a fully read-only drawer with a clear **"View only"** indicator in the header instead of controls that fail on submit.
Task taxonomy editor: the task create/edit dialog now exposes a **Classification** group — `Type` (Epic/Story/Task/Bug/Spike), `Governance class` (Flow/Gated/Hybrid), and `Delivery mode` (Waterfall/Scrum/Kanban/Milestone) — each with a grounded one-line description. These fields were already stored, seeded, and shown read-only but had no editor. Issue #1146.
Within-program resource contention: a new **Resources** tab on the program view surfaces people over-allocated across the program's projects in overlapping windows — each person's allocation broken down by project, with an over-allocation flag. Backed by `GET /api/v1/programs/{id}/resource-contention/`, which aggregates each resource's task spans across every member project, tagged with its source project. Read-only and Scheduler+ on the program (new `IsProgramScheduler` permission). Overallocation detection stays client-side per ADR-0031. OSS, within-program visibility only — cross-program leveling remains Enterprise. Issue #1149.
The blocked roll-up endpoints (`GET /projects/{id}/blocked/` and `GET /sprints/{id}/blocked/`) now accept `?blocker_type=` and `?min_age_days=` filters, so Scrum Masters and PMs can slice impediments by type (e.g. "Decision needed") or age (e.g. blocked more than 3 days) for escalation. Both filter only the team-shareable structured signal — the private blocker reason stays non-queryable (ADR-0165).
- **Scaled-agile coordination extension points (ADR-0177)**: recorded the OSS
  extension-point design that the enterprise edition registers against — a stable
  cross-team read contract (with a `contract_version` signal on
  `GET /api/v1/edition/`), a generic group-membership provider hook, and frontend
  slot wiring. Design record only; no behavior change in the community edition.
Command palette (⌘K / Ctrl+K): a fast, keyboard-first overlay to search and jump to My Work, your programs and projects, or run quick actions (switch theme, toggle the sidebar) from anywhere (v2 design system, ADR-0126). Open it with the OS-correct shortcut or the new "Search or jump to…" affordance in the top bar; ↑/↓ to move, Enter to go, Esc to close. The bare search icon it replaces is gone.
Task drawer **Blocker** section (ADR-0124): flag a task blocked with a reason, an optional type (Waiting on dependency / Missing resource / External vendor / Decision needed / Other), and an optional "waiting on" related-task link — then unblock with one tap. This is the write surface for the structured blocker fields shipped earlier (#1135/#1134), built in the v2 design language. The free-text reason stays private to the assignee and anyone @mentioned (shown with an explicit privacy note); everyone else sees the type, age, and who flagged it, never the reason. The related-task link is labeled informational and called out as not affecting schedule dates (it is not a dependency).
Method-adaptive settings surfaces: the Workspace and Project Methodology pages are now wired, and the Program general page's methodology control follows the inheritable cascade. Each picker shows whether the methodology is inherited or overridden, and locks to the workspace default (read-only) when the workspace's override policy requires it. The view bar now gates planning surfaces (Board, Schedule, Sprints) on the server-resolved effective methodology, so a workspace-level lock immediately reshapes which tabs appear. #1169
Risk register: filter the table by **All / High / Unmitigated / Mine**, sort by severity, and an always-on highlight for unmitigated risks. The segment filter composes with the existing exposure-matrix cell filter, and each active filter is independently clearable.
The community edition now shows the cross-program Portfolio rollup in the Sidebar as a disabled, grayed-out row with an "Available in TruePPM Enterprise" tooltip, instead of hiding it (which read as broken OSS). The row is deliberately not promoted while the Enterprise feature is not yet purchasable; under the enterprise edition it remains the real Portfolio rollup link (#1173).
Task detail now opens full-page: an **Expand** control in the task drawer opens a roomy, single-column focus view of the same task at its own URL (`/projects/{id}/tasks/{taskId}`), showing every detail section at once with a link back to the schedule. The drawer remains for quick in-context edits; the full page is for deep work (v2 design system — handoff "drawer + expand-to-full-page").
Blocked-task roll-up panels (ADR-0124): a "Blocked" list on the project overview (the PM's impediment triage) and an "Impediments & paused" panel in the sprint view (the Scrum Master's list, with an impediment-vs-paused split and a quick filter). Each lists flagged-blocked tasks oldest-first with the blocker type, how long it's been blocked (color-escalated), who's assigned, who flagged it, and any "waiting on" link — and never the private reason text (that stays on the task drawer, visible only to the assignee and anyone @mentioned). This is the read half of the blocker end-to-end work (#1134), consuming the existing GET /projects/{id}/blocked/ and GET /sprints/{id}/blocked/ endpoints.
A context-aware **"+ New"** button now lives in the top context bar: it creates the right thing for where you are — a task on the Board/Schedule/Grid (Schedule also offers a Milestone), a story in the Backlog, a project in a Program — and is hidden wherever you can't create (it respects your role). It never silently adds work to an active sprint: a task is created unassigned, and choosing the active sprint in the form is the deliberate, team-reviewed path (ADR-0102). (#1179, ADR-0131)
Role-based app landing (ADR-0129): TruePPM now opens on the screen that fits your role — contributors land on My Work, project managers on a project Overview — resolved server-side and consumed by the web app at `/` and after login. A first-login prompt on My Work and a new **Preferences → General** settings page (`/me/settings/general`) let you pin a default home screen or keep it automatic; a calm transparency hint explains why you landed where you did. The My Work empty state also gets a warm v2 refresh with an "Explore a demo project" call to action.
The post-login landing default now lands you on the project you **most recently opened**, not just the alphabetically-first one. TruePPM records a real per-user last-visited timestamp each time you open a project (coalesced to at most once per minute), and the resolver falls back to your previous behavior until a visit is recorded.
- **Flow analytics on the board** (issue #1188): the Kanban board now surfaces the
  methodology-neutral flow metrics (ADR-0130). A collapsed-by-default **Flow
  analytics** panel shows a cumulative flow diagram, weekly throughput, and a
  cycle/lead-time P50/P80/P95 stat strip — team-private behind the ADR-0104
  `flow_metrics` signal (a below-audience viewer sees a content-free wall, and an
  in-audience panel carries a legible "aggregate only — no individual breakdown"
  caption). Board columns gain an always-on **WIP breach chip** ("At limit" / "Over
  limit") that no longer hides behind the "Show WIP limits" toggle. The backlog
  delivery forecast now branches on `forecast_basis`: a continuous-flow team gets a
  throughput-based forecast in item/date language (never sprint/velocity vocabulary),
  with an explanatory "needs ≥4 weeks of completed-work history" state instead of a
  broken or blank widget.
The keyboard shortcut ⌘B (Ctrl+B on Windows/Linux) now collapses and expands the navigation sidebar, matching the shortcut the collapse button already advertised. The chord is ignored while you are typing in a field or the command palette is open.
The v2 health cluster's Forecast slot now shows the Monte Carlo **P50·P80 band** inline (e.g. "P50 Jun 30 · P80 Jul 14") instead of a single date, and the Velocity slot carries a visible "members only" trust boundary — surfacing that the figure stays project-scoped and is not piped to portfolio dashboards. Both reuse data already fetched for the cluster's drill-through panel (no new computation).
- **My Work blocked filter**: a "N blocked" chip at the top of My Work shows how
  many of your assigned tasks a teammate has flagged as blocked; tap it to filter
  the list to just those, and tap again to clear (#1198).
- **Schedule Grid ↔ Timeline toggle** — the Schedule view now has a `Grid | Timeline` switch. **Grid** keeps the WBS task-list table beside the timeline; **Timeline** hides it for a full-width timeline (task names render inline on the bars). The choice persists per user. (#1221)
- **Schedule "Forecast & sensitivity" insights** — the Schedule view now has a collapsible bar showing the Monte Carlo finish-date forecast alongside **"What's holding the date"**: a per-task sensitivity ranking of the tasks whose duration moves the project finish most. The Monte Carlo API response and the forecast drawer now expose this real duration-sensitivity tornado, replacing the previous PERT-spread "top drivers" list. (#1222)
Product Backlog (v2): each story now shows whether it is **Pulled** into a sprint or still a **Proposed** candidate, plus its assignee. The header carries a live count of pulled vs proposed stories, a **By epic / Ranked** view toggle (ranked shows the flat, score-ordered backlog), "Add story" and "Plan sprint" shortcuts, and epic points now render as a progress bar.
Web: groundwork for the v2 motion layer — a shared `ease-brand` easing + named `duration-fast/base/slow` tokens, four reusable entrance keyframes (`checkpop`, `toast-rise`, `modal-scale-in`, `save-bar-slide`), button press-down feedback, and a subtle hover-lift on program and board cards (no drop shadow — the border carries the edge). All decorative motion is gated on `prefers-reduced-motion`. First slice of the v2 fluidity foundation (#1163).
Web: a global toast system — app-wide confirmations now surface as a bottom-center ink pill with a sage check that rises in and auto-dismisses (~2.6s), announced politely to screen readers without stealing focus. First consumer: pinning/unpinning a project to Shortcuts confirms the change. Board-local notices stay board-scoped. Second slice of the v2 fluidity foundation (#1163).
Web: completing a task is now a moment of delight — My Work gains a one-tap complete checkbox, the checkmark springs, and a warm "Nice — {task} done." toast confirms it (on both My Work and the Schedule task list). Motion honors reduced-motion. Third slice of the v2 fluidity foundation (#1163).
Web: overlays now animate to spec — dialogs and the new-task modal scale in over a softly-blurred fade, the settings and task-drawer save bars slide up when you have unsaved changes, the task drawer slides on the brand ease, and creating a task confirms with a toast. Replaces the previously dead `animate-in`/`fade-in` classes with real keyframes. All motion honors reduced-motion. Final slice of the v2 fluidity foundation (#1163).
My Work home redesign: a time-aware greeting, three risk-ranked focus cards (what needs attention, your active sprint or critical-path work, and your open load), and a two-column layout with a method-adaptive side stack — all built from your cross-program work without losing the assigned-task list, grouping, one-tap complete, or retro items.
Monte Carlo forecast runs now persist their full distribution (histogram, confidence curve, and duration-sensitivity tornado) alongside the percentiles. A past run's chart can be re-viewed from the Schedule view's forecast history, and the latest forecast keeps its histogram after the 24-hour cache expires instead of falling back to a flat "every simulation finished on …" message. Legacy runs recorded before this change show the run-a-fresh-simulation prompt (no backfill).
Forecast run history is now a per-workspace option. Workspace owners can turn run history on or off, set how many runs are retained (up to 500), and choose who can see which member triggered each run (admins & owners, schedulers and above, or no one). Programs and projects inherit the workspace setting by default and can override it. The history list itself is visible to all project members, and reruns never send a notification.
Program → Projects settings now has a **bulk-edit matrix** UI for the bulk-fields API: select projects, pick an inherited field (methodology or iteration label), set a value, and apply it to just the checked rows in one action. Inherited values display distinctly from explicit overrides, and "Reset to inherited" clears an override. Methodology editing respects the workspace methodology policy. (#1233)
Add a bulk-edit API for inherited program and project settings (ADR-0161): workspace admins can set methodology, iteration label, and risk policy across many programs in one call (`POST /api/v1/programs/bulk-fields/`), and program admins can set methodology and iteration label across a program's projects (`POST /api/v1/programs/{id}/bulk-project-fields/`). Only the selected rows and named fields change; everything else keeps inheriting.
- **Velocity sparkline excluded-count pill**: the Board velocity sparkline now shows a visible `N excluded` pill when one or more sprints are held out of the velocity average, so sighted users get the same signal previously available only to screen readers.
- **Sprint burndown "N days left" footnote**: the daily-delta panel's burndown
  caption now appends a `(N days left)` parenthetical when fewer than five
  working days remain in the sprint, making the daily burn rate easier to read
  on a compressed sprint. Purely presentational — derived from the sprint's
  finish date, no new API field.
- **Risk register — hide low severity**: a client-side "Hide low severity"
  toggle in the risk register toolbar collapses LOW-severity risks (score 1–5)
  out of the table. The choice persists in the browser (localStorage) and
  composes with the existing segment and exposure-matrix filters.
- **`taskScheduleState` helper**: added a pure `taskScheduleState(task)` utility
  returning `'scheduled'` / `'unscheduled'` for UI that branches on the named
  scheduling state. It is the single source of truth that the existing
  `isTaskScheduled` boolean is now derived from, so the two can never disagree.
- **Risk register filter — roving-tabindex coverage**: added keyboard tests for the
  risk register's All/High/Unmitigated/Mine segment filter, locking in web-rule 167.
  The tests assert that only the focused segment is tabbable, that ArrowLeft/ArrowRight
  move DOM focus without applying a filter, and that Enter/Space activate the focused
  segment to commit it. The component already complied; no behavior change.
- **Evaluation guide**: a new getting-started page that maps every 0.3 capability
  to a bundled sample, a persona login, the exact screen, and what to expect — a
  ~30-minute walkthrough for evaluators and release reviewers.
- **Realistic sample-project history**: the four bundled demos now replay an
  authored event timeline, so they read as programs that have run for months —
  dated reassignments and comments by named people, "hero" tasks that fail review
  and bounce back before shipping, mid-sprint scope changes (accepted in one demo,
  rejected and deferred in another), closed sprints with an honest goal verdict,
  and dated risk-status lifecycles. The agile/hybrid demos are also re-anchored so
  the active sprint brackets "today" instead of resolving into the past.
Git-event automation now has a project-settings UI. Under **Project → Settings → Integrations**, a project admin can enable or disable the auto-move receiver, copy the per-project webhook URL, and generate or rotate the signing secret (shown once at generation), with built-in GitHub and GitLab setup hints. Previously the #329 receiver could only be configured by calling the API directly. (#1257)
Signal privacy: the team can now ratify a ceiling raise in the UI. When a Scrum Master or Admin raises a signal's ceiling, the Project Settings → Signal privacy ladder shows a pending team-decision card with a live approve/reject tally; team members vote inline, the proposer can withdraw, and a collapsible decision history records past outcomes. Raising a ceiling no longer silently does nothing — it opens a ratification proposal (ADR-0104 Amendment A). Pull-only, no notifications. (#1260)
Board activity feed panel: the board now has its own activity feed. A collapsible rail (toggled from the board toolbar) shows a time-ordered, filterable audit of every card mutation — created/updated/deleted, sprint entries and exits, and comments — with the actor, the field change ("status: To do → In progress"), and when. Filter by event type, person, or time range; click an event to open its card. Infinite-scrolls through history (ADR-0160). (#1261)
**View focus** — a per-user PM / Scrum Master / Unified Today lens (#1263, ADR-0162) for people who run the waterfall program and facilitate the agile team. It opens each project on the surface your focus cares about (PM → Schedule, Scrum Master → Board, Unified → Overview) and moves those view tabs to the front of the project bar. It is presentation-only — it never changes your permissions, your data, or what anyone else sees. Set it from the user menu or **Settings → General**.
The board activity feed now surfaces the accept/reject status (`pending` / `accepted` / `rejected`) of a mid-sprint scope change on its `entered_sprint` events via a new `scope_change_status` field, so the board's audit shows whether a late sprint addition was ratified — not just that it happened. Backed by a new composite `(project_id, history_date)` index on the task-history table that keeps the feed (and the existing burndown/scope scans) fast as history grows.
MS Project XML import: field-coverage docs, CI fixture tests for all three fixture files, and milestone duration fix (milestones now import with `duration=0` instead of `1`).
Eligible team members are now notified in-app when a signal-visibility ceiling-raise proposal opens or resolves (ratified / rejected / expired), so proposals no longer expire unseen because the team never discovered them. The notification links straight to Settings → Signal privacy. Email follows your existing notification preference (opt-in, off by default). (#1275, ADR-0104 Amendment B)
Daily standup walk-the-board surface (ADR-0166, #1278): a focused "Standup" mode on the active sprint board that walks the team one teammate at a time, showing each person's Done since the last working day, In progress today, and Blockers. The "done since yesterday" window is calendar-aware (a Monday standup includes Friday's completions); stale cards are flagged with a calm aging pill; the Sprint Goal is pinned at the top; and the stepper is keyboard-drivable (← / →, Esc to exit) for running the room live. Read-only and project-member-scoped — the private blocker reason is never shown on the shared screen. New endpoint `GET /projects/{id}/standup/`.
Sprint burnup chart. The sprint panel's burn chart now offers a **Burn up** view alongside Burn down: a completed line and a total-scope line, so mid-sprint scope creep is obvious — when accepted scope is injected, the total-scope line visibly steps up instead of staying flat at the committed baseline. Toggle between Burn down, Burn up, and Combined on the chart card.
Continuous-flow boards now show a **throughput forecast** on the Flow Analytics panel: a Monte-Carlo estimate over recent weekly throughput that answers "at our current pace, when does the remaining backlog finish?" P80 is the headline ("~N weeks / by &lt;date&gt;"), with P50 and P95 alongside. Sprint-cadence boards are unaffected and keep their velocity forecast. (#1280)
Workspace → Programs bulk-edit matrix: workspace admins can now set the delivery methodology, iteration label, and cross-project risk policy (slip propagation, escalation days) across many programs in a single step from the **Programs** section of workspace settings. The program list API now exposes `risk_slip_propagation` and `risk_escalation_days` so the matrix can show and diff each program's current value. (#1283)
Surfaced the velocity-calibration reforecast on the closed-sprint view: a Scrum Master can now accept or dismiss the durations that team velocity implies — and reforecast the schedule — directly from the sprint, instead of opening each task's drawer in the Schedule view.
Added a sprint-planning rail to the Product Backlog: while a sprint is in planning, commit stories into it with a per-row toggle and watch capacity, the target milestone, and committed points update in one view — no more alt-tabbing to the sprint panel.
Add outbound webhooks for project state changes (tasks, dependencies, schedule recalculation) with HMAC-SHA256 signatures and automatic retry with exponential backoff.
- **Board › Phase swimlanes**: the board is now organised into WBS-phase rows (one row per summary task) with the four status columns across each row. Collapsible lane headers show task count, average progress %, and CP/WIP-over summary chips. Each card shows a circular progress ring (sourced from the Gantt's % complete), inline assignee initials and CP rpill badges, and an entry stamp ("Entered at 62% · 4d ago") when `statusEnteredAt` is available. Column headers show WIP-limit badges (count vs limit) when "Show WIP limits" is enabled in the toolbar. Ungrouped tasks appear in an "Other" lane at the bottom.
- **Gantt › Focus mode**: two new toolbar checkboxes — "CP only" filters dependency arrows to critical-path links only; "Focus chain" dims all task list rows not in the predecessor/successor chain of the selected task to ~22% opacity. When a task is selected in focus chain mode its row shows inline predecessor (`←N`) and successor (`→N`) count chips, coloured red if those links are critical.
Epic management on the Product Backlog (#1339): backlog managers can now create, rename, and delete epics directly from the Product Backlog grooming view. A gated "+ Add epic" affordance adds an epic inline (it appears as a new group, even before it has stories); each epic group header carries an actions menu to rename it in place or delete it. Deleting an epic never deletes its stories — they move to "Ungrouped" — and the confirmation states exactly how many stories are affected. Create and rename require the Product Owner facet or Admin+; delete requires Admin+ (matching the server's permission model).
Drag a story into an epic on the Product Backlog "By epic" grooming view to reparent it (#1345). The target epic region lights up to show where the drop will land, its header swaps to a "↳ Drop to add to this epic" prompt, and dropping a story on the "No epic" bucket removes it from its epic. Reordering within a group still works, the move is optimistic with rollback on failure, and each drop is announced for screen readers. Reparenting is limited to users who can manage the backlog (PM+/Product Owner); the existing story-drawer "Parent epic" picker remains the keyboard-accessible alternative.
- **LGPL-3.0 redistribution notice for psycopg**: a repository-root `NOTICES`
  file and `licenses/` directory (the full LGPL-3.0 and GPL-3.0 texts) now record
  that every distributed edition redistributes psycopg under LGPL-3.0-only and
  keeps it an operator-replaceable component (the LGPL §4 relink guarantee). The
  notice and license texts are copied into the API Docker image — the primary
  redistribution vehicle — so they travel with each distributed copy. No psycopg
  source is modified.
MS Project imports now use a transactional outbox (`ImportRequest` model) instead of direct `.delay()` dispatch. If the task broker is unavailable at upload time, the import row stays `PENDING` and `drain_import_queue` (Beat, every 30 s) picks it up automatically — callers no longer receive HTTP 503. Response includes `import_request_id` for progress tracking.
- **WBS auto-numbering**: new tasks are automatically assigned a sequential WBS path on creation — root tasks get "1", "2", "3", …; tasks created under a parent (via `parent_id`) get the next child path, e.g. "1.3" as the third subphase under phase "1". Deep nesting works at any level ("2.1.1", etc.). Assignment is atomic (`SELECT FOR UPDATE`) to prevent races under concurrent creates.
- **WBS backfill migration** (`0019`): pre-existing tasks with a null `wbs_path` are automatically assigned sequential root-level numbers so they appear correctly in the WBS and table views.
- **WBS view "+ Child" button**: when a task is selected in the WBS tree, a "+ Child" button appears in the toolbar. Clicking it creates a new subphase directly under the selected task without requiring a subsequent indent operation.
Resource assignment and utilization view wired to API.
Task Detail Drawer extended with four tabs: Dependencies (existing), Estimates, History, and Baseline comparison (issue #141).

- **Estimates tab**: three-point PERT input (Optimistic / Most Likely / Pessimistic) with inline PERT Expected and Std Dev calculation. Three governance modes: `open` (free edit), `suggest_approve` (contributor suggests → scheduler approves with inline Accept banner), `pm_only` (read-only for non-schedulers).
- **History tab**: paginated field-diff audit trail via `GET /api/v1/projects/{id}/tasks/{id}/history/`, with relative timestamps and change-type badges.
- **Baseline tab**: plan vs. actual comparison table from the active baseline snapshot, with signed delta values.
- New API endpoints: `POST /api/v1/tasks/{id}/approve-estimates/` (RBAC: Scheduler+), `GET /api/v1/projects/{id}/tasks/{id}/history/`, `GET /api/v1/projects/{id}/tasks/{id}/baseline/`.
- New `Project.estimation_mode` field (`open` | `suggest_approve` | `pm_only`, default `open`) and `Task.estimate_status` field (`pending` | `accepted` | null).
- Monte Carlo engine gated: pending estimates treated as absent so unreviewed values never corrupt probabilistic schedule forecasts.
New project creation modal is now a 3-step wizard: (1) name and description, (2) start date, (3) template selection (Blank available; Software Delivery, Construction, and General templates coming soon).
Project Settings → Members tab: Project Admins can now invite teammates by username/email, assign one of five roles (Viewer, Team Member, Resource Manager, Project Manager, Project Admin), change roles, remove members, and leave the project from a dedicated settings page.
Added project resource pool — PMs can now build an explicit team roster per project. Resources can be added/removed from the Team tab (Roster sub-view), with per-project capacity overrides (% FTE or hours/day toggle), role titles, and notes. Removing a resource with existing task assignments requires confirmation and cascades cleanly with a schedule recalculation.
Added resource skills and task skill requirements — tag resources with skills and proficiency levels (Beginner / Intermediate / Expert), define skill requirements on tasks, and get a skill-fit grouped assignment picker (Best fit / Partial fit / No skill match) in the task detail drawer. Inline warnings appear when assigning a resource who lacks a required skill.
Ten additional MS Project XML fixture files covering edge-case formats: minimal, milestones-only, deep WBS (4 levels), all dependency types (FS/SS/FF/SF + lag), large flat (200 tasks), resource overallocation, recurring task (flatten), cross-project link, unicode names, and calendar exceptions. Each fixture has parametrize test cases in `TestEdgeCaseFixtureFiles`.
Added org-level resource management page — PMs can create, edit, and deactivate resources from a new /resources catalog page (sidebar "Org › Resources"). Deactivation is soft-delete only; historical assignments are preserved. A new IsOrgAdmin permission gates writes to any user with Project Manager role on at least one project. Extension slots are declared for Enterprise LDAP/SCIM directory-sync overlay. The project roster combobox gains an inline "Create as new resource" option so PMs can add someone without leaving project context.
Added `web:integration` CI job: full-stack Playwright suite (auth, task CRUD, WebSocket broadcast) running against real Django + PostgreSQL + Valkey on every merge to main.
WBS autonumbering: `computeWbsCodes` derives sequential outline codes (1, 1.1, 1.2, …) from tree position (`parentId` + sibling order) rather than passing through the stored `wbs_path` directly. Codes are always sequential, gap-free, and update immediately when the task list changes.
- **Summary task rollup**: parent tasks (phases) now correctly aggregate children's schedule data after CPM runs — `early_start` = earliest child, `early_finish` = latest child, `duration` = calendar-day span, `is_critical` = true if any child is on the critical path. The Gantt bar for a summary task spans from the first to last leaf task rather than using the stale stored duration.
- **Frontend summary bar fix**: `useGanttTasks` now derives `finish` from `early_finish` (not `start + duration`) for summary tasks, ensuring summary bars render the full phase span even before the first CPM run updates the stored duration.
- **Dark mode with system auto-detection** (#163): the web UI now supports three
  color schemes — Light, Dark, and Auto. Auto mode follows the OS `prefers-color-scheme`
  setting (macOS, Windows, Linux) and reacts to changes without a page reload. The
  active scheme persists across sessions (localStorage). A compact three-button toggle
  (sun / monitor / moon) is available in the TopBar on desktop. All neutral content
  surface and semantic status tokens now adapt to the active scheme via CSS custom
  properties, eliminating the need for per-component `dark:` overrides.
- **Resource Timeline**: new DOM-based allocation timeline in the Resources tab showing every resource as a row with absolutely-positioned task spans. Spans are colour-coded by state (normal, partial, over-allocated, complete) and open an inline edit popover on click for adjusting allocation %.
- **Resource Timeline — overallocation**: over-allocated resources get a red row tint, a dot-scroll jump button in the row header, and an ISO week range label (e.g. "overallocated · W18" or "W17–W19") so the affected window is visible without opening the heatmap.
- **Resource Timeline — YOU badge**: the current user's own resource row is highlighted with a `YOU` pill, making it easy to locate yourself in large teams.
- **Resource Timeline — status bar**: a footer beneath the timeline shows live scheduled/unscheduled resource and assignment counts alongside a variant legend (Normal / Partial / Over-allocated / Complete).
- **Resource Timeline — allocation edit popover**: clicking any task span opens an inline popover to adjust allocation %, with a live pre-save overallocation warning when the entered value would exceed the resource's max units.
Added a Critical Path panel to the Project Overview screen showing up to 5 CP tasks sorted by total float (most negative first), with each row displaying task name, duration, CP badge, and total slack. A "Show full critical path" link navigates to the Gantt view.
- **Configurable Kanban board columns** (issue #170): board columns now support
  per-column label rename, accent color (`#RRGGBB`), WIP limit (advisory —
  amber chip when exceeded, never blocks drops), and visibility toggle.
  Settings are persisted server-side via `PUT /projects/{id}/board-config/`
  and broadcast as a `board_config_updated` WebSocket event. A new "Columns ⚙"
  button in the board toolbar opens a right-side settings drawer (480px) with
  8 brand color swatches, custom hex input, and numeric WIP stepper per column.
- **Board: dependency / blocker indicators** — board cards now show a 🔗 chain-link icon when the task has predecessor dependencies. The icon turns red when any predecessor is not yet complete (blocked). Hovering the icon dims unconnected cards across all lanes so the dependency chain stands out. Clicking opens a popover listing predecessors and successors with status pills; the `D` keyboard shortcut opens it from any focused card (#182).
- **Board: resource overallocation badge** — assignee chips show a red dot when the resource is allocated above the configured threshold (default 100%) during the card's date window. Hovering reveals the peak factor (e.g. "1.4× allocated during this task — calendar exceptions not applied"). Threshold is configurable via `localStorage` key `board:overallocThreshold` (#184).
- **Board: milestone rail on phase lanes** — a 24 px row above each phase swimlane displays diamond markers for milestone tasks in the phase. Diamonds are pinned to the column matching the milestone's current status. Green = hit on time, red = missed or late, neutral outline = upcoming. Hover reveals the milestone name and target date. Up to 5 diamonds are shown per column; "+N more" pill for the rest (#187).
- **Board: risk linkage icon on cards** — cards with linked risks show a ⚠ icon coloured by the highest linked risk severity: green (1–5), amber (6–14), red (15–25). A count badge appears when more than one risk is linked. Clicking opens a popover listing each risk with title, status, severity dots (colour + count for colour-blind users), and a link to the full risk register. A "Risk-linked only" filter pill in the board toolbar narrows the view (#188).
- **Board: keyboard navigation** — full keyboard control of the board view. `J`/`K` or `↓`/`↑` move card focus within a column; `H`/`L` or `←`/`→` move column focus; `Enter` opens the card detail drawer; `E` edits; `D` shows dependencies; `C` shows comments; `?` opens the shortcut cheatsheet. Focus ring is WCAG AA compliant. All shortcuts are suppressed when typing in a text field or when a modal is open (#195).
- **Board: collapse button keyboard shortcut hints** — the lane collapse/expand toggle button now shows a native browser tooltip revealing the `[` (collapse) and `]` (expand) keyboard shortcuts, making them discoverable without documentation (#225).
- **Board: responsive density** — board automatically switches to compact density on viewports below 768 px (md breakpoint); users can manually override for the session, and the override resets when the viewport grows back above md. Desktop preference continues to persist in `localStorage` (#224).
- **Board: float chip in comfortable mode** — the schedule float chip now appears in both comfortable and detailed density (was detailed-only). Critical-path cards explicitly show "0d float" in red. Negative float renders with a ⚠ warning icon. All float values use tabular mono numerals (#183).
- **Board: baseline vs. forecast date variance** — hovering or focusing a board card with a baseline date now reveals a BL → FC date strip and colour-coded variance: amber for 1–5 days late, red for >5 days late, green for on-time or early (#186).
- **Board: card aging / dwell-time indicator** — cards that have spent longer than their column's cycle-time SLA in a column show a ⏱ Nd chip in amber. Cards past 2× SLA pulse red. Default SLAs: Backlog 14d, To Do 7d, In Progress 10d, Review 4d. SLA is stored per column in the board config for future UI configuration (#192).
Board batch 4 — EVM indicators, cost toggle, and P80 Monte Carlo panel (#185 #189 #196)

- SPI chip on board cards: Schedule Performance Index computed from baseline dates; green ≥ 0.95, amber 0.85–0.94, red < 0.85; shown in comfortable/detailed density when EVM toggle is SPI or Both
- CPI chip on board cards: Cost Performance Index from API field when available; same color thresholds; shown when EVM toggle is CPI or Both
- EVM toolbar toggle: Off / SPI / CPI / Both dropdown in board controls
- Cost toggle: "Show cost" checkbox reveals $actual / $BAC chips on cards and phase rows; hidden by default to avoid clutter
- P80 pill → Monte Carlo panel: clicking the P80 TopBar badge now opens a right-side panel with P50/P80/P95 date chips and the confidence histogram (#196)
- **Board: swimlane collapse/expand persistence** — collapsed lanes now persist to `localStorage` per project; "Collapse all" / "Expand all" buttons in the toolbar; `[` and `]` keyboard shortcuts on the focused lane (#190).
- **Board: card density toggle** — new toolbar selector for compact / comfortable / detailed density. Compact cards show a 3px progress strip at the bottom; detailed cards show a float chip when CPM has run. Preference persists globally per user (#193).
- **Board: plain-English critical-path tooltip** — CP cards now show "On critical path — any delay here will delay the project end date" instead of float jargon, satisfying WCAG 1.4.1 plain-language requirement (#181).
- **Board saved views & quick filters** (issue #191): View dropdown in the board toolbar with four built-in quick filters (⚠ At risk, 🔴 Critical path, 📅 This week, 👤 My work), user-saved named views per project with RBAC-gated create/delete (creator or Scheduler role), functional sort (Priority rank / Start date / % complete), and URL-encodable `?view=` parameter for deep links. New `BoardSavedView` model with `POST/GET /api/v1/projects/{id}/board-views/` and `PATCH/DELETE /api/v1/projects/{id}/board-views/{view_pk}/` endpoints; all mutations broadcast a `board_view` WebSocket event.
**Board: "My tasks" filter for contributors (#198).** A new filter pill on the Board toolbar shows only tasks assigned to the signed-in user. Defaults on for Team Member roles and off for Resource Manager and above; the choice persists per-user-per-project. The filter resolves the user → resource link via the new optional `Resource.user` FK with an email fallback for legacy rows. Backend `?mine=true` filter on `GET /api/v1/tasks/` lands alongside the UI for downstream consumers.
- **Wave 1 shell design** (issues #200–204): the app shell now fully follows the active light/dark theme.
  - **Chrome tokens complete** (#202): `--chrome-row-hover`, `--chrome-row-active`, and `--chrome-grid` CSS custom properties added (light and dark); exposed as `chrome.row-hover`, `chrome.row-active`, `chrome.grid` Tailwind utilities.
  - **Brand tokens** (#203): `--sem-*-bg` semantic background tint tokens added for badge pill fills (`semantic-critical-bg`, `semantic-at-risk-bg`, `semantic-on-track-bg`, `semantic-warning-bg`); **JetBrains Mono** added as the tabular-numerals font, loaded via Google Fonts and exposed as the `.tppm-mono` utility class.
  - **Sidebar health dots** (#200): project rows now show a 7 px semantic health dot (green/amber/red) with a 2 px colour-matched halo instead of the generic project colour dot.
  - **App StatusBar redesign** (#201): the bottom status bar is now a 24 px global shell bar showing a live presence dot + online count, the build commit hash, and the active project/view as a status note. The previous Gantt legend footer is removed.
  - **Default landing** (#204): opening the app without a view segment now lands on the Board view (the canonical planning surface) instead of Overview.
- **Tab order + Schedule rename** (#204): canonical view tab order is now `Board · Schedule · WBS · Table · Calendar · Overview · Team · Risks`; "Gantt" label renamed to "Schedule" (route stays `/gantt` for permalink compat); Board is the default landing view.
- **TopBar status badges** (#205): P80 pill is now a `<button>` (MC drawer wires in #142); at-risk and critical badges are hidden below 1024 px and collapse into a `Health ▾` dropdown that lists task items; `HealthDropdown` component added with outside-click dismiss and keyboard-accessible `role="menu"`.
- **`GET /api/v1/projects/{id}/status-summary/`** (issue #205): new endpoint that returns project health signals in a single request — task count, at-risk count (tasks with ≤ 5 days total float), critical-path count (incomplete `is_critical` tasks), task lists for badge popovers, and last-saved/recalculated timestamps. Requires project membership. The TopBar P80, at-risk, and critical badge pills now use semantic background tints (`--sem-*-bg` tokens) for filled pill styling.
- **Calendar view — milestone diamonds**: milestones now render as ◆ diamond markers inside their day cell instead of chip bars, keeping the chip lane exclusively for duration tasks. A legend strip (Critical path · At risk · On track · Milestone) appears below the grid (#206).
- **Table view — filter rail and grouping**: task list gains a debounced search input, removable owner/status filter chips, and a group-by cycle button (None → Phase → Owner → Status). Each row now shows an owner avatar, Start/Finish dates, and a status pill (Done / In progress / Not started / etc.) (#207).
- **WBS view — Predecessors, Owner, and date columns**: the WBS grid adds Predecessors (formatted as `1.1 FS+3`), Owner avatar, Start, and Finish columns. Milestone leaf rows render a ◆ glyph; project-level rows use a sunken background and summary rows use a raised background for hierarchy clarity (#209).
Board wave 2: LaneMeta phase rail with 36×36 progress ring, per-phase add-task button and modal, and column tints (Done/Review/Backlog washes) with showColTints toggle (#208, #211).
Add per-project board column configuration: `BoardColumnConfig` model, `GET/PUT /projects/<id>/board-config/` endpoint (SCHEDULER role required for writes), `useBoardConfig` hook, and `BoardView` updated to use saved config with 4-column default fallback.
Wave 3 Schedule improvements:

- **#212** — Gantt bars now render a % completion chip inside the bar (left-anchored, clipped to bar bounds, omitted for bars narrower than 32px or 0% NOT_STARTED). Task names render outside the bar (4px right of bar end, fallback left for flush-right bars), fixing light-mode contrast issues where names were previously inside the colored bar.
- **#210** — Task detail drawer now has a header section above the tab bar showing: owner row (assignee name + avatar initials, passive amber ⚠ over-allocated pill when `assignee_is_overallocated`), date row (early_start → early_finish, muted baseline dates if present), and float row (0d float in red with "· critical path" for critical tasks, "Float pending" for unscheduled). History tab field labels updated to action-oriented form ("Assignee changed", "Start date moved", etc.).
- **#213** — Unscheduled gutter below the Gantt timeline shows tasks with no planned start date. Drag-to-promote lets users drag a task row onto the canvas to set `planned_start` (PATCH `{planned_start, status: NOT_STARTED}`). Keyboard alternative via ··· overflow menu. Collapsed state persisted in localStorage.
Login screen redesigned as a two-column layout: form on the left, dark marketing panel with a mini-Gantt preview on the right (#215). Adds remember-me (30-day session), SSO stub button, "Forgot password" link, and build/version footer. Marketing panel is hidden on mobile (< 768 px).
Board Workshop mode (ADR-0046): toggle-able collaborative planning surface that converts the operating board into a live multi-cursor canvas for project kickoff workshops. Includes inline-editable phase names (contentEditable), drag-to-reorder phases via @dnd-kit/sortable, "+ Add Phase" button for building project structure from scratch (empty board shows phase canvas instead of generic empty state), workshop session model with start/end lifecycle, sticky banner with elapsed timer and participant presence, exit confirmation dialog with focus trap, and the PATCH /phases/reorder/ endpoint. WebSocket channel for cursor/edit broadcast is wired and ready for Wave 10 cursor overlays.
- **Team heatmap** (#217): week × person utilization heatmap on the Resources/Team tab. Severity-banded cells (green ramp 1–100%, red ramp 101%+) with WCAG 1.4.1-compliant percentage labels. Click any cell to open a task drill-down drawer showing assignments, hours, and units for that person × week. Configurable 4/8/12/16-week window (persisted in localStorage). Group-by Role toggle. Week ‹ › navigation. Mobile collapses to a vertical sparkline list with 8-cell mini-bar per person.
- **KPI row** (#219): four summary cards above the heatmap — Avg utilization, Over-allocated count, Under-utilized count, and Headcount. Backed by `GET /api/v1/projects/{id}/resources/summary/`. Cards apply semantic color thresholds (red if over-allocated > 0, amber if avg util > 90%).
- **New API endpoints** (both SCHEDULER+ gated): `GET /api/v1/projects/{id}/resources/heatmap/?weeks=N&start=YYYY-MM-DD&group_by=role|none` — returns ISO-week utilization percentages per resource; `GET /api/v1/projects/{id}/resources/summary/` — returns rolling-8-week aggregate stats.
- **Team tab RBAC**: Team tab is now hidden in ViewTabs and BottomNav for users with role < SCHEDULER (VIEWER and MEMBER roles). Role is resolved via a new `?self=true` filter on `GET /api/v1/projects/{id}/members/`.
- **⚡ Level loads** button on the heatmap page is a disabled Enterprise upsell slot (cross-project resource leveling available in the Team tier).
- Risk register: RiskMatrix cells are now interactive — clicking a cell filters the risk table to that P×I coordinate; clicking again or pressing Escape clears the filter (issue #218)
- Risk register: Added risk framework fields — Category (Technical / External / Organizational / Project Management), Response (Avoid / Mitigate / Transfer / Accept), Mitigation Due Date, Trigger, and Contingency — all optional, surfaced in a collapsible "Advanced" section in the risk form and displayed in the risk detail drawer (issue #221)
- Risk register: Overdue mitigation badge — when a risk's status is Mitigating and the Mitigation Due Date is in the past, an amber "Overdue" badge appears inline with the status sub-label and the row is tinted `at-risk/5` (issue #221)
- Risk register: Client-side CSV export — "Export CSV" button in the desktop toolbar generates a RFC 4180–compliant CSV with all fields including the risk framework columns; filename format `risks-{project}-{YYYY-MM-DD}.csv` with UTF-8 BOM for Excel compatibility (issue #222)
- API: Django migration `0023_risk_framework_fields` adds five nullable columns to the `risk` and `historicalrisk` tables; all existing risks are unaffected (safe `ALTER TABLE ADD COLUMN` with NULL defaults)
Overallocated cells (load > 100%) in the resource grid are now interactive: clicking or pressing Enter/Space opens the **Overallocation Drawer** (480px right-side panel on desktop, 85vh bottom sheet on mobile) showing load summary, hours over capacity, and contributing task IDs. Includes focus trap, Escape-to-close, and `aria-live` announcement on open.
Customize views: hide and show which view tabs appear in the project nav, from a "Views" menu in the top bar or Settings → General. Your choice is saved to your account and applies across every project; hidden views stay reachable from the menu and the ⌘K command palette, and Overview is always shown. (#220, ADR-0139)
Risk register CSV import (#223): the symmetric counterpart of the existing CSV export. An **Import CSV** action on the Risk register toolbar (and on the empty register) lets Members and above seed or top up a project's risks from a spreadsheet. Upload a CSV with a **Title** column — every other column is optional and matches the export header. The import is partial by design: valid rows are created, invalid rows are skipped and reported per row (number, field, reason), out-of-range probability/impact and unrecognized status/category/response are flagged, and the owner column is matched to project members only (unmatched owners are left blank with a warning, never assigned outside the project). Imports are capped at 2 MB / 500 rows, and a single batched `risks_imported` WebSocket event refreshes collaborators after the rows commit.
Sprint assignment now available from the task detail drawer (SprintSection at priority 150 — shown for leaf tasks only). Task status and % complete are now editable fields in the Overview section of the task detail drawer (#405, #406). Demoting a task to Backlog from an active board status requires confirmation (ADR-0057). The Sprint Backlog table gains a "+ Add task" button that opens the unified task create modal with the active sprint pre-populated; ⌘K/Ctrl+K is wired as a keyboard shortcut in the Sprints view.
Sprints workspace header (wave/10) — `/projects/:id/sprints` route renders the breadcrumb, sprint header (H1, status pill, Filter / Plan next / Close sprint actions), Sprint Goal card, Advancing-to-Milestone card with deep-link to Schedule view, and the horizontal Sprint Cadence timeline strip with Closed / Active / Planned cards. SprintSerializer now nests `target_milestone_detail` for the milestone card without a second round-trip.
Sprints metrics row (wave/10) — Sprint Burndown chart (Actual / Ideal / Scope-add lines + TODAY marker + trending callout + forecast close), Capacity Preflight (donut + per-person rows + on-track/at-risk/over-capacity bands), and Velocity panel (last-8 sprint bars + rolling avg ± stdev + forecast range chip + ADR-0036 footer link). New `GET /api/v1/sprints/{id}/capacity/` endpoint exposes per-member committed/available hours; `capacity_check` is now a wrapper over the broader `capacity_summary` service.
Sprint backlog table (wave/10) — bottom panel of the Sprints view groups every task in the active sprint by board status (Done / In Review / In Progress / Not Started / Backlog), with CP flags on critical-path tasks, owner avatar chips, and an "Open in board" deep-link. Group sections collapse and the state persists in sessionStorage.
Multi-team Sprints lens (wave/10) — new `My Teams` toggle in the Sprints view shows a per-project summary card for every active sprint where the user has open task assignments. Cards include sprint id, day-N-of-M, remaining points, capacity %, trend chip (`N pts ahead/behind`), and forecast range; sorted server-side most-behind first. Powered by the new `GET /api/v1/me/active-sprints/` endpoint. Toggle only renders when the user has assignments in two or more active sprints.
Sprint retrospective panel (wave/10) — new section at the bottom of the Sprints view captures retro notes and structured action items. Items checked "Add to next sprint" are promoted server-side to tasks in the next planned sprint (or an explicit target) and the resulting task UUID is rendered as a `T-XXX` chip back on the action item. Powered by new `SprintRetro` and `RetroActionItem` models plus `GET/POST /api/v1/sprints/{id}/retro/`.
WIP-limit overload detection on the board (wave/10) — column headers now visually escalate from neutral → semantic-at-risk amber when the live task count equals the configured WIP limit, then to semantic-critical red when it exceeds the limit. Chips read `{N}/{limit}` (under), `{N}/{limit} WIP` (at), or `{N}/{limit} — over WIP limit` (over). Moving a task into a column that would push it past the limit now triggers a confirmation prompt; declining cancels the move. Backwards compatible: columns with `wip_limit=null` render the unchanged neutral count chip.
Project methodology preset (ADR-0041) — `methodology` field on `Project` (`WATERFALL`/`AGILE`/`HYBRID`, default `HYBRID`) drives default tab visibility in the project workspace. New project wizard prompts for the methodology; tab matrix per ADR-0041 hides Sprints for Waterfall, Schedule/WBS/Calendar for Agile.
Sprint API backend (ADR-0037): Sprint model with state machine (PLANNED/ACTIVE/COMPLETED/CANCELLED), velocity and burndown snapshots, capacity-check warnings on activate, transactional outbox close with carry-over, and `?sprint=` filter on tasks.
Project burn chart endpoint (ADR-0022) — `GET /api/v1/projects/{id}/burn/` returns daily burndown or burnup series sourced from `HistoricalTask` snapshots, with linear ideal curve, scope tracking, and an optional planned overlay derived from the project's active baseline. Supports `chart_type=burndown|burnup`, `metric=tasks|points`, and `since`/`until` date params (default: project start through today).
- Risk register: row-level quick-edit affordance — a ✎ pencil icon appears on hover/focus on each risk table row; clicking it opens the drawer directly in edit mode, skipping the detail view step (issue #243)
- Risk register: risk comments / notes thread — each risk now has an append-only notes section in the drawer; comments show author initials, name, and timestamp; members can post notes; comments are immutable in v1 (issue #244)
- API: new `RiskComment` model with `GET/POST /projects/{project_pk}/risks/{risk_pk}/comments/` endpoints; comments are MEMBER+ to post, VIEWER+ to read; `comment_created` WebSocket broadcast via `transaction.on_commit`; Django migration `0024_riskcomment`
User profile menu replaces the TopBar "U" placeholder: avatar chip shows real initials, clicking opens a dropdown (desktop) or bottom sheet (mobile) with display name, email, 3-way theme toggle (Light / Auto / Dark), notifications stub, keyboard shortcuts stub, and Sign out (#245, #246). Theme controls removed from TopBar; new `GET /api/v1/auth/me/` endpoint returns `{id, username, display_name, initials, email}`.
### Added

- Normalized free-form `notes` fields across primary user-facing entities (ADR-0048):
  - `Risk.notes` — new `TextField` exposed on `RiskSerializer`.
  - `Sprint.notes` — new `TextField` exposed on `SprintSerializer`; editable past the PLANNED state (notes are PM annotations, not commitments).
  - `ProjectResource.notes` — widened from `CharField(max_length=500)` to `TextField` so long PM notes are no longer truncated.
  - `Task.notes` — gained an explicit empty-string default; the API contract guarantees a string return.
- TypeScript types in `packages/web/src/types` and `packages/web/src/api` now declare `notes: string` (required) on `Task`, `ApiSprint`, and `Risk` to match the API contract.
`seed_demo_project` management command — bootstraps the "Platform Migration" demo project end-to-end so reviewers can walk through the eight-step hybrid PM flow without manual data entry. Idempotent. With `--with-personas` it also creates the six persona logins (Maya / Raj / Diana / Sarah / Carlos / Tom, all password `demo`) bound to the project with role-appropriate memberships and a secondary "Pilot Deployment" project for the multi-team Sprints lens. See `docs/getting-started/demo-project.md`.
Hybrid PM flow narrative ported to the docs site as the canonical product story (`/the-story`), plus 10 new feature reference pages backlinking from each story step (Sprints, Plan Sprint, Sprint backlog, Burndown, Capacity preflight, Velocity, Multi-team lens, Retrospective, WIP overload, Methodology preset). Sidebar gains a "The Story" section between Overview and Getting Started, and the Features section now lists every wave/10 panel plus the methodology preset. Closes the launch-readiness gap where the strongest pitch only existed as a one-off HTML on the founder's laptop.
Install and upgrade documentation: `docs/getting-started/installation.md` now covers all four install paths (Docker Compose, Helm/Kubernetes, single-server systemd, scheduler library). New `docs/getting-started/upgrade.md` covers rolling upgrades, rollback, and post-upgrade verification for each path. `docker-compose.prod.yml` image references updated to GHCR. Closes part of #301.
CI/CD publish pipeline: `api:publish` and `web:publish` push Docker images to GHCR (`ghcr.io/trueppm/{api,web}`) on `v*` tag push; `helm:publish` packages and pushes the Helm chart to the GHCR OCI registry. Closes part of #301.
`make release-smoke` target: boots the dev stack, seeds the demo project, and curls every shipped endpoint — exits non-zero on any failure. New `scripts/smoke-test.sh` powers the target. New `docs/contributing/release.md` documents the full release process (`scripts/release.sh`, changelog, CI publish, enterprise handoff, hotfix procedure). Closes #301.
- Board card information popover (issue #304): clicking a card now opens a quick-summary popover with readiness, critical-path indicator, WBS, status, dates, float, sprint chip, and assignees. Footer actions: **Open detail** opens the existing task detail drawer; **Edit** opens the drawer in edit mode. Closes on Escape, click-outside, or route change. Mobile (< md, 768px) renders a bottom sheet with focus trap and scrim. Closes #265 — the click-target wired through the popover replaces the previously-unimplemented direct card → drawer interaction.
Add Activity section (priority 600) to the task detail drawer — human-readable timeline of task events with filter chips (All · Status · Edits · System), timeline rail with user initials/system dot, action verbs, and relative timestamps. Uses existing `useTaskHistory` hook with infinite-scroll pagination. A follow-up issue (#413) tracks API extension for comments, time-log, and CPM-recompute event types that are not yet in the history endpoint (#307).
Add subtasks support (ADR-0060): one level of hierarchical child tasks beneath any task.
Inline creation from the task drawer, progress rollup bar, depth-1 guard (no task of any kind
may be created as a child of a subtask, enforced on every parent_id create path), sprint scope-change audit chips when a subtask is added to an
in-sprint task, and flat My Tasks surfacing for assigned subtasks.
- **Task collaboration UI** (#310 #311): in-drawer attachments grid with drag-drop upload and external-link pin; comment thread with composer, `@mention` autocomplete (individuals + auto-groups), 10 000-char limit, and 15-minute edit window; ✅ acknowledgement and 👍 reaction affordances; mention rate-limit error surfacing. New TopBar notification bell with unread badge and slide-out panel; `/me/notifications` route for the full inbox; `/me/settings/notifications/` for the per-(event, channel) preference matrix (auto-saved 300 ms after each toggle). 30-second polling for unread count, paused while the tab is hidden. Feature documentation at `/features/task-collaboration` (ADR-0075).
- **Task collaboration** (#310 #311): task comments with threaded replies (one level), @mention fan-out to project members, emoji reactions, file and external-URL attachments, and per-user notification preferences. Mentions are parsed server-side (code-fence and escape-aware); notifications are created transactionally via bulk_create. Rate-limited to 1 000 mentions/day + 100/hour per user (ADR-0075).
Schedule view: a CPM cascade now slides collaborators' Gantt bars in real time. After a recalculation the server broadcasts a batched `task_dates_updated` WebSocket event with the moved tasks' dates, and the web client splices them straight into its cache instead of re-fetching every task — so a teammate's edit moves your bars instantly, not on the next poll. See ADR-0091.
Schedule view: promote a backlog idea onto the timeline in one move. The Unscheduled gutter now has a **Backlog** section below the To Do section — drag a backlog chip onto the timeline and it's promoted to To Do, scheduled at the drop date, and cascaded through CPM. For keyboard users, a **Schedule…** action (on the gutter chip and on Board backlog cards) opens a date picker that does the same. Backlog chips are marked with a dashed edge and readiness label so it's clear a drop promotes them.
- **Board card search**: the Kanban board toolbar now has a search box (press `/` to focus it) that finds cards by title and description across the project. Matching cards stay lit while the rest dim, a chip shows the match count, and the query is stored in the URL (`?q=`) so a searched board is a shareable link. Backed by a trigram-indexed, role-aware `GET /api/v1/tasks/search/` endpoint. (#323)
Board swimlanes can now be grouped **by assignee** (alongside the existing phase grouping) via the toolbar's Group control — each teammate gets their own lane, with unassigned cards collected in an "Unassigned" lane. The choice is remembered per board. (#324)
Board-level activity feed: a new read-only, board-scoped, filterable feed of every card mutation — status, assignee, points and name changes, sprint entries and exits, and comments — with attribution and timestamp, aggregated from existing change history with no new data stored (ADR-0160). `GET /api/v1/projects/{id}/board/activity` supports server-side filtering by event type, actor, and time window, with keyset pagination (`until` cursor → `next_until`). Any project member (Viewer+) can read it; the cost-field visibility gate is in place for when financial fields land. The board activity panel and live updates ship in a web follow-up. (#325)
Export the board as a PDF — a new "Export PDF" action in the board toolbar's More⋯ menu renders a boardroom-clean, paginated PDF of the current board (swimlanes, columns, cards with assignee/due/key chips, and a footer with project, timestamp, exporting user, and active filter context). The export honors the current sprint scope and filters, and is generated entirely in the browser.
Board cards can now move automatically on inbound Git events. When a project admin enables Git-event automation and pastes the per-project webhook URL and secret into GitHub or GitLab, an opened pull/merge request advances its linked task to **Review** and a merged one advances it to **Complete** — forward-only, through the normal status-change rules (no WIP or permission bypass). Off by default and one-way (Git → card); the inbound receiver verifies each delivery with a GitHub HMAC-SHA256 or GitLab token signature.
Mobile Monte Carlo card (#33): below md, the Gantt now shows a compact
MC card with P50/P80/P95 chips above the hidden StatusBar. Tapping the
card opens a full-screen bottom-sheet dialog containing the full MC
histogram; the close button is a 44×44 tap target (rule 5). Escape and
backdrop tap dismiss the sheet. Desktop path (MonteCarloRow above the
task list) is unchanged.
Monte Carlo P50/P80/P95 vertical markers now overlay the Gantt timeline (scroll-synced via DOM ref writes). Footer strip shows P80 risk delta vs CPM finish (`+Nd vs CPM`). Recomputing state appears when Rerun is active or after any task reschedule. New "Details" button opens a slide-in panel with the full histogram, risk deltas, top PERT duration drivers, and confidence-by-date.
Name EditableCell in build mode now shows an inline autocomplete dropdown (up to 6 suggestions: milestones first, then other task names) that filters as the user types and supports keyboard navigation.
The Gantt timeline shows a dashed amber ghost bar spanning today + 5 days whenever a task name cell is in edit mode in build mode, giving immediate positional feedback before the scheduler runs.
Clicking the start date of a milestone row in build mode opens a 220px quick-pick popover with parent-phase chips, an active-sprint end-date chip, and a custom date input.
After committing a task name in build mode, projects with `agile_features=true` now show a numbered sprint-assignment prompt (current sprint · next sprint · Backlog · Esc later) with keyboard shortcuts 1–3.
Build mode adds Option+↑/↓ (Mac) / Alt+↑/↓ (Windows/Linux) keyboard reorder among same-level siblings and a ⋮⋮ drag handle (visible on row hover) for pointer-based row reordering, both backed by the existing reorder API. The drag handle tooltip shows the correct modifier key label for the current OS.
Schedule view: continuous zoom. Zoom smoothly between hour-level detail and a multi-year overview with Ctrl/Cmd+wheel or trackpad pinch (cursor-anchored — the date under your pointer stays put), the toolbar `−`/`+` stepper, or `⌘/Ctrl` with `=`, `-`, and `0` (fit to project). The two-row date header auto-swaps its emphasized tier (day → week → month → quarter → year) as you zoom.
- **Progress-anchor gate**: `PATCH /tasks/{id}/` now returns `400 {"code": "progress_requires_anchor"}` when `percent_complete > 0` is submitted but the task has neither a `planned_start` date nor a sprint assignment. ADMIN+ users are exempt. Prevents "ghost progress" on unscheduled tasks.
- **Auto-promote on first progress**: setting `percent_complete` from 0 to any value between 1–99 on a `NOT_STARTED` task automatically transitions it to `IN_PROGRESS` and sets `actual_start` to today. Team Member+ role required; Viewers are excluded. Skipped when `status` is explicitly included in the payload.
- **Sprint cross-project ownership**: assigning a sprint that belongs to a different project is now rejected with a `400 {"sprint": "Sprint does not belong to this project."}` validation error.
- **MS Project import**: tasks imported from `.mpp` files with `PercentComplete > 0` but no start date are now clamped to `percent_complete = 0` to preserve the progress-anchor invariant.
Product-Owner backlog foundation (ADR-0105, Wave 1): tasks gain a work-item type (Story/Task/Bug/Spike/Epic) and an epic-grouping link (`parent_epic`) parallel to the WBS, a Definition-of-Ready signal with a server-enforced (advisory) "ready" gate, first-class tickable acceptance criteria with a sprint-review pass/fail trail, WSJF/RICE/value-effort prioritization scoring with a one-shot auto-rank action, and a sprint-scoped execution order (`sprint_rank`) distinct from product-backlog priority. New `GET /projects/{id}/product-backlog/` grooming view, `POST /projects/{id}/product-backlog/auto-rank/`, `POST /tasks/{id}/split/`, and `/acceptance-criteria/` CRUD. Epics are excluded from CPM and capacity math. Tracking issues #363 #364 #365 #493 #922.
Added a "By epic" board grouping option that organizes swimlanes by each card's parent epic, with a "(No epic)" lane for ungrouped work (#364).
Add an in-sprint reorder endpoint (`POST /sprints/{id}/reorder/`, Member+) that sets the within-sprint execution order (`sprint_rank`) independently of the product-backlog order (`priority_rank`), completing the dual-ordered-backlog model (ADR-0105 §5 / ADR-0110 §5). The reorder is optimistic-locked on `server_version` (stale or incomplete sets return 409) and broadcasts a `sprint_reranked` event. Closing a sprint now clears the live `sprint_rank` so carried-over tasks re-enter their next sprint un-ranked, while the closing order stays queryable in task history.
Add `remaining_points` to Task for live sprint burndown. Auto-zeroed on COMPLETE, restored from `story_points` on reopen. Burndown snapshots use `remaining_points` when set (falls back to `story_points` for legacy tasks). Task detail drawer Estimates section shows a read-only committed points badge and an editable Remaining (pts) field when the task's sprint is active.
Renovate config at `renovate.json` manages weekly dependency updates
(Python, npm, Cargo, Docker, Helm, GitLab CI) with grouped minor/patch
PRs and auto-merge for devDependency patches. Version, downloads,
pipeline, and license badges added to README. PyPI publish pipeline
deferred to 0.3 pending project-name reservation (#37).
Add PyPI version, download, CI, and license badges to the `trueppm-scheduler` README.
"Load demo data" — a one-click sample loader. A fresh install can load the **Atlas Platform Launch** demo (a three-project hybrid program spanning agile, waterfall, and hybrid delivery with cross-project dependencies, three-point estimates, baselines, risks, and a resource roster) from the Programs page (the index header on any instance, or the empty-state hero on a fresh install), the `load_sample_project` management command, or `POST /api/v1/programs/load-sample/`. Sample programs are flagged and offer a one-click "Remove sample data" teardown.
- **Board zoom**: a new zoom control in the board toolbar (Small / Normal / Large) scales the board surface — phase-column width and the gaps between columns and cards — to fit more on screen or spread it out for a presentation, without shrinking the rest of the app the way browser zoom does. The choice is remembered per browser and is an independent axis from card Density. (#379)
Add scheduler documentation and executable notebooks for calendar-aware
scheduling (`03-calendar-aware.ipynb`) and incremental CPM (`04-incremental-scheduling.ipynb`).
Add `packages/scheduler/CONTRIBUTING.md` with dev setup, bench instructions,
and design constraints. Add `docs/integration/django.md`, `fastapi.md`, and
`standalone.md` integration guides with runnable code examples. Add
`scheduler:notebooks` CI job that executes all notebooks via `jupyter nbconvert`
on every scheduler MR. (#38)
- **Marketing screenshot Playwright spec**: opt-in Playwright config and spec
  (`packages/web/playwright.marketing.config.ts`, `e2e/marketing-shots.spec.ts`)
  for capturing Overview, Board, Schedule, and Risks screenshots for marketing
  use. Runs separately from the default E2E suite and does not affect CI.
  Refs #380.
Board: Drawer layout for the BACKLOG surface (epic #361 child C). Selecting **Drawer** in the calm toolbar's layout switcher renders the inbox as a collapsible top strip above the phase grid — a responsive grid of backlog cards with a header that surfaces total count, stalled count (>14 days untouched), and the drag hint. Open/closed state persists per user via `trueppm.board.backlogDrawer.open`. Reuses `BacklogCard` from the rail; drag/drop targets use the shared `BACKLOG_BAND_DROPPABLE_ID`.
**Web**: Board view's Queue layout — single prioritised list grouped *Next up · In flight · Backlog · Recently done* (epic #361 child D). The Queue replaces the rail and phase grid when selected; promotion/demotion via row overflow menu lands in a follow-up.
Project forecast-snapshot capture: every schedule recompute now records a `ProjectForecastSnapshot` (CPM finish, total float, Monte Carlo P50/P80/P95, task counts) so a PM can see how a project's finish date has drifted over time. A nightly floor task guarantees at least one snapshot per active project per day, and a tiered retention policy (daily for 90 days, weekly to 1 year, monthly thereafter — configurable via `FORECAST_SNAPSHOT_RETENTION`) keeps the table bounded. History is exposed read-only at `GET /api/v1/projects/{id}/forecast-snapshots/`.
Add "Export CSV" button to the Task List toolbar — Blob download, < 2s for
1000 tasks. Add `start__gte` / `finish__lte` date-range filters to the
`/api/v1/tasks/` endpoint for calendar window queries. Replace the
`useCalendarTasks` stub with a real TanStack Query hook wired to the filtered
endpoint. New `src/utils/exportCsv.ts` utility with 11 vitest unit tests;
5 API tests for the date-range filter. (#40)
- **Hybrid governance / delivery-mode task fields** (ADR-0036): every task now
  carries `governance_class` (`gated` / `flow` / `hybrid`), `delivery_mode`
  (`waterfall` / `scrum` / `kanban` / `milestone`), and `parent_governance_inherited`,
  exposed read/write on the task API. These are the foundational schema the unified
  waterfall/agile model builds on — the rollup engine, agile-aware Monte Carlo, and
  governance overlays all read them. Purely additive: existing tasks default to
  `flow` / `waterfall` / inherited, so no behavior changes for current projects.
Sprint→milestone rollup (ADR-0074): when sprints are linked to a Gantt milestone via `Sprint.target_milestone`, the milestone's `percent_complete` now rolls up live from sprint state and the milestone is read-only against manual writes; the SprintsView "Advancing to milestone" card and the Gantt now show the same number, plus a +Nd / -Nd "sprint plan" variance chip and a scope-changed indicator. Aggregated only — no per-assignee or raw point counts in the WebSocket broadcast (Morgan VoC guardrail).
Kanban is now a first-class board cadence. Agile and hybrid projects can switch a board to **continuous flow (Kanban)** in Project → Workflow & fields, which hides the sprint panel, burndown, and sprint header and leans on the flow-analytics panel instead; switching is non-destructive and an in-flight sprint is preserved. Each board column can also carry a configurable **aging threshold** that gives cards a calm "aging" badge when they sit in a column too long (#410).
- **Agile-aware Monte Carlo** (`trueppm-scheduler`): the simulation engine can now
  treat sprint-delivered work as a velocity distribution instead of a three-point
  duration estimate. A task tagged `delivery_mode=scrum` with committed
  `story_points` samples sprints-to-completion from the team's historical
  throughput (`Project.velocity_samples` + `sprint_length_days`) via throughput
  Monte Carlo, so a mixed waterfall/scrum project produces a single P50/P80/P95
  finish-date distribution that reflects both per-task estimate risk and sprint
  velocity variability. Backward compatible — projects with no scrum tasks behave
  exactly as before; a scrum task with no velocity signal falls back to its
  deterministic duration.
Added a `role_context` user preference (PM / Scrum Master / Unified Today) persisted on the user profile, the API foundation for the role-context switcher (#412).

Added the Unified **Today** view — the dual-hat PM + Scrum-Master home the Unified Today focus lands on. A single project screen splits a read-only schedule pulse (schedule health, SPI, percent complete, critical/late counts, next milestone) over the active sprint board, with the active sprint's live progress surfaced on the pulse (a one-way board → schedule rollup). Available as a **Today** tab on every project (#412).
Percent-complete is now protected when a task's duration changes. By default a duration edit **keeps** the entered percent-complete (the PM's value is the source of truth) and records a `TaskDurationChangeEvent` audit row — readable at `GET /api/v1/tasks/{id}/duration-events/` and broadcast as the WS-only `task_duration_changed` event. A new inheritable workspace setting, `task_duration_change_percent_policy` (Workspace → Program → Project, ADR-0151), selects `keep` (default), `prorate` (scale the percent by the duration ratio), or `confirm` (keep server-side and let the client offer an inline re-estimate). The CPM cascade never alters entered percent-complete and never prompts.
The board now has a **sprint view**: a toolbar switcher scopes the phase columns to a single sprint (active, planned, or completed) or back to the whole project. The selection is shareable via a `?sprint=` URL param, and dragging a card into a phase while viewing an active/planned sprint assigns it to that sprint (#429, ADR-0119).
Community and documentation: SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md at repo root; README maintainer block and roadmap links; About/Maintainers page on the docs site (MacroDream context, accurate background, Visiban reference); landing page now leads with a quickstart code block and tech-stack strip; roadmap feature pages tagged with target-release caution notices (closes #458, #459, #460, #461, #462, #463, #471).
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
Tasks can now be flagged as **blocked** with a reason (`blocked_reason`). Blocking a task you don't own notifies its assignee via the new `task.blocked` notification event (#476, #855, ADR-0122).
OSS publish pipeline: `trueppm-api` (PyPI wheel) and `@trueppm/web` (npm) are now built and published as versioned, installable artifacts on each `v*` release tag, alongside the existing Docker image and Helm chart jobs. This makes the full community edition pin-installable from public registries (`pip install trueppm-api==<version>`, `npm install @trueppm/web@<version>`). The web package is now scoped as `@trueppm/web`.
Sprint planning capacity field (`Sprint.capacity_points`) and Board view sprint panel — surfaces the active sprint goal, dates, burndown chart, velocity sparkline, and planned-vs-committed capacity directly above the Board lanes. SCHEDULER+ users can edit the planning target inline; viewers see a read-only summary. Hidden entirely on WATERFALL projects. (ADR-0073, #482)
"My Work" now groups your tasks into **Today / This Sprint / Upcoming** — computed server-side so every client sees the same buckets — and surfaces a prominent **Blocked** badge with its reason. No project-management jargon (#484, ADR-0122).
The Sprints view velocity chart now draws a rolling-average trendline across the bars, so a team can read each sprint against its average at a glance (not just the numeric `avg ± stdev`).
Retrospective action items now promote to the project backlog via an explicit
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
Backlog delivery forecast: a new velocity Monte Carlo answers "when is the backlog done?" with P50/P80 sprint counts and calendar dates. It surfaces as a Backlog forecast card on the project overview and as sprint-finish + release-horizon projection chips beneath the board burndown — both reading the new `GET /projects/{id}/sprint-forecast/` endpoint. Team-private by default (ADR-0104) and shown only once two sprints have closed.
Schedule view: drag-to-pan the timeline. Hold Space and drag, or drag with the middle mouse button, to pan the Gantt on both axes — the cursor shows a grab/grabbing hand and task-bar dragging is suspended while panning. A hint in the schedule legend documents the gesture.
- **Schedule canvas pull-to-commit gate** (#492, ADR-0067): drag and resize on a
  task bar no longer commit the change on pointerup. After the gesture, a
  Confirm/Cancel popover anchors above the new bar position. Esc, Cancel, and
  click-outside revert without writing; Confirm fires the PATCH. The popover
  surfaces a "Committed in Sprint *name*" notice when the task is in an ACTIVE
  sprint so a PM cannot quietly retime sprint-committed work. Audit trail is
  unchanged — every confirmed change continues to flow through the existing
  django-simple-history record (ADR-0011) and appears in the Task drawer's
  History tab.
Product Backlog grooming view: drag-to-reorder stories by priority (within an epic group), a prioritization-score column (WSJF / RICE / value-effort), and inline title-only quick-add. Reordering is conflict-safe — a concurrent change by another Product Owner reloads the backlog so no one's order is silently lost.
Unified sprint planning surface — the PLANNED-state Sprints workspace now brings the priority-ordered backlog, the capacity gauge, the incoming-carryover preview, and the goal↔milestone bridge banner together on one screen, so the sprint-commitment conversation no longer means toggling between the board, backlog filter, and resource panel (#495).
Schedule-canvas reschedules now notify the affected people: when a confirmed reschedule moves a task's planned start, its assignee gets a targeted in-app notification (with old and new dates, deep-linked to the task), and if the task is in an active sprint the rest of the sprint team is notified too. Event-sourced notifications now render their own title and preview in the inbox and link straight to the affected task.
**Velocity calibration on sprint close** (ADR-0065 gap 1, #498). When a sprint closes, TruePPM now computes the team's rolling six-sprint velocity and, for each task in the closing sprint with story points set, generates a non-destructive `VelocitySuggestion` recommending a new `most_likely_duration`. The PM accepts or dismisses the suggestion from the Task Detail Drawer's Estimates section; the underlying value is never overwritten without consent. Suggestions require ≥3 prior completed sprints, respect the project's `estimation_mode`, and are auditable per (task, sprint).

- New endpoints: `GET /api/v1/velocity-suggestions/`, `POST .../accept/`, `POST .../dismiss/`
- `GET /api/v1/projects/{id}/velocity/` now also returns `team_velocity_per_day`
- New `scheduling.VelocitySuggestion` model with unique (task, sprint) index
- **My Work contributor surface** (#499, ADR-0065 Gap 2). New cross-project endpoint `GET /api/v1/me/work/` returns the authenticated user's assigned tasks across all projects — flat shape, no CPM fields, grouped client-side by active sprint. Companion web page at `/me/work` lists tasks with tap-to-update status chips, distinct empty states for new users vs. unassigned users, and a sidebar entry in a new "Me" section. The `PATCH /api/v1/tasks/{id}/` path now reads an optional `X-Source` request header (lowercase letters and underscores only, max 64 chars, otherwise coerced to `unknown`) and propagates it into the `task.updated` webhook payload so consumers can distinguish a status flip from `/me/work` vs. the schedule canvas. Mobile React Native screen deferred to a follow-up (`packages/mobile/` not yet scaffolded); the endpoint contract is mobile-ready with `LimitOffsetPagination` (default 100, max 200) and a `server_version_high_water` for offline delta sync.
Short hex object IDs — human-readable project-scoped identifiers for tasks and risks.
- **Inbound task-sync protocol** (#500, ADR-0068, closes ADR-0065 Gap 3). New project-scoped `POST /api/v1/projects/{id}/task-sync/` endpoint accepts a lightweight authenticated push from Jira, Linear, GitHub Issues, or any custom source. Idempotent upsert by `(project, source, external_id)` on a new `InboundTaskLink` model; default status_map (`todo`/`in_progress`/`done` plus common synonyms) with per-token override; assignee resolved by email with a `pending_assignee_email` fallback that resolves on re-push once the user joins the project; parent attach via `parent_external_id` preserves Jira epic→story hierarchy and is scoped same-source to prevent cross-source downgrade. New `ProjectApiToken` model with `tppm_<64-hex>` token format (SHA-256 hashed at rest, shown once, prefix indexed for audit identification), Admin/PM (role ≥ 3) gated `POST`/`DELETE /api-tokens/` endpoints, and an immutable `status_map` (changes require new-token-plus-revoke so the team sees them via the audit log). Append-only `ApiTokenAuditEntry` model + `GET /api-token-audit/` (member-visible) records every mint/revoke/use with token prefix, actor, source IP, and JSON detail — covers SOC 2 evidence and Morgan's team-visibility concern without building the notifications app. Per-project rate limit: 100 req/min steady state, 1000 req/min for the first 60 minutes after token mint (backfill window for migrating existing data); token-issuance gets a separate 5 req/min per-user limit. Both backed by raw `redis-py` against `settings.REDIS_URL` (no new `django-redis` dependency). Project detail response surfaces `unresolved_assignee_count` (partial-index backed, O(log n)) so PMs have a triage signal. Inbound upserts fire `task_created`/`task_updated` via `broadcast_board_event` + `dispatch_webhooks` + `enqueue_recalculate` on `transaction.on_commit()` — full real-time and CPM integration. Import-only by design: two-way write-back to the external source is Enterprise scope. Sprint-binding from the payload is deferred to a future ADR after the first-class Sprint entity (#482) stabilizes. Documentation at `/features/inbound-task-sync/` covers GitHub Actions, Jira Cloud, and Linear integration patterns plus a chunked-backfill recipe.
### Program entity (OSS) — coordinate related projects under one PM (#502, ADR-0070)

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
Settings UI implementation: workspace, project, and program settings shells with full left-rail navigation, scope switcher, and page content (#509 general/members/groups/roles, #510 methodology, #511 integrations/webhooks, #512 project settings, #513 program settings). Adds `/settings/*`, `/projects/:id/settings/*`, and `/programs/:id/settings/*` routes; wires Settings link into the sidebar Org section.
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
Added `/kaizen` skill for continuous improvement of the development harness. Distinct from `/pre-release` (which audits the codebase), kaizen audits the *process* — agent gate mandates, CI duration, MR cycle-time, override frequency — and files a small ranked list of speed wins against the next minor milestone. Hooked into `/pre-release full` as Step 0.7. Also documents fast-path gate cluster rules in user CLAUDE.md so the pre-MR gate batch (`regression-check`, `security-review`, `rbac-check`, `perf-check`, `broadcast-check`, `migration-check`) runs in parallel. Targets harness speed score 6/10 → 8/10 for 0.2.
Program Settings → Rollup KPIs is now wired to a real API (`GET|PATCH /api/v1/programs/{id}/rollup-config/`, ADR-0169). Program admins can toggle which of 10 health signals roll up to the program overview (Schedule, Risk, Cost groups) and choose the health aggregation policy (`worst` / `average` / `weighted_by_budget` / `task_weighted`). New programs are seeded methodology-aware defaults (waterfall, agile, or hybrid). All config changes are captured in the existing Program history records for audit.
Program Settings → Cadence & ceremonies wired to a real API (ADR-0079, #528). Adds program-scoped `CeremonyTemplate` CRUD (`/api/v1/programs/<id>/ceremonies/`) and a singleton `PhaseGateConfig` endpoint (`/api/v1/programs/<id>/phase-gate-config/`). Program admins can configure recurring meeting cadences (weekly / bi-weekly / monthly / on-milestone) and a phase-gate invite template; non-admins see the page read-only. Scrum sprint event names (Sprint Planning, Review, Retrospective, Daily Scrum, Standup) are rejected at the API to keep program-level cadence from absorbing per-sprint events.
Program Settings → Risk & deps policy is now wired to a real API. The slip-propagation radio (none/warn/block) and the auto-escalation days input (1–30) persist via `GET|PATCH /api/v1/programs/{id}/risk-policy/`; only program admins can edit and every change is audited via the existing program history. The 5×5 risk matrix on the same page remains workspace-scoped and read-only.
Added burn charts to the new **Reports** tab: burn down (remaining work + ideal line + scope-change markers), burn up (completed work + scope line), and combined overlay. Variant selector, metric selector (tasks / story points), and date-range pickers are included. Export to PNG and PDF available from the chart toolbar. Sprint workspace now uses the same `<BurnChart>` component instead of the legacy hand-rolled SVG burndown. The `combined` chart type is handled server-side in `ProjectBurnView` (previously raised `ValueError`).
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
The Workspace → Roles & permissions matrix now marks Enterprise-only capabilities (View audit log, Manage SSO, Manage integrations, Manage billing, Export workspace data) with an "EE" badge that links to the TruePPM Enterprise page. Evaluators can now tell which capabilities are part of the community edition versus Enterprise without leaving the matrix — previously those rows looked like broken or unfinished features. The badges are shown only in the community edition.
Workspace members now carry a baseline-availability percentage (with optional effective-date range and notes), giving the project-level allocation model a denominator for over-allocation checks. Owner/Admin can set it via the members API; each member can see their own baseline.
Mid-sprint scope audit — the Board sprint panel now shows a "⚠ N tasks added mid-sprint" badge when work is injected into an active sprint after it starts, opening a team-readable audit drawer listing who added what, when, and the point value. New `GET /sprints/{id}/scope-changes/` endpoint (#543).
Sprints now carry an optional **WIP limit** — a per-sprint ceiling on in-flight work (tasks in *In progress* or *Review*). When set, the Board's sprint panel header shows a `WIP {count} / {limit}` chip that turns amber the moment the count exceeds the limit, surfacing overload before it becomes a team-health problem. The limit is editable by Scheduler+ on planned and active sprints (locked once the sprint is completed or cancelled), mirroring the capacity-points gate. This is a lightweight signal distinct from per-column board WIP limits.
Added an at-a-glance "N on critical path" count to the active-sprint panel on the board — the reverse hybrid bridge, so a Scrum Master can see how much of the sprint sits on the schedule's critical path without leaving the board.
Team-signal privacy controls (ADR-0104, OSS). A new **Project Settings → Signal privacy** tab (agile/hybrid projects) lets a team govern how far each team signal — velocity, throughput rollup, and the retro pulse — may travel, on one ordered ladder (Team → Scrum Master → PM → Program). Each signal carries a current audience and a team-authorized **ceiling**: the Scrum Master moves the dial freely below the ceiling, while *raising* the ceiling is a deliberate, audited, team-owned decision. Velocity and the pulse stay team-private by default; sharing upward is always explicit and revocable, and the Scrum Master can pull everything back to team-only in one click. Reads are suppressed, not blocked — milestone health and schedule confidence stay visible to everyone; only the team-private detail is gated, and a non-member can never read a team signal regardless of role. A supply-only extension point (`get_shared_team_signals` / `team_signal_consent_changed`) lets the enterprise program rollup consume only what a team has explicitly opted in.
Programs now carry an optional **target date** (set on Program → Settings → General, ADMIN+) that surfaces on the program card and the Projects tab header, and each row on the Projects tab shows a standup-style **overdue / at-risk task count** for that project. The counts come from the program's projects endpoint in a single query (no extra round-trips). (#560)
The **Add project to program** picker now shows a methodology badge (Waterfall / Agile / Hybrid) on every project row and a methodology filter, so you can confidently pick the right project when several share a similar name. The filter works alongside the existing search, entirely client-side. (#564)
Program memberships now carry an optional freeform role title (e.g. "Product Owner", "Tech Lead") alongside the access role, anchoring the PO-vs-PM sovereignty signals the dual-level backlog will surface. Owners set it on any field; Admins can set the title on its own.
The Sprints workspace is now **state-aware and lets you review any past sprint**. The cadence timeline strip is a selector — click any sprint card (closed, active, or planned) to load that sprint in the workspace. Selecting a **closed** sprint shows a read-only review: a five-card outcome row (goal verdict, committed, completed, rolled-over, velocity Δ), the frozen historical burndown, its retrospective, and a **"what didn't ship"** list showing each unfinished task and whether it carried to another sprint or was dropped. Everything is read from the server's consolidated sprint-outcome API — nothing is computed in the browser — and velocity figures stay team-private for readers outside the velocity audience. Previously only the active sprint was viewable.
Added `Project → Settings → Integrations` and `Program → Settings → Integrations` pages — read-only summaries of webhooks and inbound API tokens at each scope, served by `GET /api/v1/projects/<id>/integrations-summary/` and `GET /api/v1/programs/<id>/integrations-summary/`. Webhooks and API tokens now carry a polymorphic scope (project XOR program, enforced by DB constraint): a program-scoped webhook fires for events on any project in the program, and a program-scoped token authorizes inbound writes into any project the program contains — eliminating the copy-paste-Slack-URL-into-N-projects friction for program managers. `ProjectApiToken` renamed to `ApiToken` (backwards-compat alias retained until 0.4). The two static workspace stubs (`WorkspaceIntegrationsPage`, `WorkspaceWebhooksPage`) were misclassified per ADR-0076 and have been removed from the OSS bundle; the workspace routes `/settings/integrations` and `/settings/webhooks` now render a project-picker redirect shim so existing bookmarks keep working. The `project_settings.integrations` and `task_detail.external_links` slots were added to the widget registry as Enterprise extension points (per ADR-0029).
New endpoint `GET /api/v1/projects/<pk>/scheduler-runs/` returns the
recalculation history for a project — a typed thin view over `TaskRun` filtered
to `task_name='scheduling.recalculate'`. Supports `status` (repeatable),
`started_after` / `started_before`, and `ordering` query params. Exposes
`initiated_by_username` (not raw FK) and a typed `result_summary`
(`project_finish`, `critical_path`) for SOC 2 audit and Shell "last
recalculated" indicators. (#57)
- Cloud-file link previews on tasks: pasting a Google Drive, Dropbox, Box, or OneDrive file URL onto a task now shows an inline preview card — thumbnail, title, description, and a file-type chip — instead of a bare link. Previews are fetched on demand (via the existing per-link Refresh), need no account connection, and the cached card syncs to the offline mobile client. The fetch is SSRF-guarded and rate-limited, and only `https` thumbnails are stored.
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
The project and program Integrations settings pages now show a "Coming soon" connector roadmap listing in-flight OSS connectors (Jira/Linear/GitHub task-sync, calendar export, Drive/Box/Dropbox previews, meeting links, personal connected accounts) with links to their tracking issues, so the page signals "this is coming" rather than reading as unsupported.
Project Settings → Notifications: added a per-user-per-project **Pause all notifications** kill-switch at the top of the page. While paused, no in-app or email notifications fire for that user on that project; the routing matrix is preserved unchanged so unpausing restores prior preferences exactly. Addresses Priya's (Team Member persona) VoC hard-NO: an opt-out path for members who haven't dialed in their event × channel matrix yet (#589).
Project Access — each member row now shows when they joined the project and, when their role has changed since, the date of the last role change. These per-project access timestamps are also exposed on the membership API (`joined_at`, `role_changed_at`) as minimum-viable compliance evidence for "who has access and since when".
The "Export matrix" button on Workspace → Roles & permissions now works, downloading the capability matrix as a CSV (useful as compliance-questionnaire evidence). The button is enabled even while the rest of the page is a preview, since the matrix data is static.
- **Settings: copy-link affordance**: A small copy-link button now sits next to
  the context name in the settings left rail. Clicking it copies the current
  settings URL to the clipboard, so deep-links into a specific project's
  Access, Methodology, etc. can be pasted into runbooks without leaving the
  page.
- **Settings: "Saved [time]" confirmation**: After a successful save, the
  settings shell shows a persistent footer with a relative timestamp ("Saved
  just now", "Saved 5m ago"). Gives admins a stale-vs-current signal when
  revisiting a settings page later in the session.
The Webhooks and API tokens sections on the project and program Integrations settings pages now carry a one-line explanation of what each is for, so the page reads as intentional context rather than a raw inventory.
Project → Settings → Access now shows an "on N other active projects" badge per member row, giving assigners a resource-load signal at a glance. Hovering reveals the project names you have visibility into (projects you own). Backed by a new `other_active_project_count` / `other_active_project_names` field on the membership API.
OpenAPI schema committed at `docs/api/openapi.json` as a versioned artifact.
`scripts/export-openapi.sh` regenerates it; CI job `api:schema-drift` diffs
the live DRF schema against the committed file and fails if they drift,
catching accidental public-API changes at review time (#6).
Project → Settings → Integrations and Program → Settings → Integrations now manage webhooks and API tokens inline, replacing the read-only "manage via API" placeholder. Webhooks support create/edit/delete/test with a format picker (Slack or generic JSON), an event picker covering all task/dependency/schedule/project events, a signing secret, a live Slack preview, and a recent-delivery log. API tokens support create — with a one-time secret reveal — and revoke. Webhooks and tokens can be scoped to a program (firing/authorizing across every project in it) via new `/api/v1/programs/{id}/webhooks/` and `/api/v1/programs/{id}/api-tokens/` endpoints. (#600)
The Board's sprint panel velocity card now answers "is the team's pace steady, and when does the work ship?" without a spreadsheet. The 8-sprint history chart gains a shaded **min–max band with a P50 (median) line** so the typical throughput is readable at a glance, and a one-line **delivery forecast** sits below it: for a sprint bound to a milestone it shows the reforecast **P50 / P80 dates**; otherwise it re-paces the remaining committed backlog into a "~N–M more sprints to clear X pts (by ~date)" estimate, falling back to "Need at least 3 closed sprints" until there's enough history. Velocity stays **team-private by default** (ADR-0104) — when the server gates it for an out-of-audience reader, the card shows a "team-private" state instead of the chart.
Universal JSON import/export for programs. A canonical seed format (ADR-0109) lets you load a whole program — projects, tasks, dependencies, sprints, baselines, risks, and resources — from a JSON file and export any program back out. Available as `manage.py import_seed` / `export_program`, the `POST /api/v1/programs/import/` and `GET /api/v1/programs/{id}/export/` endpoints, and as Import/Export affordances in the web app. Export round-trips: re-importing an exported file reproduces the program.
Three more bundled demo samples join Atlas: **Aurora Mobile App** (agile-only — sprints, velocity, board), **Bayside Civic Center** (waterfall-only — CPM with all four dependency types, three-point estimates, a baseline, and a risk register), and **Helios CRM Replacement** (hybrid-small — a completed waterfall planning phase feeding an agile build phase). The "Load demo data" button now offers a picker to choose between them.
Celery task hardening — retry policies, time limits, and dead-letter tracking.
The four bundled sample programs now demonstrate the full resource and risk story an evaluator should feel. Every sample exercises all five RBAC roles (Owner/Admin/Scheduler/Member/Viewer), shows real capacity profiles (full-time, part-time, and 10% advisors rather than everyone at 100%), and attaches a non-default working calendar to a resource. Each sample also ships a populated risk register — from a lightweight agile set to a 20-risk hybrid-large register whose schedule-driving risks visibly move the Monte Carlo P80. All four samples load on seed schema v2, so they import as programs already in flight with real history.
**Git-aware task links.** Paste a GitLab or GitHub merge-request, PR, or issue URL onto a task and see its live status — open, draft, merged, or closed — on an "External links" section in the task detail panel. The provider is detected automatically from the URL (self-hosted GitLab/GitHub Enterprise hosts route by your connected account's host); status is fetched on demand with an explicit refresh button (no background polling) using your connected personal access token, through an SSRF-guarded, 5-second egress path. Links add/remove/refresh sync to the mobile client. Any other URL is accepted as a generic link. If the provider needs a token you haven't connected, refresh points you to Connected Accounts. Adding and removing links follows task-edit permission; refreshing follows task-read. Closes the OSS external-integrations epic (#302).
Outbound webhooks can now render their payload in a provider-specific format. A new per-webhook `format` field selects the renderer (`generic` — the existing JSON envelope, unchanged — or `slack`, a Slack incoming-webhook message that also works with Discord and Mattermost). Four new task event types are subscribable: `task.assigned`, `task.assignee_changed`, `task.mentioned`, and `task.due_date_changed`. The format is validated against a runtime provider registry so editions can add channels without a migration. (#638)
You can now get email (and in-app) notifications for your own-task events — when a task is assigned to you, when its planned date changes, and when someone comments on your task — alongside the existing @mention notifications. Toggle each event per channel on User → Settings → Notifications; email is off by default and strictly opt-in. A read-only Email & SMTP status page under Workspace Settings shows the configured mail transport and From identity. (#639)
Long-running task progress tracking with TaskRun model and WebSocket events.
Workspace lifecycle actions are now wired in **Settings → Archive / Delete**: transfer workspace ownership to another member, export a full archive of all workspace data (emailed when ready), and permanently delete the workspace. All three are Owner-only and the export/delete are guarded by typed confirmation. (#641)
The status bar now shows a truthful live-connection indicator instead of a permanently-green dot. The pill reflects five states — Connecting, Live (with the online count), Reconnecting, Connection lost, and Disconnected — so you can always tell whether your recent edits are reaching the server. The state is conveyed by label text and an accessible description, not color alone, and only the transient "Reconnecting…" state animates (and only when reduced-motion is off).
Command palette v2 (⌘K): task search opens the task drawer inline from any route, distinct Backlog and Board jump targets per project, current-project active-sprint and retro shortcuts, and a role-gated backlog-grooming target (ADR-0138).
Add the durable workflow execution engine (ADR-0080) — an internal `trueppm_api.workflows` interface plus a default Celery + transactional-outbox backend that runs declarative multi-step workflows with once-and-only-once activities, saga-style compensation on failure, durable sleep timers, and at-least-once step delivery with drain-based recovery. No public REST surface yet; the first real workload migrates onto it in a later release.
Dead-letter alerting: permanently failed background tasks now emit a structured warning log and a `celery_task_permanently_failed` signal (enterprise extension point for PagerDuty/Slack), plus an admin-only Prometheus endpoint `GET /api/v1/health/dead-letter/` exposing the `trueppm_task_dead_letter_parked{task_name}` gauge.
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
Added client-driven idempotency: send an `Idempotency-Key` header on any `POST`/`PUT`/`PATCH`/`DELETE` to make retries safe — a retry with the same key replays the original response instead of re-applying the write. Stored atomically with the mutation and retained for 24 hours. See `packages/website/src/content/docs/api/idempotency.md`.
- **Webhook delivery sequence numbers**: every outgoing webhook delivery now carries an
  `X-TruePPM-Webhook-Sequence` header — a monotonic, contiguous, per-subscription number that is
  stable across retries and never reused (even after delivery-history pruning). Consumers can use it
  to detect gaps and reorder events that arrive out of order. The value is also exposed as
  `sequence_number` on the delivery-history API. Ordering remains a hint, not a strict-order or
  exactly-once guarantee.
Mobile sync upload (`POST /api/v1/projects/{id}/sync/`) — the offline store can now push a WatermelonDB delta of task changes back to the server. Each batch carries a `client_batch_id` for **all-or-nothing** transactional apply and **idempotent retry**: a connection that drops mid-commit leaves nothing partially applied, and re-uploading the same batch replays the original response instead of double-applying (ADR-0082). Conflict resolution is last-writer-wins for now (richer field-level merge is tracked in #322). Per-row permissions mirror the REST task path exactly. A new `TRUEPPM_SYNC_BATCH_RETENTION_HOURS` setting (default 24h) bounds the idempotency table.
The Program → Rollup KPIs settings page now includes a live "Preview" panel that shows how the current KPI selection and aggregation policy roll up against the program's real project data — the same computation the program overview renders. KPI toggles save automatically and the preview refreshes; a policy change shows a hint to save before it is reflected. Deferred KPIs appear with a muted value rather than being hidden.
- **Preference-aware notification delivery**: notification dispatch now consults each member's per-project Notifications settings. Comment @mentions are routed through the `comment_mention` matrix — the in-app inbox honors the per-channel toggle, and email is suppressed inside the member's quiet-hours window (interpreted in the project's timezone, falling back to the workspace default). The durable in-app record is never dropped by quiet hours, only transient channels are. The pause kill-switch and quiet-hours window on Project → Notifications are now live rather than write-only.
- **MS Project import/export in the UI**: the project Schedule toolbar's
  **Project actions** (`···`) menu now exposes **Import from MS Project…** and
  **Export to MS Project (.xml)**. Import accepts `.mpp`/`.xml` files via a
  drag-and-drop modal (Project Admin only); the schedule refreshes when the
  import finishes. Export downloads the schedule as MS Project XML for any
  project member. Previously these capabilities were API-only. The import
  upload cap is now configurable via the `MSPROJECT_MAX_UPLOAD_MB` setting
  (default 50 MB, raised from 10 MB).
System Health operator console at Settings → Workspace → System health (workspace-admin only). A live overview dashboard surfaces the durable-execution layer — outbox dispatcher, Celery Beat heartbeat + configured schedule, dead-letter alerting, notification dispatcher, and retention configuration — and a read-only dead-letter inspector lets operators filter permanently-failed background tasks and inspect their error, attempt summary, and payload. Backed by a new `GET /api/v1/health/system/` aggregation endpoint and filter parameters on the failed-task list (ADR-0172). Tracking issues #691 #692 #694.
- **Retention & purge policy editor**: workspace admins can now tune retention windows,
  enable/disable purges, configure the purge schedule (daily/weekly/off, UTC time of day,
  on-failure behavior), and run a purge now or dry-run it — all from **Settings → System
  health → Retention & purge**, without editing settings or restarting pods. A recent-runs
  log records each run's outcome, rows deleted, and space freed, and the System health
  overview's "Retention purge" card now reports real state instead of "unknown". The five
  per-table nightly purges are consolidated into one scheduled coordinator. Lowering a
  window shows how much data becomes purge-eligible before you save. Compliance-grade
  retention governance remains an Enterprise feature. See `docs/administration/retention.md`.
**Ungrouped projects on the Programs directory**: the `/programs` page now lists your standalone projects (those not in any program) below the program cards, each with its health, progress, and member count, plus a one-click "Move to program" action. Backed by a new `?program__isnull=true` filter on the projects list endpoint (ADR-0171).
Programs can now have an accent color — pick one of six swatches on the program General settings page to tint the program's identity square in the programs list (falls back to a health-tinted neutral when unset).
Add real-time presence tracking: WebSocket `presence.join`/`presence.leave` events, Redis-backed presence registry with TTL heartbeat, `GET /projects/<id>/presence/` REST endpoint, and `PresenceAvatarStack` in the TopBar showing who is online.
Summary task support: `is_summary` and `parent_id` annotations on the task API, duration-weighted `percent_complete` rollup, indent/outdent endpoints with atomic WBS rewriting, assignment guard blocking resource assignment to summary tasks, and summary task date/float rollup in the CPM post-processing step.
Program overview now renders a computed KPI rollup. The new Overview tab (the program's default landing) shows a program health dot plus a strip of the enabled KPIs aggregated across the program's projects, honoring the configured aggregation policy (worst-case / average / task-weighted). Counts and risk exposure roll up as program totals. `cost_variance`, `budget_utilization` (pending the cost/EVM model, #754) and `p80_completion` (pending a persistent Monte Carlo store, #753) display a "needs data" reason rather than a fabricated value; budget-weighted aggregation falls back to average until the cost model ships. This consumes the rollup config shipped in #527 — the shipped KPI set is ratified as canonical, replacing #527's originally-named list.
Show assignee initials chips (max 2 + overflow) in Gantt task list rows and first assignee initials inside canvas bars wider than 48px.
Program backlog intake pool (ADR-0069). New `BacklogItem` model at the program level with a `proposed → pulled → archived` lifecycle and epic/feature/story/task item types, offline-sync ready via `VersionedModel`. REST endpoints under `GET/POST /api/v1/programs/{id}/backlog-items/` (filter by `item_type`/`status`/`tags`, fuzzy `?q=` trigram search on title) plus a `POST .../{item}/pull/` action that converts a proposed item into a project-backlog `Task` (`status=BACKLOG`, never a sprint) in any project of the program. Requires Team Member+ on both the program and the target project. Tracking issues #733 #737 #739.
- **Recurring tasks (backend)**: tasks can now carry a recurrence rule (daily / weekly / monthly / custom, with day-of-week and day-of-month selectors, time-of-day, and Never / On-date / After-N end conditions). An hourly generator lazily spawns upcoming occurrences within a configurable look-ahead window (`TRUEPPM_RECURRENCE_HORIZON_DAYS`, default 14), inheriting the template's assignee and attachments per the rule's toggles. Recurring templates and their occurrences are excluded from CPM and Monte Carlo inputs — they are parallel, calendar-driven activities, not nodes in the schedule's logical network (ADR-0090). New `recurrence-rules` API endpoint; the setup UI ships with #738.
- **Recurring tasks (setup UI)**: a Recurrence section in the task detail drawer lets a Scheduler+ turn a task into a calendar-cadence series — pick daily / weekly / monthly / custom, the weekdays or day-of-month, a time and timezone, and an end condition (Never / On date / After N). A live "Next 4 occurrences" preview updates as you edit, and a banner makes clear the task is excluded from the critical path and Monte Carlo while it recurs. The "inherit subtasks" and "notify the morning of" toggles are present but labeled "Not active yet" (stored for a future release per ADR-0090). Members see a read-only summary. Pairs with the #736 backend; completes recurring tasks (#312).
- **Task notes**: tasks now carry a flat, per-author **notes log** distinct from the threaded comment thread — a place to capture the *why* and the decisions behind the work. Each note is an immutable, timestamped row; the author can fix their own note within a 15-minute edit window, after which it locks. Any team member can pin a note (pinned notes sort first), and authors or admins can remove one. A card-scoped search dims non-matching notes (with a live "N of M" count) so a long log stays scannable, and a 📝 freshness marker on the board card and schedule row shows when a task last gained a note. Read-only viewers see the full log without edit controls.
- **Program backlog UI** (`/programs/:id/backlog`): the program-backlog tab is now a working two-pane workspace (#742), wired to the ADR-0069 API (#737/#739). A sortable, filterable item list with status/type/tag facets and title search, an inline detail/edit pane, and the **pull-down** flow that promotes a backlog item into a project's backlog (single target, optimistic with rollback on failure). Includes a distinct mobile layout (card list + bottom-sheet detail/pull/create/filter), drag-to-reorder for proposed items, empty/no-results/error states, and full keyboard + screen-reader support. Create/edit/pull/archive require program Admin; hard delete requires Owner.
- **Decisions views**: a one-tap "Decision" chip on any task note now promotes it into a
  project-wide and sprint-scoped **Decisions** log (Reports → Decisions), grouped by
  sprint with closed sprints kept browsable. Visibility is team-owned: decisions are
  visible to the team and project managers by default, and a project admin can extend
  visibility to oversight stakeholders via a single consent switch. Decision toggles
  broadcast in real time. (ADR-0167, #748)
Pulling a program backlog item into a project now fires the `task.created` outbound webhook, so external integrations see backlog pulls like any other task create. The payload carries `source: "backlog_pull"` to distinguish the origin.
- **Fiscal quarters in the Schedule timeline.** At quarter/year zoom the header tiers now follow the workspace fiscal year by default — a workspace whose fiscal year starts in April shows Q1 = Apr–Jun, labeled `Q1 FY27`, with boundaries on fiscal (not calendar) quarters. A **Quarters: Fiscal / Calendar** toggle next to the zoom control switches the view per user; the choice is remembered in the browser. The toggle is hidden when the workspace fiscal year starts in January (fiscal and calendar quarters are then identical).
At-a-glance external-link status on the schedule. Each task-list row now shows a link glyph and count tinted by the worst external-link status (closed > draft > open > merged > unknown), and Gantt bars carry a matching worst-status dot at Day/Week zoom. Backed by a no-N+1 `external_link_summary` field on the task-list serializer.
Import a project from a file: create a new project directly from a Microsoft Project XML (MSPDI) export. A new "Import a project" action in the sidebar opens a dialog with a format picker (MS Project `.xml` supported today; `.mpp`/`.mpx` show inline guidance for saving as XML), and the project appears immediately while its tasks import in the background. Parse failures now stop cleanly instead of retrying a bad file (ADR-0092).
MS Project (MSPDI) import and export now round-trip three-point / PERT
estimates via the `Duration1`–`Duration4` ExtendedAttribute convention
(aliased Optimistic / Most Likely / Pessimistic / PERT Expected). On import
the three values are written to `Task.optimistic_duration` /
`most_likely_duration` / `pessimistic_duration` with `estimate_status`
set to `accepted`; on export the four ExtendedAttribute definitions are
emitted at project level (including Duration4's PERT formula) and per-task
values are written for leaf work tasks. All-or-none: partial three-point
data is dropped with a warning. Summary tasks and milestones are skipped
in both directions. Design recorded in ADR-0093. (#798)
Project Overview now shows a "Project history" section listing recent file
imports (filename, date, who initiated it, status, and task count) when
the project has any. Backed by `GET /api/v1/projects/{pk}/imports/`
(Member+ read) — answers Marcus's PMO audit ask on the #796 epic without
needing the enterprise audit overlay. Rows are purged after 7 days, so
this is a recent-activity surface, not a durable audit log. (#799)
Add incremental CPM recompute to `recalculate_schedule` — when `changed_task_ids` is provided, only tasks in the affected downstream subgraph are written back to the database. Falls back to a full write when the affected set exceeds 25% of project tasks.
Add actual-date overlay rendering to the canvas Gantt renderer (#80).
`drawActualDateBar` draws a 6px dashed bar below the planned bar when
`actualStart` or `actualFinish` is set — red for late tasks, green for
early, slate for in-progress. `drawScheduleVarianceBadge` renders a "+3d"
/ "-2d" label to the right of the finish edge. Both are wired into
`GanttEngineImpl._paintTaskAt` after the main bar draw. 11 new renderer
unit tests; exports new `GHOST_BAR_HEIGHT = 6` constant (rule 14). (#80)
- **Actual start and finish dates on tasks**: new `actual_start` and
  `actual_finish` fields are auto-populated when a task transitions to
  In Progress or Complete (manually overridable). A computed read-only
  `schedule_variance_days` field (actual finish minus CPM early finish)
  is exposed on the API. Baseline snapshots now capture actual dates.
Vendored `cloud_migration.xml` MSPDI fixture (28 tasks with three-point/PERT estimates) into the MS Project importer test fixtures. Produced by the standalone `mpp-sample-generator` tool (`mpp-sample build --three-point`), with provenance and the verified PERT `Duration1`–`Duration4` FieldIDs documented in `fixtures/README.md`. Unblocks the PERT mapping importer/exporter work (#798). (#801)
- **Docs version-status CI guard (#807)**: a new `docs:version-accuracy` pipeline
  job (`scripts/check-version-status.sh`) fails the build if any page under
  `packages/website/src/content/docs/` references an unshipped version in
  past/present tense. The roadmap's "## Shipped" section is the single source of
  truth; a shared `_release-status.mdx` snippet centralizes the shipped/alpha/
  underway version constants so banners derive from one place.
Summary task CPM support: `expand_summary_dependencies()` fans out summary-level dependencies to leaf tasks before the critical-path run, and the scheduling task rolls up early/late start/finish, total float, and critical status from descendant leaves onto each summary.
Drag a task onto a summary row in the WBS view to re-parent it
under that summary. An aria-live region announces
`"<Task> will become child of <Summary>"` on hover, and the target
summary highlights with the brand-primary drop-over treatment.
New endpoint: `POST /api/v1/projects/<pk>/tasks/<id>/reparent/`
with `{new_parent_id}` — cycle-safe, renumbers old siblings,
triggers CPM recalculation and a `tasks_restructured` broadcast. (#81)
Documentation page for summary tasks and WBS rollup — rollup rules
(duration span, percent-complete weighted average, critical-path
propagation), keyboard shortcuts (Tab / Shift+Tab indent, Alt+arrow
reorder), chevron collapse/expand behavior, and drag-and-drop indent
under a summary row. (#81)
Summary task web UI: collapse/expand chevrons in Gantt task list, shared expand state between WBS and Gantt views, keyboard indent (Tab) and outdent (Shift+Tab) in WBS view with Alt+Up/Down reorder and arrow-key navigation, and row selection with roving tabindex.
Real-time collaboration: comment reactions and acknowledgements now sync live to everyone viewing a task thread instead of appearing only after a reload. The acknowledgement broadcast is body-less — it never reveals who acknowledged or an aggregate count, preserving team-only ack visibility (ADR-0075).
Resource Allocation Timeline view: per-resource task span grid with inline partial-allocation editing, overallocation detection, status filters, "My allocation" shortcut, and a new `GET /api/v1/projects/{id}/resource-allocation/` endpoint (#85).
- **Live multi-writer retro board**: the sprint retrospective is now a real-time
  collaborative board where the whole team adds, edits, and drags sticky notes
  across three columns (What went well / What to improve / Ideas) simultaneously
  during the ceremony, with live presence and per-item updates over the existing
  project WebSocket. A discussion sticky can be converted to a retro action item
  in one click, which then flows into the existing promote-to-backlog action.
- The Kanban board now reflows on phones into full-width, snap-scroll status columns with a dot-strip navigator above. Swipe column-to-column, or tap a strip segment — showing each column's name, task count, and health dot — to jump. Card anatomy, WIP limits, and the critical/blocked treatment are unchanged from desktop; only the layout adapts. (#853)
Notification preferences now offer a one-click **Signal-only** profile (blocked work + deadline changes only) for contributors, with a "Show all notification types" escape to the full matrix (#855, ADR-0122).
Workspace operational audit log: Owners and Admins can review a chronological record of workspace administration events — member added, removed, or role changed; ownership transferred; project created or deleted; workspace settings changed; and workspace export triggered. Read it at `GET /api/v1/workspace/audit-events/` with cursor pagination and filtering by event type, actor, and date range. (#859)
Sprints view: a **Promote to milestone** dialog (DA-02 / ADR-0106) that binds a sprint's commitment to a schedule milestone so the sprint's velocity reforecasts the milestone's CPM finish — create a new milestone or bind an existing one, with a live forecast projection (collapsible "quick mode" / compact layout on small screens) and an audited rebind path when the sprint is already bound. Tracking #860.
- **Reforecast-on-close — the agile/waterfall bridge** (ADR-0106 §3/§5): closing a
  sprint now reforecasts its bound schedule milestone's finish as a *range* — the
  CPM finish plus a p50/p80 confidence band derived from team velocity — instead
  of a single false-precision date. The result is persisted as a `ForecastSnapshot`
  and broadcast live to the board, so the PM sees the milestone confidence update
  without a status meeting and the team does nothing beyond closing the sprint. A
  new `GET /api/v1/projects/{id}/forecast/` read returns the velocity range, the
  remaining backlog re-paced into a sprints-to-complete range, and the latest
  forecast per bound milestone. Forecasts flagged for unmodeled upstream
  dependencies are capped at low confidence rather than reading optimistically.
  Only the confidence band — never the per-team velocity series — crosses upward,
  preserving the velocity-privacy guarantee.
Sprint-close bridge digest: when closing a sprint reforecasts a bound milestone and materially shifts its likely finish or confidence, the project's PM cohort is now notified (in-app + email) with a schedule-language summary — dates and confidence only, never velocity points.
Configurable iteration terminology: a project can now label its time-boxed iteration container as **Sprint** (default), **Iteration**, **PI**, or a custom word. The chosen label flows through every iteration surface — the tab, sprint workspace, board, planning, guardrails, burndown, and the milestone-bridge dialog — so Scrumban and SAFe-adjacent teams aren't forced into Scrum-Guide vocabulary. Set it under Project → Settings → General (Agile/Hybrid projects). Display-only: it never changes scheduling, permissions, or API behavior. (#862, ADR-0111)
- **Estimation poker**: size unestimated stories during sprint planning without leaving
  TruePPM. A facilitator (Scrum Master, Product Owner, or admin) opens a Fibonacci poker
  round on a planned candidate; the team votes on hidden cards, reveals simultaneously,
  discusses any outlier, and commits an agreed value that writes straight to the story's
  points. Votes are live (multi-writer over WebSocket) and stay private until the reveal.
  (ADR-0179, #863)
Incoming-carryover preview — the sprint planning surface now shows, read-only, which unfinished tasks from the previous closed sprint rolled forward into the next planned sprint, with the points carried over. New `GET /sprints/{id}/incoming_carryover/` endpoint (#865).
Sprint planning bridge banner — a planned sprint now shows its draft goal next to the schedule milestone it advances, including how many of that milestone's predecessor tasks land in the sprint, making the agile→waterfall link explicit at planning time. Bind or change the advancing milestone inline (#866).
Sprint/phase/WBS guardrails (ADR-0101) — completing the web surface: inline build-mode sprint assignment now surfaces the warn/override/block flow under the SprintPrompt, the Sprints workspace shows read-only Tier-3 health badges (orphan tasks, phase-span, summary-in-sprint), Project Settings → Sprint guardrails lets Owners escalate composition rules warn→block (sovereignty-gated; advisory rules pinned to warn), and the board surfaces a dismissible mid-sprint scope-injection banner. Backend in 0.2.0-alpha.1 (#875).
When you add a summary, phase, recurring, or out-of-window task to a sprint, an inline non-blocking notice now explains the impact ("this double-counts in velocity") with a one-tap **Keep it here** or **Undo** — and where a project Owner has set a rule to block, the assignment is refused with a clear, actionable message. Mid-sprint scope additions that affect the Sprint Goal are now flagged in the task drawer.
Sprint/Phase/WBS guardrails: assigning a summary, phase, recurring, or out-of-window task to a sprint now surfaces a non-blocking warning with a one-tap override, and project Owners can escalate any sprint-composition rule to a hard block from a new per-project Guardrails settings page.
Mid-sprint scope-injection approve-gate (ADR-0102): a task linked to an ACTIVE sprint after activation now enters a pending-acceptance state (`task.sprint_pending`) — visible on the board and in My Work but excluded from commitment, burndown, and milestone-rollup math until a team member with the sprint-lifecycle gate (role ≥ Project Manager + project membership) accepts it into the commitment or rejects it (removing it from the sprint). New endpoints: `POST /api/v1/scope-changes/{id}/accept/` and `/reject/` (single) plus `POST /api/v1/sprints/{id}/scope-changes/accept/` and `/reject/` (bulk, `{ids:[…]}`). Sprint payloads carry `pending_count`; `SprintScopeChange` carries a `status` (pending/accepted/rejected) audit field. Sprint close is never blocked by pending items — it surfaces a non-blocking advisory and a `pending_disposition` (`carry` default re-flags carried tasks pending in the next sprint; `reject` removes them). Accept/reject are team-owned and management-inert: there is no auto-accept path and no policy/extension input to the status transition.
Sprint goals are now first-class: the Sprint Goal card in the sprints workspace can be edited inline (for schedulers and above) with live "good goal" hints — outcome-not-a-checklist, single focused theme, and a measurable cue — so a team can refine the goal where it lives instead of reopening the full Plan-sprint dialog.
- **Team-health pulse in the retro**: team members can answer a one-tap
  mood / energy / (optional) confidence pulse during the retrospective and see
  the trend across sprints. The pulse is team-private by default and governed by
  the same signal-privacy posture as team velocity — the trend is visible to the
  team and their coach only; the PM/PMO band sees nothing (not a redacted
  aggregate, no response count), and there is no cross-team or PMO rollup.
- **Sprint Review surface — accepted-vs-not + demo list**: the closed-sprint review
  now shows an accepted-vs-not-accepted breakdown derived from each story's
  acceptance criteria (stories with no criteria are flagged as a coverage gap, not
  silently counted as accepted) and a team-curated demo list — a one-tap toggle
  marks a shipped story for the stakeholder walkthrough. Acceptance is ticked live
  during the review. Counts are always visible; story points stay behind the
  team-private velocity gate, so the PM can read the review without seeing per-team
  throughput. (#924, ADR-0118)
- **Daily standup surface — "what changed since yesterday"**: the active sprint now
  shows a team-facing delta for the Daily Scrum — moved cards, new blockers
  (anything moved to *On hold*), scope added, the burndown swing, and a per-person
  at-a-glance of what each teammate touched. Pull, not push (no notifications);
  team-private by membership (a PMO/non-member can't reach it) and status-level
  only — never hours or keystroke detail. Computed live from existing history with
  no new tracking; the window defaults to the last 24 hours. (#925, ADR-0121)
Team entity and the Scrum Master / Product Owner facet axis (ADR-0078, OSS). Every project gains one auto-created default team; a new **Project Settings → Team** tab (shown on agile and hybrid projects) assigns each member a team role plus two independent facets — Scrum Master and Product Owner — so facilitation and ownership are first-class and no longer conflated with project-admin authority. A facet-resolving permission helper (`has_team_facet`) gives downstream gates a single seam to ask "is the requester the Product Owner / Scrum Master?". Minimal 0.3 slice of #599; multi-team management lands later.
Agile/waterfall bridge contract additions for the promote-to-milestone dialog (ADR-0106 §E1): a dry-run reforecast preview (`GET /sprints/{id}/reforecast-preview/`) returning the milestone's CPM finish plus a velocity-band P50/P80/P95 projection and an unmodeled-upstream-dependency flag (the team-pace band only — never the per-sprint series); optional `name`/`target_date` overrides when creating a milestone from a sprint; and a slim project milestone list (`GET /projects/{id}/milestones/?unbound=true`) for the bind-existing picker.
Team-signal privacy: raising a signal's exposure ceiling now requires team ratification (ADR-0104 Amendment A). Authorizing wider upward exposure of a team signal — for example sharing velocity up to the program — opens a proposal that a strict majority of the team must approve before it takes effect; a lone facilitator or admin can no longer widen a team signal's exposure alone. Lowering a ceiling and adjusting audience within it stay immediate single actions, an open proposal expires unratified after 72h (the ceiling unchanged), and the proposal plus every vote are recorded as a team-readable audit trail. New endpoints: `GET/POST /projects/{id}/signal-privacy/ceiling-proposals/…` for listing, voting, and withdrawing. (#930)
Sprint↔milestone binding API (ADR-0106 §1/§2): `POST /sprints/{id}/promote-to-milestone/` creates a milestone from the sprint goal or binds an existing one, and `POST /sprints/{id}/unbind-milestone/` clears it. The binding records who promoted it, when, and the committed-points baseline, so a milestone whose sprint scope changed after binding shows a "scope changed" caveat (`binding_drifted`) rather than silently shifting. Promotion is a schedule-authoring action (Resource Manager and up); the binding is idempotent and never silently re-points. Backs the Promote to milestone dialog (#860). Tracking #931.
Architecture decision records for Wave 3 OSS/Enterprise shell work: ADR-0029
(frontend slot registry and edition detection — OSS defines named extension
points; Enterprise registers at startup, mirroring the Django signals pattern),
ADR-0030 (P3M navigation shell split — OSS single-program overview page vs.
Enterprise portfolio landing, with UX reference in docs/ux/). Also adds missing
Google-style docstrings across all public API ViewSets, Serializers, and web
hooks/utilities (#95).
Planning methodology (Agile / Waterfall / Hybrid) now cascades Workspace → Program → Project (ADR-0107). A workspace sets the default methodology and an override policy; programs and projects inherit it and may override per scope unless the workspace requires a single method. The API exposes server-resolved `effective_methodology` and `inherited_methodology` read fields on the project and program serializers so every client (web, mobile, MCP) renders the same resolved value. #955
- **Sidebar project rows**: each project in the left rail now shows a right-aligned open-task count and a health dot colored from real project health (on-track / at-risk / critical), instead of a hollow placeholder. The projects list endpoint exposes a new `open_task_count` field, annotated server-side with no per-project query.
Project Monte Carlo runs are now persisted with a forecast history: each run records its P50/P80/P95 finish dates so you can see how a project's finish-date confidence drifts over time. The Monte Carlo drawer shows past runs newest-first with a per-run delta (e.g. "P80 +14d"), and the latest result now survives past the 24h cache. Run-author attribution is visible only to project Admins/Owners. OSS keeps the newest 100 runs per project (ADR-0175).
A program's accent color now renders as a consistent identity square across the app — the programs list card, the sidebar scope picker and program-group headers, the program overview header, and the backlog header — so you can tell programs apart at a glance. The square is pure wayfinding (it never implies health or status; project health stays a circle dot), and it falls back to a quiet neutral tile when no color is set.
You can now set the **Project lead** and **Program manager** from Settings → General using a searchable member picker. Previously the project lead was a hardcoded placeholder and the program manager was read-only. The lead is a real field on the project/program record (exposed via the API), the chosen person must already be a member of that scope, and assigning or clearing the lead requires Project-Manager (Admin) role or above. (#966)
- **Project ownership & program sponsorship transfer**: the **Transfer ownership**
  (Project → Settings → Lifecycle) and **Transfer sponsorship** (Program → Settings →
  Lifecycle) actions are now wired. Each opens a member picker and atomically promotes
  the chosen member to Owner while demoting the current Owner to Admin; the program
  flow can optionally rotate the program manager in the same step. The new owner /
  sponsor must already be a project / program member. Both endpoints
  (`POST /api/v1/projects/{id}/transfer/`, `POST /api/v1/programs/{id}/transfer-sponsorship/`)
  are Owner-only and reject non-owners with `HTTP 403`.
Programs can now be split into independent sub-programs via `POST /api/v1/programs/{id}/split/`. Each split creates a new program (owned by the caller, inheriting the parent's methodology and workspace settings) and moves the selected projects under it with their tasks, dependencies, baselines, and history intact; the original program is closed afterwards. Owner-only and atomic. (ADR-0156, #967)
- **Export project**: the **Export project** action (Project → Settings → Lifecycle)
  is now wired. It downloads the project as a portable canonical JSON seed file
  (`GET /api/v1/projects/{id}/export/`) — tasks, sprints, dependencies, baselines,
  risks, and resources — that re-imports into any TruePPM workspace via
  Programs → Import (ADR-0109). The single project is wrapped in a synthesized
  single-project program so the file is self-contained and round-trippable, and a
  standalone project (no parent program) exports cleanly too. Read-only and open to
  any project member; available on archived projects as well. The richer async bundle
  (`.mpp`, attachments, time entries, audit log) is tracked as a follow-up. (#967)
Split a program into sub-programs from Program → Settings → Archive / Close — name one or more sub-programs you own and assign each project to one of them. Unassigned projects stay on the original program, which is closed (read-only) after the split. Project schedules, dependencies, baselines, and history move intact.
- **Workspace members CSV export**: the Members page Export CSV button now
  downloads the visible members (name, email, role, status, groups) as a
  client-side CSV file (`trueppm-workspace-members.csv`). The export honors the
  active search and role filters.
Workspace settings: Owner/Admins can now upload a workspace logo (PNG or WebP, 2 MB max) that surfaces in the top bar, and resend a pending or failed member invite — per row or all at once. Resending re-issues the invite token (the previous link stops working). Logo uploads are raster-only and validated by magic bytes; resends are rate-limited to prevent email floods. Closes #969 (logo upload + invite resend; holiday-calendar deferred to its #906 composable-calendars dependency).
Resource assignments now support partial allocation (0–100 %) and surface an inline overallocation warning when a resource's total allocation across active tasks exceeds their capacity. Assignments are always saved — the warning is informational. Assignment create/update/delete events are broadcast in real time to all connected clients via WebSocket.
External links on a task can now carry a custom title and free-text labels, and can be edited after they are added (#970).
Attachment policy settings — Workspace, Program, and Project admins can now enable or disable task file attachments and configure the allowed file types, with child scopes inheriting the parent's policy by default and free to narrow or widen it. Replaces the previous fixed, non-configurable allow-list; a built-in security denylist (HTML, SVG, XHTML) remains permanently blocked at every scope. (#976)
Public sharing and guest access can now be set per program and per project, inheriting the workspace value by default. Program and Project → General settings show the effective setting with an "Inherit (On/Off)" indicator, and Owners/Admins can override it for that scope. A workspace policy reserves an Enterprise hard-ceiling lock for organizations that need to prevent downstream loosening.
Add frontend slot registry and edition detection (ADR-0029): `GET /api/v1/edition/` endpoint (public, no auth), `TRUEPPM_EDITION` Django setting, typed `WidgetRegistry` singleton in `packages/web/src/lib/widget-registry.ts`, `useEdition()` TanStack Query hook, and dynamic enterprise overlay import in `main.tsx`.
Closing a sprint now records a durable, per-task **membership-at-close** snapshot (`SprintTaskOutcome`) — what each task's final status was and whether it completed, carried to another sprint, or was dropped. Previously this "what didn't ship" set was destroyed at close (carried-over tasks were reassigned to the next sprint and the only trace was task history, for 90 days), so a sprint review couldn't reliably show it. The snapshot is captured inside the close transaction before carry-over runs, survives the task's later reassignment or deletion, and is the API-first foundation the consolidated sprint-outcome read (and the sprint-review UI) build on. No user-visible change yet; sprints closed before this ships report their membership as not recorded.
Sprints now carry a **goal outcome** verdict (Met / Partially met / Missed). It is defaulted at close from the points completion ratio (≥80% Met, ≥50% Partial, otherwise Missed) and can be overridden afterward by Scheduler+ — the team's call, not just the math. Exposed read-only on the sprint payload and editable even after close (unlike capacity/WIP, which lock), so any client (web, mobile, MCP) reads the verdict from the API instead of inferring it.
Sprint velocity and burn pace are now server-computed instead of derived in the browser. Each velocity history entry carries its **delta vs the prior sprint** (points and tasks), and the burndown read now returns a **burn status** (ahead / on track / behind / no data), a signed **trend** vs the ideal line, and a **projected finish date**. This moves the math that lived in the web burndown chart onto the API so every consumer — including the upcoming MCP server and mobile — gets the same pace verdict from REST.
New **`GET /api/v1/sprints/{id}/outcome/`** — a single sprint-review read that any client (web, mobile, MCP) binds to instead of stitching calls or deriving the numbers itself. It composes the commitment aggregates, the goal verdict, the velocity delta and burn status, the "what didn't ship" list (carried/dropped tasks with their disposition), and a retro summary. It works for any sprint state (a closed sprint returns the snapshotted membership; an active/planned sprint returns a `provisional` live view), reports `outcome_recorded: false` for sprints closed before per-task membership was captured, and enforces team-signal privacy server-side: readers below the velocity audience get the velocity block omitted and per-task points withheld, while titles, counts, dispositions, and completion ratios remain.
Monte Carlo forecast reads now return the deterministic `cpm_finish`, the per-percentile `delta_vs_cpm` (P50/P80/P95 days vs the CPM spine), and a cumulative `confidence_curve` — the schedule-risk premium and finish-by-date S-curve are now server-owned instead of derived in the browser (#987, API-first #986).
Added `GET /projects/{id}/sprint-health/` returning server-owned Tier-3 sprint-health signals (orphan tasks, active sprint spanning ≥3 phases, parent tasks in a sprint) with the count, threshold, tone, and consequence copy all computed server-side — so any API/MCP client gets the same guidance and the web renders it verbatim instead of re-parsing WBS paths (#988, API-first #986).
Resource utilization reads now include a per-day `load_pct`, `load_band` (on-track / at-risk / critical), and `overallocated` verdict, plus a per-resource `overallocated` flag — the overallocation classification is now server-owned and identical to the heatmap (#989, API-first #986).
Wave 4 overview redesign: `ProjectHeader` component with health badge, export/update-status actions, and project metadata subtitle; `MonteCarloWidget` with SVG mini-histogram and permanently-visible P50/P80/P95 date chips; KPI row updated to 5 cards (Schedule health, Forecast finish from P80, Tasks late, Next milestone, Team utilization); new `MonteCarloLatestView` API endpoint (`/projects/<pk>/monte-carlo/latest/`) serving the most recent cached Monte Carlo result (Redis, 24-hour TTL); `owner_name` and `start_date` added to the overview API response; `link_target` field and overallocation attention-item bucket added to the attention API response.
Add project overview page and path-based routing (ADR-0030): new `/projects/:projectId/:view` URL scheme replacing `?project=&view=` query params, `ProjectOverviewPage` with KPI cards (schedule health, SPI, late tasks, critical count, next milestone, team utilization), attention panel, and my-tasks panel; three new API endpoints (`/projects/<pk>/overview/`, `/projects/<pk>/attention/`, `/projects/<pk>/my-tasks/`); `useProjectId()` hook reads from path params; `ProjectShell` renders views as nested `<Outlet />` children.
Tasks now expose a server-computed `spi` (Schedule Performance Index) and `spi_band` (on_track / at_risk / behind) on the API, mirroring the project-level rollup thresholds — the per-task schedule verdict is no longer derived in the browser (#990, API-first #986).
`TaskSerializer` now exposes `is_stalled` (server-owned verdict: more than 3 days in the current status and not complete) and `dwell_days` (the raw days-in-column fact), so the stalled signal is reachable from the API rather than re-derived in the browser (#992, API-first #986).
Documented advanced configuration settings in the admin configuration reference: `SYNC_WATERMARK_USE_COLUMN`, the durable-execution workflow-engine tunables (`WORKFLOW_BACKEND`, `WORKFLOW_HISTORY_RETENTION_DAYS`, `WORKFLOW_DRAIN_BATCH_SIZE`, `WORKFLOW_PURGE_BATCH_SIZE`), and the idempotency-key retention settings (`IDEMPOTENCY_RETENTION_HOURS`, `IDEMPOTENCY_MAX_BODY_BYTES`).
The board activity panel now updates live: when a collaborator creates, edits, or deletes a card, posts a comment, or accepts/rejects a mid-sprint scope change, the feed refetches its head page automatically — no manual refresh. It reuses the existing real-time card-sync events and re-reads through the already role-gated activity API, so no field values cross the wire (ADR-0160 Amendment B1).
Migrated documentation site from Docusaurus to Astro Starlight with persona-based guides, administration docs, versioning infrastructure, and GitLab Pages deployment.
Transactional outbox for CPM recalculation: task-graph writes now insert a
`ScheduleRequest` row in the same DB transaction, so a broker outage no longer
causes 500 errors or silently drops recalculation requests. A Celery Beat drain
task dispatches pending rows every 30 seconds and recovers orphaned rows after
10 minutes. Nightly purge keeps the outbox table lean.
- **Gantt dependency arrows**: SS (Start→Start), FF (Finish→Finish), and SF
  (Start→Finish) link types now render as cubic Bézier arrows on the canvas
  timeline in addition to the existing FS type. Critical-path coloring applies
  to all four types. `TaskLink` now includes a `lag` field (days).
- **Task detail drawer**: clicking the `⋯` icon on any Gantt task row (visible
  on hover, always visible when the row is selected) opens a right-side drawer
  (480 px desktop / 85 vh bottom sheet mobile) for managing predecessors and
  successors. Each dependency row shows the related task name, a dep-type
  selector (FS/SS/FF/SF), and a lag input. Predecessors and successors can be
  added via a task picker and removed with the delete button. The CPM engine
  recalculates and moves dependent tasks automatically after any dependency
  change.
- **Gantt task start date**: the task bar now uses the later of `planned_start`
  (user constraint) and `early_start` (CPM result), so dependency-driven delays
  are reflected immediately even before the next CPM run completes.
- Added `make pre-push` Makefile target that mirrors the CI gate locally
  (lint, typecheck, `makemigrations --check`, openapi schema drift). Wired
  as a pre-push hook in `.pre-commit-config.yaml` so `git push` blocks on
  the same checks GitLab CI runs. Catches missing migrations, stale
  `docs/api/openapi.json`, and `ruff format` drift before they reach CI.
- **Monte Carlo documentation**: added `docs/features/monte-carlo.md` covering
  the full PERT-Beta simulation model — mean and standard deviation formulas,
  Beta method-of-moments parameterisation, vectorised CPM forward pass, and why
  the Central Limit Theorem compresses spread on long critical paths. Documents
  OSS tier caps (1 000 runs / 500 tasks), the independence assumption (no
  correlated risk factors), the absence of resource-constraint modelling, and
  guidance on interpreting P50 / P80 / P95 output for stakeholder commitments.
Added three MS Project XML import fixtures (`sample.xml`, `sample_legacy.xml`, `sample_2019.xml`) covering namespaced 2003+ format, pre-2003 no-namespace format, and modern Project 2019/365 format with calendars, extended attributes, and outline codes.
Plan Sprint modal — clicking "Plan next sprint" in the Sprints view header now opens a dialog with name, start/finish dates, and an optional goal, then POSTs to `/api/v1/projects/{id}/sprints/`. Closes the gap left by #227, which stubbed the button as a no-op pending later wave/10 issues.
Add an "Import" button to the program **Projects** tab. Program admins can now create a project from an MS Project file that lands already assigned to the program — the same entry point that already existed on the Program Settings → Projects page.
- **Retro presence overflow popover**: the "+N" overflow chip on the retro
  presence avatars is now a button that opens a small popover listing the
  remaining participants (initials avatar + display name). It closes on Escape
  and outside-click and returns focus to the trigger.
- **Schedule build mode (v1, opt-in)**: Schedule list view becomes a keyboard-first build surface when the `schedule_build_mode_v1` flag is on. Inline edit Task name, Duration, and % via F2 / double-click / Enter / Esc / Tab between fields (#338). Tab on a focused row indents under the previous sibling; Shift-Tab outdents — emergent phases form automatically (#339). Right-click any row for Edit / Indent / Outdent / Convert to milestone / Delete (#341). A bottom hint strip surfaces three contextual hotkeys; press `?` to open the full cheatsheet; the empty-state CTA puts the cursor on the first task name with one click (#342). Mobile and flag-off desktop continue to use the existing AddTaskModal flow.
- **Runtime feature flags**: new `useFeatureFlag()` primitive backed by `localStorage` with `VITE_FEATURE_FLAGS` build-time defaults. Flags can be toggled at runtime from devtools or via the `?ff=<flag_name>` URL parameter (one-shot, persists). First flag is `schedule_build_mode_v1` (off in production, on in dev) (#349).
- **Schedule render parity (#248)**: closes the gap between the current Schedule view and the target design. New WBS number column (mid-string ellipsis on long paths) and Owner avatar column (24 px circles, +N overflow chip) in the task list. View filters (CP only, Focus chain) restyle from plain checkboxes to styled toggle buttons; new render filters (Critical path, Milestones) join them in a second toggle group. Project-health summary chip in the toolbar shows `{N} tasks · {C} critical · CPM ✓` with a width-stable loading state.
- **+ Milestone toolbar action (#340)**: peer to + Task with gold accent, inserts a new milestone at today's date with `is_milestone=true, duration=0`. ⌘M / Ctrl+M shortcut wires up via the new `useScheduleKeyboard` hook (suppressed inside editable inputs). Diamond pulses on the timeline at the new milestone's position (1.5 s, motion-safe — disabled under `prefers-reduced-motion`); aria-live polite region announces "Milestone {name} inserted at {date}". Disabled with "Read-only access" tooltip for VIEWER role.
Add task create, rename, and reorder mutations wired to the API. A "+ Task" button in the Gantt and WBS toolbars opens an inline form (name + duration). WBS inline rename and drag-to-reorder are now persisted via PATCH and POST reorder endpoints. Fix sidebar active project highlight which previously activated all items simultaneously.
Added `/voc-audit` skill: persona-level review of shipped surfaces with GitLab issue cross-reference. Runs on demand against a recently-merged surface, and as Step 0.8 of `/pre-release full` (one parallel pass per user-visible surface shipped since the last release tag).
Architectural decisions for Wave 2 reopened issues: ADR-0020 amendment
(reuse `TaskRun` for scheduler-runs history, #57), ADR-0015 amendment
(ratify native-TS drag-preview worker, #19), ADR-0013 amendment
(configurable Kanban board columns via new `boards` app, #21),
ADR-0026 (React Native + WatermelonDB + Detox mobile platform, split
from #42), ADR-0027 (incremental CPM via `changed_task_ids` with
fuzz-test equivalence gate, #8).
Added `scripts/wt`, a git worktree helper for parallel multi-issue development. `scripts/wt new <issue>` creates a worktree at `../trueppm-wt/<branch-leaf>/` with symlinked `packages/api/.venv` and `packages/web/node_modules` (so dev deps aren't duplicated) and an `.envrc` that exports `COMPOSE_PROJECT_NAME=trueppm` so the worktree reuses the Docker stack from the main checkout. Includes `list`, `remove`, and `doctor` subcommands plus a soft WIP cap at 5 active worktrees. Docs: `docs/getting-started/parallel-worktrees.md`.

### Changed
- **Signal-privacy action URLs are now kebab-case**: the two project signal-privacy actions moved from `.../signal-privacy/raise_ceiling/` and `.../ratchet_down/` to `.../raise-ceiling/` and `.../ratchet-down/`, matching every other action path in the API. The old snake_case paths now return `404`. Signal privacy is new in 0.3 with no shipped consumers, so this is a clean rename with no redirect shim.
Replaced ad-hoc `bg-brand-primary` / `text-white` brand buttons and identity chips with the shared `Button` component (primary action buttons) and the design-system fill/tint recipes (`bg-sage-500 text-navy-900` for brand squares, status circles, and active-state pills; `bg-brand-primary/10 text-brand-primary` for person-initials avatars). This fixes the dark-mode contrast of the affected surfaces and keeps them on the WCAG-AA sage/navy tokens.
Hid the program-backlog **Import CSV** button until CSV import ships (#1045, #746). The button previously surfaced a "coming soon" dead-end on a primary action of a new surface.
The Project and Program **Settings → General** pages now render every field read-only for members below the Admin role, matching the server's write permissions. Schedulers, Members, and Viewers can still read the settings but no longer see an editable form that would fail with a 403/400 on save. Admins and Owners edit as before.
The bridge reforecast on the promote-to-milestone dialog and the SprintPanel velocity forecast line are now labeled honestly as velocity-band estimates: when the forecast basis is the deterministic velocity-band heuristic (not Monte Carlo), the P50/P80/P95 percentile vocabulary is replaced with "Early / Likely / Late" and an "Estimate — velocity-based, not simulated" qualifier. True P50/P80/P95 language is reserved for when real agile-aware Monte Carlo backs the forecast (#1094).
Sprint-goal editing and backlog reorder/auto-rank now resolve through the Scrum-Master / Product-Owner team facets (ADR-0078) instead of requiring `role >= ADMIN` (#1095). A Scrum Master can edit the Sprint Goal and a Product Owner can reorder and auto-rank their backlog even when their access role is below Admin. Project detail now exposes the caller's own facets via `my_facets`. (#496, a named PO role, is superseded by this facet-gating.)
Redesigned the Sprint Cadence strip: an over-committed sprint now shows a distinct overflow segment past a capacity marker plus a `⚠ +N over` label instead of a clamped "full" bar, the sprint name leads each card (the internal id moves to the accessible name), and two low-contrast labels were corrected to meet WCAG AA.
The standup daily-delta now detects new blockers from the explicit blocked-flag transition rather than a move into the deprecated `ON_HOLD` status, and splits them into "impediment" (a structured blocker type was recorded) vs "paused" (flagged with no type). Each entry carries the type and age — never the private reason text (ADR-0124). Closes #1125.
Daily delta panel — anti-scoreboard per-actor framing (#1126): per-person activity is reframed as a standup focus aid (not a ranking), rendered as stacked blocks rather than aligned columns. Zero-activity actors are suppressed, and Viewer-role members now see team totals only — never a per-person breakdown.
Sprint Review acceptance labels are reframed as coverage hygiene, not grades (#1133): "not accepted" is now "criteria incomplete" and "no criteria" is now "criteria not set" (a muted setup state). Story-point totals remain behind the velocity privacy gate; the counts stay visible.
- **Sprint scope acceptance reachable by the Product Owner / Scrum Master**: accepting or
  rejecting a mid-sprint scope injection is no longer restricted to project Admins. A team
  member who holds the Product-Owner or Scrum-Master facet (ADR-0078) can now review pending
  scope from the board — the PO owns sprint scope and the SM facilitates the ceremony. The
  team-owned back-door close is preserved: the gate still requires a real, explicitly-assigned
  membership row, so no org/PMO principal can force-accept (ADR-0102 §3, ADR-0123 §3, #1140).
- Upgraded the web build toolchain to Vite 8 and `@vitejs/plugin-react` 6, clearing the HIGH-severity esbuild advisory (GHSA-gv7w-rqvm-qjhr) from the build dependency tree. The vulnerable code was build-time only and never shipped in the application bundle; the `web:security` audit gate now passes on the full dependency tree.
The blocker's soft "waiting on" related-task link is now clearly distinguished from a CPM schedule dependency in read views and the blocked roll-up — annotated "informational — does not affect the schedule" — so a "waiting on" note can't be mistaken for a predecessor that moves dates.
The opt-in `task.blocked` email is now actionable: the body carries a direct deep-link to the blocked task (when `FRONTEND_BASE_URL` is configured), plus who flagged it and the task it is waiting on. The private blocker reason is still never included (ADR-0165). Set the new `FRONTEND_BASE_URL` setting to your public web origin to enable email links.
**Throughput-based delivery forecast for sprintless teams** (#1161, ADR-0130): the backlog delivery forecast (`GET /api/v1/projects/{id}/sprint-forecast/`) now forecasts continuous-flow / Kanban teams from a count-based throughput Monte Carlo when there is no usable closed-sprint velocity, instead of returning `warming_up` forever. The response gains a `forecast_basis` discriminator (`"velocity"` | `"throughput"`), a `remaining_count` (throughput-path backlog item count), a `p95_date`, and a new honest `status` value `insufficient_flow_history` (the flow-path parallel to `warming_up`). The legacy `basis` field is unchanged (`"monte_carlo"`) for backward compatibility with existing clients.
Design System v2 foundation (ADR-0126): the app now sits on **warm paper** (the deliberate antidote to the old cool-grey "sterile" feel) — the body uses a new `--app-canvas` token and cards stay white and pop against it; the light neutral surfaces and borders are re-pointed to the golden warm tones (dark mode already matched the navy family). Adds the canonical v2 golden token aliases (`--paper`/`--ink`/`--sage`/radii/elevation/motion) plus Tailwind `bg-app-canvas`, `rounded-card|control|chip`, `shadow-card|pop`, and `ease-brand`, and a CI/lint conformance gate (`scripts/check-design-system-v2.sh`) that blocks design drift on four fronts — arbitrary color classes, raw hex literals, off-token box-shadows (borders-over-shadows), and dark-chrome-on-light (no dark sidebar on a light app) — so all future work inherits the standard. Light/Dark/Auto theming and existing token names are unchanged.
New left navigation rail (design system v2, ADR-0126): a 248px rail that replaces the old project sidebar with the v2 information architecture — brand + collapse, a ⌘K search/jump trigger, a **Personal** group (My Work, Inbox), a **Shortcuts** group of projects you ★-pin, and a **Programs** tree you expand to its projects, plus a user footer with quick access to settings. Pins and expanded programs persist across sessions. The brand mark and the ⌘K trigger moved out of the top bar into the rail; the cross-program Portfolio rollup appears only on editions that include it. The org-level Resources catalog has an **Organization** entry in the rail, and its icon stays visible when the rail is collapsed.
The project view bar now groups its tabs into **PLAN / TRACK / PEOPLE** (method-filtered, with a `{METHOD} Workspace` tag), and the three separate health badges are replaced by **one methodology-adaptive health cluster** — Agile shows Sprint · Points · Velocity, Waterfall shows Forecast · At-risk · Critical, Hybrid shows Sprint · Forecast · Critical. Team velocity stays private to the team when the project's signal-privacy policy withholds it. (#1167, ADR-0128)
Primary empty/first-run surfaces now show a warm, encouraging empty state (icon, heading, orientation copy, and a start CTA) instead of a bare "No data" line — Schedule, the Risk register, and the task Grid — via a shared `EmptyState` component with a subtle entrance animation that honors `prefers-reduced-motion`.
A persistent **context bar** now sits at the top of the app (design system v2, ADR-0127): a breadcrumb trail (Workspace › Program › Project) with the program identity square shows you exactly where you are and lets you jump up a level, the color-scheme toggle (Light/Dark/Auto) moved out of the user menu into this always-visible row, and a ≡ button hides or shows the left navigation rail. Collapsing the rail now hides it completely for maximum canvas — the ≡ in the context bar (and ⌘K) bring navigation back — replacing the previous narrow icon rail, and your choice persists across reloads.
Presence avatars now live in the v2 context row (next to the theme toggle) rather than the view bar, grouping "who else is here" with the rest of the wayfinding chrome. Presence remains ephemeral and project-scoped: it shows who is currently viewing the project, excludes you, and is absent outside a project context — with no aggregation or activity tracking.
- **Progress-aware forecasting**: the CPM schedule and the Monte Carlo forecast
  now account for which work is open vs. closed (ADR-0132). Completed tasks are
  pinned to their recorded actual dates instead of being re-scheduled or
  re-simulated from the project start; in-progress tasks contribute only their
  remaining duration; and a new per-project **status date** (the data date,
  defaulting to today for the forecast) keeps remaining work from being
  scheduled in the past. Previously a project that was half-done was forecast as
  if starting from scratch, so the Monte Carlo P50/P80/P95 ignored real progress.
- Projects gain an optional `status_date` field (`GET`/`PATCH /projects/{id}/`);
  null means "no explicit anchor" and the forecast falls back to today.
Project Overview now leads with three risk-ranked focus cards and demotes the rest to a compact strip, and replaces schedule-index jargon with plain-language health labels.
- **Warm-paper page canvases (v2)**: page-level views (My Work, Programs list,
  Project and Program Overview, Product and Program Backlog, Resources) now paint
  the warm `bg-app-canvas` background instead of plain white, so content cards
  (`bg-neutral-surface`) visibly pop against the canvas per Design System v2
  (ADR-0126). First slice of the tree-wide v2 foundation adoption (issue 1194).
Shared UI primitives (buttons, dialogs, menus, the import flow, breadcrumb, theme toggle) now use the v2 golden semantic corner radii — `control` (8px) for buttons and triggers, `card` (12px) for panels, dialogs, and menus, and `chip` (6px) for small badges — so corner rounding is consistent by role rather than by ad-hoc size. Visual-only; no behavior change (design system v2, ADR-0126).
The My Work surface (My Work home, focus cards, task rows, status picker, retro section, landing prompts, notification inbox and preferences, general/connected-accounts settings) now uses the v2 golden semantic corner radii — `control` (8px) for buttons, inputs, and triggers, `card` (12px) for panels, modals, popovers, banners, and selectable radio-cards, and `chip` (6px) for small status badges — so corner rounding is consistent by role rather than by ad-hoc size. Visual-only; no behavior change (design system v2, ADR-0126; issue 1194).
- **Pop-surface elevation**: dropdown menus, the board drop-notice, and the
  load-sample popover now use the Design System v2 `shadow-pop` elevation token
  instead of a raw `shadow-lg`, matching the command palette and toasts. This
  drives the off-token shadow count to zero tree-wide (#1194).
The program surface (program list and cards, overview rollup KPIs, projects and resources pages, members and invite forms, cadence ceremony and phase-gate panels, the program backlog grooming view and its mobile sheets, and the add/move/create program dialogs) now uses the v2 golden semantic corner radii — `control` (8px) for buttons, inputs, selects, checkboxes, segmented controls, and icon buttons, `card` (12px) for panels, dialogs, list containers, empty states, callouts, and selectable tiles, and `chip` (6px) for small status badges, count pills, tags, and identity squares — so corner rounding is consistent by role rather than by ad-hoc size. Visual-only; no behavior change (design system v2, ADR-0126; issue 1194).
Migrated the last remaining surfaces to the v2 golden semantic corner-radius tokens (`rounded-control` 8px / `rounded-card` 12px / `rounded-chip` 6px, ADR-0126), completing the radii sweep across the web app. This final slice covers the board (cards, backlog band, queue, sprint header, flow analytics, mobile column strip, board settings, standup mode and person cards), resource (heatmap, allocation popover, overallocation and cell drawers, KPI row, legend swatches), roster (page sheet, add-to-roster combobox, cascade-delete dialog), settings (bulk-fields matrix, confirm/split/transfer dialogs, the integrations API-token/webhook/git-automation managers, and the signal-privacy and team panels), and the reports burn chart, calendar legend, login art, top bar, user menu, sprint reforecast card, today schedule pulse, and story detail drawer. Corner rounding is now consistent by element role rather than ad-hoc size: controls (buttons, inputs, selects, interactive rows), cards (panels, dialogs, drawers, popovers, bordered list containers), and chips (badges, pills, swatches, legend dots, load bars). Card-edge accent bars are pinned to the card radius so they match. Visual-only — no behavior change. Closes the v2 radii sweep of epic #1163 (issue 1194).
Adopted the v2 design-system foundation across the **Risk register** surface (#1194): legacy Tailwind radii migrated to the semantic `rounded-card` / `rounded-control` / `rounded-chip` scale by role, and the register now renders on the warm `bg-app-canvas` page surface with the heatmap and risk table as white cards that pop against it. Visual-only — no behavior change.
Adopted the v2 design-token foundation across the schedule task-detail-drawer **sections** surface (#1194): legacy Tailwind radii migrated to the role-named semantic scale — `rounded-card` (12px) for section panels, callouts, menus, and drop zones, `rounded-control` (8px) for buttons, inputs, and toggles, and `rounded-chip` (6px) for badges, status pills, and inline mention marks — so corner rounding is consistent by role rather than by ad-hoc size. Visual-only; no behavior change (design system v2, ADR-0126). Another slice of the staged, ratchet-driven migration; the remaining schedule chrome (Gantt view, tabs, build mode) follows in later changes.
Migrated the Schedule view surface (Gantt toolbar, task drawer & tabs, dependency/estimate/baseline panels, Monte Carlo cards, the unscheduled gutter, and build-mode chrome) to the v2 semantic corner-radius tokens (`rounded-control` / `rounded-card` / `rounded-chip`, ADR-0126). Controls, surfaces, and chips now round consistently with the rest of the redesigned UI; the Gantt preview-overlay bars are pinned to the canvas bar radius so on-canvas and overlay bars match. Visual-only — no behavior change. Completes the Schedule slice of the v2 radii sweep (epic #1163).
The workspace settings surface (General, Members, Groups, Methodology, Roles, Programs, Email, Attachments, Danger zone, invite acceptance, and the System Health pages — overview, dead-letter inspector, retention purge) now uses the v2 golden semantic corner radii — `control` (8px) for buttons, inputs, selects, toggles, and segmented controls, `card` (12px) for panels, dialogs, banners, callouts, and selectable tiles, and `chip` (6px) for small status badges and pills — so corner rounding is consistent by role rather than by ad-hoc size. Visual-only; no behavior change (design system v2, ADR-0126; issue 1194).
Extended the v2 design-token foundation to the Program and Project settings pages (#1194). The settings content area now renders on the warm-paper `app-canvas` token so the white setting cards pop against it, and corner radii across these pages use role-named semantic tokens (card / control / chip) instead of ad-hoc sizes. Another slice of the staged, ratchet-driven migration; remaining settings areas (workspace, integrations) follow in later changes.
Adopted the v2 design-system foundation across the **Sprints** surface (#1194): legacy Tailwind radii migrated to the semantic `rounded-card` / `rounded-control` / `rounded-chip` scale by role, and the Sprints view now renders on the warm `bg-app-canvas` page surface so its panels, cards, and dialogs (`bg-neutral-surface`) pop against it. Visual-only — no behavior change.
Adopted the v2 design-token foundation across the app shell, board, and project surfaces (#1194). Page canvases now render on the warm-paper `app-canvas` token so white cards visibly pop against the background instead of disappearing into a flat field, and corner radii use role-named semantic tokens (card / control / chip) rather than ad-hoc sizes. This is one slice of a staged, ratchet-driven migration; remaining feature areas follow in later changes.
Consolidated the top navigation into a single unified bar. Wayfinding, the view/program tabs, project health, and account controls now share one compact row instead of two — reclaiming vertical space, removing the duplicated breadcrumb, and keeping the view tabs scrollable so they never clip. The breadcrumb now appears only when the sidebar is hidden, and the theme toggle lives in the user menu.
- **Legibility floor**: raised structural micro-labels — nav/section labels, table
  headers, command-palette group labels and keycaps, status/role/WIP chips, sprint
  metrics, and the risk-policy matrix — from 10px to the 11px brand legibility floor.
  Genuinely decorative glyphs (avatar/initial squares, aria-hidden sort/icon glyphs,
  the Slack message-preview "APP" tag) are left as-is.
- **Velocity rollup index**: added a composite database index on
  `Sprint(project, exclude_from_velocity, state, closed_at)` so the velocity
  eligibility scan seeks directly to the eligible, newest-first sprint set
  instead of sequentially scanning the sprint table.
- **Notes search refactor**: extracted the task-notes client-side dim-search filter
  into a reusable `useNotesSearch` hook. Internal refactor only — no behavior change.
- **Risk matrix internals**: extracted the per-cell render of the risk matrix
  into a dedicated `RiskMatrixCell` component. Pure refactor — no behavior, token,
  or accessibility change; the matrix now maps over the grid and renders one
  `RiskMatrixCell` per probability × impact cell.
Added unit-test coverage for the shared `wipState(count, limit)` three-band WIP-limit helper, covering every band boundary (none/under/at/over) and the zero-count and zero-limit edges.
- **Settings is now one scrolling page per entity**: workspace, program, and
  project settings sections are no longer separate routes that unmount, refetch,
  and flash when you switch between them. Every section now lives on a single
  page as an anchored region, with the left rail acting as a scroll-spy
  (click to smooth-scroll, scroll to highlight the active section). The
  unsaved-changes bar is one shared surface across all sections — a dirty edit
  anywhere arms it, Save commits every changed section, and Discard reverts them
  all. Settings are deep-linkable (e.g. `…/settings#methodology`), and old
  per-section URLs redirect to the matching anchored section.
The Schedule build-mode hint strip is now contextual: it appears only while a row is focused or a cell is being edited, so the idle Schedule keeps its Monte Carlo forecast bar flush at the bottom instead of stacking two bars. The always-on toolbar pill remains the entry point to the keyboard-shortcut cheatsheet.
The Helios CRM Replacement sample's build stories now carry realistic working-day durations, so they render with proper width in their sprint windows on the schedule instead of as 1-day slivers (paired with the sprint-window positioning fix, #1284).
Paginated several list endpoints that previously returned their full, unbounded result set — workspace members, project teams and team rosters, active task runs, dead-lettered tasks, import provenance, webhook deliveries, and cross-project slip conflicts. Each now returns one bounded page (the user/audit-style tables — members and webhook deliveries — use stable cursor pagination), capping per-request memory and query cost as these tables grow. API consumers of these endpoints read rows from `results` and follow `next` to page; the web client pages through transparently.
Capped the in-memory load of task and project history before pagination; responses now include a `count_truncated` flag when more than the most recent change records are available.
Public-API consistency clean-ups ahead of the 0.3 contract freeze: the redundant `critical_path_count` alias is dropped from the project status-summary response (use `critical_count`); program import/sample endpoints now return validation errors under the standard `{"detail": ...}` envelope instead of `{"errors": [...]}`; and the operator retention/workflow/idempotency environment variables are standardized on the `TRUEPPM_` prefix, with the legacy bare names still honored as a fallback. The `trueppm-scheduler` package's `find_cycle()` and `expand_summary_dependencies()` now return small result dataclasses (the latter still unpacks as a 2-tuple), and `monte_carlo()`'s tuning arguments are keyword-only, so all three can grow fields without breaking pip consumers.
- The unified **Today** view now adapts its schedule strip to the project's methodology. Waterfall projects drop the always-empty active-sprint rollup; agile projects drop the CPM/SPI schedule pulse (off-vocabulary once the Schedule and Calendar views are hidden) and foreground the sprint; hybrid projects keep both, unchanged. The Today tab itself stays visible for every methodology.
- **Scheduler `monte_carlo()` no longer caps runs/tasks by default (#1341)**: the
  `trueppm-scheduler` library's `max_runs` and `max_tasks` parameters now default
  to `None` (no cap), so the documented `monte_carlo(project, runs=10_000)`
  example runs as written instead of raising `SimulationCapExceeded`. The
  protective cap is a request-path guard and lives where it is needed — the
  TruePPM API view already passes `MC_SIMULATION_CAP` / `MC_TASK_CAP` explicitly,
  so its 402-on-cap-breach behavior is unchanged. Direct callers (CLI, notebooks,
  PyPI consumers) are now uncapped unless they opt in.
Role gates on several membership and scope-management write actions are now also expressed as DRF object-level permission classes, in addition to the existing in-body checks (defense-in-depth). Project/program membership `create` (and project membership role/identity edits) require Owner at the permission layer; acknowledging a cross-project slip conflict requires Admin+ or the Scrum Master / Product Owner facet via the new `IsTaskScopeManager` class. There is no behavior change for authorized callers — an unauthorized request is simply rejected before the view body rather than inside it. Benign carve-outs are preserved: any member may still self-remove, an Admin may still set a program member's freeform `role_title`, and the sprint scope-change accept/reject path keeps its structured-`403` service gate. The decision, including why Viewers remain excluded from the real-time WebSocket channel, is recorded in ADR-0184.
- **`trueppm-scheduler` now ships a frozen, documented public API**: every exception raised by the package shares a common `SchedulerError` base (itself a subclass of `ValueError`, so existing `except ValueError` handlers keep working), and degenerate inputs — an empty project, a non-positive Monte Carlo run count — now raise the specific `InvalidScheduleInput` rather than a bare `ValueError`. The validator caps and the exception classes are re-exported from the package root, the `DependencyType` / `DeliveryMode` enum casing is now a documented convention, and a contract-freeze test pins the exported names, exception hierarchy, and enum casing so future changes to the public surface are deliberate.
- **Public extension surfaces hardened for the 0.3 freeze**: WebSocket workshop events now carry the shared `protocol_version` field like every other broadcast, so clients can version-gate workshop messages consistently. The `FRONTEND_BASE_URL` and `AUTH_REFRESH_COOKIE_*` settings gained `TRUEPPM_`-prefixed names (the legacy bare names still work as fallbacks). The admin `/workspace/invites/`, `/workspace/groups/`, and `/workspace/export/` list endpoints now return the standard page-number envelope (`count`/`next`/`previous`/`results`) instead of a bare array, matching every other list endpoint. The frontend slot registry now records which slots are LIVE (rendered by the OSS shell today) versus RESERVED (part of the enterprise contract but not yet wired), with a compile-time exhaustiveness check that fails the build if a new slot is left unclassified.
- **psycopg implementation is now selected per environment**: the base
  dependency is the pure-Python `psycopg` core, and the C-speedup vs. precompiled
  implementation is chosen via the new `[c]` (production — links the system
  libpq) and `[binary]` (local dev — bundled wheel) extras rather than being
  pinned globally. A bare install no longer forces a compiler.
- **`html-to-image` is now tracked at `^1.11.13`** (loosened from the exact
  `1.11.13` pin) so patch releases are auto-adopted; the lockfile still pins the
  exact resolved version for reproducible builds.
- **Consistent `since`/`until` window type across the computed analytics reads**: the forecast-snapshot history (`GET /api/v1/projects/{id}/forecast-snapshots/`) now documents its `since`/`until` query parameters as an ISO 8601 date (`YYYY-MM-DD`), matching the burn series (`GET /api/v1/projects/{id}/burn/`). Both project-grained windowed reads now expose one `date` contract instead of two (date vs date-time), so a client generated from the published schema sees a single shape. A full ISO datetime is still accepted at runtime; a bare date is now correctly interpreted as a timezone-aware midnight bound.
- **MS Project export declares its `application/xml` response, and the WebSocket event taxonomy covers task-run and retro-board events**: the schedule export (`GET /api/v1/projects/{project_pk}/export/msproject.xml`) now documents an `application/xml` binary 200 body in the published schema, so a generated client knows the media type of the download. The frozen WebSocket event-type contract now also includes the five `task_run_*` events (started, progress, completed, failed, cancelled) and the four `retro_item_*` events (created, updated, moved, deleted); the freeze guard's scanner was hardened to follow one level of broadcast-wrapper indirection so these wrapper-emitted events are discovered and locked.
- **Board-first navigation**: Board tab moves first in ViewTabs and BottomNav; default project route now redirects to `/board` instead of `/overview`.
- **Gantt → Schedule rename**: "Gantt" tab label renamed to "Schedule" across ViewTabs and BottomNav per design handoff.
- **5-column board model**: Board default columns expanded from 3 to 5 — Backlog · To Do · In Progress · Review · Done — matching the design handoff column model. `TaskStatus` extended with `BACKLOG` and `REVIEW` values.
- **Adaptive sidebar chrome theming**: Sidebar and chrome shell surfaces migrated from hardcoded `gantt-surface` (dark navy) to `chrome-*` CSS custom property tokens. Light mode renders a warm off-white shell; dark mode retains the deep navy. Satisfies WCAG 4.5:1 on both surfaces via `semantic-*` tokens.
- **Chrome dividers and surface tokens**: Added `chrome.border` Tailwind token (`rgba(0,0,0,0.08)` light / `rgba(255,255,255,0.08)` dark). Sidebar gains a right divider; ORG section uses the chrome divider. StatusBar moves to `surface-sunken`; Board scroll area uses `surface-sunken`. Brings the shell in line with the design spec's divider hierarchy.
- **Gantt popover/drawer transparency fix**: Canvas scroll container now establishes an explicit stacking context (`z-0`), so the three GPU-composited canvas layers no longer paint over `Columns` popover, `TaskDetailDrawer`, or other absolute/fixed overlays.
- **Card readiness states**: Board cards now show a `ReadinessChip` derived from a new `readiness` API field (`idea` / `estimated` / `ready` / `baselined`). Idea cards (no assignee) render with a dashed border, italic title, and `?` avatar placeholder. The left accent bar follows readiness state, overridden by critical-path status.
- **Drop-shadow rule enforcement**: Removed `shadow-xl` from `AllocationEditPopover` and `shadow-lg` from `LoadTooltip` (rule 1 violation); both now rely on `border` for separation.
Close live-impact-simulation (#19) on the native-TypeScript Gantt drag-preview
worker. ADR-0015 amendment ratifies the shipped path; the Rust WASM build at
`packages/wasm-scheduler/` stays green as the conformance reference and
migration target. New vitest perf guard asserts the 1000-task FS-chain preview
stays under 33 ms p95 — failing this test is the signal to execute the WASM
migration documented in the ADR. (#19)
- **Auto-roster on resource assignment closes two gaps**: re-pointing a `TaskResource` to a different resource via PATCH now adds that resource to the project roster, and MS Project imports auto-roster every assigned resource. Both paths previously skipped the roster, leaving assigned resources invisible in Team → Roster, Allocation, and Heatmap. The pattern is centralised in `ensure_project_resource()` (#241).
## Schedule — dep-type UX polish and milestone edit completeness (#249 + #253)

- Dependency-type picker now shows plain-English labels (`Finish → Start`, `Start → Start`, `Finish → Finish`, `Start → Finish`) instead of bare CPM acronyms in both the existing-row selector and the add-row selector.
- Changing a dependency type to a value that would create a cycle now shows an inline per-row error message (with the cycle path) immediately below the offending row; the error clears automatically on the next interaction.
- Task detail drawer suppresses PERT `EstimatesSection` for milestone tasks (milestones have no duration to estimate).
- MetaRail now shows milestone-appropriate fields: `Date` row (renamed from `Start`), no `Finish` row (single point in time), `— (milestone)` in the Duration row (not `0d`), binary progress text (`Not yet reached` / `✓ Reached`) without a progress bar, and predecessor chips with plain-English `title` tooltips.
- Milestone create flow (`+ Milestone` / ⌘M) now unconditionally drops into inline name-cell-edit and opens the task drawer (so the `Date` field is immediately visible) regardless of whether build mode is active.
Schedule: Monte Carlo row no longer renders an always-visible mini-histogram strip — only the P50, P80, P95 outlined date chips. Real-world inputs without PERT estimates collapse to a single bucket and the strip degenerated to one bar, which misled more than it informed. Hover or keyboard-focus still opens the full distribution tooltip; the mobile sheet and TopBar MC panel are unchanged.
**Sprint header buttons + timeline plan-arrow flows (#299).** Sprint workspace gets the missing wiring around its three header CTAs. The Filter button opens a popover with assignee (Me / Anyone / per-resource) and status (5-chip) filters, persisted per-sprint in sessionStorage; the filter applies only to the Sprint Backlog table while the metrics row still reflects the whole sprint. The Close sprint button now opens a confirmation dialog with a carry-over destination picker (next planned sprint, project backlog, or leave-on-this-sprint for retrospective fidelity). The timeline strip's last-planned card swaps its old `Plan →` action for `Activate →` (when the start date is within three days, calling `POST /sprints/{id}/activate/` and surfacing capacity warnings inline) or `Edit` (opening `PlanSprintModal` in edit mode and PATCHing the sprint). New `activateSprint` and `updateSprint` mutations on `useSprintMutations`.
- Unified task create/edit modal (issue #305): replaces the legacy `AddTaskModal` (board phase headers) and the inline `AddTaskForm` strip on Schedule and WBS views with a single redesigned modal supporting both create and edit flows. The modal includes per-assignee unit % editing with a Σ total indicator, an inline predecessors picker, sprint membership (when `agile_features` is enabled on the project), and a role-gated Delete action with a destructive-confirm dialog. Edit mode prefills from the task and surfaces a "Last edited by …" footer derived from the existing audit history. The previous popover **Edit** action (issue #304) now opens this modal instead of the read-only drawer. Mobile (< 768px) renders the form as a full-screen sheet via the new shared `<BottomSheet>` component (also adopted by the card popover from #304).
**Task detail drawer — section-registry redesign (#306, #309).** The legacy four-tab drawer (Dependencies / Estimates / History / Baseline) is replaced with a 540px registry-driven collapsible-section list per ADR-0050. New sections register against `task_detail.section` on the existing `WidgetRegistry` (ADR-0029), letting Enterprise add panels (custom fields, etc.) without OSS importing from `trueppm_enterprise`. Sticky 120px meta rail surfaces status, start, finish, duration, float, and progress at a glance. Overview is the only section open by default; others lazy-mount on first expand to avoid initial fetch storms. Each section is wrapped in a React error boundary so a buggy section cannot crash the drawer chrome. Mobile bottom-sheet shell is preserved; mobile React Native drawer is queued for milestone 0.2.
- **WebSocket event names for task collaboration** are now namespaced under `task_` and per-action past-tense: `task_comment_created`, `task_comment_updated`, `task_comment_deleted`, `task_attachment_created`, `task_attachment_deleted`. The earlier `*_changed` shape with an `action` discriminator field has been removed, and the un-namespaced `comment_created` / `attachment_created` shape from the M-1 refactor collided with RiskComment's pre-existing `comment_created` event (ADR-0044). Clients listening to the old combined events must update their handlers — no compatibility shim. Payload shape is unchanged otherwise (`id`, `task_id`, and `parent_id` for comments) (ADR-0075 §D, M-1 + collision fix).
**Default cache/broker is now [Valkey](https://valkey.io), not Redis** (#316): the bundled Helm chart, `docker-compose.yml`, `docker-compose.prod.yml`, and CI service template now use `valkey/valkey:8-alpine` (Helm: Bitnami `valkey` 3.x) instead of Redis 7. Valkey is the BSD-licensed Linux Foundation fork of Redis, wire-compatible with Redis 7.2 — `django-redis`, `channels_redis`, `redis-py`, and Celery work unchanged. The `REDIS_URL` / `REDIS_PASSWORD` env var names and the `redis://` URL scheme are deliberately preserved (deferred to 1.0) so existing self-hosters' `.env` files keep working. Self-hosters upgrading from a previous compose stack should run `docker compose down` once to remove the old `redis` container before `docker compose up -d`. Existing managed Redis services (ElastiCache, Memorystore, Azure Cache) remain drop-in alternatives — just point `REDIS_URL` at them.
- Real-time board: `task_updated` WebSocket events now carry a field-level delta (which fields changed, the new version, and who changed them). Collaborators converge on card changes without a full board re-fetch, and the editor who made a change no longer re-fetches over their own optimistic update. Field *values* are never broadcast — role-gated fields (e.g. story points) stay gated. (#327)
- Unified the WBS and Table views into a single **Grid** view (issue #334, ADR-0053). The previous two top-level navigation entries (`Table` at `/projects/:id/list` and `WBS` at `/projects/:id/wbs`) are replaced by one **Grid** entry at `/projects/:id/grid` with three display modes selectable from a segmented control inside the view: **Flat** (sortable, virtualised flat list), **Outline** (tree with WBS hierarchy, drag-to-reparent, indent/outdent), and **Grouped** (group by phase, owner, status, sprint, or resource). Last-used mode persists per project (`localStorage`) and the methodology preset drives the initial default — Waterfall and Hybrid open in Outline, Agile opens in Flat. Filters, search, bulk-select, and CSV export are now shell-level controls that apply across all three modes. Resource grouping intentionally lists multi-assignee tasks under each of their resources; a tooltip in the toolbar explains the duplication. The legacy `/wbs` and `/list` URLs redirect to `/grid` so existing bookmarks and shared links keep working.
Added shared Playwright fixture (`packages/web/e2e/fixtures/`) with `setupAuth`, `setupApiMocks`, and `setupCatchAll`. The catch-all returns a typed 404 + console warning for any unmocked `/api/v1/*` request, replacing the silent `ECONNREFUSED 127.0.0.1:8000` proxy errors that previously flooded e2e traces. `board.spec.ts` and `wave9-workshop.spec.ts` migrated as references — ~150 lines of boilerplate dropped per spec, zero unmocked warnings.
- **CI: stale-stub gate**: a new `lint:todo-grep` job fails the pipeline on `STUB:` or `WIP:` markers in source and on `TODO(#NNN)` references that point at a closed issue. Bare `TODO` (no issue reference) emits a warning but does not fail. Excludes `packages/web/e2e/`, `docs/`, and `*.md` files (#350).
- **Schedule outbox forensics**: `enqueue_recalculate` now records why a CPM recalculation was queued (`task_change`, `dependency_change`, `manual`). Dependency mutations and the manual trigger endpoint were previously logging every event as `task_change`, hiding the real cause when investigating "why did this reschedule fire?". The `DEPENDENCY_CHANGE` enum was defined but never used (#355).
**Board: BACKLOG cards now live in a left-side "Inbox · backlog" rail (#381, epic #361, ADR-0057).**

The Board view used to render BACKLOG as a column inside every phase, which forced premature phase assignment and dragged the phase progress chip toward zero. BACKLOG cards now sit in a phase-agnostic rail to the left of the phase grid; the phase grid shows only committed columns (TO DO / IN PROGRESS / REVIEW / DONE).

The rail header reads `Inbox · backlog · {N} ideas` with a stalled-count badge when any card is older than 5 days. Cards use a redesigned style: priority bars, readiness chip (idea / estimated / ready / baselined), phase color rail, optional stalled indicator. The rail collapses to a 44px vertical strip; preference persists per user across sessions.

A new `Task.committed` manager filters out BACKLOG and soft-deleted rows. The Monte Carlo simulation input and the resource overallocation check now use it, so backlog ideas no longer bleed into capacity heat maps or completion forecasts. Default `Task.objects` is unchanged — the Board still sees BACKLOG to render the rail.

Drag rules:

- BACKLOG → committed column promotes the card.
- TO DO → BACKLOG opens a confirm dialog (deliberate-decision moment, audit row recorded automatically).
- IN PROGRESS / REVIEW / DONE → BACKLOG is blocked — work already started.

Phases with no committed cards now show an em-dash instead of "0%", so the chip reads as "not applicable yet" rather than "0% done".

Calm toolbar, drawer/queue layout variants, and phase-grid empty-cell quieting ship as separate children of epic #361 (#382, #383, #384, #385).
When a task hits 100% progress, status now flips automatically based on
the actor's role: PMs and PMOs land in COMPLETE; contributors (Team
Member, Resource Manager, Viewer) land in REVIEW so a sign-off step is
preserved without a separate "review pending" tag. The Review *column*
itself is the governance gate — VoC 2026-05-08 (Option E). REVIEW now
also clamps `percent_complete` to 100 on save, mirroring COMPLETE,
because both states semantically mean "work delivered" — only sign-off
status differs. Backfill migration 0030 patches existing
`status=REVIEW, progress<100` rows.
**Board** — calm toolbar refactor (#382, epic #361 child B). The 14-control row collapses into an identity block (project name + activity stats), three primary chips (Group / Sort / Density), three quiet pill toggles (★ My tasks / ⚠ At-risk / $ Cost), a `Rail · Drawer · Queue` layout segmented control, and a `More⋯` overflow popover that holds the secondary controls (Collapse all / Expand all / Show WIP / Column tints / EVM / Columns / Keyboard shortcuts / Workshop). Layout choice and a new backlog-card density preference persist across reloads via the `useBoardToolbarPrefs` hook. Behaviour is unchanged — every control delegates to the same setters as before.
- web/board: Phase grid quieted per epic #361 child E. Empty status cells now render as a 16px tick at rest (drop targets expand back to full slots during drag); `LaneMeta` swaps the `ProgressRing` arc for an inline 4px progress bar with a mono percent label; column headers gain a status-dot prefix (TO DO, IN PROGRESS, REVIEW, DONE) and right-align the WIP fraction in mono. The Done-column resting tint quiets from `/5` to `/[0.025]` now that the dot carries the affordance. Workshop mode is unchanged.
- web/board: Synthetic phase-less Project Tasks lane (#386) now defaults task creation to BACKLOG instead of TO DO. The "+" button is renamed to `Add to backlog` and TaskFormModal opens with status pre-set to BACKLOG and title `Add to backlog`. Phase lanes (real WBS summary tasks) keep the existing `+ Add task` → NOT_STARTED behavior. Resolves the BACKLOG-vs-TO-DO default tension surfaced by the VoC panel after #386: brain-dumps from a job site no longer auto-commit, while the committed-lane semantics on real phase projects stay intact. Also normalizes the `'root'` view-layer sentinel to `null` at the modal call site so `parent_id` reaches the API as `null` per the documented contract.
`make pre-push` now runs Python lint and typecheck (`ruff`, `mypy`) for `packages/api` and `packages/scheduler`, mirroring the full set of CI gates that block MR pipelines.
- **Delivery-mode-aware rollup of parent percent-complete** (ADR-0108, hybrid model):
  a summary/phase task's rolled-up percent now reflects how each child is delivered —
  waterfall children contribute duration-weighted explicit percent, scrum children
  contribute story-point burndown, kanban children contribute item throughput
  (done/total), and zero-work milestone gates no longer dilute the number. A PM sees a
  real percent on a phase even when its children are scrum stories. Pre-existing
  waterfall projects are unaffected (the rollup reduces to the prior duration-weighted
  average). A summary task's percent-complete is now read-only on the API — it is
  computed from its children, so a manual write is rejected rather than silently
  discarded.
- **Scope rollup** (ADR-0108 §3): a new `GET /api/v1/tasks/{id}/scope/` returns a
  task subtree's current story-point scope, the active baseline's snapshot of that
  scope, and the delta — so a PM can see how much a phase has grown since baseline.
  The delta is reported as null (never a misleading 0) when there is no active
  baseline. Baselines now capture each task's story points at snapshot time.
Raise API test coverage gate from 65% to 80% (current: 89%). Add
`scheduler:bench` CI job with 100- and 500-task timing benchmarks (hard
limit 2s) — artifact stored for regression comparison. Add Playwright
`auth.spec.ts` (login happy path, 401 error, network error) and
`view-switching.spec.ts` (Gantt/WBS/Board/Table navigation, deep-link,
round-trip). Closes web+API scope of #42; mobile Detox tracked separately.
(#42)
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
Docs site: fix admonition contrast failures in both light and dark modes, establish light-as-default theme, and rewrite the landing page to lead with TruePPM's waterfall/agile/hybrid positioning.
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
The mid-sprint "scope changed" signal on milestone rows (schedule list, overview, and the sprint workspace) is now a persistent, clickable chip instead of a hover-only tooltip — one click opens a drawer with the per-task scope-change delta (+N / −M points), giving the team and the PM the same audit from either side (#550).
- **Toolbar responsive collapse**: Schedule, Board, and Resource view toolbars
  now follow consistent breakpoint rules. At ≥1024px every control shows its
  full label; between 768–1023px secondary toggles render icon-only; below
  768px the secondary toggles collapse into a shared overflow popover
  (`⋯ More options`). Primary actions (Today, Add task, Group/Sort/Density,
  view-mode switcher, period nav) stay visible at every supported width.
  Toolbars no longer wrap to a second row at narrow widths.
The agile-only **Aurora Mobile App** sample now ships an epic-grouped backlog — its 30 user stories roll up into six epics — so the pure-scrum demo reads like a real backlog an agile team plans in, matching the epic→story hierarchy already in the Atlas sample.
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
The disabled project-level working-calendar override on Project → Settings → General now shows a one-line workaround (set the work week per task) instead of a dead button, so users aren't left without a path forward until the picker ships.
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
Python dependency constraints now carry explicit upper bounds (capped at the next major) instead of bare `>=` floors, so a fresh install can no longer silently pull a breaking major release. As part of this, the API standardizes on **Django 5.2 LTS** (`>=5.2,<6.0`). The JavaScript dependencies were already bounded by npm's `^`/`~` ranges. (#718)
- **Workspace fiscal year is now a structured month + day** instead of free text. Workspace Settings → General offers quick presets (Jan 1, Apr 1, Jul 1, Oct 1) plus a **Custom** month/day picker for oddball fiscal starts such as the UK tax year (April 6). Existing free-text values (`"January 1"`, `"April"`, `"4/1"`, …) are parsed into the structured form automatically on upgrade; anything unrecognized falls back to January 1.
Eliminate N+1 queries and unbounded scans from the 0.2 perf audit: read prefetch caches in `TaskCommentSerializer` and `SprintRetroSummarySerializer`, scope `_me_work_retro_action_items` to member projects, add `select_related("target_milestone")` to `SprintViewSet` and `select_related("calendar")` to the program projects action, convert `MeActiveSprintsView` per-sprint burndown queries to a single `Prefetch`, and cap the `/utilization/` default window to ±8 weeks from today. Closes #772
- **Schedule view real-time perf**: The dependency-links query now paginates through every page (previously capped at the first 50, silently dropping arrows and CPM edges on larger projects); the 30 s fallback poll is gated on the WebSocket being down instead of always running; and a burst of live mutation events is coalesced into a single trailing refetch. Part of #773.
Hardened the `trueppm-scheduler` public surface: Monte Carlo now consumes the RNG in a version-independent lexicographic topological order so seeded P50/P80/P95 are stable across networkx versions and task insertion order; replaced TruePPM tier wording in `SimulationCapExceeded` with neutral, actionable messages; documented that CPM free float covers finish-to-start successors only; fixed the README quick-start expected `early_finish` (2026-01-23); and the Python and Rust conformance harnesses now assert `total_float`/`free_float` against the shared fixtures. Closes #774
- **Program navigation moved to the top bar, with a Settings tab**: a program's `Overview · Backlog · Projects · Members` tabs now live in the global top bar — the same place project tabs do — and a new **Settings** tab makes program settings reachable directly (previously you could only get there via the settings scope switcher). The redundant in-program header is gone; the program name shows in the sidebar and each view, and program delete remains under Settings → Archive/Close.
Workspace settings: placeholder buttons that were never wired are now disabled rather than dead-but-clickable. The OSS gaps (logo replace, add holiday calendar, member CSV export, resend invite) link to #791; the workspace lifecycle actions (export / transfer / delete) link to #641. "View change history" and "Sync from directory" are Enterprise capabilities (audit trail, directory sync) and now carry an Enterprise upsell badge instead of doing nothing.
Creating a project-shared board saved view now requires the Member role or above; a Viewer can still use shared views but can no longer add to the shared set (#820). This aligns board-view creation with the rest of the write-permission matrix (`IsProjectMemberWrite`). Reading shared views remains open to any project member.
- **Faster sync pulls and CPM scheduling on large projects**: the offline-sync delta endpoint now reads its watermark from a denormalized `Project.last_sync_version` column (kept current by save-time signals) instead of a 12-table `UNION ALL` on every pull, and the critical-path engine computes total/free float with a per-call working-day index (binary search) rather than a per-task day-by-day loop — dropping float computation from O(tasks × span) on a 10k-task year-long plan. Outputs are unchanged; the watermark column is verified equal to the previous query by a conformance test (ADR-0142).
Monte Carlo is now available for large projects: the OSS task cap (`MC_TASK_CAP`) is raised from 500 to 5,000, so projects up to the 10k-task scaling target no longer get an HTTP 402 from the simulation endpoint (#823). Operators on constrained hardware can lower the cap.
`trueppm-scheduler` public-surface decisions ahead of 1.0 (#826): Monte Carlo percentiles (P50/P80/P95) now use the standard `numpy.percentile` convention (linear interpolation) instead of an undocumented in-house nearest-rank, so values may shift by a day; `Project.from_dict`/`from_json` and `DateRange.from_dict` now raise the documented `InvalidScheduleInput` on malformed input instead of leaking `KeyError`/`ValueError`; `ScheduleResult` defensively copies its task and critical-path lists; and the engine-unused public fields (`Task.planned_finish`, `Task.percent_complete`, `Calendar.hours_per_day`, `Calendar.timezone`) are documented as reserved (round-tripped but not yet consumed by CPM/Monte Carlo). The `monte_carlo()` docstring now notes the default `max_runs=1000` cap so the 10,000-run example doesn't trip `SimulationCapExceeded`.
Helm: the bundled dev/demo PostgreSQL and Valkey are now first-party vendored subcharts (official `postgres:16` / `valkey/valkey:8` images) committed under `charts/`, replacing the deprecated Bitnami charts. The chart no longer depends on the Bitnami repository and resolves offline (`helm lint`/`helm template` need no `helm dependency build`). Production is unchanged — it disables both and points `DATABASE_URL`/`REDIS_URL` at managed services (CloudNativePG recommended for self-hosted HA Postgres).
WebSocket event-name convention is now uniformly `snake_case`: the presence events, previously dot-namespaced (`presence.join` / `presence.leave`), are now `presence_join` / `presence_leave` to match every other board event (#828). The deliberate WebSocket (`snake_case`) vs webhook (dot-namespaced, e.g. `task.created`) naming distinction is now documented in `packages/website/src/content/docs/api/websockets.md`. Wrapping the webhook payload in a versioned envelope is tracked for 1.0 (#852).
Documentation: new-feature pages (programs, recurring tasks, task collaboration, webhooks, workspace settings, system health, retention, durability, email, dead-letter alerting) now carry a "0.2 — in progress" callout, and the configuration reference documents the new retention/durability/recurrence env vars plus the not-yet-wired `EMAIL_*` settings.
OpenAPI documentation is substantially expanded (#846): list endpoints now document their query parameters (`/tasks/`, `/dependencies/`, `/recurrence-rules/`, `/projects/?program__isnull`, `/sprints/?state`, velocity-suggestions, utilization, resource-allocation, resources/heatmap, burn, project-resources `?force`, resource-skills/task-skill-requirements); custom report endpoints (monte-carlo incl. the 402 cap response, burn series, attention, overview, my-tasks, me/work, import provenance, edition) now carry response schemas; and the parameterless ghost `tasks/{id}/suggestions/{accept,decline,revoke}/` routes — which 404'd at runtime because they lacked the `suggestion_pk` segment — are removed from the router (the real routes with `suggestion_pk` are unchanged). Expands the #781 summary pass.
- **Resources › Allocation Timeline toolbar**: overallocation count badge now appears in the toolbar primary row when one or more resources are over-allocated in the current window. A "Filter resources…" search input in the secondary toolbar row filters the timeline rows by name client-side. The unscheduled-assignments warning strip now includes a "Run scheduler" button.
- **Hardened OSS write paths against third-party receiver failures**: the
  `risk_changed`, `task_status_changed`, and `sprint_scope_changed` extension-point
  signals are now dispatched with `send_robust`, so a raising Enterprise receiver
  can no longer break the OSS save path that emits them.
Team members without admin access now see a focused **Notifications + Profile** settings view instead of the workspace/project admin pages (Methodology, Workflow, Roles, Groups). Gated on a new `can_access_admin_settings` signal from `/auth/me/` (#856, ADR-0122).
- **Backlog-to-timeline drop dialog now speaks sprint language**: dragging a backlog idea onto the schedule (or using its keyboard "···" action) now shows a dialog worded in sprint/milestone terms — "Add to a sprint", "Target date" — instead of CPM/scheduling vocabulary like "Planned start". The success toast and screen-reader announcements match ("Added '{name}' to the sprint, starting {date}"). Behavior is unchanged; this is a vocabulary translation layer for product owners who don't think in CPM terms.
Capacity preflight now surfaces team points load against the sprint's points ceiling — a header chip (`{committed}/{capacity} pts · {pct}%`, red when over) and a plain-English footer ("Team is at 75% of capacity. 6 pts free."), alongside the existing per-person hours view (#864).
- **Project start auto-shifts to fit an earlier task** (#867): scheduling a task (drag, typed date, create, bulk, or sync) with a `planned_start` before the project's `start_date` now pulls the project start back to that date in the same transaction, instead of rejecting the edit. The CPM "no task starts before the project start" invariant is unchanged — the boundary just follows the work. The shift rides task-write permission (Team Member+), not the Admin-gated project-start edit, since the project start is treated as a derived artifact of its tasks. Collaborators receive a `project_updated` board event alongside the task change. Moving a project start *later* remains a deliberate Project edit.
- **Unified task Activity timeline (#869, ADR-0096 Part 2)**: the task-detail drawer's split "History" and "Activity" sections are replaced by a single chronological **Activity** timeline that merges field changes and comments newest-first. A field-group filter (Dates · Progress · Status · Assignment · Estimates · Description · Comments) and a per-person filter let you slice to just the changes you care about; multi-field edits collapse behind an expand control while single-field changes show their before→after inline. Comments appear as read-only "commented" events (the Comments section still owns the discussion thread), and a change record with nothing user-visible to show is omitted rather than rendering a bare "Updated" row.
- **Promote-to-milestone dialog now reads live data and lets you name the milestone**
  (the agile/waterfall bridge, DA-02): the dialog's reforecast preview and milestone
  picker were swapped from in-app stubs to the live bridge endpoints, so the projected
  CPM-finish range and the list of bindable milestones now reflect real project data.
  Create mode is now editable — the new milestone's **name** and **target date** are
  prefilled (from the sprint goal and finish date) but can be changed before binding,
  instead of being a fixed read-only preview.
- **Scheduler input-validation legibility**: a malformed `dep_type` or
  `delivery_mode` passed to `Dependency.from_dict` / `Task.from_dict` now raises
  `InvalidScheduleInput` naming the field and listing the allowed values
  (e.g. `Invalid dependency type 'XX'; must be one of: FS, FF, SS, SF.`) instead
  of a bare Python enum `ValueError`. First-run error quality for the standalone
  `trueppm-scheduler` package.
- **Sidebar cleanup — scoped program picker**: The left sidebar replaces the two flat Programs/Projects lists with a searchable program **scope picker** that narrows the project list. In the "All programs" scope projects are grouped under collapsible program headers; scoping to one program shows a flat list. Each project is now a single line with a status dot (hollow when health is unknown) instead of three lines (name → "Unknown" → "Program · X"). An in-scope **search box** filters projects within the current scope. My Work stays pinned at the top and Resources/Settings at the bottom (#959).
Redesigned the task detail drawer into four tabs — Details, Subtasks, Activity, and Files — with an editable task-name header, a schedule strip with a critical-path banner, and a per-tab subtask count. Most fields still save instantly; the free-text description now edits locally behind a save bar (flushing on blur, tab-switch, or close) so a half-typed note is never committed by accident. Drawer sections remain a registry extension point so Enterprise can add its own tabs and sections.
External links on a task now accept a URL without an explicit scheme (e.g. `github.com/acme/api`); `https://` is assumed instead of rejecting the input (#970).
The Monte Carlo detail panel and row now render the server's `cpm_finish`, `delta_vs_cpm`, and `confidence_curve` instead of recomputing the percentile-vs-CPM deltas and the cumulative finish-by-date curve in the browser; the schedule view reads the server's project CPM finish rather than scanning task dates (#987, API-first #986).
Sprint health badges now render the server's sprint-health signals (`GET /projects/{id}/sprint-health/`) verbatim instead of re-deriving orphan, phase-span, and parent-task counts from WBS paths in the browser. The count, the show/hide verdict, the tone, and the user-facing copy are now server-owned, so headless and MCP clients get identical guidance.
The resource utilization grid now renders the server's per-day `load_pct`, `load_band`, and `overallocated` verdict instead of re-deriving load percentage, the on-track/at-risk/critical band, and the overallocation flag from raw hours in the browser, so a headless/MCP client reads the same load verdict (#989, API-first #986).
Board cards now render the server-owned per-task `spi` and `spi_band` instead of re-deriving the Schedule Performance Index from baseline dates in the browser; the verdict band is now identical wherever it renders (#990, API-first #986).
Board phase lanes now show the phase summary task's server-owned, delivery-mode-weighted `percent_complete` rollup (ADR-0108) instead of a divergent client-side mean of committed leaf tasks — the lane progress now matches the same phase's progress in the Gantt (#991, ADR-0115, API-first #986).
Board cards now render the server-owned `is_stalled` verdict and `dwell_days` for the entry-stamp instead of re-deriving the stalled policy from `status_changed_at` in the browser (#992, API-first #986).
Clarified the OSS/Enterprise boundary: the OSS unit is the **program** (a PM or program manager coordinating one or more related projects); the Enterprise unit is the **portfolio** (coordination across multiple programs under organizational governance). Updated CLAUDE.md, README, overview, architecture, guides, feature docs, and the `enterprise-check` skill to reflect this consistently.
Adopted the TruePPM Brand v1.0 identity across the web app (Design System v2.0, ADR-0103): the True Navy / Truth Sage palette, the duotone dependency-arrow logo and two-color wordmark, and Space Grotesk as the display typeface. All surfaces re-themed from the previous green palette with WCAG 2.1 AA preserved; dark mode reverses navy ink to pale while sage holds.
- **Gantt › Monte Carlo row**: the P50/P80/P95 date chips and a mini histogram strip are now permanently visible below the Gantt instead of appearing only on hover. The strip colours histogram bars by percentile region (green ≤ P50, amber P50–P80, red > P80). Hovering or focusing the strip still opens the detailed histogram tooltip.
- **Gantt › AssigneeChips**: initials font size raised from 10 px to 12 px (`text-xs`) to comply with the design system minimum and WCAG 1.4.3.
Import dialogs, dropzone, and format picker now use the semantic `rounded-card` (12px) radius token instead of the legacy `rounded-lg`, aligning the import component family with the Design System v2 foundation.
- **Schedule "+ Milestone" now opens a real create dialog**: clicking + Milestone (or pressing ⌘M) opens the unified task-create form in milestone mode so the user can pick name, date, and parent up front. Previously the row was inserted immediately at today's date with the placeholder name "New milestone" and the user had no way to set the date short of opening the drawer afterwards. Replaces the inline insert-then-edit-name path from issue #240's first cut.
- The `regression-check` skill (`.claude/skills/regression-check/SKILL.md`) now runs on Opus instead of Sonnet. Pre-merge regression audits are cross-cutting and benefit from the deeper reasoning model — particularly when reasoning about stale mocks, permission gates, and contract boundaries that span multiple touched files at once.
The published `trueppm-scheduler` package description and module docstring no longer claim "resource-leveling". The engine performs critical-path method (CPM) scheduling — all four dependency types, calendar-aware lag, cycle detection, summary-task expansion — and Monte Carlo schedule-risk analysis (P50/P80/P95), but it does not level resources. The PyPI metadata and the scheduler feature docs now describe the actual scope, and the CPM output reference documents the `free_float` field (computed across finish-to-start successors today).
Improve `seed_demo_project` demo data to tell a complete, realistic project story: COMPLETE phases (Discovery + Build) with `percent_complete=100`, overdue IN_PROGRESS tasks (Pilot data sync at 60% past its due date), Dan Ortiz over-allocated at 150% across two parallel Migration tasks, baseline variance showing original vs. current dates (up to 26-day slip visible on Gantt), correct FS dependency network (including parallel Pilot + Comms tracks), software-domain sprint stories replacing hardware placeholders, and updated retro notes/action items to match the migration narrative.
Settings (Workspace / Program / Project): every not-yet-wired control now carries an honest callout linking the issue that tracks it — the project & program lead/manager pickers (#966), the project & program lifecycle actions Transfer ownership / Export / Transfer sponsorship / Split program (#967), the project calendar override picker (#968), and the remaining workspace actions logo upload / holiday calendar / member CSV export / resend invite (#969, re-pointed from the now-closed #791). Disabled lifecycle placeholders now use the accessible stub treatment (rule 122) instead of low-contrast dimming.
Tighten `ux-review`, `perf-check`, `security-review`, `broadcast-check`, and `docs-writer` skills with regression-class checks ported from a downstream pre-release audit: focus-visible vs focus gate, sub-12px text gate, raw color-shade gate, count-bearing button aria-label, hover-reveal focus-reveal rule, admin-hidden-not-disabled rule, `.count()`/`.order_by()` prefetch-bypass, computed-field annotation-fallback, ORM-in-on_commit-closure rule, per-recipient WS field-leak rule, post-revocation data retention rule, dotted event-name contract + uid-only deletion-payload contract, and a behavior-drift narrative-prose sweep on doc updates.
- **Project navigation tab order**: Overview is now the first (leftmost) tab when opening a project, aligning with ADR-0030's specified default landing surface. Board moves to second. The mobile bottom nav mirrors this order and now includes Overview (replacing Risks, which remains accessible on desktop).
- The web container image now runs as a non-root user and listens on port 8080 (previously root on port 80), hardening the published image. The bundled `docker-compose.prod.yml` is updated transparently; if you run `ghcr.io/trueppm/web` standalone, map to container port 8080.

### Fixed
- **Gantt scroll performance**: the dependency-arrow layer no longer rebuilds its full task-and-link routing structures on every scroll frame. Arrow geometry, redundant-edge suppression, and merge grouping are now computed once per data/zoom change (cached as a `DependencyLayout`) and only re-projected by the current scroll offset while panning; obstacle and halo lookups use a row-banded spatial index instead of scanning every task. Scroll on large dependency-dense schedules (1k+ tasks) holds frame rate where it previously dropped frames.
- **Bound-milestone forecasts now refresh live for collaborators (#1007)**: when a sprint close reforecasts its bound milestone (ADR-0106), the web client handles the `milestone_forecast_updated` broadcast and refreshes the project delivery forecast, milestone list, and any open promote dialog — so a teammate viewing the forecast on another tab sees the new P50/P80 range without reloading.
- **Scheduler non-finite input on the `from_dict` path**: `Task.from_dict` and
  `Project.from_dict` now reject non-finite `story_points` / `velocity_samples`
  at parse time, matching `from_json` — previously an infinite value slipped
  through and only surfaced as a bare `OverflowError` deep in the velocity
  sampler. The public `monte_carlo` docstring now documents the per-run sprint
  horizon clamp (velocity-driven P95 is a loose lower bound for extreme-variance
  teams), and `schedule()` documents that recurring-task exclusion is the
  caller's responsibility (the engine schedules every task it is given).
- **OpenAPI schema accuracy (MCP-readiness)**: async endpoints (sprint close, schedule recalculation, MS Project import) now correctly document their `202 Accepted` responses instead of `200`; sprint activate documents its `409` conflict and promote-to-milestone its `201`/`409` outcomes; every viewset action now carries an explicit summary and response so generated clients and the OpenAPI schema no longer show degraded operation names. Project-scoped API tokens (`Authorization: Bearer tppm_…`) are now advertised as their own `projectApiTokenAuth` security scheme rather than incorrectly inheriting JWT auth.
- **OpenAPI schema version**: the published schema's `info.version` reported `0.2.0` on the 0.3 API; it now reports the correct release version, and `scripts/release.sh` keeps it in lockstep on every future release so generated clients and API docs no longer show a stale version.
Accessibility fixes for keyboard and screen-reader users across the task drawer, notification panel, board, and sidebar: the TaskDetailDrawer and NotificationPanel tablists now implement the full WAI-ARIA tab pattern (tab `aria-controls`, a `role="tabpanel"` body labelled by its tab, and ArrowLeft/Right navigation on the drawer tabs); the NotificationPanel moves focus to its first control on open (WCAG 2.4.3); the Schedule grid announces that Enter reschedules the focused task and arrow keys navigate rows (WCAG 4.1.3); board column headers include the WIP-limit state (at/over limit) in their accessible name; and the grouped "All programs" sidebar list is wrapped in a `Program groups` nav landmark so assistive tech can jump between groups without tabbing through every project.
Accessibility and design-system sweep across the schedule, sprint, board, and program-backlog surfaces: raised sub-floor font sizes to the legible minimum (rule 50), gave the velocity chart a non-color health signal in each bar title (WCAG 1.4.1), switched disabled buttons to the explicit neutral recipe instead of `opacity-50` (rule 122), surfaced hover-reveal drag handles and destructive-button focus rings on keyboard focus (WCAG 2.4.7), fixed Monte Carlo marker tints to use the pre-computed dark-mode `-bg` tokens (rule 8b), and flipped Gantt in-bar label text to near-black ink on the light 400-stop dark-mode bar fills (WCAG 1.4.3).
Fixed a dark-mode contrast failure on the Schedule surface: ad-hoc `bg-brand-primary text-white` controls rendered white-on-sage-400 (≈ 1.8:1, WCAG 1.4.3 fail) on the dark schedule canvas. Standalone action buttons (commit popover, comment/link/subtask composers, build-mode prompts) now use the shared `Button` component (rule 144); toggle pills, the date-drop indicator, the owner avatar, and inline-aligned buttons use the canonical sage-500/navy-900 fill (navy-on-sage ≈ 6.8:1 in both modes). Also corrected stale web design-rule 137, which still mandated the retired `dark:focus-visible:ring-semantic-on-track` override and cited the pre-rebrand green's 2.81:1 figure — `brand-primary` is now mode-aware sage and passes WCAG 1.4.11 unaided (rules 4/46, ADR-0103).
Viewers no longer see add/edit/delete controls for links and attachments, or an editable description, in the task drawer — controls that previously appeared and then failed with a 403 on submit. The drawer now threads the viewer's project role into each section (#1046, ADR-0050 amendment).
The demo on-ramp now keeps an evaluator oriented after loading a sample. The Schedule view shows a non-blocking "recalculating" badge while a freshly-imported sample's first CPM pass is still pending, so dashed/uncomputed dates read as "processing" rather than "broken." A compact "Demo project — part of [program]" indicator now appears on every project-level view of a sample program (not just the program overview), so the cue survives navigation into the Schedule, Board, and Sprints. And the "remove sample data" confirmation now states plainly that it removes the whole demo program including any changes you made, while your own projects are unaffected.
Monte Carlo now agrees with the deterministic CPM schedule on zero-duration milestones: FS successors of a milestone no longer start a working day early, lag conversion anchors on the milestone's actual day, and a terminal milestone's completion date is no longer reported one day early. Seeded P50/P80/P95 values shift on schedules containing milestones (correctness fix).
Monte Carlo's working-day index now covers velocity-sampled scrum durations (#411); completion dates for scrum tasks were previously clamped to an index sized from the placeholder duration and could be reported months early. Oversized `story_points` (relative to team velocity) are now rejected eagerly by the project-span guard instead of amplifying memory in the sampler.
Monte Carlo now honors `planned_start` (start-no-earlier-than) with the same floor the deterministic pass applies; previously a pinned task's simulated distribution could predate the deterministic early finish by months. A `planned_start` beyond the project-span cap is now rejected with `InvalidScheduleInput`.
Complete three-point (PERT) estimates are now validated for ordering (`optimistic <= most_likely <= pessimistic`); an inconsistent estimate previously made every Monte Carlo run sample the constant `most_likely` — potentially beyond the stated pessimistic bound — with no error.
Scheduler input robustness: non-finite `story_points` / `velocity_samples` are rejected with `InvalidScheduleInput` instead of crashing in the velocity sampler; a summary task with an empty children list is rejected at expansion with a clear message instead of a dangling-edge "unknown task" error; the CLI `monte-carlo` command no longer trips the library's 500-task cap it cannot raise.
Sprint velocity and delivery-forecast views now update live for every collaborator when a sprint is excluded from velocity — previously only the user who made the change saw the recompute until a manual refresh.
The closed-sprint "Rolled over" headline now reflects the true carried-disposition point sum (the same source the "what didn't ship" list uses) instead of a `committed − completed` proxy that contradicted the list when scope was injected mid-sprint. Dropped tasks are scope removal, not rollover, and no longer inflate the figure (#1097).
Stopped real-time project board broadcasts from logging an ASGI `RuntimeError` when a client disconnected or refreshed while an event was in flight. The stale event is now dropped silently (clients already reconcile via the sync delta on reconnect).
Daily delta panel — explicit error and freshness states (#1128): a failed load now shows a clear "Couldn't load the delta" message with a Retry button instead of a blank panel, and a "Last updated HH:MM" line distinguishes a quiet "nothing changed" window from stale or failed data.
- **Gantt dependency arrows now divert around milestone diamonds**: a dependency line whose vertical drop column fell on a milestone diamond in an intervening row previously drew straight through the diamond. The router now treats the diamond as an obstacle on the drop column and right-sweeps the column past its edge (or routes through the row gutter when no clear column fits), so the arrow skirts the milestone instead of piercing it.
- **Monte Carlo ignored planned-start floors**: the probabilistic forecast
  dropped each task's `planned_start` when building its simulation input, so
  tasks floated back to the project start date and the P50/P80/P95 forecast
  could finish *before* the deterministic CPM date — an impossible result. The
  simulation now honors `planned_start` as a start-no-earlier-than floor,
  matching the deterministic CPM pass.
- **scheduler: Monte Carlo lag-delta build vectorized** (#1205): the per-`(dependency-type, lag)` delta precompute ran an `index_size`-long pure-Python loop of calendar snaps, so a project with many distinct lag values could tie up the synchronous Monte Carlo request path for ~30 s. It is now a single vectorized `searchsorted` (byte-for-byte equivalent, verified against the scalar reference and the CPM↔Monte-Carlo parity fuzzer), cutting the worst case roughly 7×.
- **scheduler: calendar exception lookup is now O(log E)** (#1206): `Calendar.is_working_day` scanned every exception range linearly on each of the (potentially hundreds of thousands of) days a schedule walks, so a calendar with a few thousand exceptions could stall a `schedule()`/`monte_carlo()` request for minutes. Exceptions are now looked up via a cached merged-interval bisect, and the engine rejects a calendar with more than 100,000 exception ranges up front.
- **scheduler: summary-dependency expansion is bounded** (#1208): `expand_summary_dependencies` materialized the full leaf cross product of a summary→summary dependency with no cap (unlike the cycle-check path, which was already guarded), so a single wide edge could produce millions of `Dependency` objects. It now applies the same `MAX_EXPANDED_EDGES` pre-check and caches leaf resolution per node.
The Schedule view's Monte Carlo forecast is now a single consolidated bar instead of two surfaces that disagreed. Previously the top "σ Monte Carlo" row and the bottom "Forecast & sensitivity" panel rendered the P50/P80/P95 dates one calendar day apart (a local-timezone formatting bug) and listed the percentiles twice; the shell health header also showed "P80 —". All forecast dates are now formatted in UTC to match the server, the percentiles appear once, the header falls back to the live forecast's P80, and the Rerun, Details, run-history, and maximize/minimize controls live in one bar.
- **Sprint burndown sparkline alignment**: the solid "actual remaining" line and
  the dashed "ideal" line in the sprint board header burndown were drawn on
  different scales — the actual line back-filled un-snapshotted (future) days
  with the full committed value, flat-lining at the top while the ideal declined
  to zero, so the two never met at the sprint-end/zero corner. The actual line now
  ends at the last real snapshot instead of riding flat to the corner, and the
  ideal-line slope and the "ahead/behind of ideal" trend number share a single
  source of truth so they can no longer disagree by an off-by-one. Both lines
  now sit on one coordinate system: day-0 anchored at the committed value, day-N
  at zero.
- **Calendar change now recalculates the schedule**: changing a project's working calendar previously left every task's dates and floats computed against the old calendar until some unrelated edit forced a recompute. Because CPM lag is calendar-aware, a calendar swap is a scheduling input change — it now enqueues a full CPM recalculation (tagged with the new `calendar_change` reason) on commit, exactly like a dependency edit.
Code-review fixes for MR !127: narrowed broker-failure catches in dispatch paths (no more silent `Exception` swallowing), replaced hex literals in the board progress ring with design-token strokes, promoted all sub-12px Board text to `text-xs` (rule 50), made the drag placeholder match the source card height (rule 102), rebuilt the Gantt focus-chain traversal with O(V+E) adjacency maps, subscribed `MonteCarloTimeline` to `prefers-reduced-motion` via `useSyncExternalStore`, and moved the outbox trigger tests onto `django_capture_on_commit_callbacks` so the new `transaction.on_commit` deferral is exercised end-to-end.
Sprint-assigned tasks with no planned start date now position in their sprint window on the schedule, instead of collapsing onto the project start date. Agile-planned stories in a hybrid project no longer pile up at the project origin (ADR-0168).
- **Iteration label now respected across the sprint surfaces (#1287)**: user-facing copy that previously hard-coded "sprint" — the exclude-from-velocity toggle, forecast chips, sprint-review outcome, scope-change drawer, carryover card, daily delta, team-health pulse, board accept/reject actions, standup empty states, schedule promote toasts/dialog, backlog commitment chips, and the decisions "current sprint" filter — now reads the project's configured iteration designation (Sprint/Iteration/PI/Cycle/custom, ADR-0111). Projects on the default label see no change; renamed projects no longer leak "sprint" into these views.
Fixed the retrospective "promoted task" chip, which linked to a dead in-page anchor; it now opens the promoted backlog task in the Schedule view.
- **Burn chart tooltip no longer reports 0 (#1304)**: hovering the Reports burn chart (and the sprint burndown) showed `Remaining 0 tasks · Ideal 0 tasks · 0 ahead` for every point regardless of the data, because the tooltip read the Recharts payload array as if it were the data point. It now reads the plotted row correctly, so Remaining / Ideal / Completed and the ahead/behind delta reflect the real values in every mode (burn down, burn up, combined; tasks and story points).
Wrapped multi-write and cascade delete paths (resource roster delete, acceptance-criterion creation, baseline creation, sprint bulk scope-change, resource soft-delete fan-out, notification-preference presets) in atomic transactions so a partial failure or concurrent request can no longer leave the database in an inconsistent state.
Eliminated N+1 query patterns on several hot list and board endpoints (sprint list, cross-project slip conflicts, task retrieve, notifications, webhooks, workshop sessions, retrospective boards) by adding the missing `select_related`/`prefetch_related` joins and batching previously per-row lookups.
Real-time collaboration now propagates several board/project changes that previously left connected peers stale until a manual refresh: cross-project dependency accept/reject, task-suggestion decline/revoke (a silent state reconciliation that never exposes who declined), task duration changes, and cross-project slip-conflict acknowledgements. The WebSocket board-event envelope also gained a `protocol_version` field so future clients can negotiate the wire format without a breaking change.
The unified **Today** view is now reachable on mobile — it was present in the desktop view tabs but missing from the bottom navigation rail, leaving the 0.3 headline view unreachable on phone-sized screens.
- **Design-system token drift**: removed the retired `dark:*:ring-semantic-on-track` focus-ring override everywhere (`brand-primary` is now mode-aware and passes WCAG 1.4.11 in both themes, so the dark-mode escape hatch is no longer needed), raised the remaining flagged sub-12px text (`text-[9px]` / `text-[10px]`) to the 12px floor, switched static semantic fills from the opacity modifier (`bg-semantic-{state}/N`) to the dark-mode-correct `-bg` tokens, and collapsed the `dark:text-brand-primary` reversals on the board to the mode-aware token.
- **OpenAPI schema accuracy for integrators**: the published API schema (`docs/api/openapi.json`) now declares a `servers` array (so `openapi-typescript` / Orval / `openapi-generator` emit clients with a base URL), documents the `201` response and request body of `POST /projects/{id}/task-sync/`, declares the `?since=` query parameter on the offline-sync pull endpoint, and declares the `start` / `end` / `resource` / `status` filter parameters on `GET /programs/{id}/resource-contention/`. Also corrects the webhook docs (the OSS event cap is 14, not 11 — the `sprint.activated` / `sprint.closed` / `sprint.scope_changed` trio) and the WebSocket reference URLs (they are `ws/v1/projects/{id}/`).
Corrected a documentation version-tense inaccuracy: the retrospective promotion section no longer describes an unshipped 0.3 behavior change in the past tense, and the workspace member-export note is phrased as forward-looking ("ships in 0.3").
Restored the sidebar link to the Programs gateway (`/programs`), which the v2 rail rewrite had dropped. Without it there was no in-app path to the Programs page or to the "Load demo data" on-ramp.
Iteration backlog tasks are now editable. Tasks listed in the Iterations view's "Iteration Backlog" panel rendered as static rows with no way to open them, so a task could be seen but never edited from this surface. Each task name is now an accessible "Open …" button that opens the shared task detail drawer — the same editor the Board and Schedule use — for both the active and the planned iteration's backlog.
- **Monte Carlo now explains a flat forecast instead of always blaming missing estimates**: when a simulation collapses to a single date (P50 = P80 = P95), the result carries a `forecast_diagnostic` diagnostic and the schedule view shows the *actual* reason — three-point estimates awaiting approval, agile work with no closed-sprint velocity yet, estimated work that sits off the critical path, all work complete, or genuinely missing estimates. Previously every flat forecast told the user to "add PERT estimates", which was misleading on projects that already had them (e.g. estimates withheld pending approval in Suggest & Approve mode).
Epics on the Product Backlog can now be edited (#1346): clicking an epic's name opens a detail drawer — the same side panel a story opens into — to edit the epic's **name** and **description**, with edits batched behind a Save bar. Previously an epic could only be renamed through a hidden "⋯" menu and its description could not be edited at all. The rename moves into the drawer; **Delete** stays on the actions menu. Editing requires the Product Owner facet or Admin and above (the same gate as before); a viewer still sees a read-only header.
- **Sprint planning → backlog handoff**: the Sprints view now bridges to the Product Backlog when planning. A planned sprint's backlog section gains a **Pull from backlog →** link (and an explanatory empty-state call-to-action), so committing *existing* stories to the sprint is discoverable from where planning starts — previously the only "add" affordance there created a brand-new task, leaving no path to the per-story commit toggle that already lives on the Product Backlog.
Hardened residual API performance ahead of 0.3: the MS Project import-history list now batch-loads its linked task runs in a single query instead of one per row, and added database indexes so backlog tag filtering, the risk register, and sprint finish-date sorting no longer fall back to a sequential scan or an in-memory sort.
- **Self-host install no longer crash-loops on a fresh config.** The documented install artifacts now satisfy production's import-time boot guards instead of walking operators into them:
  - `.env.example` flags `INTEGRATION_ENCRYPTION_KEY` and the attachment-storage choice as **REQUIRED — production refuses to boot without them**, replacing the stale note that implied the key only mattered on first integration use.
  - The Helm chart now actually renders the `envFrom:` secret-injection pattern its README documented — on the API, Celery worker, **and** the migrate/bootstrap init containers (which import the same settings and would fail first). Previously `envFrom` guidance was silently non-functional, so injected secrets never reached the pods.
  - `administration/configuration` documents `INTEGRATION_ENCRYPTION_KEY` and the storage choice under **Required in production** with the boot-refusal behavior.
- **Keyboard and screen-reader access to backlog and sprint dialogs**: the epic
  and story detail drawers, the Plan/Close-sprint and scope-change dialogs, the
  Monte Carlo result panel, and the board settings panel are now reachable and
  operable without a mouse. Drawers trap focus and announce themselves as modal
  on mobile (where they cover the screen) while staying non-modal on desktop; the
  unsaved-changes guard on the epic/story drawers is now the focus-trapped
  "Discard unsaved changes?" dialog instead of the browser's native `confirm`,
  so it is announced and dismissable with the keyboard. Retro and sprint-header
  controls now meet the 44px minimum touch-target size.
- **Board column "at limit" warning was never shown**: a column sitting exactly
  at its WIP limit (not yet over it) showed no warning on the drop zone or the
  mobile column header, because two inline `count > limit` checks bypassed the
  shared `wipState()` helper and only handled the over-limit case. Both now route
  through `wipState()`, so the at-limit band surfaces consistently everywhere the
  desktop column header already showed it.
- **Off-token identity colors and undersized status text**: role and methodology
  accent chips and group-avatar swatches in workspace settings used raw
  arbitrary-value Tailwind color classes that scattered the same hue across files
  and tripped the design-system arbitrary-color gate; they now draw from a
  single-sourced `identityColors` palette applied via inline style. A handful of
  `text-[10px]`/`text-[11px]` status labels and a disabled-grey helper line were
  bumped to the nearest readable token.
Several real-time collaboration gaps where a write changed shared state but connected clients were not notified, so peers' views silently desynced until a manual refresh:

- **Roster changes** now always broadcast. Removing a resource from a project roster with no task assignments — the most common case — previously emitted nothing, and editing an allocation/notes row (`PATCH`) was also silent. Soft-deleting or restoring a resource from the org catalog now fans a roster update out to every project the resource is assigned to.
- **Sprint retrospectives** broadcast when notes/action items are upserted or the visibility gate is toggled, so a teammate with the retro open sees the change live.
- **MS Project imports** signal the restructured task tree immediately on commit, instead of leaving an empty-looking list until the asynchronous schedule recalculation eventually lands.
- **Cross-project slip conflicts** broadcast when a program schedule pass opens or auto-resolves one, so the downstream project's slip badge updates without polling.
- **OpenAPI accuracy for three computed endpoints**: the published schema now types the JSON returned by the latest Monte Carlo forecast (`GET /api/v1/projects/{id}/monte-carlo/latest/`), the program KPI rollup (`GET /api/v1/programs/{id}/rollup/`), and within-program resource contention (`GET /api/v1/programs/{id}/resource-contention/`). Previously these documented an empty/untyped response, so a client generated from the schema received no model for them; each now carries a typed object response and a description of its keys.
Suggested-assignee actions (accept, decline, revoke) now re-check the caller's project membership at request time. A user who was named on a suggestion but has since lost membership of the project can no longer accept, decline, or revoke it — the suggestion row's reference is no longer treated as authorization on its own.
Tightened two API permission gates to the declarative DRF layer: the resource catalog's `?include_deleted=true` query parameter is now honored only for org admins (a non-admin passing it gets the deactivated resource pool filtered out as before, closing an enumeration gap), and the MS Project import endpoint now declares its Project Admin requirement as a permission class rather than enforcing it only in the request body.
- **Grooming board query performance**: the Product Backlog (grooming board) endpoint no longer fires one extra query per blocked story or per satisfied Definition-of-Ready criterion. The backlog queryset now `select_related`s the `blocked_by` actor and the soft `blocking_task` link, and prefetches acceptance criteria with their `met_by` reviewer, so the query count stays constant regardless of backlog size instead of scaling with the number of blocked stories and met criteria.
Fixed the warning badge text/border color failing WCAG 1.4.3 contrast. The shared `--semantic-warning` token was the brand amber `#D97706` (~2.74:1 as text on the warning-bg tint); it is now yellow-800 `#854D0E` (≥5.4:1), so every warning badge — sprint retro, team-health pulse, product backlog, the "Refine" DoR badge, and Git automation — inherits AA contrast from a single source.
Added missing test coverage for the durable execution hardening shipped in !127: webhook `test_ping` broker-failure handling (view now wraps `.delay()` in try/except matching `dispatch.py`), `dispatch_webhooks` broker-down swallowing, `deliver_webhook.reject_on_worker_lost` attribute, and `trigger_schedule` on-commit deferral.
- **Active tab preserved on project switch**: switching to a different project in the sidebar now keeps the current view active (e.g. switching projects while on Calendar lands on Calendar for the new project, not Overview).
- **WBS backfill ordering**: the migration that assigns sequential `wbs_path`
  values to tasks created before WBS auto-assignment ordered tasks by primary
  key, but task primary keys are UUIDs (random), so the assigned numbers were
  in non-deterministic order. Switched the migration to order by `short_id`
  (project-scoped, monotonic per insertion), making the backfill deterministic
  and aligned with creation order.
Assigning a resource to a task now automatically adds them to the project roster (`ProjectResource`), so they appear in Team → Roster, Allocation, and Heatmap without a separate manual step.
- **Run scheduler button now triggers a recalculation**: the `Run scheduler` button on the Allocation timeline unscheduled-assignments banner and the Heatmap 409 empty state now POSTs to `/projects/{id}/schedule/` and refreshes the affected views. Previously wired but untested; the new vitest coverage prevents regression on the invalidated query keys (#242).
"Run scheduler" button in the Allocation timeline and Heatmap views now triggers a real CPM recalculation and refreshes the view automatically.
Table view rows no longer blank: the virtualizer's scroll container is now co-located with `useVirtualizer` inside `VirtualRows`, matching the working pattern used by the Schedule view's task list panel.
Fix BottomNav to use path-based routing instead of query params (closes #250); use `bg-chrome-surface` on TopBar and BottomNav shell chrome (closes #251); add Playwright E2E coverage for TopBar health badges and BottomNav routing (closes #252).
**Monte Carlo endpoint no longer returns 500 for malformed `n_simulations`.** A bare `int(request.data.get("n_simulations", ...))` upstream of the existing error handler raised `ValueError`/`TypeError` on non-integer or null payloads, surfacing as an unhandled 500. The cast is now wrapped and returns `400` with a clear message; non-positive values are also rejected.
Schedule: Monte Carlo result panel now shows real simulation data fetched from `GET /projects/{id}/monte-carlo/latest/` instead of a fixture. A 404 (no simulation has been run yet) renders as an inline "Run Monte Carlo" empty state — both in the Schedule footer strip and the mobile card — replacing the prior behavior of hiding the row entirely. Also fixes `MonteCarloRow` not receiving `projectId` from `ScheduleView`, which after the hook rewire would have left the desktop row blank even when results existed.
- **Workshop reconnect**: participants who rejoined a session remained visible as offline because the existing `WorkshopParticipant` row's `left_at` was not cleared on reconnect (closes #258); workshop participant events (joined/left) now invalidate the session query cache so the banner updates without a page reload (closes #259); fixed a `mountedRef` race in `useProjectWebSocket` that silently dropped the reconnect after a `projectId` or token change (closes #260).
Risk register: New Risk drawer now renders as a 480px right-side panel alongside the risk table on desktop, instead of stacking below the page content. Mobile bottom-sheet behavior is unchanged.
- Post-login destination prefers Overview (ADR-0030 canonical landing). The Login page now rewrites a captured `next=/projects/{id}/board` parameter to `/projects/{id}/overview` before navigating, so users who log out from a project's board return to its Overview instead. Other deep links (risks, schedule, sprints, resources, etc.) pass through untouched so shared URLs still work after a re-auth.
- Phase rollup bars and dependency arrows now render on the Schedule view even when the phase row itself has no `planned_start` set. The original #332 commitment gate was applied too broadly to summary tasks (which are containers — PMs never set `planned_start` on phases) and to dependency arrows anchored on summaries, hiding the rollup span and silently dropping arrows pointing to or from a phase. The leaf-task gate from #332 still suppresses bars for uncommitted backlog tasks; only the summary case is exempt.
Fix successor cascade not propagating after a dependency edit (closes #314). The Celery app was never set as Django's default because `trueppm_api/__init__.py` was missing the standard `from .celery import app as celery_app` integration line — every `shared_task.delay()` resolved to an unconfigured default Celery instance and raised `OperationalError: Connection refused`, which `enqueue_recalculate` swallowed as a `logger.warning`. The outbox row was silently left PENDING and CPM never ran, so summary tasks showed no rolled-up bars and dependency edits did not move successors. The drain task that should have caught it was also offline because `celery-beat` was crash-looping on a `celerybeat-schedule` permission error in dev. This change wires the Celery app at startup, makes `enqueue_recalculate` adopt a stranded pending row (instead of silently swallowing every subsequent edit), escalates the dispatch-failure log to `logger.exception` so a future broker outage is visible, points `celery-beat` at a writable schedule path, and fixes a malformed `task-runs-purge-nightly` schedule entry that crashed beat after the permission fix. On the web side: leaf tasks now use `early_finish` (working-day-correct CPM result) for their bar's right edge instead of re-deriving with calendar-day arithmetic — that mismatch made summary roll-ups visibly extend past their widest child by one day per weekend. Regression tests cover the Celery wiring (current_app must be the configured trueppm app with a real broker_url), the adopt-pending behavior, and the leaf/summary finish parity.
**Schedule view — Unscheduled gutter only shows actually-scheduling work** (#317): the gutter now lists only `NOT_STARTED` tasks that are not in a sprint and have no PM-committed `planned_start`. BACKLOG ideas stay on the Board until promoted, sprint-committed tasks are treated as already scheduled, and CPM-computed `early_start` no longer hides cards from the gutter — a card promoted from BACKLOG to To Do remains visible until the PM commits a date. `IN_PROGRESS` / `REVIEW` / `COMPLETE` tasks without a committed start surface a `⚠ missing dates` chip on the task list row so data-integrity issues are not silently hidden.
Fix every Celery Beat-scheduled drain and purge task being silently dropped (closes #319). Each `CELERY_BEAT_SCHEDULE` entry references its target by short name (e.g. `scheduling.drain_schedule_queue`), but the corresponding `@idempotent_task` decorators did not pass `name=`, so Celery registered the tasks under their fully-qualified module paths and the worker rejected every Beat-fired message as `Received unregistered task`. As a result the outbox-drain safety net for the scheduling, webhooks, MSProject import, and sprint-close flows had not been firing at all — stranded `pending` rows could only be recovered by the immediate-dispatch path, which is exactly the path #314 had broken. This change adds `name=` to all eight affected decorators (`drain_schedule_queue`, `purge_old_schedule_requests`, `drain_webhook_queue`, `drain_import_queue`, `purge_old_import_requests`, `drain_sprint_close_requests`, `update_sprint_burndown_snapshots`, `purge_sprint_close_requests`) and adds a regression test that asserts every `CELERY_BEAT_SCHEDULE` entry resolves to a registered task in `celery_app.tasks` — adding a future Beat entry without a matching `name=` will fail the test rather than producing another silent-failure incident.
Backlog cards no longer display as scheduled. CPM auto-fills `early_start` for every dated task, which caused board cards in the BACKLOG column to render with a CP pill, "0d float" chip, and a Gantt bar — and the Schedule view's Unscheduled tray to claim "All tasks have planned dates" while still painting bars for them. Display gates now read `plannedStart` (or sprint membership) rather than CPM-derived dates: board CP/float chips, phase rollups, the CP-only filter, Gantt bar/summary/milestone rendering, and dependency arrows all suppress uncommitted work, and the Unscheduled tray now surfaces both NOT_STARTED and BACKLOG tasks without a committed date.
Monte Carlo: unify the data path between Project Overview and Schedule view (single hook + cache key — Overview no longer has its own parallel `useMonteCarloLatest`), and surface a persistent **Rerun forecast** button alongside a "Last run: 2h ago" freshness signal on both surfaces. Mobile contributor surfaces remain read-only. The `MonteCarloLatestView` API response now includes `last_run_at` captured at cache-write time.
Setting a task's `planned_start` to today (or any past date) on a **To Do** task now transitions the card to **In Progress** on the Board across every entry point: dragging from the **Unscheduled** gutter, dragging the bar on the Schedule timeline, editing the date in the task drawer, and integration sync. The unified data-model rule — "In Progress means actual work has begun" — is enforced server-side in `TaskSerializer.update`, so any current or future code path that sets `planned_start` inherits it automatically. Future-dated `planned_start` keeps the card at **To Do** (committed, not started); past-dated drops pin `actual_start` to the chosen date so historical starts aren't overwritten with today. A one-shot `manage.py backfill_in_progress_status` command corrects existing rows that should have transitioned under the old buggy behavior (#336).
**Session expiry now surfaces a banner instead of silently dropping the user on the login screen.** When any API request 401s with no successful refresh, or the project WebSocket closes with code 4001, the app shows a "Your session expired" dialog with a Sign in button. In-flight queries are cancelled, mutations short-circuit, and `RequireAuth` holds the current screen so the banner can render — the previous behaviour redirected to `/login` with no explanation, which made stale-cache UI look like a generic outage. (#352)
**Schedule view refreshes immediately after add / remove dependency, even when the WebSocket is dead.** `useAddDependency` and `useRemoveDependency` now invalidate the project-level `tasks` and `dependencies` query caches on success, in addition to the per-task `task-dependencies` keys. Previously the originating client only refreshed via the WebSocket `dependency_*` broadcast — silent under auth expiry, dev StrictMode races, or any network hiccup. (#353)
**Saving a task no longer soft-deletes its real predecessors when the dependency query is in error state.** `TaskFormModal` hydration refuses to overwrite a populated `pristine.predecessors` with an empty list while the underlying `useTaskDependencies` query is unresolved (initial load OR error), and `syncPredecessors` bails out with a recoverable user-facing message instead of diffing against a stale baseline. (#354)
- Reject impossible dependencies at create time. `POST /dependencies/` and `PATCH /dependencies/{id}/` now run cycle detection on the project's expanded leaf graph and return a structured `400 {"detail": "cyclic_dependency", "cycle": [{id, name, hex_id}, …]}` when the proposed edge would close a loop. Previously the cycle was only discovered later when CPM ran, leaving the schedule frozen at stale values with no in-product explanation.
- The board's task modal and the schedule view's dependencies tab now surface a visible `role="alert"` toast naming the cycle path ("This would create a circular dependency: A → B → A. Remove one of these edges first.") so the user knows which edge to remove. Form state is preserved across the error so the predecessor selection does not reset.
- Self-loops (`predecessor == successor`) are short-circuited with the same structured error.
- See ADR-0055 for design notes; the scheduler now exposes a public `find_cycle(edges, children_map)` helper.
DependencySerializer now rejects predecessor/successor FKs that point at soft-deleted tasks (returns 400), preventing orphaned edges that corrupt the CPM graph and cause sync conflicts.
Dependency create/update now runs membership checks on both predecessor and successor before the same-project check, so non-members always receive 403 regardless of project pairing (defense-in-depth hardening).
- Schedule: `+ Task` and `+ Milestone` no longer fail with HTTP 400 — both now seed a placeholder name (`"New task"` / `"New milestone"`) so the server's non-blank `name` validator passes; the build-mode cell editor opens immediately for overwrite (#360).
- Schedule: `+ Task` and `+ Milestone` now insert under the highlighted phase instead of always appending at root. Parent inference walks back from the focused / selected row to the nearest enclosing summary; `TaskFormModal` surfaces the destination phase in the create-mode header (#360).
- Schedule: arrow keys (`ArrowUp` / `ArrowDown`) now move the focused row to the previous / next visible task in both build-mode and flag-off paths, matching the documented `useScheduleFocus` keyboard contract (#360).
- Schedule: phases (summary tasks) are now offered as predecessor candidates in the `+ Task` modal — the prior client-side filter was based on an incorrect assumption that the server rejects summary predecessors; it does not, and the CPM engine already expands summary→leaf edges via `children_map` (#360).
- Schedule: milestones now always render as a single point in time. Linking a successor to a milestone no longer produces a row that shows different Start and Finish dates. The fix enforces the milestone invariant at three layers — the API → scheduler boundary forces `duration=0` when `is_milestone=True`; the post-CPM bulk write resets `early_finish` and `late_finish` to their respective starts; and the `TaskSerializer` clamps `duration` to `0` when `is_milestone` is true. The Schedule grid's Finish column also renders an em-dash for milestones so legacy data with a non-zero `early_finish` cannot leak a date range into the UI (#360).
**Web — Add task** dialog's *Parent phase* picker now lists leaf tasks in addition to existing phases. Selecting a leaf parent posts the create payload as a child of that task; the API derives `is_summary` from the presence of children, so the parent is automatically promoted to a phase on the next read. Milestones remain excluded from the picker (they cannot host children). Hint copy now says "Adding a task here will turn this task into a phase." when a leaf parent is chosen, and "New task will be added as a child of this phase." for an existing summary. Issue #378.
Tasks moved into the COMPLETE column now always read 100% — both in the
ring on the board card and in the popover progress strip — and the underlying
`percent_complete` is auto-clamped on save so SPI math and exports agree
with the column the card lives in. Existing `status=COMPLETE,
percent_complete<100` rows are backfilled. Inverse coupling
(`progress=100 → status=COMPLETE`) is intentionally not enforced; the UI
keeps surfacing the "mark complete" nudge so the PM makes that call.
- web/board: Phase-less projects (no WBS summary tasks) now render a synthetic "Project Tasks" lane whenever the backlog rail/drawer holds at least one card, so the calm-board promote-by-drag affordance has a target. Previously the grid showed only the "No tasks yet" empty-state, leaving simple projects unable to promote backlog → committed work via the board. Truly empty projects (no committed, no backlog) still render the empty-state copy. Closes epic #361.
Fixed Monte Carlo finish dates being one working day later than CPM — the offset-to-date converter now correctly maps exclusive EF offsets to inclusive CPM-style dates.
Monte Carlo simulation now converts dependency lag from calendar days to working-day offsets using the project calendar, matching CPM lag semantics (previously lag was treated as working days, diverging from CPM by ~20% on a standard calendar).
Fixed `project_start` being reported as a later date than work actually begins when multiple parallel root tasks exist — now correctly uses `min(early_start)` across all tasks instead of the first topological-order entry.
Sprint capacity now accounts for each task's actual duration overlap with the sprint window, so a 1-day task no longer consumes the same committed hours as a 10-day task.
Schedule variance now computes against the active baseline finish date instead of `early_finish`, preventing CPM recomputes from silently eroding the reported variance.
Project Health "Most-slipped critical tasks" panel now returns the tasks with the largest schedule drift first (was showing least-slipped).
Burn chart baseline overlay now uses story points (not task count) when `metric=points`, so the Y-axis units are consistent between the actual and planned series.
Sprint carry-over (backlog and next-sprint) now bumps `server_version` on each moved task so mobile sync clients see the close-out mutations.
Summary task `percent_complete` rollup now aggregates leaf descendants at any depth instead of only direct children, fixing incorrect rollup on WBS trees deeper than two levels.
Project SPI now uses baseline finish dates as the planned-by-today denominator (not CPM early_finish), preventing SPI from drifting to 1.0 on each scheduler run. SPI > 1.0 is now reported correctly when the project is ahead of schedule.
Monte Carlo P50/P80/P95 date chips now render the correct calendar date for users west of UTC (was showing one day early after ~16:00 local time).
SPI chip on board cards now appears for tasks with a 1-day baseline (where start date equals finish date); was silently hidden for this common case.
Schedule today-line and sprint Day-N-of-M ribbon now advance at local midnight instead of UTC midnight, fixing premature day rollover for users west of UTC.
Phase rollup % on the board no longer counts uncommitted cards (no `plannedStart`, no sprint) toward the average — same gate the CP/float chips already use (`isTaskScheduled`). Previously an unscheduled To Do counted as a 0% task and dragged the rollup down, so a phase with 4 done + 4 uncommitted ideas read 50% instead of 100%. When every card in a phase is uncommitted, the rollup now collapses to the em-dash empty state (ADR-0057) — there is no committed delivery to roll up.
Hide editable PERT O/M/P inputs on summary (phase) tasks in the task detail drawer — the MC engine only samples leaf task durations, so those fields were silently ignored and confused users. Summary tasks now show a read-only `PhaseUncertaintyBlock` with Phase P50/P80/P95 schedule confidence dates when any descendant has PERT estimates and Monte Carlo has been run; the Estimates section is hidden entirely when no descendants have estimates (#403).
Board backlog "+ Capture idea" button is now wired to create a BACKLOG task; shows "Adding…" and disables while the mutation is in flight.
Fix 14 Wave 2 pre-release blockers: Helm liveness/readiness probes now point at
`/api/v1/health/`; `workshops/broadcast.py` uses `async_to_sync` (removes asyncio
event-loop conflict); frontend WebSocket handler covers all 28 previously unhandled
event types; `aria-modal` corrected on desktop side panels; `UserMenu` mobile sheet
uses `role="dialog"`; `BoardCard` aria-label uses `effectiveProgress`; `RiskDrawer`
notes textarea has an accessible label; `text-[10px]` replaced with `text-xs` across
10 components; `focus:ring` replaced with `focus-visible:ring` across all interactive
elements in schedule/resources/board; focus rings added to all combobox option items;
`shadow-sm` removed from `BoardViewDropdown`; `MonteCarloRow` hidden for Contributor
role (RBAC rule 47).
Fix parent phase picker in New Task modal — replaced `<input>` + `<datalist>` with a
`<select>` element so all phases are always visible. The datalist approach filtered
options based on the pre-populated inferred parent label, hiding every phase except
the first.
- **Gantt dependency arrows** (ADR-0063): FS arrows now follow the consolidated routing rules — 5-segment canonical Manhattan path with three branches (collapsed 3-segment L for forward-clear corridors, R12 gutter dogleg for stacked-sequential targets, left-detour around any non-source/non-target bar blocking the V drop). Merge junctions render for ANY target with 2+ FS predecessors (not just milestones); the junction marks the single point of convergence with a charcoal dot + white halo, and the trunk arrow has a straight ≥ 8px shaft into the arrowhead. Merge junction marker bumped from 4/3 to 6/5 (halo/dot radii) — the original spec sizing was visually subordinate to the 2-px arrow stroke and easy to miss on dense charts. Split T-junctions where one source has multiple outgoing arrows now render as plain corners (no dot) — visually a T is one line passing through plus one branching off, indistinguishable from any other Manhattan corner, so a dot read as noise. ADR-0063 Rule 15 added: four intersection types (crossing / T-junction / merge / near-miss) each get a distinct visual treatment; crossings get a bridge hop (10-px arc on the "over" segment), T-junctions get a smaller 5/4 dot, merges keep the 6/5 dot. Rule 15 Type A (bridge hops) is fully implemented — `drawDependencyArrows` was refactored to a 4-phase collect-then-draw pipeline (paths collected → orthogonal crossings detected → paths stroked with quadratic Bézier arcs lifting horizontal segments over verticals → junction dots drawn last). The arrowhead approach was also fixed in this MR: the polyline now terminates at the arrowhead BASE (tipX − arrowSize), giving every arrow a visible APPROACH_STUB (8 px) of straight horizontal shaft into the arrowhead instead of attaching the head directly to a corner. Two additional decluttering fixes (overrides 4 and 5 in ADR-0063): (a) ancestors of an arrow's target are now transparent obstacles, so an arrow from outside a phase into one of its descendants descends straight through the summary rollup instead of doing a chart-spanning U-detour around the entire phase bar; (b) redundant FS edges are suppressed at render time — when a source has FS to both a summary and one or more of that summary's descendants, only the summary edge renders (the descendant edges are implied because a summary's earliest start is gated by its first child's start). Schedule semantics are unchanged; only the visual is decluttered. Type B (T-junction-on-path) implementation is still deferred to ADR follow-up #9. Summary rollups remain valid arrow endpoints (override of spec R11 — waterfall PMs use phase-to-phase dependencies). All arrows render in charcoal `#444441` regardless of critical-path state; selected-task arrows highlight in brand-primary. SS/FF/SF unchanged (Bézier).
Hide **Duration (working days)** in the task form modal for pure-agile projects (`methodology = AGILE`). Agile teams size work in story points; velocity-to-calendar translation belongs at the program level, not per task. Fixes browser "value must be ≥ 1" validation tooltip on backlog idea tasks with `duration = 0`.
Overview KPI cards no longer clip long values (long milestone names, multi-word health labels) at narrow card widths. The primary value now scales fluidly with the card's own width via container-query units and wraps as a last resort, so the six-card strip at `lg`+ breakpoints stays legible when the sidebar is open. (#506)
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
Monte Carlo simulation no longer fails with "Dependency references unknown task" on a project that has cross-project dependencies. The project-scoped simulation now drops edges whose endpoints fall outside the project's task set (cross-project links and non-committed backlog tasks), matching the existing CPM behavior.
Single-key keyboard shortcuts are now consistently suppressed while typing. A shared `isTypingInInput()` guard covers inputs, textareas, selects, `contenteditable` regions, and ARIA comboboxes across the board and schedule shortcut handlers — so a `?` typed into the resource-search combobox no longer opens the cheatsheet, and pressing Enter to submit a filter field no longer starts a keyboard reschedule on the selected Gantt task.
The Export / Transfer ownership / Delete workspace buttons on Workspace → Settings → Archive / Delete are now disabled (with an explanation linking the tracking issue) until their backing endpoints ship — previously they looked live but did nothing, a foot-gun next to an irreversible delete action.
Summary task bars on the Gantt now render with filled diamond end-caps
matching the milestone diamond geometry, replacing the previous
rounded-rect + bracket-tail shape. Expanding or collapsing a summary row
also publishes an aria-live announcement (`"<Name> expanded, N children
visible."` / `"<Name> collapsed."`) so screen-reader users hear the
state change. (#71)
Project and program Settings forms now refresh their fields when you switch to a different project or program; previously the form stayed on the first one you opened.
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
Schedule view: right-click no longer freezes after deleting a row. Deleting a task (especially one on the critical path) used to leave the hovered-row id pinned to the now-deleted task, which kept every other row in dimmed/`pointer-events-none` state, and could also orphan the row's context-menu portal when cache invalidation unmounted the row. The result was that subsequent right-clicks on every other row were silently swallowed until a full page refresh. The row now gets the in-flight treatment during delete, the open menu auto-closes, the right-click handler is suppressed for the row being deleted, and the hover-chain id is cleared the moment its target task leaves the list.
Sync scaling: mobile delta pull now has composite `(project, server_version)` covering indexes on every synced table, turning a near-high-water-mark resync from a full-project row scan into a single index seek (#810); and a sync upload batch now issues one bulk existing-row fetch and one coalesced `tasks_bulk_mutated` broadcast instead of one SELECT and one channel-layer round-trip per row, so a reconnect storm no longer overflows the WebSocket inbox (#809).
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
Query hygiene across the projects/history/resources apps (#821): task-comment and attachment lists no longer issue a redundant per-request membership `.exists()` (already enforced by the permission layer) and prefetch their parent task; the project-detail unresolved-assignee count is folded into the row as a subquery annotation instead of a live `COUNT()`; retro action items prefetch their assignee (removing an N+1 on `assignee_username`); the resource-assignment create reuses a single resource fetch for both the overallocation and skill-fit checks; and the project history summary caps each object type at 5,000 most-recent rows with a `count_truncated` flag so a busy 90-day window can't load unbounded history into memory.
Monte Carlo now matches deterministic CPM for Start-to-Finish (SF) dependencies with lag — an off-by-one working-day error made SF-linked milestones forecast one day early.
scheduler: Monte Carlo now converts dependency lag against each run's actual predecessor date (calendar-aware) instead of a single project-start reference, so simulated schedules match deterministic CPM when lags span weekends/holidays.
scheduler: `Task.free_float` is now computed across all four dependency types (FS/SS/FF/SF) per the standard critical-path definition, rather than finish-to-start successors only. A task whose only successors are SS/FF/SF no longer reports `free_float == total_float` incorrectly.
Developer experience: `packages/web/src/api/types.ts` no longer carries a misleading "Generated by openapi-typescript — run generate:types" header. The file is hand-maintained; the header now says so and warns that running the codegen script would overwrite and break it.
Accessibility: notification and task-drawer controls now use `focus-visible` rings (no stray focus ring on pointer click), the Schedule task-list row and ARIA grid focus rings are now visible on both light and dark surfaces, and Schedule-view toolbar controls show a visible focus ring in dark mode (WCAG 1.4.11/2.4.7).
Accessibility: a global offline banner (`role="status"`) now warns you're offline *before* a write fails (#834); the task-detail drawer announces `aria-modal="true"` to match its active focus trap (#838); the over-allocated chip is no longer mis-announced as a button (#838); and the Schedule task-list panel splitter is now keyboard-resizable (Arrow / Home / End) with proper `aria-valuenow`/`min`/`max` semantics (#838).
Schedule view: critical-path task rows now show a plain-English tooltip explaining the schedule impact, and the board toolbar is pinned to a single fixed-height row.
Real-time collaboration: task external links, promoted retro suggestions, project API token mint/revoke, and project custom-field changes now refresh live for all connected collaborators instead of requiring a page reload.
Accessibility (WCAG 2.1.1 / 2.4.3 / 4.1.2): the desktop task form now traps focus, sets initial focus, and restores focus to its trigger on close (via a new shared `useFocusTrap` hook generalized from the mobile sheet); the board card overflow menu and its "Move to…" submenu are now keyboard-navigable (Arrow / Home / End to move, Escape to close and return focus to the trigger); the dirty-discard prompt now uses the ARIA-managed `ConfirmDiscardDialog` instead of an unmanaged `window.confirm`; the Assignees/Predecessors search results are a plain list (not a mislabeled `listbox`); and the Assignees/Predecessors sections are programmatically labelled via `role="group"` + `aria-labelledby` (#838).
Board: the card actions (⋯) menu trigger now meets the 44×44px minimum touch-target size on mobile.
- **MS Project import no longer persists tasks before the project start** (#873): the importer `bulk_create`s tasks, bypassing serializer validation, so a `.mpp` whose tasks predated the imported project start could persist sub-start "ghost" `planned_start` values the CPM silently clamps. The importer now pulls the project `start_date` back to the earliest imported task start before persisting (the same auto-shift the interactive paths use, #867).
- **Task history now shows what actually changed (#874, ADR-0096 Part 1)**: the per-task activity history rendered a bare "Updated" entry with no detail whenever an edit touched a field outside a narrow 11-field allow-list — the most common cases being a WBS reorder, a reassignment, a sprint move, or a story-point/priority change. The history endpoint now builds its diff by allow-by-exclusion, so every tracked field renders a real before→after, with people and sprints shown by name instead of a raw id, and change records with nothing user-visible to show are omitted entirely. The contributor-private blocker reason stays hidden from other members.
Program members now carry `joined_at` and `role_changed_at` access-evidence timestamps, matching project members. Previously `ProgramMembership` was missing these fields despite ADR-0070 stating it mirrors `ProjectMembership` exactly, so the program members view could not answer "who has access and since when".
Project-start floor now respects working days: when a project starts on a weekend or holiday, the "Schedule before the project start?" prompt and its **Snap to project start** action target the first working day (e.g. the following Monday) instead of the non-working start date — so snapping no longer re-trips the guard. The dialog names the working-day floor when it differs from the literal start date.
Regression test asserting `SyncTaskSerializer` exposes `actual_start`,
`actual_finish`, and `is_milestone` in the sync pull payload, plus a
schema guard that fails if any mobile-critical field is dropped from
`SyncTaskSerializer.Meta.fields` (#90).
Add missing `is_milestone`, `actual_start`, and `actual_finish` fields to the sync pull serializer so mobile clients receive actual date and milestone data.
The Rust/WASM scheduler no longer panics (trapping the module) on a task whose start date is near the calendar's representable maximum combined with a large dependency lag — date arithmetic in the forward, backward, and free-float passes is now overflow-checked and surfaced as a clean error.
scheduler (wasm): the Rust/WASM engine no longer panics (trapping the module in the browser) on a calendar whose exceptions blanket the schedule after an isolated working day. Calendar stepping is now bounded and returns an error, matching the Python engine.
The critical path is now returned in a guaranteed topological order — a predecessor always precedes its successor — even when two critical tasks share an early start (e.g. a start-to-start link). Both the Python and Rust/WASM engines order it identically.
scheduler: the critical path is now ordered deterministically by (early_start, id) in both the Python and Rust engines, so its ordering is stable across networkx versions and identical between the two engines for projects with parallel critical tasks.
Fixed the app failing to load data after a page reload or deep-link. Since the access token is now held in memory only, a fresh page load began unauthenticated and recovered only via per-request 401 retries — a 401 storm that did not reliably rehydrate the page. The app now mints an access token from the refresh cookie on startup, before rendering, restoring instant data load on reload.
Gantt timeline now fills the full panel width; task list columns (Dur · Start and %) align correctly with their headers; unscheduled tasks no longer render errant bars on the canvas.
Risk register IDs are now unique, contiguous decimals (`R-001`, `R-002`, …) served by the API, replacing the shared hex counter that collapsed every risk to `R-0000`. Exports and cross-project surfaces show the fully-qualified `<PROJECT>-R-001` form.
Schedule: task bars now render their full inclusive duration. The canvas renderer treated the scheduler's inclusive `early_finish` as an exclusive end date, so every bar painted one day short — most visibly collapsing a 2-day task into a single column. Bars, the resize/link-dot hit zones, dependency-arrow anchors, and the accessibility focus ring now all extend through the end of the finish day (#950).
Schedule bar resize now commits a working-day duration, not a calendar-day duration. Dragging a task's right edge across a weekend or calendar exception previously inflated the stored duration (and could falsely flag a no-op grab as a change). The Gantt resize now sends the target finish date and the server derives the working-day duration from the project calendar.
Fixed real-time presence join/leave broadcasts that silently failed with an `AsyncToSync` `RuntimeError` when fired from the WebSocket consumer's event loop. Presence ("who's online") updates now reach connected clients immediately instead of only refreshing on the next reconnect.
- **Gantt timeline whitespace at coarse zoom levels**: at month, quarter, and year zoom the
  timeline canvas terminated almost immediately after the last task bar because the trailing
  buffer (118 days) translated to only ~94–354 px — narrower than the viewport. The user
  could not scroll right far enough to plan ahead. Fixed by enforcing a minimum canvas
  width of `viewportWidth × 3` in `buildScaleData`, so there is always ~3 viewports of
  scrollable whitespace beyond the last bar at every zoom level. Canvas is also rebuilt
  on container resize so the floor follows the viewport.
- **Gantt timeline header labels** are now visible when scrolled past the last task
  bar. The label for the current period (month, quarter, year) pins to the left edge
  of the viewport rather than rendering off-screen when the period boundary has
  scrolled behind the user.
- **Gantt canvas white void when scrolling right**: the sticky canvas wrapper used
  `width: 100%` which resolved to the full scroll-spacer width; CSS sticky `left: 0`
  cannot hold when the element is as wide as its containing block, so the canvas
  scrolled off-screen. Fixed by exposing `--gantt-vw` / `--gantt-vh` CSS custom
  properties from the engine and sizing the wrapper from those values.
- **Gantt scroll spacer too narrow after project switch**: `totalCanvasWidth` was read
  once from `engine.scales` at render time; added a `scales-change` subscription so
  the scroll spacer stays in sync when `setTasks()` rebuilds the scale.
- **Gantt task-list columns expanded**: the combined Dur·Start column is now split into
  separate **Dur**, **Start**, and **Finish** columns so each value is clearly readable
  and individually resizable. Full-height column dividers align between header and data
  rows. Default widths: task=220, dur=52, start=74, finish=74, %=44 (localStorage key
  bumped to v4 to reset stale cached widths).
Editing a task no longer lags the UI. A task update only triggers a schedule recalculation when a field that actually affects the schedule changes — editing progress, the description, or the name now skips the whole-project CPM recalc entirely (it was firing on every change). Edited fields also update instantly in the UI via an optimistic cache update, so a progress slider or status change no longer briefly reverts while the save lands.
Task Detail drawer: clicking **Discard** on the Description save bar now reliably reverts the edit. Previously a blur-vs-click race let the Description's blur-flush optimistically persist the very edit being discarded, so the unsaved-changes bar reappeared and the text was silently saved. The same fix also removes a redundant double-PATCH when clicking **Save changes**.
Task progress `%` is now rounded to a whole number everywhere it is shown as text. Summary/parent rows carry a duration-weighted rollup of their children's progress (e.g. `31.36%`) where leaf rows are integers; the Schedule task list (read and build mode), the WBS/Table grid rows, and the task-drawer subtask list now `Math.round` for display, matching the milestone-rollup cell, the canvas bar label, and the Overview KPI cards. Progress-bar fill widths remain fractional (geometry, not a label).
Fixed in-app documentation links ("Open runbook" on System Health, plus the Email, Connected Accounts, and My Work help links) that pointed at relative `/docs/...` paths and 404'd in local dev and self-hosted deployments. Links now resolve to the published docs site (`docs.trueppm.com`) via a shared `docsUrl()` helper (overridable with `VITE_DOCS_BASE_URL`), and the Connected Accounts link now targets the correct page.
Restored a clickable path to the Programs gateway from the sidebar. The #959 scope picker is a project *filter*, and it had dropped the only navigation to `/programs` from the expanded sidebar and mobile drawer. The "Programs" section header is now a link to the gateway (trailing chevron + hover underline, `aria-current` when active, 44×44 touch target), distinct from the scope filter below it so navigating and filtering never collide. The mobile drawer closes on navigation; the collapsed rail's icon link is unchanged.
**Login response schema no longer claims a phantom `refresh` field (#997).** `POST /api/v1/auth/token/` delivers the refresh token as an httpOnly cookie and returns only `access` in the body (#897), but the generated OpenAPI schema still inherited simplejwt's `TokenObtainPair` shape, which declares `refresh` as a required field. Any schema-driven client (the 0.4 read-only MCP server, generated SDKs) failed required-field validation on login. The view now declares an explicit access-only response via `@extend_schema`, and the phantom `TokenObtainPair` schema is no longer emitted.
- **Bulk task write performance**: the bulk task endpoint (`POST /projects/{id}/tasks/bulk/`) now serializes its created/updated results through a single annotated batch fetch instead of bare model instances. Previously each returned task triggered per-row live queries (and silently-wrong defaults for annotation-backed fields like `is_summary`); a bulk create of 50 tasks issued hundreds of extra queries in the response phase alone. Response cost is now constant in the number of tasks mutated.
- **Milestone rollup performance on the Gantt fetch**: sprint-driven milestone rollups are now batched once per task-list and sprint-list request (two queries total) instead of recomputed per row. The task list (`GET /tasks/`) and sprint list previously issued `O(milestones × sprints)` extra queries computing each milestone's `milestone_rollup`/`target_milestone_detail` on read — dozens of queries on a single page of the hot schedule fetch. Rollup values are unchanged.
- **Board readiness ghost state**: unassigned cards in NOT_STARTED, IN_PROGRESS, or REVIEW columns no longer showed the "idea" dashed-border ghost styling (italic name, `?` avatar) after being promoted out of Backlog. `readiness` is now BACKLOG-boundary-aware — `idea` applies only while a card remains in the Backlog column. Moving a card back to Backlog retains its assignee and readiness (drag demotion is re-sequencing, not de-commitment). (ADR-0047)
Enable `ATOMIC_REQUESTS` so `transaction.on_commit()` defers Celery and broadcast callbacks to post-commit, preventing broker failures from returning HTTP 500 on task mutations.
Fixed the task drawer's Attachments controls wrapping their labels (e.g. "+ Attach\nfile") when a long upload-validation message appeared — the `+ Attach file` and `+ Pin link` buttons no longer share a flex row with the status/error text, so a long message can never shrink them. Messages now stack on their own line below the buttons.
- **Board view scroll**: the active-sprint summary (burndown chart + velocity
  sparkline) at the top of the board now scrolls with the cards instead of
  staying pinned above them. The panel previously consumed permanent vertical
  space, leaving the phase grid short and difficult to scroll on smaller
  viewports. The toolbar, workshop banner, and "My tasks" filter chip remain
  fixed above the scroll region.
Fixed the calm board toolbar's More⋯ popover being clipped off the right edge of the viewport. The popover now anchors to the right edge of its trigger chip so menu items remain fully readable.
Add `celery-beat` service and cap worker concurrency at 2 to prevent OOM kills in the dev Docker Compose stack. Without Beat, the `drain_schedule_queue` outbox fallback never ran, leaving tasks unscheduled when the worker was down. Without a concurrency cap, 10 prefork workers consumed ~460 MB and triggered the kernel OOM killer.
- **Pre-commit ruff version**: bumped `ruff-pre-commit` from `v0.8.6` to `v0.15.8` to match the API venv; the mismatch caused a circular reformat loop on every commit touching API test files. Also restricted the `mypy` pre-commit hook to `packages/scheduler/` to prevent spurious `import-not-found` errors on API files.
- **Completed tasks keep their full duration on the schedule**: a task marked 100% complete no longer collapses to a single-day bar (Start == Finish) while its Duration column still reads the original estimate. The progress-aware CPM pass now lays a completed task out at its full working-day duration — anchored to whatever actual dates were recorded, deriving any missing endpoint, and falling back to its planned position when no actuals exist — instead of treating "0% remaining" as a zero-length task. Completing a card that was never started also no longer stamps a fake `actual_start` of today, which previously pinned the bar to a single day at the wrong place.
- **`make coverage-diff-api`**: propagates `CI=1` into the api container so test branches that toggle on the env var (e.g. the incremental CPM perf benchmark, which uses a 600 ms budget under CI vs. 200 ms locally) take the same path the GitLab CI runner takes. Previously the local pre-push hook ran the same suite without `CI=1` and hit timing flakes that GitLab CI never saw.
Loading or removing demo/sample data now updates the sidebar project list immediately, without requiring a manual page refresh. The "Load demo data", import-program, and remove-sample actions previously only refreshed the program list, leaving the newly created (or removed) projects stale in the sidebar until reload.
Design system: semantic badge/card fills now use the dark-mode-correct `-bg` tokens instead of the `bg-semantic-*/N` opacity modifier (#830); program backlog text is raised to the 12px floor (#831); and disabled controls in Settings use the accessible disabled treatment instead of half-opacity text that failed WCAG 1.4.3 (#833).
Documentation: corrected the risk-register "CSV import" claim (it is CSV export), fixed 22 broken `/architecture/adr/` links to `/architecture/decisions/`, aligned the baselines roadmap reference (0.5), and fixed a present-tense Helm note for the unshipped 0.2 release.
Fix docs site legibility (aside text invisible in dark mode), add `/api/schema/swagger-ui/` URL alias for drf-spectacular standard path, and add v0.1.0-alpha.1 version to the docs version selector.
Filled three durability gaps in the transactional outbox: the manual schedule trigger and MS Project import now route through `enqueue_recalculate()` so broker outages leave a recoverable PENDING row. Added a webhook delivery drain poller (`drain_webhook_queue` Beat task, every 30 s) that re-dispatches stranded PENDING deliveries and marks inactive-webhook deliveries as FAILED.
Corrected the **Email & SMTP** settings page so it no longer states that SMTP transport is configured via environment variables / Helm values — that binding is not yet wired (tracked in #764).
Schedule view dependency arrows no longer cut horizontally through task name labels (the "strikethrough" artifact). The canvas renderer painted bars + labels first and arrows last, so every arrow's horizontal exit/entry segment — which runs at row-center y, exactly where the label sits — was drawn on top of the text. Labels are now rendered after arrows, so the text covers any crossing arrow line. The split also lets future engine work add layers between bars and labels without re-introducing the regression.
Filter unscheduled tasks (null `early_start`/`early_finish`) from Gantt data to prevent "Invalid time value" crash when a newly created task has not yet been processed by the CPM engine.
Gantt view now shows unscheduled tasks in the task list instead of displaying "No tasks yet".
Task creation no longer returns 500 (missing `scheduling.0002_schedulerequest` migration was unapplied).
Fixed crash ("Invalid time value") when unscheduled tasks reached the ARIA overlay date formatter.
Docker Compose API health check prevents nginx from crashing on startup before the API is ready.
- **Homepage layout**: "Why TruePPM?" feature cards were vertically staggered, causing right-column cards to render offset lower than left-column cards. Removed the `stagger` prop to restore a uniform 2×2 grid.
Made the incremental CPM benchmark test deterministic by asserting on the number of rows passed to `Task.objects.bulk_update` instead of a wall-clock budget. The previous wall-clock assertion was flaky on shared CI runners (sustained-slow phases defeated best-of-N sampling); the new assertion is immune to runner noise and gives a sharper regression signal — a regression to the full-write path is now caught by an order-of-magnitude row-count increase rather than a single millisecond threshold.
Guarded the `PENDING→DISPATCHED` transition in `enqueue_recalculate` with a savepoint: a previously stranded `DISPATCHED` row (CI integration environment without a Celery worker, or a worker outage in production) no longer 500s the next task mutation via `schedule_request_one_dispatched_per_project`. The new row is left `PENDING` and `drain_schedule_queue` coalesces on the next tick — same failure-model contract as the existing broker-outage path.
**Web — login screen** moved the *Forgot?* recovery link from the Password label row to a right-aligned position below the password input. Keyboard tab order now flows Email → Password → Forgot? → Keep me signed in → Sign in, removing the unwanted detour through the recovery link between the Email and Password fields.
- Resolved conflicting `projects` migration leaves on `main` after `#521` and the `#520`/`#528` merge migration both landed at `0042`. Adds an empty `0043` merge migration that depends on both leaves so `makemigrations --check` passes.
- **Monte Carlo on agile projects now reflects team velocity**: a project whose work is delivered as Scrum stories (story points, not three-point duration estimates) previously forecast a single flat completion date — every story collapsed to its one-day placeholder duration, so P50, P80, and P95 were identical and unrealistically early. The simulation now feeds the team's completed-sprint throughput to the scheduler, so Scrum/story-point tasks sample sprints-to-completion from the real velocity distribution and the forecast carries a genuine uncertainty band. Waterfall three-point (PERT) projects are unchanged, and a project with no velocity history falls back to deterministic durations as before.
Fix all web API hooks (useProjects, useGanttTasks, useBaselines, useRisks) to unwrap DRF PageNumberPagination envelopes — project list, Gantt tasks, baselines, and risk register were showing empty data against the real API.
Program → Projects: the "Add existing", "New project", and "Remove" controls are now correctly limited to program Admins and Owners (they were previously shown to all members, whose actions then failed server-side).
Fix CI failure on pre-release builds: widened `trueppm-api`'s dependency
on `trueppm-scheduler` from `>=0.1.0` to `>=0.1.0a0` so pip accepts the
locally-installed pre-release editable. Previously, PEP 440 excluded
`0.1.0-alpha.1` from satisfying `>=0.1.0`, causing every API CI job to
fail with "No matching distribution found" once the version was bumped
to an alpha.
- **Schedule: open task details by double-clicking a bar**: double-clicking a task
  bar, milestone, or summary rollup on the Schedule timeline now opens its detail
  drawer. The engine already emitted a `task-open` event on double-click, but the
  Schedule view never subscribed to it, so the only affordance over a bar was the
  `grab` cursor for dragging — there was no way to reach a task's details from the
  timeline. A quiet "Double-click a task to open its details" hint was added to the
  schedule legend for discoverability. Single-click still selects (ring +
  dependency-chain highlight) without opening the drawer.
Fix `seed_demo_project` command so superusers automatically receive project memberships in both seeded projects, making the demo immediately usable when logged in as admin without needing to use a persona account.
Settings UX/accessibility fixes: workspace toggle labels now follow their state, so a switched-on toggle no longer reads "Disabled" (#978); the Project → Team tab labels its Scrum Master / Product Owner facet columns instead of leaving the switches unlabeled (#974); the Signal privacy ladder spells out "Scrum Master" / "Project Manager" (with the abbreviations kept as a narrow-screen fallback) rather than the ambiguous "SM" / "PM" (#975); and the redundant "Danger zone" card on General settings is replaced by a single inline link to the Archive / Delete page, consistent across Workspace, Program, and Project (#977).
Remove duplicate view-tabs navigation from TopBar (ProjectShell toolbar already handles in-project view switching) and suppress the transient "Failed to load projects" flash caused by the 401→token-refresh→retry cycle.
Restore ViewTabs to TopBar as the sole view switcher (underline style, per design rule 38). Remove the redundant pill-style toolbar from ProjectShell. Add WBS tab and rename "List" to "Table" for label consistency.
Fix tag-triggered CI pipeline and GitLab Releases: added `v*` tag rule to
`workflow:rules` (tag pipelines were silently suppressed), added the tag
case to `rules-website` so `website:build` runs and GitLab Pages deploys
on release tags, and added a `release:create` job that creates a GitLab
Release entry for every `v*` tag (pre-release builds get a short changelog
pointer; stable builds extract their CHANGELOG section).
Task drawer Resources section now displays resource names. The `/task-resources/` endpoint payload was missing `resource_name`, leaving rows in the redesigned drawer (#306) with only the percent input and remove button.
Fixed accessibility and UX gaps: WCAG 2.1 AA focus rings on all dark-surface elements, 44×44 px touch targets, NewProjectModal focus trap, TaskListView bulk-delete confirmation with countdown, pending-task rows in Gantt after creation.
- **WASM scheduler validation parity with Python (#1085, #1086, #1087)**: the
  Rust/WASM engine now rejects the same degenerate input the Python engine does,
  closing three cross-engine accept/reject divergences. A complete three-point
  estimate with `most_likely` outside `[optimistic, pessimistic]` is rejected
  (#1085); a `planned_start` (SNET) pinned more than `MAX_PROJECT_SPAN_DAYS` after
  the project start is rejected, and the furthest pin's offset is added once to
  the cumulative span bound (#1086). Two reachable panic paths — a dependency that
  references an unknown task, and an incremental update with a stale
  `changed_task_id` — now return a clean error instead of trapping the WASM module
  (#1087); the Python engine raises `InvalidScheduleInput` (was a bare
  `ValueError`) for the unknown-dependency case so both engines reject the shared
  conformance fixtures identically.
Document CPI/cost API deferral in TaskSerializer and ADR-0035; add vitest coverage for EVM toolbar toggle and Show cost checkbox; add Playwright E2E coverage for swimlane collapse, density toggle, float chip, baseline variance, card aging, milestone rail, priority rank, and SPI chip.
- **Wave 3-8 design conformance pass**: align the shipped UI with the golden design mockup across the schedule, overview, table, resources, and risk views. Highlights — risk matrix bubbles use the design's ring-color formula and shrink from 40px to 26px, the heatmap panel widens to 440px, the risk register exposes a mobile overflow menu so Export CSV is no longer desktop-only, the Project Overview KPI grid grows to 6 cards (adding the **Open risks** card backed by new `open_risk_count` / `high_risk_count` fields on the overview API), the Attention panel adopts severity dots, the My Tasks rows show owner avatar / % / status pill, the Gantt chip text uses palette tokens instead of hardcoded `#FFFFFF`, the Table "On hold" pill flips from at-risk red to warning gold, the heatmap cell margins match the design's 4px / 2px spec, and the Resources heatmap "Level loads" button is now slot-overridable via `resources_heatmap.level_loads`. The risk serializer also gains `owner_name` and `owner_initials` so the register table can show the assigned owner's name without a second request, and a non-blocking `validate_mitigation_due_date` validator is registered on `RiskSerializer` per ADR-0043.
- **Workshop mode — phase stability**: adding a new phase no longer scrambles previously dragged phase order; the new phase appends to the bottom and existing positions are preserved.
- **Workshop mode — cross-phase card move**: dragging a card into a lane belonging to a different phase now reparents it (PATCH `parent_id`) in addition to updating its status.
Fixed a date-rot test (`test_patch_planned_start_without_status_change`) that turned `main` red: it hardcoded a `planned_start` of `2026-06-01`, which once past correctly triggered the #336 `NOT_STARTED → IN_PROGRESS` auto-transition and broke the test's "status unchanged" assertion. The date is now computed relative to today so the test stays stable.
- **Task short ID in frontend** (#452): Added `shortId` field to the `Task` TypeScript type and `useScheduleTasks` API mapping so task short IDs (e.g. `00000001`) are available in the web client.
- **TaskResource RBAC coverage** (#448): Added test for `TaskResource.project_id` property that the `CanAssignResource` permission class relies on for project-context resolution.
- **numpy floor bump** (#456): Raised the `trueppm-scheduler` numpy dependency floor from `>=1.24` (EOL) to `>=1.26`.
- **Helm SECRET_KEY guidance** (#451): Added a prominent comment in `values.yaml` explaining that `SECRET_KEY` and `ALLOWED_HOSTS` must be mounted from a Kubernetes Secret — the application will not start without `SECRET_KEY`.
- **Configuration docs** (#450): Documented `TRUEPPM_EDITION`, `HISTORY_RETENTION_DAYS`, `TASK_RUN_RETENTION_DAYS`, and `VITE_FEATURE_FLAGS` env vars in the administration configuration page.
- **Risk Register docs** (#445): Added feature documentation page for the Risk Register (scoring, lifecycle states, response strategies, task linking).
- **Webhooks docs** (#446): Added feature documentation page for outbound webhooks (event types, payload shape, signature verification, delivery retries).
- **Board docs** (#447): Added feature documentation page for the Kanban Board (column layout, card anatomy, keyboard move alternative, mobile snap-scroll).
- **Subtasks, Schedule toolbar, Schedule build mode docs** (#449): Ported three feature docs from the root `docs/features/` directory to the published website with Starlight frontmatter and added all new pages to the sidebar.
Task detail drawer no longer renders every section twice. The frontend slot registry (`WidgetRegistry`) appended on every `register()` call, so any time the OSS section init module re-ran (Vite HMR, module re-import, React StrictMode double-invoke) the drawer doubled up — `OVERVIEW × 2`, `DEPENDENCIES × 2`, `ESTIMATES × 2`, `HISTORY × 2`, `BASELINE × 2`. `register()` now replaces by `(slot, id)` instead of appending, which also lets HMR pick up the new component when a section is edited mid-session.
- **Workspace settings unreachable for the first admin**: on a fresh install the
  bootstrapping admin (a Django superuser with no explicit workspace membership
  row) was bounced from **Settings** to their personal notification preferences.
  `GET /auth/me` derived the `can_access_admin_settings` / `workspace_role` signal
  from membership rows only, ignoring the implicit-OWNER bootstrap that workspace
  RBAC already grants a superuser — so the API let them manage the workspace while
  the UI told them they couldn't. The signal now resolves through the single
  canonical workspace-role resolver, so it can never drift from what RBAC
  enforces; a deactivated membership also correctly reports no admin access.

### Security
Bumped the `django-allauth` floor to 65.18.0 to exclude versions affected by CVE-2025-65431 (improper authentication via mutable Okta/NetIQ `preferred_username` UID) and CVE-2026-27982 (SAML `RelayState` open redirect), plus related fixes from the 65.13.0/65.14.1 security releases.
The production server now fails fast at boot when `INTEGRATION_ENCRYPTION_KEY` is missing or malformed, instead of booting successfully and only erroring the first time a user connects an integration credential. Registered as a `manage.py check --deploy` security check and enforced at settings import time, mirroring the existing `SECRET_KEY` guard.
Attachment uploads are now validated by server-side content sniffing, not just the client-declared `Content-Type`. A payload (e.g. HTML/SVG) that poses as an allowed type by setting a false MIME header is rejected with a 400, closing the gap where the "allowed types" guarantee was advisory.
**Generic seed import no longer rebinds a pre-existing global resource by email (#1004).** `import_seed` matched resources against the workspace-wide catalog by email and attached the existing row — including its `user` FK — to the importer's project. A generic (non-sample) import now creates fresh resource rows so a crafted seed cannot pull a real user's resource into the importer's project; the demo/sample loader still reuses the shared persona catalog as intended.
Hardened project access gates to be declarative at the DRF layer rather than relying on in-body checks. The MS Project import, export, and import-provenance endpoints now enforce membership via `IsProjectMember`; comment reactions are blocked on archived projects; and the resource-roster `SCHEDULER` floor is enforced declaratively on nested routes. All were already safe today — this removes the risk that a future refactor silently bypasses an in-body-only gate. (#1005, #1006)
Raised dependency manifest floors that sat below the safe lockfile-resolved versions, so a fresh or cache-evicted install without the lockfile can no longer pull a vulnerable version: `axios` to `^1.16.0` (excludes the compromised 1.14.1 and CVE-2026-40175 prototype-pollution→SSRF, fixed in 1.15.0), `celery` to `>=5.6` (5.4/5.5 are no longer security-maintained upstream), `redis` to `>=7.0`, and `trueppm-scheduler` now carries a `<1` upper bound. `html-to-image` is strictly pinned to `1.11.13` (unmaintained). The `wasm:license-check` CI job now also runs `cargo deny check advisories` against the RustSec database — previously only crate licenses were scanned — and the cargo-deny pin is bumped to 0.19.9 so it can parse CVSS 4.0 advisories.
Seed import on the generic (`create_users=False`) path no longer resolves a seed account's username to a pre-existing real user. A crafted seed can no longer pull a known victim's account into the importer's own program — as a program member, the program lead, a task assignee, or a resource's user FK. The server-curated sample/demo path is unaffected.
The SCHEDULER+ field-level RBAC gate on sprints now also fires on **create**, not only update. A Team Member could previously `POST` a new sprint with `capacity_points`, `wip_limit`, `goal_outcome`, or `exclude_from_velocity` pre-set — fields reserved for Resource Manager (Scheduler) and above — because the gate skipped when no instance existed yet. The create path now resolves the project from the nested route and applies the same `role >= SCHEDULER` check before accepting any of those fields.
Closed a velocity-signal leak in `VelocitySuggestionSerializer`: `suggested_duration` (computed from the team's velocity rate) is now suppressed behind the same ADR-0104 velocity gate that already guards `team_velocity_per_day`, so a reader below the velocity audience can no longer back into the team's pace via the calibration suggestion (#1099, a new instance of the #949 leak class). The velocity-calibration prompt in the Task Detail Drawer hides itself when the value is suppressed rather than rendering an empty estimate.
**Deleting a project now fully removes it and its contents from view (#1111).** Previously a soft-deleted project kept resolving at its URL as an empty "zombie" shell, and its tasks, sprints, risks, and baselines were left orphaned — still reachable through the project-scoped list endpoints (via the surviving membership row) and still counted in My Work, capacity, sprint velocity, and portfolio rollups. Project soft-delete now cascade-tombstones those children, the project queryset and the overview/attention endpoints exclude soft-deleted projects (a deleted project 404s), and the web app shows an honest "this project isn't available" state instead of a blank dashboard. Recoverable deletion (Trash/restore + retention) lands separately in #1113–#1115.
Triaged the 21 WARNING-level Semgrep SAST findings (raw SQL, unvalidated-password, credential-disclosure, throttle config, `len`-vs-`count`) — each is fixed or carries an inline `# nosemgrep` justification (all were safe: parameterized/static ltree queries, bootstrap/seed-only passwords, log lines that never emit secrets, and intentional prefetch-cache reads). The `security:semgrep` CI gate now fails on WARNING in addition to ERROR.
Bumped web dependencies flagged by the OSV scanner: `form-data` to 4.0.6 (GHSA-hmw2-7cc7-3qxx, High), and the dev-only `js-yaml` to 4.2.0 (GHSA-h67p-54hq-rp68) and `@babel/core` to 7.29.7 (GHSA-4x5r-pxfx-6jf8). `js-yaml` is pinned via an `overrides` entry because `@redocly/openapi-core` hard-pins 4.1.1.
- **Monte Carlo lag-delta DoS**: a project member could exhaust an API worker (multi-GB memory + minutes of synchronous CPU) by triggering Monte Carlo on a project with many dependencies. The simulation built one working-day delta array per dependency edge — O(edges × schedule span), unbounded by the project-span guard (an `SF` dependency with zero lag slips it entirely). Delta arrays are now memoized per distinct `(dependency type, lag)` combination, and the precompute is capped explicitly; a network too large or too varied to simulate is rejected with a 400 instead of OOM-ing the worker.
- **Velocity sampler memory amplification**: the agile/velocity Monte Carlo path sized its bootstrap draw matrix as `runs × max_sprints`, where `max_sprints` scaled with `story_points / velocity` and was bounded only by `max_sprints × sprint_length_days`. A one-day sprint length therefore let a large story-point count drive a multi-GB allocation while still clearing the span guard. The per-run sprint horizon is now capped by an absolute `MAX_VELOCITY_SPRINTS` ceiling, bounding the matrix independently of sprint length. (Reachable today only via the `trueppm-scheduler` library; hardened ahead of wiring team velocity into the API forecast.)
- **scheduler: deserialization only raises documented exceptions** (#1207): `Project.from_json` could escape its documented exception contract on untrusted input — a deeply nested JSON document raised `RecursionError`, a year-9999 start date with a large span overflowed the date range as a bare `OverflowError` (reaching the CLI and Celery worker), and a non-object top-level document raised `AttributeError`. All three now surface as `InvalidScheduleInput`, and the engine rejects a start date too close to the representable date ceiling before any calendar walk.
- **scheduler: public API rejects type-confused input cleanly** (#1209): `find_cycle` and direct `schedule()`/`monte_carlo()`/`Task.from_dict` calls could leak undocumented `TypeError`/`AttributeError`/`NetworkXError` when handed the wrong Python types (malformed edge tuples, a non-`timedelta` duration or lag, a `datetime` where a `date` was expected, a non-numeric velocity sample, a non-integer `working_days` bitmask). These are now validated up front and raise the documented `InvalidScheduleInput`.
- **Dependency CVE patches**: updated `dompurify` to 3.4.10 (web, via `jspdf`) to clear seven XSS/mutation advisories affecting ≤3.4.6, and bumped the `cryptography` pin to `>=48.0.1` (api) to pick up the OpenSSL fix shipped in pyca/cryptography 48.0.1 (GHSA-537c-gmf6-5ccf).
Floored the transitive `msgpack` dependency (via `channels-redis`) to `>=1.2.1` to pick up the fix for GHSA-6v7p-g79w-8964, a denial-of-service (SEGV) when a `msgpack` `Unpacker` is reused after an error while decoding untrusted input.
Added an operator security note and a startup warning when a production deployment uses a `DATABASE_URL` without `sslmode`, and documented the outbound-request (SSRF) egress boundary including the DNS-rebinding caveat for self-hosters.
Baseline activation is now owned solely by the dedicated activate endpoint. `is_active` is read-only on the baseline serializer, so a project manager can no longer create a pre-activated baseline directly — which previously bypassed the deactivate-others invariant and could raise an unhandled `IntegrityError` (HTTP 500) when a second active baseline collided with the one-active-per-project constraint.
The `seed_demo_project --with-personas` command no longer hardcodes a fixed `demo` password on the seeded persona logins. The password is now resolved at seed time: the `TRUEPPM_DEMO_PASSWORD` env var if set, otherwise `demo` under `DEBUG=True` for local development, otherwise a random token printed once at seed time — so a public (non-debug) instance never ships real accounts with a trivially guessable password.
- **Database driver now picks up OS-level security upgrades**: the production
  API image installs psycopg as `psycopg[c]`, compiling its C extension against
  the **system** libpq instead of the bundled `psycopg[binary]` wheel, so
  libpq/OpenSSL security updates applied to the base image flow through to the
  database driver.
The `seed_integration_fixtures` management command no longer ships a hardcoded fixture password. It now resolves the credential the same way the demo seeder does (`INTEGRATION_USER_PASSWORD` env var, a static default only under `DEBUG`, otherwise a generated random token), never echoes an env-supplied secret to stdout, and refuses to run its destructive re-seed on a non-`DEBUG` instance without an explicit password (or `--force`).
**Project membership now enforced at the permission layer for project-nested routes.** `IsProjectMember.has_permission()` previously returned `True` for any authenticated user, so list endpoints under `/projects/<project_pk>/...` (task-runs, scheduler-runs, webhooks, risk comments) leaked data when a non-member supplied a known project UUID. The check now verifies a `ProjectMembership` row before the queryset runs. `IsProjectMemberWrite`, `IsProjectScheduler`, `IsProjectAdmin`, and `IsProjectOwner` get the same gate. Skill and ResourceSkill catalogs are now writable only with the documented `SCHEDULER+` floor on at least one project (new `IsOrgScheduler`).
**`settings/dev.py` refuses to load outside a developer workstation or test runner.** The dev settings module replaces `DEFAULT_PERMISSION_CLASSES` with `AllowAny` and sets `ALLOWED_HOSTS=['*']`; previously, a misconfigured staging or production deployment that pointed `DJANGO_SETTINGS_MODULE` at the dev module would silently disable authentication on every endpoint. A new `_assert_dev_environment_safe` guard runs at import time and raises `RuntimeError` unless pytest or mypy is in scope, or `TRUEPPM_ALLOW_DEV_SETTINGS=1` is set. `docker-compose.yml` and `.gitlab-ci.yml` now set the opt-in env var explicitly.
- **Scheduler cycle-check DoS guardrail**: a single summary→summary dependency
  on a very wide WBS could fan out to millions of leaf-level edges during
  cycle detection (`O(P×S)`), stalling every subsequent dependency create. The
  scheduler now bounds the expansion at 100,000 leaf edges, computed from leaf
  counts before any cross product is materialised, and rejects a pathological
  graph with an actionable error. The API surfaces this as a `400` rather than
  a hung request.
Fix 10 pre-release security, performance, and correctness blockers found during the 0.2 audit:

- **Security**: WebSocket sync and workshop consumers now reject soft-deleted members (#419)
- **Security**: `FailedTaskViewSet` restricted to admin users — tracebacks no longer leak to any authenticated user (#420)
- **Security**: `CalendarViewSet` write operations now require org-admin role (#421)
- **Security**: `TaskBulkView` delete operation now enforces Admin+/assignee gate matching `IsProjectMemberWriteOrOwn` (#422)
- **Security**: `TaskSkillRequirementViewSet` create/list scoped to member projects and gated to Scheduler+ on writes (#423)
- **Performance**: `broadcast_board_event` replaced `asyncio.run()` with `async_to_sync` — eliminates event-loop startup on every write (#425)
- **Performance**: `SyncRiskSerializer.get_task_ids` iterates prefetch cache instead of bypassing it with `values_list` (#426)
- **Performance/correctness**: `useScheduleTasks` now fetches all pages and uses a 30s fallback interval instead of a 2s poll (#424)
- **Performance**: History `_compute_diffs` / `_count_field_changes` pair records in Python instead of firing one DB query per record via `prev_record` (#418)
- **Performance**: `TaskSerializer` summary rollup moved to a DB-side correlated subquery annotation, eliminating one raw SQL round trip per summary task on list responses (#417)
- **Performance**: Route-level code splitting added to `router.tsx` — heavy views (Gantt, Board, Reports, etc.) now load on first visit rather than at login (#427)
- **Scheduler**: `README.md` quick-start example rewritten to match the current API (#415)
- **Scheduler**: `monte-carlo` CLI passes `max_runs=None` so the default `--runs 10000` no longer raises `SimulationCapExceeded` (#416)
- **Inbound sync IDOR guard now structurally enforced**: the project-ID/token mismatch check on `POST /api/v1/projects/{id}/task-sync/` is enforced by a new `IsTokenForProject` DRF permission class rather than by view-body ordering. A token issued for project A cannot be used to upsert tasks into project B regardless of URL; mismatches return 401 to avoid leaking project existence.
- **Audit log `source_ip` restricted to Project Manager+**: the `GET /api-token-audit/` endpoint now redacts `source_ip` for callers below the Project Manager (Admin) role. Integration system IP addresses are infrastructure metadata; exposing them to Viewer-level members was an unintended information leak.
- **`SECRET_KEY` length enforced at boot** — production settings now refuse to start when `SECRET_KEY` is shorter than 32 characters or carries the Django `django-insecure-` placeholder prefix. Mitigates PYSEC-2025-183 for self-hosters who would otherwise sign JWTs (via SimpleJWT, which inherits `SECRET_KEY` as its `SIGNING_KEY`) with a trivial HMAC key. A new Django system check tagged `security` also surfaces the same error under `manage.py check --deploy`. See `docs/administration/secret-key.md` for the generator command and verification recipe.
- **Project notification preferences reject and purge unknown keys**: a one-shot migration strips any invalid event-type or channel keys persisted into a preference matrix before key validation shipped, and the read path now filters them out so attacker- or typo-supplied keys can never leak into the API response or mislead the delivery router (e.g. by colliding with a real event key or raising on lookup).
**Integration PATs are now verified against the provider before they are stored.** Connecting or rotating a credential on `POST /api/v1/me/credentials/<provider>/` previously encrypted and stored any non-empty string without checking it. The GitLab and GitHub providers now ping their `/user` endpoint with the token before persisting; a wrong, expired, wrong-scope, or wrong-host token (e.g. a github.com PAT pasted into the GitLab slot) is rejected with `422 provider_verification_failed` and the row is never written. A new SSRF-guarded egress helper (`apps/integrations/http.py`) resolves the target host and refuses any URL that resolves to a private, loopback, link-local, or cloud-metadata address, so a self-hosted `base_url` cannot be used to probe internal services. The `generic` provider keeps a no-op verifier (accepted, unverified).
Hardened `trueppm-scheduler` against a degenerate calendar whose `exceptions` blanket the schedule. `monte_carlo()` previously walked its working-day index past the representable date range and raised an uncaught `OverflowError` (a synchronous-request DoS), while `schedule()` rejected the same input cleanly — the two entry points have been reconciled. `_validate_project` now probes calendar reachability from the project start (matching the Rust WASM engine's `validate_project`), and the inner working-day walks are individually guarded, so every path raises a documented `InvalidScheduleInput` instead of spinning. Added regression coverage on both `schedule()` and `monte_carlo()` for full-blanket and single-working-day-then-blanket calendars, and the cross-engine invalid-fixture conformance suite now exercises `monte_carlo()` as well as `schedule()`. Both engines also now reject duplicate task IDs at validation instead of emitting a corrupt result in which the shadowed task carries all-`None` CPM dates.
Hardened the `trueppm-scheduler` engine against adversarial input. Degenerate calendars (no working day, or holiday exceptions blanketing the schedule), out-of-range or negative task durations and dependency lag, an excessive cumulative project span, non-positive Monte Carlo run counts, cyclic summary-task hierarchies, and non-finite JSON literals (`NaN`/`Infinity`) are now rejected eagerly with a clear `InvalidScheduleInput`/`ValueError` instead of spinning the CPU for millions of iterations and raising an uncaught `OverflowError`/`RecursionError`. The same bounds are enforced at the API edge (`Task.duration`, `Dependency.lag`, `Calendar.working_days`), and the Monte Carlo endpoint maps any residual date-range overflow to a 400, so a crafted project can no longer tie up the synchronous simulation request path. The WASM scheduler validates the same inputs up front so a degenerate or oversized project returns a catchable error rather than panicking the engine in the browser.
Outbound webhook deliveries are now validated against the SSRF guard: a webhook URL that resolves to a private, loopback, or link-local address (e.g. cloud metadata at `169.254.169.254`) is rejected at registration and blocked at delivery time. Closes #768.
Editing a project's settings (name, description, color, dates, calendar) now requires the Project Manager role or above. Previously any project member — including read-only Viewers — could modify project-level settings. Closes #769.
The JWT login endpoint (`POST /api/v1/auth/token/`) is now rate-limited per client to bound password-guessing attacks; excess attempts receive HTTP 429. Closes #770.
MS Project XML import now parses with `defusedxml`, rejecting entity-expansion / XXE payloads in uploaded files. Production deploys also gain `SECURE_CONTENT_TYPE_NOSNIFF`, `SECURE_REFERRER_POLICY`, an opt-in `SECURE_SSL_REDIRECT` (with the `/health/` and `/edition/` probes exempt), and configurable `CSRF_TRUSTED_ORIGINS`. Closes #771.
Production now refuses to boot when task attachments would be stored on ephemeral local disk (which loses uploads on container/pod restart). Point `TRUEPPM_DEFAULT_FILE_STORAGE` at a remote object-storage backend (S3/MinIO), or set `TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true` when local storage is backed by a persistent volume. Closes #775.
- **Webhook delivery follows redirects (SSRF bypass)**: outbound webhook
  delivery in `webhooks/tasks.py` re-used the default `urllib` opener, which
  follows 3xx redirects. A malicious receiver returning `302 Location:
  http://169.254.169.254/...` (cloud metadata) or an RFC1918 host would re-fetch
  the request without re-running the `assert_url_allowed` SSRF guard — and on a
  307/308 the original signed HMAC payload would replay against the internal
  target. Delivery now uses a no-redirect opener shared with the integrations
  egress chokepoint. (Closes #808.)
Real-time sessions are now evicted the moment a project membership is revoked: soft-deleting a `ProjectMembership` or demoting a member below the Member role pushes a `connection.evict` to the project's board and workshop WebSocket groups, closing that user's live sockets (code 4003) instead of letting them keep receiving CPM/task/presence updates until they disconnect (#813 — the active-connection analog of the reconnect-time fix #419).
- **JWT refresh endpoint throttle**: `POST /api/v1/auth/token/refresh/` was
  wired bare — the login endpoint had a 10/min throttle (#770) but refresh did
  not. A leaked refresh token could be exchanged for access tokens at unlimited
  rate. Added `ThrottledTokenRefreshView` with a `60/min` scoped throttle,
  mirroring the login pattern. (Closes #814.)
`GET /users/search/` no longer returns user email addresses (it still matches on email so invite-by-email works), now requires active workspace membership, and is throttled per user at 60/min — closing a PII-harvesting surface where any single authenticated account could paginate the typeahead to dump every workspace email (#815, ADR-0061 amended).
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
- **WebSocket handshake no longer carries a JWT in the URL**: real-time board and workshop sockets now authenticate with a short-lived, single-use ticket (`POST /api/v1/ws/ticket/`, 30-second TTL, consumed once) instead of an access token in the `?token=` query string, which leaked into access logs, load-balancer logs, and browser history (RFC 6750 §2.3, ADR-0141). The legacy `?token=` parameter keeps working for one release as a logged, deprecated fallback so existing clients have time to migrate.
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
Hardened the Helm chart for secure-by-default installs: auto-generated PostgreSQL and Valkey passwords persisted in a chart-owned connection Secret, Valkey auth on by default, `DATABASE_URL`/`REDIS_URL` injected via `secretKeyRef` (never rendered in plaintext), restricted container security contexts (`readOnlyRootFilesystem`, dropped capabilities, seccomp), default resource limits, `automountServiceAccountToken: false`, and an opt-in NetworkPolicy restricting datastore ingress to the API and worker pods.
Fixed a cross-project IDOR in the mobile sync upload: a `created`-bucket row whose client-generated id collided with a task in another project could be mutated under the caller's role on the URL project. The upsert lookup is now scoped to the target project, and a cross-project id collision returns 409 (regenerate the id).
The project board and workshop WebSocket consumers now resolve the authenticated user with `is_active=True`, so a deactivated account holding a still-valid JWT can no longer keep receiving real-time events until its token expires.
Enforce the configured password policy when accepting a workspace invite, so weak passwords can no longer be set on the unauthenticated invite-accept path.
Prevent a workspace Admin from deactivating or changing the role of a peer Admin or an Owner; you can now only modify members ranked below your own role.
Resource emails are no longer exposed to non-admin callers on the resource catalog, and the list endpoint is now per-user rate-limited, preventing org-wide email harvest.
Task attachment filenames are now sanitized on upload, preventing stored XSS and HTTP header injection via crafted file names.
Webhook signing secrets now require at least 32 characters (auto-generated when omitted) and are returned only once on creation, hardening delivery signature verification.
Sync upload batches are now deduplicated per actor: `SyncBatch` gained an `actor_user` foreign key and uniqueness is scoped to (project, actor, client_batch_id), so a member reusing another user's `client_batch_id` can no longer replay and read back that user's stored response (task ids, server_versions, watermark).
The workshop WebSocket relay no longer forwards arbitrary client payloads verbatim: `receive_json` now drops frames over 4 KB, enforces a per-user message-rate limit, and only relays an allowlist of known event types, closing a denial-of-service amplification vector.
CPM `cpm_complete`, `task_dates_updated`, and `cpm_error` board broadcasts are now deferred with `transaction.on_commit` and wrapped with their database writes in a single transaction, so clients can no longer receive schedule dates from a recompute whose persistence subsequently rolled back.
JWT refresh tokens now ride in an httpOnly, Secure, SameSite=Strict cookie (read from the cookie at the refresh endpoint, never localStorage), the access token is held in memory only, and a strict Content-Security-Policy header (including frame-ancestors 'none') is sent on every response.
Block `javascript:`/`data:` and malformed URLs in task external links and pinned attachments so they can no longer execute or crash the row render.
Validate the login `next` redirect parameter as a same-origin relative path to prevent open-redirect attacks.
security(api): the outbound SSRF guard now unwraps IPv4-in-IPv6 transition formats (NAT64 `64:ff9b::/96`, IPv4-mapped, 6to4, Teredo, and IPv4-compatible `::a.b.c.d`) and re-checks the embedded IPv4, closing a bypass where a wrapped cloud-metadata or RFC1918 address (e.g. `[64:ff9b::a9fe:a9fe]`) passed the `is_global` check on a NAT64-enabled cluster.
Reject invite acceptance for a deactivated workspace member (no silent reactivation) and clear the raw invite token when email delivery fails terminally.
security(api): an integration credential's `base_url` is now restricted to the provider's known SaaS hosts plus an operator-configured `TRUEPPM_INTEGRATION_ALLOWED_HOSTS` allowlist, validated before the token is verified. Previously a user could set any public host and have their PAT shipped in an `Authorization` header to an attacker-controlled domain on first verify.
security(api): the webhook delivery audit log (`/webhooks/{id}/deliveries/`) is now Admin-only. It previously let any project Member read every event payload ever sent — including task notes, comment snippets, and assignee emails — beyond what project membership otherwise grants.
Hardened the CI supply chain (#904): every public CI base image is now pinned by `@sha256` digest (retiring the mutable `:latest` tags on `alpine` and `release-cli`), the Trivy scanner is installed from a pinned, checksum-verified release tarball instead of piping the upstream `install.sh` through `sh`, the PostgreSQL PGDG signing key is verified against a known sha256 before use, and the `api` application now commits a resolved `uv.lock` (with a `uv lock --check` drift gate) for reproducible installs and a scannable dependency surface. Renovate now pins and maintains image digests going forward.
security(deps): bump the docs-site (`packages/website`) dependency tree to clear two HIGH-severity build-time CVEs — devalue sparse-array deserialization DoS (GHSA-77vg-94rm-hx3p) and fast-uri path-traversal / host-confusion (GHSA-q3j6-qgpj-74h6, GHSA-v39h-62p7-jpjc). In-range (lockfile-only) update; the static export builds unchanged.
Refresh-token rotation and logout now actually revoke the previous refresh token. The `token_blacklist` app ships in `INSTALLED_APPS` by default, so a rotated or logged-out refresh token is rejected on replay instead of remaining valid for its full 7-day TTL. A nightly Celery Beat job (`flushexpiredtokens`) keeps the blacklist tables bounded. Completes the httpOnly refresh-cookie security control from #897.
**Velocity-calibration suggestions no longer leak `team_velocity_per_day` past the ADR-0104 gate (#949).** `VelocitySuggestionViewSet` exposed the per-day velocity rate — the same point-based number the velocity gate strips from `/velocity/` — to any project member, so a reader suppressed on `/velocity/` could recover it from the suggestion surface. The serializer now nulls `team_velocity_per_day` for readers below the velocity audience (cached per project to avoid an N+1 on the gate query).
- **Django upgraded to 5.2.15**: raises the dependency floor from `5.2` to
  `5.2.15` to patch five advisories fixed in that release — `get_signed_cookie`
  salt-derivation cross-context reuse (PYSEC-2026-199), `Authorization` not added
  to `Vary` allowing private cached-response disclosure (PYSEC-2026-197), reuse of
  a partially-initialized SMTP connection after a failed `STARTTLS` handshake when
  `fail_silently=True` (PYSEC-2026-200), whitespace-padded `Vary` header bypass of
  the cache key (PYSEC-2026-198), and case-insensitive `Cache-Control` directive
  mismatch leading to incorrect caching (PYSEC-2026-201).
**Project forecast no longer leaks the velocity series past the ADR-0104 gate (#981).** `GET /api/v1/projects/{id}/forecast/` returned the raw `velocity_summary` (full per-sprint series + rolling points) and the derived sprints-to-complete range without applying the velocity privacy gate, so a reader suppressed on `/velocity/` could recover the same team-private band from `/forecast/`. The endpoint now runs the velocity sub-payload through `suppress_velocity_summary()` and nulls `sprints_to_complete_low/high` and `remaining_committed_points` for below-audience readers; separately-gated milestone snapshots are unaffected.
**Seed import can no longer hard-delete another user's program via a colliding code (#994).** The JSON seed importer's idempotent "replace existing" step keyed on the non-unique, user-assigned `Program.code`, with no ownership scope — so any authenticated user could craft a seed whose `program.slug` matched a victim program's code and hard-delete it (and every child project, task, dependency, sprint, risk, and baseline — with no tombstone). Replacement is now scoped to programs the importing user holds an OWNER membership on, and on the demo/sample path it additionally refuses to touch any program containing real (non-sample) work, mirroring the `remove-sample` guard.
**Task skill requirements now enforce membership on the target task's project (#995).** Writes were gated only by `IsOrgScheduler`, which proves the SCHEDULER role on *some* project, not the task's project — so a Scheduler on one project could create, edit, or delete skill requirements on tasks in projects they had never joined. Create, update, and delete now verify the actor holds at least SCHEDULER on the target task's project.
**Sprint scope-change endpoints no longer leak cross-project UUID existence (#996).** `SprintScopeChangeViewSet` used an unscoped queryset, so accept/reject returned 403 for an existing scope-change the caller couldn't touch and 404 for a missing one — a discriminator that let any authenticated user probe whether any scope-change UUID existed across the database. The queryset is now scoped to the caller's member projects, so non-members get a uniform 404. The write authorization gate (role ≥ ADMIN, enforced in the service layer) is unchanged.
Bumped the transitive `dompurify` dependency to 3.4.11 to clear advisory GHSA-cmwh-pvxp-8882 (medium) flagged by the OSV scanner.
- **react-router upgraded to 7.16.0**: patches a high-severity advisory chain in
  react-router 7.0.0–7.14.2 (vendored turbo-stream RCE via TYPE_ERROR
  deserialization, open redirect via protocol-relative URLs, XSS in RSC redirect
  handling, stored XSS via unescaped `Location` header, and a `__manifest` DoS).

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
