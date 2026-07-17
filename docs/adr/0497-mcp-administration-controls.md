# ADR-0497: MCP administration controls — instance-wide disable switch and env-overridable token limits

## Status
Accepted

## Context
The read-only MCP surface (ADR-0186) is reachable by any personal API token that
carries the `mcp:read` scope. Once tokens exist, MCP readability is *implicit* — it
lives in token existence plus `McpReadableViewMixin`, which is mixed into ~18 read
viewsets. A self-hosting operator (Persona 10) has **no single lever** to say "no
agent access on this instance, period," and several safety-relevant limits are
hardcoded Python constants that cannot be tuned per deployment:

- `MAX_PERSONAL_ACCESS_TOKENS = 10` (per-user PAT cap, ADR-0214)
- `TokenIssuanceThrottle.USER_LIMIT = 5` (token-mint rate, ADR-0068)
- task-sync `STEADY_STATE_LIMIT = 100` / `BACKFILL_LIMIT = 1000`
- the `mcp_read` / `mcp_read_compute` throttle rates *are* env-backed (ADR-0208
  pattern) but are only reachable through generic env passthrough — not surfaced as
  first-class Helm values.

The OpenAPI `ProjectApiTokenScheme` description also predates personal/program/`mcp:read`
tokens and still describes only the project-scoped task-sync token.

This sits at the **Programs and Projects / Operations** P3M layer — it is OSS
operator configuration, not cross-program governance. Per the auth carve-out, an
operator controlling *their own* instance's agent access is squarely OSS; org-wide
identity governance would be Enterprise. `grep -r 'trueppm_enterprise'` on the touched
code returns zero imports.

## Decision
1. **`TRUEPPM_MCP_ENABLED`** (`env.bool`, default `True` for backward compatibility).
   A new `McpInstanceEnabled` permission is added as the **first** guard in
   `McpReadableViewMixin.mcp_token_guards()`. It is **token-scoped and fail-closed**:
   a non-token (human JWT/session) request passes unconditionally, so normal auth on
   the shared viewsets is unaffected; an API-token caller is **denied 403** whenever
   the switch is off. Placing it first short-circuits the scope/owner guards so a
   disabled instance is the single operator chokepoint. This mirrors the public-board
   kill switch (ADR-0245) but enforces at the mixin's one guard chokepoint (all ~18
   MCP viewsets funnel through it) instead of per-view.

2. **Promote the MCP throttle env vars into first-class Helm values** in
   `packages/helm/values.yaml` under the existing `env:` map (auto-rendered by the
   `trueppm.envVars` helper). `TRUEPPM_MCP_ENABLED` is surfaced there too, next to the
   public-board kill switch.

3. **Make the hardcoded caps env-overridable** via Django settings, each keeping its
   current value as the default and read at request time so `override_settings` (and a
   live operator env change) takes effect: `TRUEPPM_MAX_PERSONAL_ACCESS_TOKENS`,
   `TRUEPPM_TOKEN_ISSUANCE_PER_MINUTE`, `TRUEPPM_TASK_SYNC_STEADY_STATE_LIMIT`,
   `TRUEPPM_TASK_SYNC_BACKFILL_LIMIT`. These are validation constants, not model
   fields — no migration.

4. **Refresh the `ProjectApiTokenScheme` OpenAPI description** to describe the current
   token types (personal/owner-scoped, project-scoped, program-scoped) and the
   `mcp:read` scope, then regenerate `docs/api/openapi.json`.

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
| Enforce the switch in each of the ~18 views (mirror ADR-0245 verbatim) | Follows the exact share-link precedent | 18 duplicated checks, easy to miss one — the opposite of a single chokepoint |
| Enforce in the authenticator (deny at auth time) | Denies before permissions run | Conflates authentication with an authorization policy; loses the clean 403 "no MCP permission" semantics and complicates the existing refusal-audit path |
| Bind caps as class attributes from settings at import time | Simplest edit | `override_settings` and live env changes would not take effect (import-time binding); harder to test |
| Add an org-admin UI toggle | Nicer UX | Over-scoped — this is deploy-time operator config (Persona 10), not an org-admin governance feature (that is the Enterprise line) |

## Consequences
- **Easier**: an operator gets one env var (`TRUEPPM_MCP_ENABLED=false`) to cut all
  agent access instantly, and can tune every token limit per deployment without a code
  change. A denied MCP read is already recorded as a `POLICY` refusal by the mixin's
  existing agent-action audit (`_record_mcp_agent_action`), so the switch's denials are
  observable with no new plumbing.
- **Harder**: nothing materially — the switch defaults on, so existing deployments are
  unchanged.
- **Risks**: a fail-*open* bug would silently keep agent access alive after an operator
  disabled it. Mitigated by placing the check first and returning `False` (deny) as the
  only non-token-passing path, plus a regression test asserting denial when off and a
  test asserting human JWT is unaffected.

## Implementation Notes
- P3M layer: Programs and Projects / Operations (operator configuration).
- Affected packages: api, helm, docs.
- Migration required: no (constants/settings only — verified with `makemigrations --check`).
- API changes: no new endpoints; only the OpenAPI security-scheme description text.
- OSS or Enterprise: **OSS** (self-hosting operator config; zero `trueppm_enterprise` imports).

### Durable Execution
1. Broker-down behaviour: N/A — synchronous permission check + settings reads; no async dispatch.
2. Drain task: N/A — no async work introduced.
3. Orphan window: N/A — no outbox rows.
4. Service layer: N/A — enforcement is a DRF permission class; no new dispatch path.
5. API response on best-effort dispatch: N/A — denials return a synchronous 403.
6. Outbox cleanup: N/A — no outbox rows.
7. Idempotency: N/A — the check is a pure function of `settings.TRUEPPM_MCP_ENABLED` and the request; repeating it is side-effect free. (The refusal-audit row it triggers is idempotent via the existing agent-action path.)
8. Dead-letter / failure handling: N/A — a denial is the safe terminal outcome; there is nothing to retry.
