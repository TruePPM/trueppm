# ADR-0589: Jira Data Center / Server as a deployment variant of the `jira` external source (#2270)

## Status
Accepted

## Context

ADR-0097 introduced a user-scoped, one-way, **read-only** external task-source
registry (`EXTERNAL_TASK_SOURCES`) so a contributor can pull the items assigned to
them from their own account into **My Work**. The OSS registry ships exactly one
source, `jira`, implemented by `JiraCloudSource` — Jira **Cloud** only: REST v3 with
HTTP Basic `email:token` auth, and a `base_url` hard-restricted to `*.atlassian.net`.

0.4 is positioned as *the self-hosting PM's beta*, and its headline coexistence
feature is marketed as **live** inbound Jira sync. But a self-hoster who points the
connect flow at their own Jira **Data Center / Server** is rejected: the source is
Cloud-shaped and the host is not `*.atlassian.net`. The audience the release names is
the one the flagship feature excludes for live sync. The only self-hoster path today
is the separate offline XML import (#1664) — a point-in-time snapshot, not the
advertised live mirror.

Classification is settled by ADR-0097's carve-out: the boundary keys on *user-scoped,
one-way, read-only, no writeback* — **not** on Cloud vs self-hosted. Personal
read-only DC/Server sync is **OSS**. (Org-wide, bidirectional connectors remain the
Enterprise Integration Hub.)

## Decision

**1. One registry key, a deployment discriminant — not a second source.**
`jira` stays a single `EXTERNAL_TASK_SOURCES` key. A new `config["deployment"]`
(`"cloud"` default | `"server"`) selects the API shape at call time:

| | Cloud | Data Center / Server |
|---|---|---|
| REST version | v3 (`/rest/api/3/…`) | v2 (`/rest/api/2/…`) |
| Auth | Basic `email:token` | Bearer Personal Access Token |
| Account email | required | not used |
| Host | `*.atlassian.net` | operator-allow-listed host |

The registered `JiraSource` picks an internal `_JiraBackend` strategy
(`_JiraCloudBackend` / `_JiraServerBackend`); the request, parse, and DTO-mapping
logic is shared (the `statusCategory` → display-bucket projection is identical on v2
and v3). The `ExternalTaskSource` ABC signature is unchanged — dispatch lives *inside*
the source, so the cross-repo registry surface stays frozen.

Rejected: a separate `jira_server` key. The issue asks to *distinguish Cloud vs Server
in one connect flow*, not to show two "Jira" tiles; a second key also forks
`ExternalWorkItem.source` and every consumer keyed on it, and the sync worker
(`tasks.py`) already passes `config` through untouched, so a discriminant needs no
worker change. This establishes a reusable precedent: **deployment variants of an
external source are expressed as an internal strategy under one key**, which
ServiceNow on-prem / GitLab self-managed will hit next.

**2. The operator allow-list stays the immovable exfil gate — the product surfaces
it, never bypasses it.** `providers.assert_base_url_allowed` is **unchanged**: a
self-hosted host is permitted only if it is in `TRUEPPM_INTEGRATION_ALLOWED_HOSTS`.
The threat is credential *exfiltration*, not classic SSRF: the egress guard blocks
private hosts but a *public* attacker host passes, so relaxing to "any https host"
would turn a socially-engineered paste (`base_url = https://attacker.example`) into a
handoff of the user's real DC PAT. The "product-level path" the issue asks for is a UX
obligation: a first-class Cloud/Server toggle in the connect dialog, and the existing
`BaseUrlNotAllowed` message (which already names the env var) surfaced verbatim so a
self-hoster reads the rejection as operator policy, not a bug.

**3. Bearer PAT only for the v1 Server variant.** DC/Server PATs (8.14+) authenticate
as `Authorization: Bearer <pat>` — the modern, recommended path, no second secret, no
email. Basic `user:password` (pre-8.14 installs) is a tracked follow-up (#2272), gated
on real demand.

**4. Server preserves the context path (and port).** Unlike Cloud (always root-hosted
on `atlassian.net`), DC/Server is frequently deployed under a context path
(`https://jira.corp.example/jira`) and/or a non-standard port. `_jira_origin` (Cloud)
deliberately drops the path as defense-in-depth; the new `_jira_server_base` **keeps**
origin + port + context path (still forcing `https`, still after the allow-list) so
`{base}/rest/api/2/…` and the `/browse/<KEY>` deep link resolve on a path-hosted
install. Dropping the path was the one non-obvious way to ship a "connected but empty"
Server connection.

## Consequences

- A self-hoster connects their own DC/Server Jira for live read-only My Work sync,
  provided the operator has allow-listed the host — the 0.4 self-hosting audience is
  no longer excluded from the flagship feature.
- The security boundary is identical to before: the allow-list, not the connect UI, is
  the egress authority; no new exfil primitive is introduced.
- `ExternalWorkItem.source` stays `jira`; My Work grouping, the sync worker, the
  encryption boundary, and DTO sanitization are untouched.
- A stored connection row from before the discriminant existed reads as `cloud` (the
  only variant that existed then) — a safe upgrade no-op.
- **Internet-reachable DC only, by design.** The operator allow-list governs *which
  hostnames* a PAT may be sent to; the SSRF egress guard (`http.assert_url_allowed`)
  independently blocks any host that resolves to a **private/internal IP**, with no
  allow-list bypass. So a DC/Server instance on an internal address (RFC1918,
  in-cluster) is still blocked even when its hostname is allow-listed — the feature
  works for internet-reachable DC only. Relaxing the SSRF guard for a specifically
  operator-blessed internal host (DNS-rebinding-safe) is deliberately **out of scope**
  here — it modifies the shared egress chokepoint and warrants its own threat model
  (#2281).
- Follow-ups: internal/private-network DC hosts (#2281); basic `user:password` auth
  for pre-8.14 installs (#2272).

## Related

- ADR-0097 (EXTERNAL_TASK_SOURCES boundary), ADR-0291 (Connected Accounts surface),
  ADR-0313 (connect wizard)
- #2270 (this change), #2272 (basic-auth follow-up), #1394/#1418/#1419 (inbound Jira
  Cloud), #1664 (offline XML import — the prior self-hoster fallback), #902 (base_url
  allow-list / exfil gate)
