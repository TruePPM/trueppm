---
title: Architecture Decision Records
description: Where to find the canonical ADRs for TruePPM.
---

TruePPM keeps Architecture Decision Records (ADRs) at the source-of-record location in the monorepo, not in this docs site. ADRs change often during early development; mirroring them here would constantly drift.

## Where the ADRs live

📖 **[`docs/adr/` on GitLab](https://gitlab.com/trueppm/trueppm/-/tree/main/docs/adr)**

Each ADR is a markdown file using the [Michael Nygard format](https://github.com/joelparkerhenderson/architecture-decision-record/blob/main/locales/en/templates/decision-record-template-by-michael-nygard/index.md). The numbering is monotonic; status (`Proposed`, `Accepted`, `Deprecated`, `Superseded`) is in each ADR's "## Status" section.

## How the ADR corpus is organized

The repository holds 337 numbered ADRs (spanning 0001–0914), and it grows with most features. This page curates 60 of them — the records that explain the shape of the system to a new contributor or evaluator, not an index of every decision ever made. A few conventions make the set navigable:

- **Numbering is monotonic and never reused.** A higher number is a later decision, not a more important one. Numbers are assigned at merge, so they roughly track chronology.
- **Status lives in each record.** Every ADR has a `## Status` section: `Proposed` (documented, may still evolve), `Accepted`, `Deprecated`, or `Superseded` (with a pointer to the record that replaced it). A few headline records below are still `Proposed` — the decision is captured, but the ADR's own Status section is authoritative.
- **Most ADRs map to a feature.** A record usually corresponds to a GitLab issue or epic and to a page under [Features](/features/schedule/); the ADR carries the *why*, the feature page documents the *what*.
- **Amendments append, they don't rewrite.** When a decision shifts, the ADR gets an `## Amendment` section dated and explained, so the original reasoning stays legible.
- **The numbering has gaps, and that's expected.** ADR numbers are reserved per feature branch when its worktree is created, so parallel agents working different issues never claim the same number. A reservation is released — not reused — when its branch is abandoned before merge, or when its ADR is renumbered to resolve a collision with another branch that merged first (`docs/adr/0146-single-page-scroll-spy-settings-ia.md` documents one such collision in progress). As of this audit, 577 numbers are unused across 88 gap ranges. These are unallocated reservations, not deleted content. (These four figures are verified against the tree by `scripts/check-adr-status.sh`, so they cannot silently drift again.)

## Start here

If you are evaluating TruePPM, these six records explain the shape of the whole system:

- [ADR-0036](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0036-hybrid-pm-philosophy-and-sprint-model.md) — Hybrid PM philosophy and the sprint model — *the wedge document; pairs with [The Story](/the-story/)*
- [ADR-0030](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0030-p3m-navigation-shell-split.md) — P3M navigation shell split — OSS single-program vs. enterprise portfolio landing
- [ADR-0013](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0013-board-kanban-view.md) — Board / Kanban view — data model, API, and integration design
- [ADR-0037](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0037-sprint-model-data-api-and-board-integration.md) — Sprint model — data, API, and board integration
- [ADR-0027](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0027-incremental-cpm-recompute.md) — Incremental CPM recompute — subgraph delta strategy
- [ADR-0070](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0070-program-entity-oss.md) — Program entity (OSS) — the multi-project unit beneath a [program](/features/programs/)

## Decisions by area

### Scheduling engine & the hybrid bridge

- [ADR-0012](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0012-monte-carlo-api-and-oss-cap.md) — [Monte Carlo](/features/monte-carlo/) API endpoint and the OSS-tier simulation cap
- [ADR-0015](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0015-wasm-cpm-engine.md) — WASM CPM engine (Rust + wasm-pack) — accepted with deferral: conformance reference today, browser/on-device wiring is future work; the web drag preview runs a TypeScript worker
- [ADR-0027](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0027-incremental-cpm-recompute.md) — Incremental CPM recompute — subgraph delta strategy
- [ADR-0599](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0599-api-first-boundary-scheduling-compute.md) — The API-first boundary — authoritative schedule is server-side over the API; the interactive drag preview, future offline recompute, and the engine-as-library run outside it, bounded by "the server always has the last word"
- [ADR-0055](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0055-cycle-detection-on-dep-create.md) — Server-side cycle detection on dependency create / update
- [ADR-0065](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0065-hybrid-bridge-v1-1-cpm-velocity-feedback-my-work-and-inbound-sync.md) — Hybrid bridge v1.1 — CPM velocity feedback, "My Work", inbound task sync
- [ADR-0106](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0106-agile-waterfall-bridge-sprint-milestone-binding-reforecast-forecast-contract.md) — Agile/waterfall bridge — sprint↔milestone binding and reforecast-on-close

### Schedule view (canvas Gantt)

- [ADR-0040](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0040-wave3-schedule-bar-drawer-gutter.md) — [Schedule](/features/schedule/) bar render, task drawer, and the unscheduled gutter
- [ADR-0014](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0014-gantt-rendering-and-task-constraints.md) — Canvas rendering fixes and the task planned-start constraint
- [ADR-0054](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0054-schedule-build-mode-v1.md) — Schedule build mode v1 — keyboard-first build surface
- [ADR-0144](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0144-consolidated-forecast-bar-persisted-distribution-history-config.md) — Consolidated forecast bar and per-run distribution persistence

### Board & Kanban

- [ADR-0013](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0013-board-kanban-view.md) — [Board / Kanban](/features/board/) data model, API, and integration
- [ADR-0035](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0035-board-batch-3-ppm-signals.md) — PPM signals on cards (deps, overallocation, milestones, risks, keyboard)
- [ADR-0039](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0039-board-column-config-color-and-wip-limit.md) — Column config — color and WIP-limit persistence
- [ADR-0119](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0119-board-sprint-view.md) — Board sprint view
- [ADR-0145](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0145-board-find-and-fit-card-search-and-zoom.md) — Find-and-fit — full-text card search and board-local zoom
- [ADR-0159](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0159-board-pdf-export-client-side.md) — Board PDF export — client-side, boardroom-clean single page
- [ADR-0160](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0160-board-level-activity-feed.md) — Board-level activity feed (filterable, board-scoped)
- [ADR-0164](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0164-project-board-cadence-kanban-mode.md) — Project-level board cadence — first-class continuous-flow Kanban mode

### Sprints & agile delivery

- [ADR-0036](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0036-hybrid-pm-philosophy-and-sprint-model.md) — Hybrid PM philosophy and the sprint model
- [ADR-0037](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0037-sprint-model-data-api-and-board-integration.md) — Sprint model — data, API, and board integration
- [ADR-0073](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0073-sprint-planning-capacity-and-board-panel.md) — [Sprint](/features/sprints/) planning capacity, board sprint panel, velocity sparkline
- [ADR-0094](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0094-sprint-states-state-aware-workspace.md) — Sprint states — state-aware planning and closed views
- [ADR-0102](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0102-sprint-scope-injection-approve-gate.md) — Sprint scope-injection approve-gate (pending-acceptance state)
- [ADR-0113](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0113-sprint-exclude-from-velocity-and-setup-iteration-guidance.md) — Sprint `exclude_from_velocity` flag and Sprint-0 / setup-iteration guidance

### Programs & multi-project coordination (OSS)

- [ADR-0070](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0070-program-entity-oss.md) — Program entity (OSS)
- [ADR-0069](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0069-dual-level-backlog-program-backlog-item-and-project-backlog.md) — Dual-level backlog — program `BacklogItem` and project backlog
- [ADR-0095](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0095-program-navigation-in-topbar.md) — Program navigation moves to the global top bar
- [ADR-0120](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0120-cross-project-dependencies-within-program.md) — Cross-project dependencies within a program — program-scoped CPM pass

### Settings, RBAC & administration

- [ADR-0011](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0011-object-change-history.md) — Object change history (configurable retention — default 90 days)
- [ADR-0146](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0146-single-page-scroll-spy-settings-ia.md) — Single-page scroll-spy settings IA
- [ADR-0072](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0072-role-ordinals-extension-point.md) — Role ordinals as an enterprise extension point
- [ADR-0153](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0153-inheritable-attachment-policy.md) — Inheritable attachment policy with per-scope override
- [ADR-0157](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0157-oss-operational-audit-log.md) — OSS operational audit log + enterprise-signing extension point

### Real-time, sync & platform conventions

- [ADR-0091](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0091-per-task-websocket-cpm-date-deltas.md) — Per-task WebSocket CPM date deltas
- [ADR-0089](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0089-webhook-sequence-in-delivered-body.md) — Webhook delivery sequence number in the delivered body
- [ADR-0019](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0019-outbound-webhooks.md) — Outbound webhooks for project state changes
- [ADR-0141](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0141-websocket-short-lived-ticket-auth.md) — Short-lived ticket for the WebSocket handshake
- [ADR-0016](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0016-short-hex-object-ids.md) — Short hex object IDs — human-readable, project-scoped identifiers
- [ADR-0086](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0086-schema-version-convention-for-user-saved-json-state.md) — `schema_version` convention for user-saved JSON state
- [ADR-0125](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0125-rest-over-graphql-related-data-conventions.md) — Stay on REST / DRF — related-data fetching over a GraphQL migration
- [ADR-0142](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0142-sync-watermark-column-and-cpm-working-day-index.md) — Sync watermark column and CPM working-day index

### Design system & the v2 interface shell

- [ADR-0002](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0002-ui-harmonization.md) — UI harmonization — chrome, Gantt colors, design-token gaps
- [ADR-0103](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0103-design-system-v2-navy-sage-rebrand.md) — Design System v2.0 — navy/sage rebrand and brand-token architecture — superseded by [ADR-0126](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0126-design-system-v2-golden-standard.md)
- [ADR-0134](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0134-v2-unified-shell-bar.md) — v2 unified shell bar — collapse the two-row top region into one
- [ADR-0127](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0127-v2-context-bar-shell-slice-2.md) — v2 context bar — presence and live health drill-through
- [ADR-0128](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0128-v2-grouped-view-bar-health-cluster.md) — v2 grouped PLAN / TRACK / PEOPLE view bar + methodology-adaptive health cluster
- [ADR-0131](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0131-context-aware-create-affordance.md) — Context-aware, role-aware "+ New" affordance and create-intent dispatch

### OSS / Enterprise boundary, integrations & the AI-native foundation

- [ADR-0029](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0029-frontend-slot-registry-and-edition-detection.md) — Frontend slot registry and edition detection
- [ADR-0030](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0030-p3m-navigation-shell-split.md) — Navigation shell split — OSS single-program vs. enterprise portfolio
- [ADR-0049](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0049-external-integration-extension-points.md) — External integration extension points (task links, outgoing channels, notifications)
- [ADR-0097](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0097-user-scoped-external-task-sync.md) — User-scoped read-only external task sync (personal pull) — the OSS integration carve-out
- [ADR-0104](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0104-unified-team-signal-privacy-model.md) — Unified team-signal privacy model + enterprise rollup extension point
- [ADR-0077](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0077-mcp-server-scope-and-edition-boundary.md) — MCP server scope, edition boundary, and token-scope model — the 0.4 read-only release split is superseded by [ADR-0186](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0186-read-only-mcp-server-oss-scaffold-and-read-tools.md)
- [ADR-0112](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0112-ai-layer-oss-extension-points.md) — AI-layer OSS extension points — agent-as-actor and signed-answer provenance
- [ADR-0362](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0362-plan-grounded-governance-one-surface.md) — Plan-grounded governance — the "computed, not guessed" positioning frame (layer, don't invert)

### Data exchange & import / export

- [ADR-0021](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0021-msproject-import-export.md) — MS Project import / export
- [ADR-0068](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0068-inbound-task-sync-protocol-project-api-tokens-audit-and-status-map.md) — Inbound task-sync protocol — project API tokens, audit, status map
- [ADR-0114](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0114-seed-schema-v2-relative-dates-event-replay.md) — Seed schema v2 — relative-date anchors and event replay with backdated history

The methodology overlay that ties these together is [ADR-0041](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/0041-project-methodology-tab-visibility.md) — the project [methodology preset](/features/methodology-preset/) that drives tab visibility per planning model.

## Why ADRs?

Decisions matter more than code; code can change in a refactor, but the *why* is gone unless captured. ADRs prevent re-litigating the same trade-offs every quarter and give new contributors a way to understand the system without interrogating its authors.
