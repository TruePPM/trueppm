# ADR-0077: MCP Server Scope, Edition Boundary, and Token-Scope Model

## Status: Proposed (v3 — post-architect); **release split superseded by [ADR-0186](0186-read-only-mcp-server-oss-scaffold-and-read-tools.md)**

> **Erratum (2026-07-08) — release slot reconciled: read-only ships in 0.4, writes in 0.6.**
> This supersedes the 2026-06-06 erratum below (kept for history). Issue #1449 flagged a
> contradiction between this ADR's "everything at 0.6" erratum and the roadmap, which lists
> a **read-only MCP server as a 0.4 headliner**. The roadmap
> (`packages/website/src/content/docs/overview/roadmap.md`, the single source of truth) is
> correct and authoritative:
>
> - **Read-only MCP → 0.4** (headliner). Designed in
>   [ADR-0186](0186-read-only-mcp-server-oss-scaffold-and-read-tools.md) (Accepted), which
>   **supersedes this ADR's §B/§D/§E/§L** (the release split, OpenAPI-generated tool model,
>   the 4-layer `team_internals` scope system, and the embedded `packages/api/mcp/`
>   packaging) **for the 0.4 read-only deliverable**. It lands across three MRs under the
>   #603 umbrella: #503 scaffold (`packages/mcp/`), #601 minimal `mcp:read` token-scope
>   slice, and #504 the read tools. This ADR's §A (OSS edition) and §F (health bands
>   computed at the API layer) are **retained** by ADR-0186.
> - **Write surface (create/update task, move card, log time), session auth, and the full
>   4-layer scope system → 0.6** ("open & portable"), tracked under #505/#604 with
>   prerequisites #599 (per-team opt-in UX) and #602 (Notification `source_type`). #601's
>   full scope system beyond the `mcp:read` slice also defers here.
>
> The *technical* reasoning in §B still holds: the adapter targets the committed OpenAPI
> schema (§D), so tools should follow API freeze. The read surfaces the 0.4 tools wrap
> (schedule, critical path, Monte Carlo what-if, sprint status, risk register, My Work) are
> stable enough to freeze at 0.4; the write surface is deliberately held to 0.6 so
> automation never lands against a moving mutation API. When reading the section bodies
> below, treat their release numbers as historical — [ADR-0186](0186-read-only-mcp-server-oss-scaffold-and-read-tools.md)
> is the release-slot authority for the read-only work and the roadmap is the source of truth.

> **Erratum (2026-06-06) — release re-slot to 0.6 [SUPERSEDED 2026-07-08, see above].**
> This ADR's §B/§D/§M describe a
> read-only-in-0.3 / writes-in-0.4 split. That split is superseded. Following the
> 2026-05-25 persona-per-release roadmap rebalance, the MCP server is slotted to
> **0.6 — "open & portable"**, shipping read **and** write together, framed as an
> interoperability surface. The roadmap (`packages/website/src/content/docs/overview/roadmap.md`,
> the single source of truth) and all eight tracking issues (#503/#504/#505 scaffold/read/write,
> prerequisites #599/#601/#602, and umbrella #603/#604) are on 0.6.
>
> The *technical* reasoning in §B is unchanged and is in fact why 0.6 is correct: the
> adapter is generated from the committed OpenAPI schema (§D), so it should target APIs
> only after they freeze. The agile/sprint/forecast/team surfaces it wraps are created
> and reshaped across 0.3→0.5; they stabilize by ~0.5, making 0.6 the first release
> where the tool surface is stationary. The Team-entity *core* prerequisite (§C.1) has
> partially landed early via #927 (0.3); the remaining prerequisites (#599 per-team
> opt-in UX, #601 ApiToken scopes, #602 Notification source_type) remain at 0.6.
> Read "0.3" as "first frozen-API release" and "0.4" as "the following release" when
> reading the section bodies below; the absolute version numbers are 0.6 and beyond.

(Numbered 0077 to leave 0076 for the *Integration Management Surface Boundary* ADR, which is conceptually a prerequisite — it settles workspace-vs-project integration scope before MCP adds a new integration surface.)

## Context

The 0.3 roadmap line in `README.md` lists "MCP server integration" alongside epic task type, unified sprint planning, and multi-team agile. Two questions need settling before code is written:

1. **What edition does it belong in?** TruePPM's boundary doc lists "AI scheduling" as Enterprise, but an MCP server exposing OSS APIs is a thin protocol adapter, not AI scheduling.
2. **What release does it ship in?** Bundling MCP with 0.3 couples it to APIs being *created* in 0.3 — building an adapter against a moving target produces tool-definition churn on every serializer change.

Two VoC passes shaped this scope. The first (v1) averaged 4.1/10 with four 🔴 blockers. The second (v2) averaged 5.25/10 overall and **7.0/10 across the personas the 0.3 MCP is designed for** (Priya, Alex, Jordan, Morgan).

An architect review surfaced three implementation prerequisites: (1) "team" is not a first-class model, (2) `ApiToken` has no `scopes` field, (3) `Notification` only accepts mention sources. v3 incorporates all three.

## Decision

### A. Edition: OSS

MCP server exposing existing OSS REST endpoints is **OSS** — protocol adapter, not new capability. Passes adoption-lens (single PM benefits without portfolio governance). Not AI scheduling (exposes engine outputs, doesn't replace CPM with an LLM). Enterprise may add tools wrapping Enterprise-only APIs via a backend provider registry (§G).

### B. Release split: read-only in 0.3, writes + new surfaces in 0.4

0.3 ships read-only over APIs stable in 0.2. Writes and any tool wrapping a 0.3-new endpoint land in 0.4 once those surfaces freeze.

### C. Prerequisites (must land before MCP code starts)

Four prerequisite work items, each tracked in its own issue:

1. **Team entity (new OSS model)** — `apps/teams/` with `Team`, `TeamMembership`. Sprint gains optional `team` FK. ADR-0078. Issue **#599**.
2. **ApiToken scopes (amends ADR-0068)** — additive `scopes` field; `TokenHasScope` permission class; `TeamInternalsOptIn` model. Migration backfills existing tokens with `legacy:full`.
3. **Notification source_type + detail (amends ADR-0075)** — `source_type` discriminator + `detail` JSONField; new `MCP_TEAM_INTERNALS_ACCESSED` event type.
4. **ADR-0069 program backlog ships before MCP** — `list_program_backlog` depends on it; unblocked by ADR-0070 (accepted 2026-05-18).

### D. 0.3 tool list

All read-only. **Tool-discovery source:** the adapter consumes the committed OpenAPI
schema at `docs/api/openapi.json` (regenerated by `scripts/export-openapi.sh`; kept in
sync by the `openapi-schema` pre-commit hook and the `api:schema-drift` CI gate). At build
time the adapter walks the schema's paths, selects operations tagged `mcp-exposed`, and
emits one MCP tool per selected operation — `operationId` → tool name, request/response
schemas → tool input/output schema, and the `description` (enforced non-empty by
`scripts/check-mcp-schema-descriptions.py`, §J) → tool description. No tool is registered
for a path absent from `openapi.json`, so the schema is the single source of truth for the
tool surface. Enterprise tools wrapping Enterprise-only endpoints register through the
backend `MCP_TOOL_PROVIDERS` registry (§G), not through this OSS schema walk.

**Project / task** (scope `project:read`): `list_projects`, `get_project`, `list_tasks` (filters: status/assignee/sprint/blocked/project), `get_task`, `list_my_tasks`, `get_my_blockers` (response includes blocker assignee + deep link).

**Schedule** (scope `project:read`): `get_schedule_summary` — CPM critical path, milestones, slipping tasks.

**Sprint** (scope `sprint:read`; `team_internals:read` for raw): `list_sprints`, `get_sprint`, `get_sprint_health(sprint_id)` — returns health bands by default (`stable`/`declining`/`recovering`); `?include=raw_metrics` requires `team_internals:read`. Raw includes velocity-over-last-N, burndown trajectory, WIP-by-status, scope-change audit (added/removed items with author + delta).

**Forecast** (scope `project:read`): `get_release_forecast(target)` — `target=milestone` only in 0.3; `target=epic` deferred to 0.4 (see §I). Always returns P50/P80 range, never a single date.

**Backlog / program** (scope `program:read`): `list_program_backlog` (depends on ADR-0069); `list_programs`, `get_program_health(program_id)` — derived rollup, stays within one program (cross-program is Enterprise).

**Resource** (scope `project:read` team-agg; `team_internals:read` per-individual): `get_resource_allocation(scope, range)` — team-aggregate default; per-individual gated. Supports partial allocations (60/40). Pre-commit conflict detection deferred to 0.4.

### E. Token-scope model — 4-layer defense in depth

Auth uses ADR-0068's `ApiToken` extended per §C.2 with explicit scopes.

**Scopes:** `project:read`, `sprint:read`, `team_internals:read`, `program:read`.

**Enforcement layers (all four required):**

1. **Issuance endpoint** validates requested scopes. `team_internals:read` requires a `TeamInternalsOptIn` row for the target team (toggled per ADR-0078's consent model — *not* via implicit project-Admin override).
2. **`ProjectApiTokenAuthentication`** attaches `token.scopes` to `request.auth.scopes`.
3. **DRF `TokenHasScope(scope)` permission class** on every wrapped REST endpoint. **Load-bearing**: the MCP is NOT the security boundary; REST enforces scopes independently.
4. **MCP tool dispatcher** declares required scopes per tool; rejects with clear errors before invoking.

**Revocation:** team Admin (per ADR-0078's consent model) can revoke `TeamInternalsOptIn`; outstanding tokens are invalidated immediately.

**First-use notification:** first time a `team_internals:read` token is used against a team by a non-team caller, fan out `Notification` (source_type='mcp_team_internals_accessed', detail={tool_name, caller_user_id, token_prefix}) to every team member. Sticky in_app preference. Push, not just audit-log.

### F. Health metrics — bands computed at API layer

`compute_sprint_health(sprint)` and `compute_program_health(program)` in `apps/projects/services.py`. REST endpoint returns bands by default; `?include=raw_metrics` requires `team_internals:read`. All callers (MCP, web, future enterprise) compute identically.

- **Sprint health**: `completed_points / committed_points` ratio over last N closed sprints, with stdev; `stable` if stdev < 15% of mean, `declining` if last-N mean < earlier-N mean by > 20%, `recovering` if rising after decline.
- **Program health**: weighted average of constituent project health, weighted by remaining duration.

Sprint has no FK to Program; queries join through `Project.program_id`.

### G. Backend Enterprise extension — provider registry

ADR-0029's slot registry is React-only; backend Python equivalent is ADR-0049's provider-registry pattern. Enterprise registers additional MCP tools via `MCP_TOOL_PROVIDERS` in `packages/api/mcp/registry.py` — same shape as `TASK_LINK_PROVIDERS`, `NOTIFICATION_CHANNELS`.

### H. Non-personas for 0.3 MCP

- **Sarah (PM)** — offline + writes + mobile. MCP is networked. Her surface is the mobile-offline track.
- **Marcus (PMO)** — cross-program rollup. Intentionally Enterprise.
- **Janet (COO)** — push digest + RAG + PDF. Different channel. *Mitigation:* docs "Sunday digest recipe" page.
- **David (Resource Mgr)** — pre-commit conflict warnings (require writes; 0.4). Read-side allocation lands in 0.3.

### I. Open question resolution — summary-tasks-as-epics

**Resolution: NO.** `Task` has no `is_summary` boolean (inference via ltree). "Epic" already has competing meanings; the 0.3 epic-task-type endpoint will introduce a third. Shipping fake `list_epics` over summary tasks teaches a wrong mental model the 0.4 endpoint will then have to break. **Better Jordan-pacifier:** `get_release_forecast(target=milestone)` in 0.3; `target=epic` in 0.4 with the real endpoint.

### J. OpenAPI tool-description framing

`@extend_schema(description=...)` is the override. **Rule:** every MCP-wrapped endpoint must carry an explicit annotation with coaching framing (team_internals tools) or engineer vocabulary (Priya tools). New CI lint (`scripts/check-mcp-schema-descriptions.py`) fails if `description` is missing or auto-generated for any `mcp-exposed` path.

### K. Audit log strategy

Reuse `ApiTokenAuditEntry.action='used'`; `detail` JSON captures the MCP tool name + scopes. Team-visible audit log view: filtered query over `ApiTokenAuditEntry` joined to team's `Sprint`s, gated by team membership.

### L. Transport, packaging, setup

MCP server runs as a separate process in `packages/api/mcp/`. Auth: API tokens. Session deferred to 0.4. **`trueppm mcp setup` CLI** creates token, writes `~/.config/claude/mcp.json`, verifies connection.

### M. 0.4 expansion (documented for sequencing)

Write tools; tools wrapping 0.3-new endpoints (epic, unified sprint planning, multi-team agile); session auth; streaming; `check_proposed_allocation`.

## Consequences

**Positive:** VoC-validated (7.0/10 target-persona avg); defense-in-depth scope enforcement; bands-at-API blocks the dual-use launder path; first-use notification + revocation makes opt-in real consent; generated tool definitions + CI drift + description lint prevent quality rot; ADR-0049 pattern is well-trodden.

**Negative:** Four prerequisites push effective MCP delivery toward late-0.3/early-0.4; new Team entity is a meaningful data-model addition (its own ADR + VoC); two MCP releases instead of one; per-team opt-in adds issuance UX complexity.

**Risks:** Per-team opt-in must be visible (not buried) or it's consent theater; LLM clients may round-trip band data into productivity narratives despite framing (monitor early adoption); OpenAPI schema quality is the LLM-tool quality (CI lint + manual review).

## Open questions

1. Enterprise MCP scope — own server, or extend via `MCP_TOOL_PROVIDERS`? Defer.
2. Streaming transport — 0.4 with writes.
3. Mobile MCP — revisit when ADR-0026 lands.

## References

- ADR-0029, ADR-0036, ADR-0049, ADR-0068, ADR-0069, ADR-0070, ADR-0075, ADR-0076
- ADR-0078 — Team Entity (prerequisite — §C.1)
- `CLAUDE.md` — OSS/Enterprise boundary
- `.claude/personas.md` — VoC personas
