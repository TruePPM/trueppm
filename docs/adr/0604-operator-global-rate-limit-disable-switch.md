# ADR-0604: Operator-only global rate-limiting kill switch

## Status
Accepted

Extends [ADR-0208](0208-general-api-rate-limiting-and-stability-policy.md)
(general API rate limiting). Follows the operator-flag idiom of
[ADR-0497](0497-mcp-administration-controls.md) (`TRUEPPM_MCP_ENABLED`) and the
read-only System-Health surface of [ADR-0172](0172-system-health-operator-ui-read-api.md).

## Context

The nightly `perf:load` k6 job (#2280) fails its `http_req_failed < 1%`
threshold. All 20 virtual users authenticate with a single shared JWT, so once
they ramp up they collide on the global DRF **`user` throttle scope** (default
`1000/min`, ADR-0208) — the broad CRUD surface (`/projects/`, `/tasks/`,
`/programs/`) declares no per-endpoint scope, so it inherits that default — and
~24% of requests return `429`. The throttle is behaving correctly; the load
pattern is legitimately rate-limited. To measure *raw* throughput the job needs a
way to turn throttling off.

More generally, an operator load-testing or debugging a real deployment, or a
developer running the full stack locally, currently has no clean "off" — only
per-scope rate knobs (ADR-0208) they would have to raise, one at a time, to
implausibly large numbers.

Disabling rate limiting removes a DoS/abuse protection (CWE-770). The forces:

- it must be **impossible to leave on by accident in production** — a single
  stray env var must not silently open a DoS path;
- it must be **visible** — a site owner must be able to tell, from the app, that
  protection is off;
- it must **not** be an in-app toggle — an authenticated user (even an admin)
  must not be able to switch off a platform protection through the API
  (ADR-0497's explicit boundary);
- the env contract becomes an operator-facing surface, so it must be stable.

**P3M layer**: platform / operations. General DoS protection and its operator
override are self-hosting concerns a single team needs, not org-level governance.
**OSS.**

## Decision

Add an operator-only, env-gated global kill switch that disables **all** DRF
throttling, with a two-key acknowledgment and read-only visibility.

**1. Control — two env vars, `core/ratelimit.py`.**
`TRUEPPM_RATE_LIMIT_ENABLED` (bool, default `true`). To disable, an operator must
*also* set `TRUEPPM_RATE_LIMIT_DISABLE_ACK` to the exact sentinel
`i-understand-this-disables-abuse-protection`. Required in **every** environment
(not gated on `DEBUG`). `resolve_rate_limit_enabled()` is a pure function:
`requested_enabled=false` + valid ack → disabled (+ CRITICAL log); + missing/wrong
ack → **refused**, stays enabled (+ CRITICAL log). The refusal fails toward the
*protected* state and deliberately does **not** `raise` (unlike the
`ALLOW_UNENCRYPTED_DB` boot guard): a fat-fingered flag must remove neither the
protection nor the app's availability.

**2. Enforcement — one settings transform + a decorator.**
When disabled, `apply_rate_limit_disable(REST_FRAMEWORK)` empties
`DEFAULT_THROTTLE_CLASSES` and sets every `DEFAULT_THROTTLE_RATES` value to `None`
(DRF's "do not throttle"). This neutralizes *all* `SimpleRateThrottle`-family
throttles — the defaults and every scoped throttle (login, monte_carlo, mcp_read,
share_*, …), present and future — from one place, with no per-class edits. The
eight custom Redis `BaseThrottle` classes (task-sync, sync-upload, git-webhook,
task-link-refresh, mentions, token-issuance, attachment-upload) do not read those
rates, so each carries a one-line `@bypass_when_disabled` decorator that
short-circuits `allow_request` at request time. The bypass is **total**,
including the fail-closed sync write-path throttle — "off means off", so the
admin-facing status is literally accurate.

**3. Visibility — read-only, admin-only.**
`GET /api/v1/health/system/` (already `IsAdminUser`-gated, ADR-0172) gains a
`security.rate_limiting_enabled` field. The web app shows a persistent red
**critical** banner and a **Settings → System** card to workspace admins whenever
it is off. A startup `CRITICAL` log line and the `trueppm.ratelimit.enabled`
OpenTelemetry gauge (`1`/`0`) give ops an alertable signal. The flag is
**never** exposed on the public `/health/`, `/readyz`, or `/edition/` probes — a
disabled protection must not be advertised to anonymous callers.

**4. Consumer.** The `perf:load` CI job sets both env vars in its `variables:`
block (safe: an ephemeral container on dev settings).

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Global kill switch (chosen)** | One honest boolean; visible; covers all scopes; testable | New env contract + UI surface |
| Just raise `TRUEPPM_THROTTLE_USER_RATE` for the perf job | Zero new code; narrowest blast radius; uses an existing ADR-0208 knob | Only fixes the CI symptom; no honest "off"; a banner reacting to "user rate = 999999/min" is meaningless; ~25 scopes to raise for a true "off" |
| Ack gated on `DEBUG` (single key in dev) | Perf job sets one var | A `DEBUG`-dependent branch is an extra edge case; "always require the sentinel" is a simpler, uniform invariant. **Rejected.** |
| `raise ImproperlyConfigured` on unacknowledged disable | Loud, matches `ALLOW_UNENCRYPTED_DB` | Turns a typo into an outage; the safe state here is *protection-on*, not *crash*. **Rejected** in favor of force-enabled + CRITICAL. |
| Keep the fail-closed `SyncUploadThrottle` enforced | Preserves write-path integrity | Makes "rate limiting disabled" untrue; the banner would need a caveat. Operator acknowledged; blunt instrument by design. **Rejected.** |
| In-app admin toggle | Nicer UX | Over-scoped — lets an authenticated user disable a platform DoS protection via the API; this is deploy-time operator config, not governance (ADR-0497). **Rejected.** |
| Monkeypatch DRF `SimpleRateThrottle.allow_request` | One patch covers every scope, request-time toggleable | Fragile across DRF upgrades; the kind of thing security/code review flags. **Rejected** in favor of the settings transform + decorator. |

## Consequences

- **Easier**: the perf job measures real throughput; operators get a clean,
  documented, single-flag "off" for load-testing/debugging; the state is
  observable (banner, card, gauge, log).
- **Harder**: two env vars now form a stable operator contract — renaming either
  (or the sentinel) is a breaking change and needs a deprecation note.
- **Risks**: an operator who genuinely disables it *and* silences the log/banner
  runs unprotected — mitigated by requiring the explicit acknowledgment, keeping
  the default on, refusing unacknowledged disables, and surfacing the state four
  ways. The `security` field on `/health/system/` is admin-gated, so it leaks no
  signal to an unauthenticated attacker.

## Implementation Notes
- P3M layer: Programs and Projects / Operations (platform self-hosting control).
- Affected packages: api (`core/ratelimit.py`, `settings/base.py`,
  `apps/*/throttles.py`, `apps/observability/{selectors,views,otel/metrics}.py`),
  web (banner + Settings → System card + `useSystemHealth`), helm
  (`values.yaml`), website (`administration/configuration.md`), ci (`perf:load`).
- Migration required: no.
- API changes: yes — additive `security` object on `GET /api/v1/health/system/`
  (admin-only). No new endpoint.
- OSS or Enterprise: **OSS** (`grep trueppm_enterprise packages/` clean).

### Durable Execution
1. Broker-down behaviour: **N/A** — pure config resolution + synchronous request-time
   throttle checks + read-only endpoint fields. No async dispatch.
2. Drain task: **N/A** — no async work introduced.
3. Orphan window: **N/A** — no outbox rows.
4. Service layer: **N/A** — settings-time resolution; no `services.py` dispatch path.
5. API response on best-effort dispatch: **N/A** — the only API change is an
   additive read-only field on an existing synchronous 200 endpoint.
6. Outbox cleanup: **N/A** — no outbox rows.
7. Idempotency: `apply_rate_limit_disable` is idempotent; the switch is a pure
   function of two env inputs, so repeated settings loads yield the same state.
8. Dead-letter / failure handling: **N/A** — no tasks. A misconfiguration
   (unacknowledged disable) fails safe (protection stays on) and is logged at
   CRITICAL.
