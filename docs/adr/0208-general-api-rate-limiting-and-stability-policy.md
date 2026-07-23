# ADR-0208: General API Rate Limiting & Published Stability/Deprecation Policy

## Status
Accepted

> **ADR-number race note.** Renumbered 0205 → 0208 at push time: a concurrent
> worktree merged `0205-web-sync-status-badge` to `main` first, so this ADR moved
> to the next free number above the batch's 0206 (#1082) and 0207 (#1604). If 0208
> collides again at merge, renumber the later-merged ADR and repoint references —
> the standard renumber-at-merge drill.

> **Extended by [ADR-0604](0604-operator-global-rate-limit-disable-switch.md)**
> (#2316): adds an operator-only global kill switch (`TRUEPPM_RATE_LIMIT_ENABLED`)
> that disables all throttling for load testing / local debugging, gated behind a
> two-key acknowledgment, refused-by-default, and surfaced read-only to admins.

## Context

The DRF backend ships **scoped throttles only** — `login`, `refresh`,
`user_search`, `ws_ticket`, `monte_carlo`, and a handful of other
credential-adjacent or expensive endpoints each declare their own
`throttle_scope`. There is **no `DEFAULT_THROTTLE_CLASSES`**, so every other
endpoint — the entire CRUD surface — has no rate limit at all. A self-hosted
instance therefore has no baseline protection against a runaway or malicious
client exhausting worker time and DB connections (CWE-770; OWASP A05:2021
Security Misconfiguration). The `semgrep` `missing-throttle-config` rule flags
exactly this gap.

A global default was **deliberately avoided** until now for one concrete reason,
recorded in `settings/base.py`: a bare `AnonRateThrottle` would also count the
unauthenticated Kubernetes probe endpoints `/api/v1/health/` (liveness /
readiness) and `/api/v1/edition/` (the React shell's startup edition read),
which orchestrators hit on a tight loop. If a busy readiness loop consumed the
shared anon bucket, it could 429 the liveness probe and cause Kubernetes to
restart a healthy pod.

Separately, TruePPM has **no published API stability or deprecation policy**. The
0.4 beta introduces a read-only MCP surface (#503/#504/#603) and 0.6 will add the
MCP write surface (#505/#604); integrators building against either need a written
contract for what they can rely on across releases. The full public v1 freeze is
scheduled for 0.9 GA hardening (#726), but the policy is worth publishing now to
protect these early integration surfaces rather than waiting for the freeze.

**P3M layer**: platform. Both the general throttle and the stability policy are
core self-hosting concerns — general DoS protection and a public-API contract are
table stakes a single team/PM needs, not org-level governance. **OSS.**

## Decision

**1. Add a probe-exempt global default throttle.**

Introduce `trueppm_api.core.throttling` with two classes — the stock DRF
`AnonRateThrottle` / `UserRateThrottle` subclassed as
`ProbeExemptAnonRateThrottle` / `ProbeExemptUserRateThrottle`. Each overrides
`get_cache_key` to return `None` (DRF's "do not throttle") when
`request.path_info` is `/api/v1/health/` or `/api/v1/edition/` (trailing-slash
normalized), and otherwise defers to `super().get_cache_key`. Register both in
`REST_FRAMEWORK["DEFAULT_THROTTLE_CLASSES"]`. Matching on `path_info` (not
`path`) keeps the exemption correct under a `SCRIPT_NAME` sub-path mount. This
resolves the original tension: the global default now exists *and* the probes
are never counted.

**2. Env-configurable default rates.**

Add `anon` and `user` to `DEFAULT_THROTTLE_RATES`, read from
`TRUEPPM_THROTTLE_ANON_RATE` (default `60/min`, per client IP) and
`TRUEPPM_THROTTLE_USER_RATE` (default `1000/min`, per account) via
`django-environ`, mirroring the existing `TRUEPPM_`-prefixed operator knobs.
Surfaced in `packages/helm/values.yaml` as plain (non-secret) config keys.

**2a. Trust the client IP only behind a known proxy depth.**

Set `REST_FRAMEWORK["NUM_PROXIES"]` from `TRUEPPM_NUM_PROXIES` (default `1`, the
chart's single ingress). Without it, DRF keys the anon throttle on a
client-supplied `X-Forwarded-For` verbatim, so an attacker could rotate the
header to mint a fresh anon identity per request and bypass the anon limit —
defeating the feature's own purpose. `NUM_PROXIES` makes DRF read the real
client IP from a trusted position in the XFF chain. The authenticated `user`
scope keys on the account id and is unaffected.

**3. Scoped throttles replace, not stack.**

DRF replaces `DEFAULT_THROTTLE_CLASSES` when a view declares its own
`throttle_classes`/`throttle_scope`; it does not merge them. So `login`,
`monte_carlo`, and the other scoped endpoints keep only their specific, stricter
limit — the general default does not add on top. This is the desired behavior
and is documented as such.

**4. Publish the stability & deprecation policy now.**

Add `docs/api/stability.md` (registered in the website sidebar) covering the v1
surface scope, the additive/behavioral/breaking change classes, the deprecation
window (≥ one minor release, with a `Deprecation` response header and changelog
notice), and the URL-path versioning approach. It states that the **full v1
freeze will land in 0.9** (future tense — 0.9 is unshipped) and that the policy
is published early to protect the 0.4 read-only MCP surface and the 0.6 write
surface.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Probe-exempt global default (chosen)** | Baseline protection everywhere; probes safe; env-tunable; satisfies the semgrep rule intent | Two small throttle subclasses to maintain |
| B. Bare `AnonRateThrottle` / `UserRateThrottle` global default | Zero custom code | 429s the k8s probes on a tight loop → spurious pod restarts. This is exactly why the global default was avoided before |
| C. Per-view throttles only (status quo, extended) | No global class; explicit per endpoint | Incomplete by construction — every new endpoint is unprotected until someone remembers to add a scope; the CRUD surface stays open |
| D. Exempt probes by moving them off `/api/v1/` | No throttle override needed | Breaks the documented probe URLs and existing Helm/readiness config; churny for no gain |
| E. Defer the stability policy to the 0.9 freeze | Less to write now | Leaves 0.4 MCP and 0.6 write integrators with no contract during the window they most need one |

## Consequences

- **Easier:** every endpoint now has a baseline rate limit; new endpoints inherit
  it automatically instead of each needing a hand-added scope. Operators tune the
  ceiling from Helm/env. Integrators have a written stability contract to plan
  against before the GA freeze.
- **Harder:** the probe-exempt path list is now load-bearing — if a future probe
  endpoint is added, it must be added to `_PROBE_EXEMPT_PATHS` or it will be
  throttled. A regression test pins the exemption.
- **Risks:** a too-low `anon`/`user` rate could throttle legitimate bursty
  clients; the defaults (60/min anon, 1000/min user) are generous and tunable.
  The stability policy is a public commitment; the deprecation-window promise
  must be honored from here forward (its permanence is sealed by the 0.9 freeze).

## Implementation Notes
- P3M layer: platform
- Affected packages: api (`core/throttling.py`, `settings/base.py`), helm
  (`values.yaml`), website (`administration/configuration.md`, `api/reference.md`,
  `api/stability.md`, `astro.config.mjs`)
- Migration required: **no** (no model change)
- API changes: no new endpoints; adds a global default throttle and a `Retry-After`
  header + `429` contract on the previously-unlimited surface
- OSS or Enterprise: **OSS** (`trueppm-suite`)
- `dev.py` retains its two `# nosemgrep: missing-throttle-config` pragmas: its
  `REST_FRAMEWORK` is built via `**REST_FRAMEWORK` spread and so does not carry
  the *literal* `DEFAULT_THROTTLE_RATES` key the semgrep `pattern-not-inside`
  requires — adding `DEFAULT_THROTTLE_CLASSES` to `base.py` does not change that
  static match. `base.py` itself needs no pragma (it declares the key literally).
