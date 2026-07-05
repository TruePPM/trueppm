# ADR-0214: User-scoped Personal Access Tokens

## Status
Accepted

## Context

The community edition has no way for a user to authenticate a script against the API
**as themselves**. Today the only session-free credential is the `ApiToken` shipped in
ADR-0186 — but that token is **project- or program-scoped**: it authorizes access to a
single project's (or program's) data and is minted by a Project/Program Admin from the
project/program Integrations settings. There is no per-user credential a PMO analyst can
use for a weekly Power BI portfolio extract, a Product Owner for a roadmap-export script,
or a developer for CI tooling — the API-first principle ("if it's not in the API, it
doesn't exist") requires one.

Issue #648 asks for a **Personal Access Token (PAT)**: `tppm_`-prefixed, owned by a user,
full-access (acts as that user, so RBAC applies exactly as their session would), optional
expiry, a cap of 10 active tokens per user, and auto-revocation of all a user's PATs when
their password changes.

**The forces at play:**

- The token infrastructure already exists and is mature: `tppm_` prefix, `secrets.token_hex(32)`,
  SHA-256 hashing into a unique-indexed `token_hash`, `token_prefix` for audit identification,
  soft-revocation via `revoked_at`, `last_used_at` bump, the `ApiTokenAuditEntry` append-only
  log (MINTED/REVOKED/USED), one-time raw-token reveal, and a WebSocket broadcast on mint/revoke.
  Duplicating all of this for a second token type is wasteful and risks divergence in a
  security-critical surface.
- The **authentication hot path** runs on every request that presents a `tppm_` bearer.
  `ProjectApiTokenAuthentication` does a **single** SHA-256 lookup on the unique `token_hash`
  index. Personal and project tokens share the `tppm_` prefix and are therefore
  indistinguishable at parse time — a second token *table* would force the authenticator to
  query two tables (or restructure the token format), doubling the worst-case auth cost on
  every request.
- ADR-0186 §E explicitly designed the `scopes` `ArrayField` to be **forward-compatible**:
  "0.x can add scopes additively with no migration churn." A full-access personal token is
  just `scopes=['legacy:full']` with a user owner — the field was built anticipating exactly
  this.
- `ApiToken` currently carries a check constraint `api_token_scope_xor` requiring **exactly
  one** of `project`/`program` to be non-null. A personal token (both null) violates it.
- `ApiToken.created_by` is `SET_NULL` — it records the *minter*, not an *owner*. A personal
  full-access credential must **die with its user** (CASCADE), never outlive a deleted account.

**P3M layer:** Operations / Programs and Projects. A personal credential lets a user script
against the data they can already reach. It is **OSS** — session-free personal API access is
table-stakes developer/analyst tooling, part of the adoption surface. Enterprise can later
layer scope/policy controls (token lifetime limits, mandatory expiry, per-scope grants) via
the ADR-0029 slot registry without changing this primitive.

## Decision

**Extend the existing `ApiToken` model to support a third, user-scoped variant** rather than
introducing a separate `PersonalAccessToken` model.

1. **Model changes** (`apps/projects/models.py`):
   - Add `owner = ForeignKey(AUTH_USER_MODEL, on_delete=CASCADE, null=True, blank=True,
     related_name="personal_api_tokens")` — the acting user for a personal token; null for
     project/program tokens. CASCADE so a deleted account takes its full-access credentials
     with it.
   - Add `expires_at = DateTimeField(null=True, blank=True)` — optional expiry; null =
     non-expiring (preserves existing project/program token behaviour).
   - **Relax** `api_token_scope_xor` to require **exactly one** of `{project, program, owner}`
     non-null (three-way XOR). Every existing row (project XOR program) still satisfies the
     relaxed rule — a pure relaxation, safe on shipped data, no data migration.
   - Mirror on `ApiTokenAuditEntry`: add nullable `owner` FK (CASCADE) and relax
     `api_token_audit_scope_xor` the same way, so personal-token mint/revoke/use events are
     auditable under the same append-only log.

2. **Authentication** (`apps/projects/authentication.py`):
   - Add an **expiry filter** to the single lookup:
     `Q(expires_at__isnull=True) | Q(expires_at__gt=now())`. Applies uniformly; project/program
     tokens have null `expires_at` and are unaffected.
   - `select_related("owner")` and return `(token.owner or token.created_by or AnonymousUser(), token)`.
     For a personal token the acting user is `owner`; for project/program tokens `owner` is null
     and behaviour is unchanged. Because `request.user` becomes the owner, **all downstream
     DRF object-level RBAC applies exactly as that user's session** — a Viewer's PAT reads only
     what a Viewer sees. A PAT is *not* a superuser credential.

3. **CRUD** — new `MyApiTokenViewSet` at `/api/v1/me/api-tokens/` (`[IsAuthenticated]`,
   auto-scoped to `owner=request.user`):
   - `GET` list / retrieve (never returns the raw token or hash).
   - `POST` create — generates the raw token, returns it **once**, writes a MINTED audit row
     (owner-scoped), broadcasts nothing project-scoped (personal tokens have no board channel;
     see Durable Execution). Enforces the **10-active-token cap** (`count() >=
     MAX_PERSONAL_ACCESS_TOKENS`, where "active" = not revoked, not deleted, not past expiry),
     following the comments/notes count-gate precedent. Reuses `TokenIssuanceThrottle` (5/min).
   - `DELETE` — soft-revoke (`revoked_at = now()`), WRITES a REVOKED audit row; idempotent.
   - v1 tokens are full-access: `scopes` fixed to `['legacy:full']`, no scope picker
     (issue: "v1 is full-access — no scopes"). Enterprise adds scoping later on the same field.

4. **Password-change revocation** — a shared service
   `revoke_all_personal_access_tokens(user)` (`apps/access/services.py`, sibling of
   `revoke_all_refresh_tokens`) that soft-revokes every non-revoked PAT owned by the user.
   Called inside the atomic block of `PasswordResetConfirmView.post`, immediately after
   `revoke_all_refresh_tokens(user)`. Only **personal** (owner=user) tokens are revoked;
   project/program tokens are org assets, not personal credentials, and are untouched. Any
   future authenticated change-password endpoint MUST call the same service (documented here
   so the hook is not missed).

5. **Web** — a new **Account settings → Personal Access Tokens** page under `/me/settings`
   (net-new; no account-level token surface exists). Reuses the `ApiTokensManager` patterns
   (list with prefix + last-used + expiry state, create modal with one-time reveal, revoke
   confirm) pointed at `/me/api-tokens/`, plus an expiry picker and a live "N of 10" cap
   indicator. Detailed layout is deferred to the `ux-design` gate.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **(A) Extend `ApiToken` (chosen)** | Single SHA-256 auth lookup on the hot path; reuses hashing, reveal, audit log, revoke, WS, throttle; `scopes` was built forward-compatible (ADR-0186); constraint change is a pure relaxation, safe on shipped rows, no data migration | Constraint + audit-model surgery on a shipped security table (mitigated: relaxation only, covered by `api:migration-check` + new pytest); `ApiToken` becomes polymorphic across 3 scopes |
| **(B) Separate `PersonalAccessToken` model** | Clean lifecycle isolation; no touch to the shipped MCP token table; independent CASCADE/expiry/cap semantics | Two tables with the **same `tppm_` prefix** → authenticator must query both every request (2× hot-path cost) OR fork the token format (breaks the single-prefix secret-scanner regex); duplicates hashing/reveal/audit/WS/revoke logic, inviting divergence in a security-critical path |
| **(C) Fork the token format** (`tppm_u_…` personal vs `tppm_…` project) to route to two tables in one lookup | Restores single-lookup with two tables | Two token grammars; existing legacy tokens are un-namespaced so routing is asymmetric; more surface for a parsing bug; no upside over (A) |

Option (A) wins on the decisive factor — the auth hot path stays one indexed lookup — while
inheriting a mature, audited token surface. The constraint relaxation is the only real cost
and it is safe by construction.

## Consequences

- **Easier:** one token model, one authenticator, one audit log, one reveal/revoke flow to
  reason about and secure. Adding future scoped personal tokens (Enterprise) is additive on
  the existing `scopes` field.
- **Harder:** `ApiToken` now spans three scope shapes; every query that assumes a token is
  project/program-scoped must be re-checked for the `owner` case (audited during
  implementation: `_summarize_api_tokens`, the project/program viewsets' `owner__isnull=True`
  filter, and the WS broadcast paths must ignore owner-scoped tokens).
- **Risks:**
  - A migration that mis-relaxes the constraint could admit a token with two scopes set
    (e.g. project + owner) → a confused-deputy credential. Mitigation: the three-way XOR is
    exact-one-of, and a pytest asserts both "personal token (owner only) is allowed" and
    "mixed-scope token is rejected at the DB."
  - Forgetting to filter `owner__isnull=True` in the existing project/program token list
    endpoints would leak personal tokens into a project's token list. Mitigation: explicit
    filter + regression test on the existing endpoints.
  - A full-access PAT is a bearer of the user's full authority. Mitigation: acts strictly as
    the user (RBAC unchanged, no privilege elevation), 10-token cap, optional expiry,
    password-change revocation, one-time reveal, SHA-256-at-rest, constant-time-safe compare
    (hash lookup, not string compare). Scrutinized by the follow-on `threat-model` +
    `security-review` gates.

## Implementation Notes

- **P3M layer:** Operations / Programs and Projects
- **Affected packages:** api (models, migration, authentication, serializers, views, urls,
  services), web (new /me/settings PAT page, hook, api types)
- **Migration required:** yes — one `projects` migration: add `ApiToken.owner`,
  `ApiToken.expires_at`, `ApiTokenAuditEntry.owner`; relax both check constraints. Additive
  nullable columns + constraint relaxation only; no data migration.
- **API changes:** yes — new `/api/v1/me/api-tokens/` (list/create/retrieve/destroy); auth
  class gains an expiry check and owner resolution; OpenAPI schema regenerated.
- **OSS or Enterprise:** OSS (`trueppm-suite`). No enterprise import.

### Durable Execution
1. **Broker-down behaviour:** N/A for the token lifecycle itself — mint/revoke are synchronous
   DB writes with no Celery dispatch. The only async side effect is the existing WS broadcast,
   already deferred with `transaction.on_commit()` in the project/program viewsets; the personal
   viewset does not broadcast (no board channel for a user-scoped token), so there is no new
   dispatch path.
2. **Drain task:** N/A — no new async work category; no `.delay()` introduced.
3. **Orphan window:** N/A — no outbox rows.
4. **Service layer:** new `revoke_all_personal_access_tokens(user)` in `apps/access/services.py`
   (a synchronous ORM update, sibling of `revoke_all_refresh_tokens`). No Celery service.
5. **API response on best-effort dispatch:** N/A — create/revoke are synchronous; create returns
   `201` with the one-time raw token, revoke returns `204`.
6. **Outbox cleanup:** N/A — no outbox rows. `ApiTokenAuditEntry` rows are append-only and retained
   under the existing audit-retention policy (unchanged).
7. **Idempotency:** Create is `idempotency_exempt` (a one-time secret must never be replayed from
   the idempotency store — same rationale as the project token viewset). Revoke is naturally
   idempotent — re-revoking a token is a no-op (`revoked_at` already set). The auth-time
   `last_used_at` bump is a bare `.update()`, safe under concurrent requests (last-writer-wins,
   no correctness dependency).
8. **Dead-letter / failure handling:** N/A — no Celery task. A failed mint/revoke is a normal
   synchronous request error surfaced to the caller; the DB transaction rolls back, leaving no
   partial token.
