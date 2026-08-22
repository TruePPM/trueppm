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
[Current deprecations](#current-deprecations) below; the window mechanism itself
has not yet been exercised through to a removal. When a **breaking** change to a
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
