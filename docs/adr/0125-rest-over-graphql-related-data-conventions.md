# ADR-0125: Stay on REST/DRF — related-data fetching conventions over a GraphQL migration

## Status
Proposed (2026-06-14)

> Numbering note: highest committed ADR at authoring time is **0123**. ADR-0124 is
> claimed by the in-flight blocker wave (Wave B, uncommitted on a feature branch), so
> this ADR takes **0125** to avoid the known collision. If both land out of order,
> renumber whichever merges second per the repo convention.

## Context

The founder asked whether *now* is the right time to migrate the API layer from
REST/DRF to GraphQL, motivated by **relationship-mapping pain** — the friction of
fetching deeply-related data (project → program → tasks → dependencies → resources →
assignments → baselines) over the current REST surface.

This is the **first ADR to record the REST decision at all** — a codebase scan found
*zero* occurrences of `graphql`/`graphene`/`strawberry` and no prior ADR mentioning
GraphQL. The decision has been implicit; this ADR makes it explicit and, just as
importantly, records the REST-native conventions that resolve the actual pain.

**P3M layer:** This is a cross-cutting API-architecture decision, not a single-layer
feature. The related-data conventions it establishes apply at the Programs-and-Projects
and Operations layers (OSS). The one narrow future case for a GraphQL-shaped read layer
(portfolio rollups) sits at the Portfolios / Senior-Leadership layer — i.e. Enterprise.

### What the codebase scan establishes

The relationship-mapping pain is real, but a wholesale GraphQL migration collides with
four load-bearing subsystems and discards a large existing investment:

1. **MCP / AI-readiness is hard-coupled to the OpenAPI schema.** ADR-0077 generates the
   MCP tool surface from the committed `docs/api/openapi.json` (240 paths, 275 component
   schemas), enforced by the `openapi-schema` pre-commit hook and `api:schema-drift` CI
   gate. The web client's `types.ts` is generated from the same schema via
   `openapi-typescript`. ADR-0112 stamps every REST/MCP answer with provenance from one
   unified helper. GraphQL would require a parallel MCP adapter strategy and a third
   surface to keep in lockstep.

2. **Offline sync is strongly table/endpoint-shaped.** ADR-0026/0082: `GET/POST
   /api/v1/projects/{pk}/sync/` returns one fixed envelope per project filtered by a
   single global `server_version` watermark across 12 collections (37 models inherit
   `VersionedModel`). Tombstones are carried as rows. There is no per-collection query
   composition, no field selection, no cross-project join. GraphQL subscriptions are a
   different mechanism and would not replicate this delta contract — and offline is a
   1.0 mobile-critical differentiator (Sarah's hard-NO).

3. **Real-time is a deliberate two-protocol design.** ADR-0091: WebSocket events on the
   `project_{pk}` Channels group carry **resource IDs only** (`{"event_type", "payload":
   {"id": ...}}`); clients re-fetch via REST on receipt. REST owns mutation + read;
   WebSocket owns push-only deltas. A unified GraphQL query+subscription layer discards
   this separation.

4. **RBAC is centralized in DRF permission classes.** ADR-0072's 5-role ordinal model is
   enforced at the **viewset** layer (`ProjectScopedViewSet` filters every queryset to
   the user's memberships; ~20 permission classes in `access/permissions.py`), with
   field-level privacy gates (ADR-0104) in serializers. GraphQL's arbitrary query graph
   distributes authorization across field resolvers and multiplies IDOR surface — and we
   have already eaten one cross-project IDOR (#887). This is a security regression risk,
   not just churn.

Critically, **GraphQL does not fix the stated problem.** Resolver N+1 is the default and
must be solved with DataLoader batching everywhere, plus query-cost/complexity analysis
to prevent DoS. The codebase already has **185** `select_related`/`prefetch_related`
calls (the `Prefetch(queryset=...select_related())` pattern on nested list endpoints) and
a `perf-check` gate. The real gap is the **read-shaping** layer: the scan found **zero**
`?expand=`, `?include=`, or `?fields=` handling and no sparse-fieldset mixin. That — not
the query language — is what "relationship-mapping pain" actually is.

### Decomposing the pain

| Symptom | REST-native fix |
|---|---|
| N+1 on nested reads | `prefetch_related` + `perf-check` (already in the kit) |
| Over-fetching on mobile | sparse fieldsets — `?fields=id,name,status` |
| Request waterfalls / under-fetching | `?expand=`/`?include=` nested embedding |
| One deep graph (e.g. program rollup) | purpose-built read-only composite / view-model endpoint |

## Decision

**Stay on REST/DRF. Do not migrate to GraphQL.** Resolve relationship-mapping pain with
three additive, REST-native conventions, applied in order of preference:

1. **Sparse fieldsets — `?fields=`** (and optionally `?omit=`). A whitelisted,
   comma-separated field selector implemented as a single reusable
   `DynamicFieldsMixin` on `serializers.ModelSerializer`. Mobile and bandwidth-limited
   clients trim payloads without new endpoints. Field names are validated against the
   serializer's declared fields (unknown field → 400), so this never widens the exposed
   surface.

2. **Related-object embedding — `?expand=`** (JSON:API-style). A whitelisted set of
   expandable relations per serializer (`expandable_fields`), each backed by a mandatory
   `prefetch_related`/`select_related` so expansion can never introduce N+1. Default
   response stays flat (IDs/summaries); `?expand=program,assignments.resource` embeds the
   nested bodies. The allowlist is the security boundary — only relations the caller is
   already authorized to read through the parent viewset are expandable.

3. **View-model composite read endpoints** for a *single* genuinely deep graph that
   `?expand=` cannot express ergonomically (e.g. a program dashboard read). A dedicated
   read-only `@action` / endpoint returning a purpose-built serializer, prefetch-tuned
   and `perf-check`-cleared. Reads only; all writes stay on the canonical resource
   endpoints. This is the escape hatch, not the default.

GraphQL is **deferred, not forbidden.** See the re-evaluation trigger below.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Stay REST + `?fields=`/`?expand=`/view-models** (chosen) | Additive; preserves OpenAPI→types→MCP pipeline, sync, WS, centralized RBAC; allowlists keep authz centralized; ships incrementally; no runway hit | Convention discipline required; `?expand=` allowlists must be maintained per serializer |
| B. Wholesale REST→GraphQL migration | Client-specified queries; single round-trip nested reads; no endpoint proliferation | Detonates OpenAPI/types/MCP pipeline (ADR-0077/0112); no delta-sync story (ADR-0026/0082); breaks two-protocol WS design (ADR-0091); scatters RBAC across resolvers → IDOR surface (ADR-0072, #887); resolver N+1 worse by default; consumes the entire 0.4-beta→1.0 runway; bleeding-edge for the contributor pool |
| C. Additive read-only GraphQL/BFF layer alongside REST | Targets deep-read pain without touching writes/sync | Two API paradigms to maintain, document, secure, and MCP-expose; the one surface that motivates it (portfolio rollups) is **Enterprise**, where a thin composite REST endpoint usually wins anyway; premature |
| D. Do nothing | Zero cost now | Pain persists; teams hand-roll ad-hoc nested serializers inconsistently; mobile over-fetch unaddressed |

## Consequences

**Easier:**
- Mobile/bandwidth clients trim payloads (`?fields=`) without bespoke endpoints.
- Nested reads collapse waterfalls (`?expand=`) with prefetch guaranteed, so no N+1.
- The OpenAPI→`types.ts`→MCP→provenance pipeline keeps working unchanged; one contract.
- RBAC stays in one place (viewset permission classes + serializer privacy gates).
- The GraphQL question stops re-litigating itself every quarter — there's a recorded
  decision and an explicit trigger to reopen it.

**Harder:**
- Every serializer that adds `expandable_fields` must declare the backing prefetch, and
  that path must clear `perf-check`. Forgetting the prefetch is the failure mode to guard.
- `?fields=`/`?expand=` add query-param surface that drf-spectacular must document
  (parameters appear in the schema; verify they don't trigger enum-name collisions per
  the `ENUM_NAME_OVERRIDES` convention).

**Risks:**
- **Expand-without-prefetch N+1.** Mitigated by guardrail: any `expandable_fields` entry
  requires a matching prefetch and a `perf-check` run on that path before merge.
- **Allowlist drift becoming an authz hole.** Mitigated: expansion is restricted to
  relations already readable through the parent viewset; no `?expand=` may reach a
  resource the caller can't already GET.

## Implementation Notes
- P3M layer: Programs and Projects + Operations (OSS) for the conventions; the deferred
  GraphQL/BFF case is Portfolios / Senior Leadership (Enterprise).
- Affected packages: `api` (DynamicFieldsMixin, per-serializer `expandable_fields`,
  view-model endpoints), `web` (client helpers to pass `fields`/`expand`; regenerated
  `types.ts`). No `scheduler`, `helm`, or `mobile` changes required by this ADR itself.
- Migration required: **no** (no model/schema-DB changes; query-param + serializer-mixin
  work only).
- API changes: **yes, additive** — new optional `?fields=` and `?expand=` query params on
  read endpoints; new read-only view-model endpoints case-by-case. No breaking changes to
  existing default response shapes. OpenAPI schema regenerates; verify no drift.
- OSS or Enterprise: **OSS** (`trueppm-suite`). The conventions are core API ergonomics.
  Any future deep portfolio-rollup read layer is **Enterprise**.

### Re-evaluation trigger (when to reopen the GraphQL question)
Reopen only when a **specific, named screen or client flow is demonstrated to be
inexpressible** with `?fields=` + `?expand=` + a view-model endpoint *without*
unacceptable round-trips or payload — documented with the concrete query shapes that
fail. A general "GraphQL would be nicer" is explicitly **not** a trigger. Even then, the
first candidate is a read-only additive layer (Option C), not a migration (Option B), and
its likely home is Enterprise.

### Durable Execution
This ADR introduces only **synchronous read-path** conventions (sparse fieldsets,
relation embedding, read-only view-model endpoints). It adds no async work, no
mutations, and no broadcasts. Each checklist item is therefore N/A with justification:

1. Broker-down behaviour: **N/A** — pure read endpoints, no dispatch.
2. Drain task: **N/A** — no async work introduced.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: **N/A** — reads go through existing viewsets/serializers; no new
   dispatch path. (If a view-model endpoint ever needs to *trigger* compute, it must
   route through the relevant `services.py` per ADR-0091/CPM conventions — out of scope
   here.)
5. API response on best-effort dispatch: **N/A** — synchronous reads return the resource
   body directly.
6. Outbox cleanup: **N/A** — no outbox usage.
7. Idempotency: **N/A for writes**; reads are inherently idempotent and side-effect-free.
8. Dead-letter / failure handling: **N/A** — no async task to fail; invalid `?fields=`/
   `?expand=` values fail fast synchronously with 400.
