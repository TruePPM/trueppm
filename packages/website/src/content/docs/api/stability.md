---
title: API Stability & Deprecation Policy
description: What the v1 REST API guarantees across releases, how changes are classified, and how deprecations are announced and retired.
---

This page states what integrators can rely on when building against the TruePPM
REST API, how the API changes between releases, and how deprecations are
announced and retired. It applies to the versioned REST surface under
`/api/v1/` and the WebSocket channels documented alongside it.

:::note[Pre-1.0 status]
TruePPM is pre-GA. This policy is published now — ahead of the full v1 freeze —
so that integrators building against the read-only MCP surface and the coming
write surface have a stable contract to plan against. The **full v1 API freeze
will land in 0.9** as part of GA hardening (see the
[roadmap](/overview/roadmap/)). Until then the guarantees below describe the
policy we hold ourselves to; the freeze is what makes them permanent.
:::

## What the v1 surface covers

The **stable, integrator-facing surface** is:

- Every path under `/api/v1/` documented in the [API reference](/api/reference/)
  and present in the published [OpenAPI schema](/api/reference/#interactive-schema).
- The request and response **field names, types, and semantics** described in
  that schema.
- HTTP [status codes](/api/reference/#status-codes) and error-body shape,
  including every machine-readable `code` enumerated in
  [Errors and status codes](/api/errors/).
- Authentication flows (JWT, project-scoped API tokens) and the
  [rate-limiting contract](/api/reference/#rate-limiting).
- The WebSocket channels and event envelopes in the
  [real-time](/api/websockets/) documentation.
- The [Idempotency-Key](/api/idempotency/) protocol.

The following are **explicitly not part of the stable surface** and may change
at any time without notice:

- The Django admin (`/admin/`) and any internal management endpoints.
- Undocumented query parameters, response fields, or endpoints not present in
  the published OpenAPI schema.
- The exact wording of human-readable `detail` messages (the machine-readable
  status code and error `code` are stable; the prose is not).
- Ordering of list results where no explicit ordering is documented.
- Internal header names beyond the documented ones.

## Change classes

Every change to the API falls into one of three classes.

| Class | Examples | Compatibility |
|-------|----------|---------------|
| **Additive** | A new endpoint, a new optional request field, a new response field, a new enum value on a non-exhaustive field, a new WebSocket event type | Backward-compatible. Ships in any release. |
| **Behavioral** | A default value change, a validation tightening, a new required-only-on-new-resource constraint | Announced in the changelog. Ships in a minor release; avoided within a series where possible. |
| **Breaking** | Removing or renaming an endpoint or field, changing a field type, changing an existing status code, making an existing optional field required, removing an enum value | Requires a deprecation window (below) and, at GA, a new API version. |

**Clients must tolerate additive change.** A conforming client ignores response
fields it does not recognize and does not break when a new enum value or a new
event type appears. Building a client that rejects unknown fields will cause it
to break on an additive change that this policy considers backward-compatible.

## Deprecation window & notice

One stable element is scheduled for deprecation — see
[Current deprecations](#current-deprecations) below. The window mechanism has not yet
been exercised through to a removal; the four Breaking changes taken so far all
bypassed it deliberately, and all four are recorded inline in step 3. When a **breaking** change to a
stable element becomes necessary, the intent is for it to go through a
deprecation window rather than being removed outright:

1. **Announcement.** The deprecation will be called out in the
   [changelog](https://gitlab.com/trueppm/trueppm-suite/-/blob/main/CHANGELOG.md)
   under a `Changed` or `Deprecated` heading, and the affected endpoint or
   field will be marked `deprecated` in the OpenAPI schema.
2. **Runtime signal.** The plan is for responses from a deprecated endpoint to
   carry a `Deprecation` header (and, where a replacement exists, a `Link`
   header pointing at it), so a client can detect reliance on a deprecated
   surface without reading release notes. This header does not exist in the
   codebase today; it will be built ahead of the first deprecation, not
   asserted as already wired.
3. **Window.** Once a deprecation is announced, the intent is for the
   deprecated element to keep working for **at least one full minor release**
   (roughly 10–12 weeks at the current [release cadence](/overview/roadmap/))
   before it may be removed — and never less.
   Security-critical removals would be the only exception, and would be
   documented as such.

   **Invoked once, in 0.4 (#2881).** `POST /api/v1/integrations/projects/{id}/git-webhook/`
   answered `401` for a bad or missing signature in 0.3; in 0.4 it answers the same `404`
   it returns for "no automation configured". Changing an existing status code is a
   **Breaking** change by the table above, and it shipped with no deprecation window
   because the window would have been self-defeating: the `401` *was* the vulnerability.
   It told any caller holding a project ID — which every project Viewer has — that the
   project has automation enabled with a secret set. A client branching on `401` from
   that endpoint must treat `404` as the same condition.

   **Bypassed a second time, in 0.4 (#3137).** The `schedule_in_deliver` field is
   removed outright from `GET /api/v1/auth/me/` and `PATCH /api/v1/auth/me/profile/`
   with no deprecation window. Removing a field is **Breaking** by the table above, so
   this is a policy exception and is recorded as one rather than as routine. The
   reasoning ([ADR-0942](https://gitlab.com/trueppm/trueppm-suite/-/blob/main/docs/adr/0942-project-rail-verb-bands-and-a-workspace-scope-band.md)
   §3): the field was display-only — no rollup, report, export, schedule computation
   or webhook read it — so the deprecation window would have preserved nothing but the
   field's own ability to round-trip a value that changed nothing. Marking it
   `deprecated` for a release would have meant publishing, for another 10–12 weeks, a
   documented and writable setting that the product no longer honors.

   Unlike an ordinary removal, a stale write **does not fail silently**: a `PATCH`
   carrying `schedule_in_deliver` is refused with a `400` keyed to the field name, so
   an integration still sending it finds out at the moment it sends it rather than
   inferring it from a response body. The whole request is rejected, so sibling fields
   in the same body are not applied.

   **Bypassed a third time, in 0.4 (#3301).** Board Workshop Mode is removed outright,
   taking four paths (`POST /api/v1/projects/{id}/workshop/start/`, `.../workshop/end/`,
   `.../workshop/force-end/`, and `GET /api/v1/projects/{id}/workshop/current/`), the
   `WorkshopSession` and `WorkshopParticipant` schemas, and the `workshop_started` /
   `workshop_ended` WebSocket event types with it. Removing an endpoint is **Breaking**
   by the table above, so this is a policy exception and is recorded as one rather than
   as routine. The reasoning: the feature was single-user by construction. The web
   client's workshop state was component-local and set only in the start mutation's
   success handler, no join endpoint was ever built, and `start` is ADMIN-gated and
   answers `409` while a session is active — so no second participant could reach an
   active session by any route, and the presence apparatus behind these endpoints was
   unreachable. A deprecation window exists to let a client migrate to a replacement;
   there is no replacement here, and the `Deprecation` header described in step 2 does
   not exist to send.

   As with the removal above, a stale call **does not fail silently**: the removed paths
   answer `404`, so an integration still calling one finds out at the moment it calls
   rather than inferring it from a response body. The changelog fragment names every
   removed path, schema, and event type, and the removal is declared in
   `scripts/schema-removal-allowlist.txt` so the schema gate treats it as reviewed
   rather than accidental.

   **Bypassed a fourth time, in 0.4 (#3370).** Three read endpoints are removed outright:
   `GET /api/v1/teams/{id}/`, `GET /api/v1/projects/{id}/board/lanes/`, and
   `GET /api/v1/tasks/{id}/scope/`, together with the `BoardLane`, `BoardLanes` and
   `TaskScopeRollup` component schemas. Removing an endpoint is **Breaking** by the table
   above, so this is a policy exception and is recorded as one rather than as routine.

   What the three have in common is that **nothing calls them**: a repository-wide search
   across the web client, its Playwright suite, the mobile app, the MCP server, the docs
   tree and the three closed-source client repos finds no caller of any of them. A
   deprecation window exists to give a client time to migrate, and there is no client to
   give time to. What each one leaves behind differs, and is worth stating exactly:

   - `teams/{id}/` — looking a team up **by its id alone** is gone. Team attributes
     (`name`, `short_id`, `is_default`, `member_count`) are still served by the
     project-scoped list `GET /api/v1/projects/{project_id}/teams/`, which is what our own
     web client has always used. The two `teams/{id}/members/` routes are unaffected, but
     they return the team as a bare id, not as an object.
   - `board/lanes/` — **there is no server-side replacement.** The WBS swimlane grouping
     it returned is not what `board-config` carries: `board-config`'s `lanes` are the named
     lanes *within* a status column, a different concept with a different shape. The
     swimlane grouping is a client-side derivation again, and re-exposing it would be a
     fresh API-design decision rather than restoring this route. The route has never
     appeared in a tagged release at all — it was built during the 0.4 cycle and is removed
     before that line reaches beta — so no client can be holding it.
   - `tasks/{id}/scope/` — the rollup behind it stays. `services.compute_scope_rollup` is
     ADR-0108 §3 engine logic, is unchanged, and is now covered as a unit rather than
     through the route. What is withdrawn is only the claim that the scope delta is
     reachable over the API; a client that needs it has no endpoint today.

   As with the removals above, a stale call **does not fail silently**: the removed paths
   answer `404`, so an integration still calling one finds out at the moment it calls
   rather than inferring it from a response body. The changelog fragment names every
   removed path and schema, and the removal is declared in
   `scripts/schema-removal-allowlist.txt` so the schema gate treats it as reviewed rather
   than accidental.

   These exceptions are available because TruePPM is pre-1.0 alpha and the v1 surface is
   not yet under a GA compatibility promise. They should not be read as a precedent for
   removals after GA.
4. **Removal.** The element would be removed only after the window elapses, in
   a minor release before GA or in the next major version at and after GA.

## Current deprecations

### `group_by=project` on the resource heatmap

`GET /api/v1/projects/{id}/resources/heatmap/` accepts `group_by` values of
`role`, `project`, and `none`. **`project` will be deprecated in 0.4 and has
never had any effect.** The endpoint is scoped to a single project, so grouping
its rows by project is a single group by construction; the cross-project heat map
is an Enterprise feature. A request using it is served exactly as `none`.

Because `project` is a documented enum value in the published schema, removing it
outright is a **Breaking** change by the table above, so it stays accepted for the
window rather than starting to answer `400`.

What changes in 0.4 is that the silence ends: the response gains a **`group_by`
field naming the grouping actually applied**, so a caller asking for `project`
reads back `"group_by": "none"` instead of having no way to tell. That field is an
additive change and is safe for every existing client.

| | |
|---|---|
| Announced | 0.4 |
| Behavior during the window | accepted, served as `none`, echoed as `none` |
| Earliest removal | 0.6 |
| Migration | send `none`; read the response's `group_by` field rather than assuming the request value was honored |

## Versioning approach

- The API is versioned **in the URL path** (`/api/v1/`). This is the version an
  integrator pins against.
- Within `v1`, changes follow the change-class rules above: additive changes
  ship freely; breaking changes go through the deprecation window.
- A **new URL version (`/api/v2/`) is introduced only for breaking changes that
  cannot be made additively** once the surface is frozen. Before that point,
  while TruePPM is pre-1.0, the deprecation window is the mechanism and no `v2`
  is planned.
- TruePPM follows [semantic versioning](https://semver.org/) for the product as
  a whole; the API-path version tracks the compatibility of the API surface
  specifically.

## Why this policy ships now

Two upcoming surfaces make an early, written contract worthwhile:

- The **read-only MCP server shipping in 0.4** exposes the live schedule to MCP
  clients. Integrators wiring an agent to it need to know which fields and
  computed values they can depend on across releases.
- The **MCP write surface arriving in 0.6** will let automation create and
  update work. A write client that pins against a moving target is fragile, so
  the deprecation policy above is committed to in writing before that surface
  lands — ahead of the runtime `Deprecation`-header mechanism itself, which
  will be built out before it is first needed.

Publishing the policy at beta — rather than waiting for the 0.9 freeze — means
early integrators build against a known contract from the start. The **0.9
freeze will make the v1 surface permanent**; this policy is the promise we hold
in the interim.
