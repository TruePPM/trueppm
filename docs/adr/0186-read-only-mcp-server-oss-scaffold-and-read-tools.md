# ADR-0186: Read-only MCP server — OSS scaffold, read-tool surface, and the token-auth model for 0.4

## Status
Accepted

Accepted for 0.4 with the product owner's decision points resolved:

- **Decision point 1 (auth, §E):** confirmed — **#601 is implemented as the
  *minimal* scope slice** (the `scopes` `ArrayField` with a `legacy:full` backfill,
  the single new `mcp:read` scope, and the `TokenHasScope` defense-in-depth class).
  The full scope system (`team_internals:read`, `TeamInternalsOptIn`, the #599 Team
  entity, the #602 notification) stays deferred to the 0.6 write/internals work.
- **Decision point 2 (deployment, §H):** confirmed — the **Dockerfile is in scope**
  for the scaffold; **no Helm / in-cluster deployment in 0.4** (stdio runs the server
  client-side as a subprocess). A shared multi-user HTTP/SSE endpoint is a separable
  later follow-up.
- **Decision point 3 (issue consolidation, §J):** confirmed — **#603 is the
  umbrella/tracking issue for #503 (scaffold) + #504 (read tools)**; the work is
  designed once, here, not re-derived under ADR-0077's superseded approach.

**Delivery sequencing.** The 0.4 read-only MCP deliverable lands across three MRs,
all tracked under the **#603 umbrella**: (1) **#503 — this scaffold** (`packages/mcp/`
FastMCP package, project-API-token bearer auth, stdio + HTTP/SSE transports,
Dockerfile, `mcp:lint`/`mcp:typecheck`/`mcp:test` CI jobs, empty tool list); then
(2) **#601 — the minimal token-scope slice** (`ApiToken.scopes` + `legacy:full`
backfill + `mcp:read` + `TokenHasScope` + write-endpoint rejection), which also wires
`ProjectApiTokenAuthentication` onto the read viewsets the MCP wraps; then (3) **#504
— the ~13 read tools** plus the additive `ProjectSerializer.my_role` field (F). The
scaffold's auth machinery is mock-tested in isolation because end-to-end project-token
auth on the read endpoints is wired by MR (2).

Supersedes the 0.4-relevant parts of **ADR-0077** (MCP server scope, edition
boundary, token-scope model). ADR-0077 §A (OSS edition) and §F (health bands
computed at the API layer) are **retained**; its §B/§D/§E/§L (release split,
OpenAPI-generated tools, the 4-layer `team_internals` scope system, and the
embedded `packages/api/mcp/` packaging), and its 2026-06-06 erratum re-slotting
MCP to 0.6, are **superseded** by this ADR for the 0.4 read-only deliverable.

## Context

Read-only MCP is one of the two 0.4 beta headliners (the other is the native
mobile editor). The roadmap — the single source of truth — describes it as:

> point any MCP client (Claude Desktop and the like) at your self-hosted instance
> and ask real questions of the live schedule: critical path, a non-mutating Monte
> Carlo what-if, sprint status and velocity, the risk register, and My Work. Every
> answer is computed server-side by the same CPM/Monte Carlo engine the UI uses —
> never an LLM guess, never leaving your box. Read-only by design; write tools are
> deliberately held to 0.6.

Three issues describe the work: **#503** (FastMCP package scaffold + API-token
auth + Dockerfile), **#504** (read tools: projects, tasks, board, schedule,
risks), and **#603** (read-only adapter over OSS APIs). #1078 adds an AI-agent
actor note to the persona set.

An earlier design, **ADR-0077 v3**, already exists and is elaborate: a separate
process embedded under `packages/api/mcp/`, MCP tools **generated from
`openapi.json`** at build time (with `mcp-exposed` operation tags and two new CI
lints), and a **4-layer defense-in-depth token-scope model** with four scopes
(`project:read`, `sprint:read`, `team_internals:read`, `program:read`), a new
`TeamInternalsOptIn` consent model, a first-use fan-out notification, and a hard
dependency on a new **Team entity (#599)**, **ApiToken scopes (#601)**, and
**Notification source_type (#602)**. ADR-0077 then carried a 2026-06-06 erratum
re-slotting the whole thing to **0.6** with read **and** write together.

Two things have changed since ADR-0077 was written, and they reframe the decision:

1. **The 0.4 scope rebalance** (105 issues moved to 0.5) deliberately re-centered
   0.4 on the field PM — mobile and **read-only MCP** — and held the agile/team
   surfaces that ADR-0077's heavy scope model was built to protect. So the
   erratum's "0.6, read+write together" is itself superseded: read-only MCP is
   back at 0.4 as a headliner, and the rich sprint-internals surface it gated is
   not part of the 0.4 read tools.

2. **The actual 0.4 read surface (#504) exposes nothing per-individual.** It is
   project/task/board/schedule/risk/program metadata plus sprint *health bands and
   aggregates* — exactly the data the requesting user can already read in the web
   UI under their existing RBAC role. There is no raw per-person velocity, no
   scope-change-author audit, no per-individual allocation in the 0.4 surface.
   With nothing consent-sensitive exposed, there is nothing for ADR-0077's
   `team_internals:read` scope, `TeamInternalsOptIn` consent, and first-use
   notification to gate — so that entire apparatus (and its #599/#602
   prerequisites) is off the 0.4 critical path.

This ADR settles, for the 0.4 read-only deliverable: edition, release, packaging,
the tool surface mapped to concrete endpoints, the auth model and the open #601
question, the deployment surface, and the API-first/RBAC-preserving guarantee.

This document was produced by applying the `architect` discipline directly
(design questions, alternatives, trade-offs, consequences, boundary check) rather
than re-deriving ADR-0077 from scratch.

## Decision

### A. Edition: OSS (reaffirmed)

A read-only MCP server over the existing OSS REST API is **OSS**, per ADR-0077 §A
and the `CLAUDE.md` AI carve-out: *personal/team read-only AI over OSS APIs is
OSS; org-wide AI governance is Enterprise.* It is a thin protocol adapter that
exposes engine outputs the requesting user can already read — not AI scheduling
(it does not replace CPM with a model), not cross-program/portfolio coordination,
not org identity governance. The package never imports `trueppm_enterprise`; the
dependency direction stays one-way (enterprise → core). Enterprise may later
register additional tools wrapping Enterprise-only endpoints through its own
provider registry; that is out of scope here.

### B. Release: read-only ships in 0.4; writes stay at 0.6

Read-only MCP ships in **0.4** as a headliner. The write surface (#505/#604),
session auth, and any richer sprint-internals surface stay at **0.6**. This
supersedes ADR-0077 §B (read in "0.3") and its erratum (read+write together in
0.6). The technical reason ADR-0077 gave for waiting — *build the adapter only
against frozen APIs* — is satisfied: the 0.4 read surface wraps endpoints that are
stable as of 0.3 (projects, tasks, board-config, forecast, monte-carlo/latest,
risks, sprints, programs, me/work), not endpoints being created in 0.4.

### C. Packaging: a standalone `packages/mcp/` API client — not embedded in Django

New top-level package **`packages/mcp/`** (Python, `trueppm-mcp` on PyPI), built
on **FastMCP**, that talks to TruePPM **only over HTTP** via `httpx`. This
supersedes ADR-0077 §L (`packages/api/mcp/`, embedded next to Django).

Rationale — this is the strongest possible expression of the API-first principle
and the load-bearing security property of the whole design:

- The MCP process **never imports Django, never touches the ORM or the database,
  never imports `trueppm_enterprise`.** It is a pure client of the public REST
  API. Every tool is an `httpx` GET against `/api/v1/...` carrying the user's
  `Authorization: Bearer <token>`.
- Because it is "just another API client", **RBAC, member-scoped querysets, and
  the 404-vs-403 existence oracle (ADR-0184, #996) are enforced by the API layer
  unchanged** — there is no second, weaker copy of the permission model to keep in
  sync. The MCP server cannot see anything the same user with the same token
  cannot see through the web client.
- It decouples MCP release and deployment from the API image (the Trivy gate, the
  `psycopg`/libpq stack, etc.). The MCP package ships and versions independently.

Transport: **stdio is the 0.4 primary** (the AI client spawns the server as a
local subprocess via `claude_desktop_config.json`, pointing at the self-hosted API
URL with the user's token); **HTTP/SSE is secondary** for web-based assistants.

### D. Tools: hand-authored FastMCP tools over `httpx`, not OpenAPI-generated

The 0.4 tool surface is small (≈13 tools) and stable. Each tool is a hand-authored
`@mcp.tool()` function that issues one (occasionally two) `httpx` GET(s) and
shapes a compact result. This supersedes ADR-0077 §D (build-time OpenAPI schema
walk + `mcp-exposed` operation tags + `check-mcp-schema-drift.py` +
`check-mcp-schema-descriptions.py`).

Rationale: hand-authoring gives precise control over #504's context-budget
contract that a mechanical schema walk cannot express — omit null fields, truncate
long descriptions to 200 chars with a `truncated: true` flag, compose the board
state from two endpoints, and enrich `caller_role`. Standing up an `mcp-exposed`
tagging convention plus two new CI lints is disproportionate machinery for ~13
read tools. Generation can be revisited when the 0.6 write surface multiplies the
tool count.

### E. Auth model and the #601 question — read-only-by-construction + a minimal token read-marker

This is the central open question for 0.4: **does read-only MCP need the #601
ApiToken-scopes system, or is read-only-by-construction enough?**

**Decision: read-only-by-construction is the primary guarantee; a *minimal* token
read-marker is required as defense-in-depth; the *full* #601 scope system
(`team_internals:read`, `TeamInternalsOptIn`, the #599 Team entity, the #602
notification) is NOT needed for 0.4 and is deferred to the 0.6 write/internals
work.**

Two facts drive this:

1. **The server is read-only by construction.** It authenticates as a normal
   `ApiToken` (ADR-0068): `ProjectApiTokenAuthentication` returns
   `(token.created_by, token)`, so `request.user` is the token's creator and RBAC
   is enforced exactly as for the web client. The MCP server defines **only read
   tools** and issues **only GET requests**. A Viewer's token sees Viewer data; no
   escalation is possible.

2. **But today's ADR-0068 token carries write authority** over the inbound
   task-sync surface (`POST .../task-sync/`), and an MCP token is **distributed to
   desktop AI clients** — a far larger exposure surface than a server-to-server
   inbound-sync token sitting in CI. "The server only calls GETs" does not protect
   a leaked token that is replayed *directly* against the write endpoint.
   **Therefore a read-distributed token must be markable read-only at the token
   layer** — server-side read-only-by-construction is necessary but not
   sufficient.

The minimal sufficient change is a coarse read-only capability on `ApiToken`. We
choose a **minimal slice of #601** over a bare boolean:

- Add the `scopes` `ArrayField` with a migration that **backfills every existing
  token with `legacy:full`** (preserves all current inbound-sync write behavior).
- Add exactly **one** new read scope — `mcp:read` — minted for MCP tokens.
- Add the `TokenHasScope` permission class (tiny, composable) and apply it as a
  defense-in-depth class on the read viewsets the MCP wraps; the inbound write
  view rejects any token lacking `legacy:full` (i.e. an `mcp:read` token cannot
  write).
- **Drop** from 0.4: `team_internals:read`, `sprint:read`, `program:read`,
  `TeamInternalsOptIn`, the first-use fan-out notification, and the #599 Team-entity
  and #602 Notification prerequisites. None has a trigger in the 0.4 read surface
  (Decision G), and the `scopes` field is forward-compatible — 0.6 can add more
  scopes and the consent model additively, with no migration churn.

We prefer the 1-scope slice to a `read_only` boolean because it is the same
migration cost, it preserves existing tokens identically (`legacy:full`), and it
lands the exact field and permission class the 0.6 write/internals surface will
extend — avoiding a later boolean→scopes migration. This keeps the MCP **not** the
security boundary: REST enforces the scope independently (ADR-0077 §E layer 3
survives in minimal form), and the MCP dispatcher simply never offers a write tool.

### F. Token issuance and the `caller_role` enrichment

- MCP tokens are minted through the **existing** project/program API-token UI and
  endpoints (`/projects/{id}/api-tokens/`), with the new `mcp:read` scope. No new
  auth primitive; the raw token is shown once and stored as a SHA-256 hash exactly
  as today.
- #504 requires `caller_role` on `list_projects` / `get_project`. `ProgramSerializer`
  already exposes `my_role` / `my_role_label`; **`ProjectSerializer` does not.**
  Per the API-first principle, `caller_role` must come from the authoritative API,
  not be inferred in the MCP server. The #504 implementation therefore adds
  `my_role` / `my_role_label` to `ProjectSerializer` (a small additive,
  annotation-backed serializer change mirroring `ProgramSerializer`); the MCP tool
  passes it through as `caller_role`.

### G. The 0.4 read-tool surface (tool → endpoint)

All read-only; all `GET /api/v1/...`; all gated by the user's existing RBAC at the
API layer. `*` marks the #504 acceptance MVP.

| Tool | Endpoint(s) | View / serializer |
|---|---|---|
| `list_projects`* | `GET /projects/` (+ `my_role` enrichment, F) | `ProjectViewSet` / `ProjectSerializer` |
| `get_project`* | `GET /projects/{id}/` + `GET /projects/{id}/overview/` (health) | `ProjectViewSet` / `ProjectDetailSerializer` + `ProjectOverviewView` |
| `list_tasks`* | `GET /tasks/?project=&status=&mine=&sprint=&is_critical=&type=&updated_after=` | `TaskViewSet` / `TaskSerializer` |
| `get_task`* | `GET /tasks/{id}/` | `TaskViewSet` / `TaskSerializer` |
| `get_board_state`* | `GET /projects/{id}/board-config/` + `GET /tasks/?project=` (composed columns+cards) | `BoardColumnConfigView` + `TaskViewSet` |
| `get_schedule_summary`* | `GET /projects/{id}/forecast/` (+ `/tasks/?is_critical=true` count) | `ProjectForecastView` |
| `list_risks`* | `GET /projects/{id}/risks/` | `RiskViewSet` / `RiskSerializer` |
| `get_monte_carlo_forecast` | `GET /projects/{id}/monte-carlo/latest/` (P50/P80/P95, cpm_finish, delta) | `MonteCarloLatestView` |
| `list_sprints` | `GET /projects/{id}/sprints/` | `SprintViewSet` / `SprintSerializer` |
| `get_sprint` | `GET /sprints/{id}/` (+ `/projects/{id}/sprint-health/` band) | `SprintViewSet` + `ProjectSprintHealthView` |
| `list_my_work` | `GET /me/work/` | `MeWorkView` / `MeWorkTaskSerializer` |
| `list_programs` | `GET /programs/` (`my_role` already present) | `ProgramViewSet` / `ProgramSerializer` |
| `get_program_health` | `GET /programs/{id}/rollup/` (single-program rollup only) | `ProgramViewSet.rollup` |
| `whoami` (connection verify) | `GET /auth/me/` | `MeView` |

Sprint tools return **health bands and aggregates only** (per ADR-0077 §F,
retained) — no raw per-person velocity or scope-change-author audit. Program
health is a **single-program** rollup; cross-program is Enterprise.

**Deferred from 0.4 (flagged, not built):** the roadmap's *non-mutating Monte
Carlo what-if* ("slip this task three days — when do we ship?") requires a
**non-mutating** what-if endpoint (tracked by #993). A read MCP tool may wrap it
only once such an endpoint exists and is provably side-effect-free; until then the
read surface ships `get_monte_carlo_forecast` (latest persisted run) and the
what-if tool is held. This keeps the read MCP from triggering a schedule
recompute write.

### H. Deployment surface

- **Dockerfile: in scope** for the #503 scaffold — a single-stage image whose
  entry point runs the server (stdio by default; HTTP/SSE via flag). This lets an
  operator self-run the HTTP transport for web assistants.
- **Helm chart addition: out of scope for the 0.4 scaffold.** The 0.4 primary
  model is stdio — the server runs **client-side** as a subprocess next to the
  user's AI client, reaching the self-hosted API over HTTPS. No in-cluster
  component is required for that path. An in-cluster HTTP/SSE deployment (a shared
  multi-user MCP endpoint) is a later, separable follow-up and is **noted here as
  out of scope** rather than silently assumed. (🔴 for Kelly to confirm — Decision
  point 2.)

### I. API-first / RBAC-preserving guarantee (the load-bearing property)

Stated explicitly so it cannot drift:

- The MCP server **never** accesses the database or the Django ORM. Every read is
  an `httpx` GET against `/api/v1/...`.
- The MCP server **never** imports `trueppm_enterprise` (verified by the existing
  `grep -r "trueppm_enterprise" packages/` boundary check, which now covers
  `packages/mcp/`).
- All authorization — RBAC role gates, member-scoped querysets, object permissions,
  the 404-vs-403 existence oracle — is enforced by the **API layer**, identically
  for the MCP client and the web client. The MCP server holds **no** privileged
  path and is **not** the security boundary.
- Read-only-by-construction (no write tools, GET-only) plus the `mcp:read` token
  marker (no write authority even if the token is replayed directly) together make
  the read MCP safe to distribute to a desktop AI client.

### J. Issue consolidation

#503 (scaffold) and #504 (read tools) are the concrete deliverables. **#603**
("read-only adapter over OSS APIs") describes the same adapter under ADR-0077's
now-superseded generated/scope-gated approach; it should be re-pointed as the
umbrella/tracking issue for #503+#504 (or closed as superseded by this ADR), so
the work is not designed twice. (🔴 for Kelly to confirm — Decision point 3.)

## Consequences

**Positive**
- Headliner unblocked without the #599 Team entity, #602 notification, or the
  `TeamInternalsOptIn` consent system on the critical path — a much smaller 0.4
  surface than ADR-0077 proposed.
- Strongest API-first posture: a process with zero DB/ORM/enterprise access, so
  RBAC has exactly one enforcement point and the MCP cannot leak more than the
  user can already read.
- The `scopes` slice is forward-compatible: 0.6 adds write scopes and the richer
  internals consent model additively, with no migration to undo a boolean.
- Independent packaging/versioning; the MCP image is decoupled from the API image's
  build and scan constraints.

**Negative**
- Two diverging MCP design records exist (ADR-0077 and this one); the supersession
  scope must be read carefully. Mitigated by the explicit retain/supersede note in
  the Status block.
- A small additive `ProjectSerializer.my_role` change is required for `caller_role`
  (F) — a serializer + annotation touch, plus an OpenAPI regenerate.
- Hand-authored tools must be kept in step with serializer changes manually (no
  generation safety net); mitigated by the small, stable surface and pytest
  coverage of each tool's shape.

**Risks**
- LLM clients may narrate health bands into productivity surveillance despite
  framing. Mitigated structurally: the 0.4 surface exposes **no** per-individual
  internals, so there is no raw data to launder; the consent gate arrives with the
  richer surface in 0.5/0.6.
- Roadmap copy says "per-team token scopes keep sprint internals private"; in 0.4
  the privacy comes from **not exposing** raw internals rather than from a per-team
  scope gate. The copy should be softened (the per-team gate lands with the richer
  surface later) — a roadmap-copy note for Kelly, not a blocker.

## Alternatives considered

- **Implement ADR-0077 as written (full 4-scope model, Team entity #599,
  TeamInternalsOptIn, first-use notification, OpenAPI-generated tools, embedded
  `packages/api/mcp/`).** Rejected for 0.4: it pulls three heavyweight
  prerequisites and two new CI lints onto the headliner's critical path to protect
  a sprint-internals surface that 0.4 does not expose. Its valuable ideas
  (bands-at-API, scopes-as-defense-in-depth) survive in minimal form.
- **No token change at all — rely purely on "the server only calls GETs."**
  Rejected: an ADR-0068 token carries write authority and is now distributed to
  desktop clients; a leaked/replayed token could write directly. A read-distributed
  token must be read-marked at the token layer.
- **A bare `read_only` boolean on `ApiToken`.** Workable, but the same migration
  cost as the 1-scope `scopes` slice while forcing a later boolean→scopes migration
  when the write surface lands. Rejected in favor of the forward-compatible slice.
- **Embed the MCP server in the Django process (ADR-0077 §L).** Rejected: it
  tempts direct ORM access, couples MCP to the API image, and creates a second
  permission surface. The standalone HTTP-client design makes the API-first/RBAC
  guarantee structural rather than aspirational.

## References

- ADR-0077 — MCP server scope, edition boundary, token-scope model (retained §A,
  §F; superseded §B/§D/§E/§L + erratum)
- ADR-0068 — inbound task-sync protocol, project API tokens, audit, status-map
- ADR-0112 — AI-layer OSS extension points
- ADR-0184 / #996 — RBAC defense-in-depth and the 404-vs-403 existence oracle
- Issues #503 (scaffold), #504 (read tools), #603 (adapter — to consolidate),
  #601 (ApiToken scopes — minimal slice adopted), #599 (Team entity — deferred),
  #602 (Notification source_type — deferred), #993 (non-mutating MC what-if),
  #1078 (AI-agent actor persona note)
- `CLAUDE.md` — OSS/Enterprise boundary and the AI carve-out
- `packages/website/src/content/docs/overview/roadmap.md` — 0.4 headliner (source
  of truth for release/tense)
