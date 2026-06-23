---
title: Architecture Decision Records
description: Where to find the canonical ADRs for TruePPM.
---

TruePPM keeps Architecture Decision Records (ADRs) at the source-of-record location in the monorepo, not in this docs site. ADRs change often during early development; mirroring them here would constantly drift.

## Where the ADRs live

📖 **[`docs/adr/` on GitLab](https://gitlab.com/trueppm/trueppm/-/tree/main/docs/adr)**

Each ADR is a markdown file using the [Michael Nygard format](https://github.com/joelparkerhenderson/architecture-decision-record/blob/main/locales/en/templates/decision-record-template-by-michael-nygard/index.md). The numbering is monotonic; status (`Proposed`, `Accepted`, `Deprecated`, `Superseded`) is in each ADR's "## Status" section.

## How the ADR corpus is organized

The repository holds more than 160 numbered ADRs, and it grows with most features. A few conventions make the set navigable:

- **Numbering is monotonic and never reused.** A higher number is a later decision, not a more important one. Numbers are assigned at merge, so they roughly track chronology.
- **Status lives in each record.** Every ADR has a `## Status` section: `Proposed` (documented, may still evolve), `Accepted`, `Deprecated`, or `Superseded` (with a pointer to the record that replaced it). Several headline records below are still `Proposed` — the decision is captured, but the ADR's own Status section is authoritative.
- **Most ADRs map to a feature.** A record usually corresponds to a GitLab issue or epic and to a page under [Features](/features/schedule/); the ADR carries the *why*, the feature page documents the *what*.
- **Amendments append, they don't rewrite.** When a decision shifts, the ADR gets an `## Amendment` section dated and explained, so the original reasoning stays legible.

## Start here

If you are evaluating TruePPM, these six records explain the shape of the whole system:

- **ADR-0036** — Hybrid PM philosophy and the sprint model — *the wedge document; pairs with [The Story](/the-story/)*
- **ADR-0030** — P3M navigation shell split — OSS single-program vs. enterprise portfolio landing
- **ADR-0013** — Board / Kanban view — data model, API, and integration design
- **ADR-0037** — Sprint model — data, API, and board integration
- **ADR-0027** — Incremental CPM recompute — subgraph delta strategy
- **ADR-0070** — Program entity (OSS) — the multi-project unit beneath a [program](/features/programs/)

## Decisions by area

### Scheduling engine & the hybrid bridge

- **ADR-0012** — [Monte Carlo](/features/monte-carlo/) API endpoint and the OSS-tier simulation cap
- **ADR-0015** — WASM CPM engine (Rust + wasm-pack) for sub-100 ms on-device recompute
- **ADR-0027** — Incremental CPM recompute — subgraph delta strategy
- **ADR-0055** — Server-side cycle detection on dependency create / update
- **ADR-0065** — Hybrid bridge v1.1 — CPM velocity feedback, "My Work", inbound task sync
- **ADR-0106** — Agile/waterfall bridge — sprint↔milestone binding and reforecast-on-close

### Schedule view (canvas Gantt)

- **ADR-0040** — [Schedule](/features/schedule/) bar render, task drawer, and the unscheduled gutter
- **ADR-0014** — Canvas rendering fixes and the task planned-start constraint
- **ADR-0054** — Schedule build mode v1 — keyboard-first build surface
- **ADR-0144** — Consolidated forecast bar and per-run distribution persistence

### Board & Kanban

- **ADR-0013** — [Board / Kanban](/features/board/) data model, API, and integration
- **ADR-0035** — PPM signals on cards (deps, overallocation, milestones, risks, keyboard)
- **ADR-0039** — Column config — color and WIP-limit persistence
- **ADR-0119** — Board sprint view
- **ADR-0145** — Find-and-fit — full-text card search and board-local zoom
- **ADR-0159** — Board PDF export — client-side, boardroom-clean single page
- **ADR-0160** — Board-level activity feed (filterable, board-scoped)
- **ADR-0164** — Project-level board cadence — first-class continuous-flow Kanban mode

### Sprints & agile delivery

- **ADR-0036** — Hybrid PM philosophy and the sprint model
- **ADR-0037** — Sprint model — data, API, and board integration
- **ADR-0073** — [Sprint](/features/sprints/) planning capacity, board sprint panel, velocity sparkline
- **ADR-0094** — Sprint states — state-aware planning and closed views
- **ADR-0102** — Sprint scope-injection approve-gate (pending-acceptance state)
- **ADR-0113** — Sprint `exclude_from_velocity` flag and Sprint-0 / setup-iteration guidance

### Programs & multi-project coordination (OSS)

- **ADR-0070** — Program entity (OSS)
- **ADR-0069** — Dual-level backlog — program `BacklogItem` and project backlog
- **ADR-0095** — Program navigation moves to the global top bar
- **ADR-0120** — Cross-project dependencies within a program — program-scoped CPM pass

### Settings, RBAC & administration

- **ADR-0011** — Object change history (configurable retention — default 90 days)
- **ADR-0146** — Single-page scroll-spy settings IA
- **ADR-0072** — Role ordinals as an enterprise extension point
- **ADR-0153** — Inheritable attachment policy with per-scope override
- **ADR-0157** — OSS operational audit log + enterprise-signing extension point

### Real-time, sync & platform conventions

- **ADR-0091** — Per-task WebSocket CPM date deltas
- **ADR-0089** — Webhook delivery sequence number in the delivered body
- **ADR-0019** — Outbound webhooks for project state changes
- **ADR-0141** — Short-lived ticket for the WebSocket handshake
- **ADR-0016** — Short hex object IDs — human-readable, project-scoped identifiers
- **ADR-0086** — `schema_version` convention for user-saved JSON state
- **ADR-0125** — Stay on REST / DRF — related-data fetching over a GraphQL migration
- **ADR-0142** — Sync watermark column and CPM working-day index

### Design system & the v2 interface shell

- **ADR-0002** — UI harmonization — chrome, Gantt colors, design-token gaps
- **ADR-0103** — Design System v2.0 — navy/sage rebrand and brand-token architecture
- **ADR-0134** — v2 unified shell bar — collapse the two-row top region into one
- **ADR-0127** — v2 context bar — presence and live health drill-through
- **ADR-0128** — v2 grouped PLAN / TRACK / PEOPLE view bar + methodology-adaptive health cluster
- **ADR-0131** — Context-aware, role-aware "+ New" affordance and create-intent dispatch

### OSS / Enterprise boundary, integrations & the AI-native foundation

- **ADR-0029** — Frontend slot registry and edition detection
- **ADR-0030** — Navigation shell split — OSS single-program vs. enterprise portfolio
- **ADR-0049** — External integration extension points (task links, outgoing channels, notifications)
- **ADR-0097** — User-scoped read-only external task sync (personal pull) — the OSS integration carve-out
- **ADR-0104** — Unified team-signal privacy model + enterprise rollup extension point
- **ADR-0077** — MCP server scope, edition boundary, and token-scope model
- **ADR-0112** — AI-layer OSS extension points — agent-as-actor and signed-answer provenance

### Data exchange & import / export

- **ADR-0021** — MS Project import / export
- **ADR-0068** — Inbound task-sync protocol — project API tokens, audit, status map
- **ADR-0114** — Seed schema v2 — relative-date anchors and event replay with backdated history

The methodology overlay that ties these together is **ADR-0041** — the project [methodology preset](/features/methodology-preset/) that drives tab visibility per planning model.

## Why ADRs?

Decisions matter more than code; code can change in a refactor, but the *why* is gone unless captured. ADRs prevent re-litigating the same trade-offs every quarter and give new contributors a way to understand the system without interrogating its authors.
