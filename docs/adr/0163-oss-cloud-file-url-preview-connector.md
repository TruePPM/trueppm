# ADR-0163: OSS cloud-file URL preview connector

## Status
Accepted

## Context

A contributor pastes a cloud-file URL (Google Drive, Dropbox, Box, OneDrive,
public S3) onto a task. Today TruePPM stores it as a `generic` `TaskLink` and
renders a bare URL — the reader has to click through and context-switch to find
out what the document even is. The git-aware task links (ADR-0049 §1, #637) solve
the equivalent problem for GitLab/GitHub by fetching live PR/MR status; this ADR
extends the **same** `TASK_LINK_PROVIDERS` registry to render an OpenGraph preview
card (thumbnail + title + description) for cloud-file hosts.

This is **not** a redesign of the integrations substrate. It is an additive
extension of the shipped pattern:

- `registry.py` already defines `TaskLinkProvider` (`matches()` +
  `fetch_metadata() -> LinkMetadata`) and the `TASK_LINK_PROVIDERS` registry.
- `http.py` already provides an SSRF-guarded, redirect-disabled, 5-second,
  256 KB-capped `get()` (the #302/#677/#637 egress chokepoint).
- `TaskLink` is a `VersionedModel` already pulled into the project sync delta
  (`SyncTaskLinkSerializer`) and already has an on-demand refresh endpoint
  (`TaskLinkViewSet.refresh`).

**P3M layer**: Operations / Programs and Projects — a task-attached convenience
used by the team (Priya, Alex, Jordan) and the PM (Sarah). It aggregates nothing
across projects, so it stays OSS.

**Voice-of-Customer (avg 4.4/10)**: The low average is dominated by personas this
task-link convenience is correctly *not* aimed at (Janet/Marcus are portfolio
personas; David/Sarah's mobile/allocation 🔴s are the documented expected
pre-0.4/0.5 firings). The decisive OSS-adoption gate, Morgan (Agile Coach), scored
it **8/10 🟢** — "no admin setup, no mandate, team-owned." The actionable VoC
constraints are folded into this design:
- Sarah: the cached card must render **offline** → store preview on `TaskLink`
  (a `VersionedModel`) so it flows through the sync delta. (Decision §A.)
- Alex/Morgan: unfurl on **explicit** action, not auto-on-paste. (Decision §D.)
- Morgan/security: a public-URL unfurl must not surface a **private** file's title.
  (Mitigated — see Consequences/risks.)

**Deferred to follow-ups (out of #571 scope):** a `figma` provider (Jordan's most
common design link), and an audit-trail egress hook (Marcus). Both are filed as
separate issues.

## Decision

### A. Store the preview on `TaskLink`, enrich `LinkMetadata` — additively
Add three optional, server-owned columns to `TaskLink`: `description`,
`thumbnail_url`, `preview_type`. Add three optional fields to the `LinkMetadata`
dataclass (`description`, `thumbnail_url`, `preview_type`, all defaulting to
`None`/empty). The git providers continue to return `LinkMetadata(status, title)`
and leave the new fields unset → **no behavior change, no Enterprise break** (a
registered Enterprise provider that predates these fields keeps working).

Storing on `TaskLink` (rather than a side cache or a new model) is required: the
card must render offline, and `TaskLink` is the only place that reaches the mobile
sync delta. The new columns are added to `SyncTaskLinkSerializer.Meta.fields` so
they flow to WatermelonDB with no other wiring.

### B. `preview_type` is a server-derived, choices-validated classification
Canonical small set: `document`, `spreadsheet`, `presentation`, `image`, `pdf`,
`folder`, `file` (generic fallback). Stored as `CharField(choices=...)` following
the existing `LINK_STATUS_CHOICES` module-level-tuple pattern. Derived by each
provider from `og:type` + URL/path heuristics (e.g. `/spreadsheets/` → spreadsheet).
A closed set keeps the web layer's icon mapping exhaustive and lets the API schema
enumerate it.

### C. OpenGraph parsing uses the Python stdlib — zero new dependencies
A new module `integrations/opengraph.py` parses `og:*` / `twitter:*` meta tags and
`<title>` from the fetched HTML using `html.parser.HTMLParser` (stdlib). No
`beautifulsoup4`/`lxml` — they are not current dependencies and would trigger a
license/CVE dependency audit for a meta-tag scrape that stdlib handles. The parser
reads only the bounded body `http.get()` already caps at 256 KB, and `HTMLParser`
has no entity-expansion ("billion laughs") exposure.

### D. Reuse the on-demand refresh endpoint; the row is the cache
No auto-fetch on paste. The unfurl runs only when the user creates the link and
triggers a refresh, or hits the explicit refresh button — exactly the #637 pattern.
`fetched_at` (already on `TaskLink`) is the "as of …" stamp; the UI shows it and a
"Refresh" affordance. The "24-hour cache" is the row itself: the preview persists
and syncs; there is **no** new cache table, no Redis key, no TTL sweeper. A refresh
is naturally idempotent (re-fetch and overwrite).

### E. Throttle the refresh action
The git refresh required a per-user credential and so was implicitly rate-limited;
a cloud-file unfurl is an **anonymous** outbound GET, which is more abusable as an
SSRF/egress amplifier. Add a scoped throttle (`TaskLinkRefreshThrottle`,
`integrations/throttles.py`) to the refresh action. This is the minimal egress
governance the OSS tier needs; richer per-tenant rate budgets stay Enterprise
(ADR-0049 §6).

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| **A. Enrich `LinkMetadata` + `TaskLink` (chosen)** | Reuses refresh endpoint, serializer, sync delta; offline-safe; additive/no-break | 3 new columns + a migration on a synced model |
| B. Separate `TaskLinkPreview` model (1:1) | Keeps `TaskLink` lean | A second synced table + join; offline render needs extra sync wiring; more surface for no gain |
| C. Redis-only preview cache keyed by URL hash | No migration | Does **not** sync → card is blank offline (fails Sarah's hard requirement); cross-user cache raises a private-title-leak question |
| D. New `unfurl()` method on the provider ABC | Explicit separation from status fetch | A new abstract method is a **breaking** contract change for Enterprise providers; `fetch_metadata` already returns the right place to put it |
| E. Add `beautifulsoup4` | Robust parsing | New dependency + license/CVE audit for a meta-tag scrape stdlib does fine |

## Consequences
- **Easier**: any future file host is one `TaskLinkProvider` subclass + a registry
  line; the preview card, refresh, sync, and RBAC are all inherited.
- **Easier**: the card renders offline from the sync delta with no extra work.
- **Harder**: `LinkMetadata` now has two response shapes (status-only for git,
  enriched for files). Tests must pin that git providers leave preview fields empty.
- **Risk — private-file leakage (Morgan/security)**: a private Google/Box file URL
  returns a provider login wall to an anonymous GET, so the OG scrape yields the
  generic app title, **not** the private document name — no private title leaks.
  Redirects are disabled in `http.py`, closing the redirect-to-internal disclosure
  path. Verified in `security-review`.
- **Risk — `thumbnail_url` as a tracking/IP-leak vector**: the stored `og:image`
  is attacker-influenceable and rendered client-side as `<img src>`. No script
  execution risk, but it leaks the viewer's IP to the image host. Mitigation:
  persist only `https://` thumbnail URLs; drop anything else. Flagged for
  `security-review`.
- **Risk — egress amplification**: mitigated by the new refresh throttle (§E) on
  top of the existing SSRF guard and 5 s / 256 KB caps.

## Implementation Notes
- P3M layer: Operations / Programs and Projects
- Affected packages: api (`apps/integrations`, `apps/sync` serializer field add), web
- Migration required: **yes** — `integrations/0006`, three additive
  `blank=True, default=""` columns on `TaskLink`. No NOT NULL without default, no
  data migration, no destructive op. Existing rows sync with empty preview fields.
- API changes: **yes** — `TaskLinkSerializer` exposes `description`,
  `thumbnail_url`, `preview_type` as **read-only** (server-owned, like `status`);
  four provider keys (`google_drive`, `dropbox`, `box`, `onedrive`) plus public-S3
  matching join the registry; refresh response carries the enriched fields.
  `SyncTaskLinkSerializer` gains the three fields.
- OSS or Enterprise: **OSS** — user-scoped, one-way, read-only, public-URL unfurl,
  no writeback and no org-admin config. Matches the ADR-0097 carve-out verbatim
  ("user connects … one-way … read-only … no writeback" = OSS basic).

### Durable Execution
1. **Broker-down behaviour**: N/A — the unfurl is a synchronous, request-cycle
   GET inside the refresh action (identical to #637 git status refresh). There is
   no `.delay()`, no outbox row, nothing to lose if the broker is down.
2. **Drain task**: N/A — no async work, so no drain.
3. **Orphan window**: N/A — nothing is dispatched on commit.
4. **Service layer**: provider dispatch goes through `TASK_LINK_PROVIDERS.get(key)`
   → `handler.fetch_metadata(url, credential=None)`; OG parsing isolated in
   `integrations/opengraph.py::parse_opengraph()`. No new Celery service.
5. **API response**: synchronous — the refreshed `TaskLink` (with enriched preview
   fields) is returned in the 200 body. Not a `{"queued": true}` path.
6. **Outbox cleanup**: N/A — no outbox.
7. **Idempotency**: a refresh re-fetches and overwrites the same row's preview
   fields and `fetched_at`; running it twice yields the same end state. The throttle
   bounds repeat calls.
8. **Dead-letter / failure handling**: a transport/parse failure degrades to
   `LinkMetadata(status="unknown")` with empty preview fields (the `fetch_metadata`
   contract already specifies "never raises for an unreachable provider"); the row
   keeps its last good preview and the UI shows the stale "as of …" stamp. No retry,
   no DLQ — a manual refresh is the human-actionable retry.
