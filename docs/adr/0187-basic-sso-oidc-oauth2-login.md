# ADR-0187: Basic SSO — self-service OIDC/OAuth2 login against the operator's own IdP

## Status

Accepted (2026-06-30)

Accepted with the **#1405 backend** implementation (the OIDC relying party + the
`OIDCProvider` config surface). The pre-implementation `threat-model` mitigations are
folded into the code and recorded in **§ Implementation outcome (#1405 backend)**
below; the **#1392 web** and **#1406 mobile** slices follow against the now-frozen
backend contract. **Enforce-SSO decision locked: OSS ships *no* commercial surface
for the disabled-local-accounts state — see §4/§5 and resolved open question 1.**

> **Numbering caveat (confirm at merge):** `0184` is the highest ADR on `main`.
> `0185` and `0186` are expected to be claimed by sibling 0.4 design-import streams
> running in parallel worktrees (PWA/offline, Jira Connect, Web Time Entry). This
> ADR takes `0187`; **verify the next free number and renumber this file if it
> collides at merge.**

## Context

Self-service single sign-on is a **0.4 OSS roadmap commitment** and table stakes for
self-hosters. An operator points TruePPM at the identity provider they already run
(Keycloak, Authentik, Authelia, Zitadel, or a hosted IdP — Google, GitHub, GitLab)
and their users log in through it. This is **authentication**, not identity
*governance*; the CLAUDE.md auth carve-out draws the line precisely:

> **Log in via your own IdP → OSS. Provision, deprovision, and govern accounts from
> a directory → Enterprise.**

This ADR is the **shared 🔴 blocker** for three sibling issues and resolves the
"no auth/SSO ADR exists" gap (the only auth ADR today is
`0141-websocket-short-lived-ticket-auth`):

- **#1405** — backend: provider-config model + login/callback endpoints
- **#1392** — web: login flow (5 states) + admin OIDC config page
- **#1406** — mobile: in-app-browser OIDC + PKCE (**sequenced later** — depends on the
  not-yet-existent `packages/mobile/` RN scaffold; see §7)

A prior `enterprise-check` (2026-06-29) **locked the boundary** for this work. This
ADR documents that locked split and the *mechanism* by which the excluded
capabilities register as enterprise extension points, so the OSS surface can ship
now and the enterprise governance layer attaches later with **zero OSS change**.

### What already exists (we build on it, we do not reinvent it)

- **Session model — keep it.** Login is `CookieTokenObtainPairView`
  (`core/auth_views.py`, #897): the **access** token is returned in the JSON body and
  held in memory by the SPA; the **refresh** token rides in a hardened
  `httpOnly`, `Secure`, `SameSite=Strict` cookie scoped by `Path` to
  `/api/v1/auth/token/refresh/`, rotated with blacklist-on-rotation. SSO reuses this
  session verbatim — it does **not** mint a new token surface.
- **`allauth` + `allauth.account`** are installed; **`allauth.socialaccount` is
  not.** There is no social-provider plumbing today.
- **User model** is stock `django.contrib.auth.User` (no `AUTH_USER_MODEL`
  override). Identity is keyed on email.
- **Workspace is a singleton** (`apps/workspace/models.py` — single-row,
  installation-wide config, lazily created via `Workspace.load()`). Multi-tenancy is
  Enterprise. **There is exactly one workspace in OSS**, so SSO config is
  installation-wide, not per-tenant.
- **Workspace roles** (`WorkspaceRole`: `MEMBER=100`, `ADMIN=300`, `OWNER=400`) and
  the `IsWorkspaceAdmin` / `IsWorkspaceOwner` permission classes gate workspace
  config. Admin config pages are `IsWorkspaceAdmin`.
- **Secret-at-rest is solved** (ADR-0049 §3): `apps/integrations/encryption.py`
  `encrypt_secret()` Fernet-encrypts integration PATs into a write-only
  `BinaryField` using `settings.INTEGRATION_ENCRYPTION_KEY`. The OIDC client secret
  reuses this exact pattern — **no new dependency**.
- **PyJWT 2.13.0** is already in `uv.lock` (transitive via simplejwt) and ships
  `cryptography` (via Fernet). ID-token signature verification can use PyJWT's
  `PyJWKClient` with the `crypto` extra — minimal new surface (see §2 and
  Implementation Notes).
- **Extension-point precedents:** ADR-0029 (frontend `WidgetRegistry` slot registry
  + `GET /api/v1/edition/` edition detection) and ADR-0177 (backend single-slot
  `register_*_provider` idiom returning a safe community default when unregistered).

### VoC lens — the self-hoster

The self-hoster persona's blocker is the **"SSO tax"**: a product that paywalls
login federation is dead on arrival for a team that already runs Keycloak. The
design priorities that follow: SSO is the **primary** sign-in path on the login
screen (not a hidden alternate); setup is a **single admin page** with discovery,
a **Test connection** button, and a copy-able redirect URI; and **no enterprise
license is implied anywhere** — hence the `OSSChip` and the mandatory correction of
the mislabeled stub (§6).

## Decision

Ship a **purpose-built OIDC Relying Party** (Authorization Code + PKCE) backed by a
single `OIDCProvider` config row, that mints the **existing** cookie-JWT session.
**Do not** adopt `allauth.socialaccount`.

### 1. Provider-config model — `OIDCProvider`

A new Django app `trueppm_api.apps.sso` (one app per domain) owns:

```text
OIDCProvider
  id                    UUIDField (PK)
  workspace             FK → Workspace (on_delete=CASCADE)   # singleton today; FK keeps
                                                             # enterprise multi-tenancy open
  enabled               BooleanField(default=False)
  display_name          CharField                            # "Acme SSO"
  issuer_url            URLField                             # discovery base;
                                                             # {issuer}/.well-known/openid-configuration
  client_id             CharField
  client_secret_ciphertext  BinaryField                      # Fernet (ADR-0049 §3), write-only,
                                                             # NEVER serialized back
  scopes                ArrayField(Char, default=["openid","email","profile"])  # OSS-fixed
  allowed_email_domains ArrayField(Char, default=list)       # gates auto-create
  auto_create_members   BooleanField(default=False)
  default_role          PositiveSmallInteger(default=WorkspaceRole.MEMBER)  # single role
  allow_password_signin BooleanField(default=True)           # INFORMATIONAL in OSS (§4)
  created_at / updated_at
```

Deliberate calls (architect rigor):

- **Singleton-aligned, not synced.** `OIDCProvider` follows the `Workspace` config
  pattern, **not** the synced-resource pattern. It is **not** a `VersionedModel`,
  carries **no `server_version`**, and never enters the WatermelonDB sync delta.
  Issue #1405 mentions `server_version` in passing; we **drop it on purpose** — this
  is admin secret-bearing config, and putting it in the client sync stream risks
  leaking config (even masked) to every device. The admin page reads it over a
  dedicated authenticated endpoint, nothing more.
- **`client_secret` is Fernet-encrypted at rest** via the existing
  `encrypt_secret()` helper, stored as a `BinaryField`, **write-only**, and **never
  returned** to any client (the serializer exposes a `secret_set: bool` flag and a
  masked hint only). A **Rotate** action overwrites the ciphertext.
- **`scopes` is fixed to `openid email profile` in OSS.** The field exists for
  enterprise to widen (it would request `groups`/custom claims through its own
  provider extension), but OSS never offers more — there is no `groups` scope and no
  consent line about "directory group memberships."
- **`redirect_uri` is derived, not stored** — computed as
  `{public API origin}/api/v1/auth/oidc/callback` and shown read-only in the admin
  page for the operator to copy into their IdP's allowed-redirect list. The callback
  enforces an **exact-match redirect-URI allow-list** server-side.

`migration-check` at implementation: workspace-scoped FK, no `NOT NULL` without
default, batch the model edits into **one** migration.

### 2. Login + callback flow — Authorization Code with PKCE

Five endpoints under `apps/sso`, wired at `/api/v1/auth/oidc/...` next to the
existing cookie-auth views:

1. **`GET /api/v1/auth/oidc/discover?email=`** — extract the email **domain**, match
   it against `allowed_email_domains` of the enabled provider, return
   `{ provider_present, display_name, issuer }`. **No enumeration leak:** this only
   reveals whether a *domain* uses SSO; it never touches the user table and never
   reveals whether an account exists. Always `200`; unmatched → `{provider_present:
   false}`. Unauthenticated; throttled with a scoped rate.
2. **`GET /api/v1/auth/oidc/login`** — generate a single-use signed **`state`** (CSRF),
   a PKCE **`code_verifier`** (→ `code_challenge`, method **S256**), and a **`nonce`**;
   store `{state → verifier, nonce, created_at}` server-side in the cache with a
   short TTL (~5 min, single-use); `302` to the IdP `authorization_endpoint` with
   `scope=openid email profile`, `code_challenge`, `redirect_uri` (allow-listed).
3. **Provider consent** — IdP-side, not ours (reference only).
4. **`GET /api/v1/auth/oidc/callback?code=&state=`** —
   - validate `state` (exists, unexpired, **single-use → delete on read**);
   - exchange `code` + `code_verifier` at the `token_endpoint`;
   - **validate the ID token**: signature against the discovery `jwks_uri`
     (PyJWT, RS256/ES256/asymmetric-only allow-list — `none`/`HS*` rejected). The
     JWKS is fetched through the **SSRF-guarded egress** (`apps/integrations/http`),
     **not** `PyJWKClient`'s own socket — see § Implementation outcome. Enforce
     `iss == issuer`, `aud == client_id`, `exp`/`iat`, and `nonce` matches the
     stored value;
   - bind identity to the **IdP `email` claim** (and require `email_verified`),
     **never** a user-supplied value;
   - **identity resolution** (durable key): match on **`(issuer, sub)`** via an
     `OIDCIdentity` link row first; if none, fall back to the verified `email` for
     the **initial** link and persist the `sub` so later logins match the stable
     subject, not the mutable email (account-takeover mitigation — see Threat model);
   - **account rules:**
     - email matches an existing local user → **link** and sign in;
     - else if `auto_create_members` **and** domain ∈ `allowed_email_domains` →
       **create the user and one `WorkspaceMembership` at `default_role`** (this is
       "**create user on first successful login**" — *not* JIT provisioning, *not*
       SCIM);
     - else → **`403 SSO_NO_MEMBER`**.
   - on success: **reuse `_set_refresh_cookie`** to set the httpOnly refresh cookie,
     then `302` to the SPA completion route (`{FRONTEND_BASE_URL}/auth/sso/complete`).
     **No token is ever placed in the URL or fragment.** The SPA mounts, calls the
     existing `/api/v1/auth/token/refresh/` (the refresh cookie is now present), and
     receives a fresh in-memory access token. The entire SSO session is the existing
     session — one code path, one token surface.
5. **`POST /api/v1/workspace/sso/test-connection`** *(admin)* — fetch the discovery
   document + JWKS, validate reachability and that the required endpoints/keys exist;
   power the admin "Test connection" button. `IsWorkspaceAdmin`.

Plus the admin config surface:

- **`OIDCProviderView`** (singleton GET/PUT/DELETE under `/api/v1/workspace/sso/`,
  mirroring `WorkspaceSettingsView`) — `IsWorkspaceAdmin`; secret **write-only**;
  **Rotate** action; `Disable SSO`. (Issue #1405's `/workspaces/{id}/...` phrasing is
  the *multi-tenant Enterprise future*; OSS uses the **singleton** path, consistent
  with `WorkspaceSettingsView`.)

### 3. Where config is stored + the admin page

Config lives in the `OIDCProvider` row, edited **only** through the
`IsWorkspaceAdmin`-gated endpoint above. The web admin page is **Workspace settings →
Single sign-on** (`AdminOIDC`): status banner + Test connection; provider fields
(display name, issuer, client id, masked secret + Rotate, copy-able redirect URI,
scopes shown read-only as `openid email profile`); sign-in policy (allowed email
domains, Auto-create members + default role, and the **read-only** "Allow password
sign-in" row — see §4); plus an empty state (`AdminOIDCEmpty`). This is the
**Settings sub-page wiring** change class once the shell exists — but because it
introduces a genuinely novel interaction (the 5-state SSO login flow), the web slice
(#1392) takes the **full frontend-feature gate chain** (`ux-design` → implement →
`ux-review`).

### 4. Out of OSS — and how each registers as an enterprise extension point

The boundary is **locked**. None of the following ship as OSS functionality; each has
a **stable seam** so `trueppm-enterprise` attaches with no OSS edit. The one-way
dependency holds: enterprise → OSS, never the reverse.

| Excluded capability | OSS treatment | Extension-point mechanism |
|---|---|---|
| **`groups` scope + group→role mapping** | OSS requests `openid email profile` only and assigns the single `default_role`. No `groups` scope, no consent line, no claim→role logic. | **Backend, ADR-0177 idiom.** `apps/sso/extensions.py` exposes `register_oidc_identity_mapper(provider)` / `oidc_role_for(claims, config)`. OSS default ignores claims and returns `default_role`. Enterprise registers a mapper that reads `groups`/custom claims (requesting the wider scope through its own provider-config extension) and maps to roles, with the auth-event audit trail. |
| **"Allow password sign-in: OFF" (enforced org-wide SSO / disable local accounts)** | The `allow_password_signin` flag is **stored but never enforced**, and OSS shows **no commercial surface** for the OFF state — **no upsell, no teaser, no Enterprise badge** (decision locked; see open question 1). OSS always permits password login. The serializer reports `allow_password_signin_enforced: false` as a static, informational field only. | **Backend seam only (in OSS).** `register_local_login_policy_provider(provider)` / `local_login_allowed(user)`; the OSS default always returns `True`, so `CookieTokenObtainPairView` is never blocked. Enterprise registers a provider that, when `allow_password_signin=False`, blocks password login for non-exempt accounts and emits the audit event — and **enterprise** owns any UI that surfaces the OFF state. OSS ships an empty extension-point slot, never the enforcement and never a marketing surface for it. |
| **SCIM / LDAP / directory provisioning + deprovisioning** | **Entirely absent.** "Create user on first successful login" is the *only* account-creation path, gated by the domain allow-list. No lifecycle sync, no deprovisioning, no directory read. | Not designed here. Directory provisioning is a separate enterprise subsystem that registers against membership creation, **not** the login flow. Explicitly out of scope; do **not** file it in the OSS tracker. |

> **Enterprise follow-ups (file in `trueppm-enterprise`, NOT the OSS tracker):**
> `groups` scope + group→role mapping; enforced-SSO password-disable *enforcement* +
> auth-event audit trail; SCIM/LDAP directory sync. The OSS `enterprise`/`portfolio`
> labels are reserved for OSS-side extension-point work and trip `boundary:check` if
> applied to these.

### 5. Edition/contract posture

The two backend seams (`register_oidc_identity_mapper`,
`register_local_login_policy_provider`) follow ADR-0177's idempotent single-slot
registration and degrade to a safe community default with no enterprise package
installed. **OSS carries no commercial surface for the excluded capabilities** — no
upsell widget, no edition-gated teaser — so there are **no `if (edition ===
'enterprise')` branches in OSS components**, and `grep -r "trueppm_enterprise"
packages/` stays at zero. Any surface that markets or exposes the enforced-SSO OFF
state lives entirely in `trueppm-enterprise`.

### 6. Correct the mislabeled login stub (🔴, owned by #1392)

`packages/web/src/features/auth/LoginPage.tsx` (lines ~317–348) ships a
"Continue with SSO" button whose tooltip reads **"SSO available in Enterprise tier"**
(code comment: *"stub in OSS; enterprise overrides this component"*). This is the
**headline reason this work exists** and directly contradicts the OSS auth carve-out.
The web slice (#1392) replaces it with the real SSO entry point + `OSSChip`. The
co-located tests assert the wrong copy and must move in the **same commit**:
`LoginPage.test.tsx` lines 31/99/101 (`'SSO available in Enterprise tier'`,
`'Continue with SSO'`). **Flagged here, fixed in #1392 — not in this ADR branch.**

### 7. Mobile (#1406) — sequencing

Mobile SSO is the **same OSS authentication capability** (PKCE is the correct public-
client flow). It is **explicitly later**: `packages/mobile/` does not exist yet, so
#1406 is blocked on the React Native scaffold **and** on the #1405 backend. The
backend endpoints in §2 are designed to serve it unchanged, with one mobile-specific
addition deferred to #1406: the native return uses a **custom-scheme / universal-link
`redirect_uri`** through the platform in-app browser (ASWebAuthenticationSession /
Chrome Custom Tabs), and tokens land in the Keychain/Keystore — not a web cookie. No
OSS backend change is required to add that redirect URI to the allow-list later.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **Custom OIDC RP minting the existing cookie-JWT session (chosen)** | One session model; full control of PKCE, account-linking, and the singleton admin page; reuses Fernet secret-at-rest and PyJWT; clean OSS/enterprise seams | We own the RP code (state/PKCE/JWKS validation) — must be threat-modeled and tested rigorously |
| `allauth.socialaccount` generic OIDC provider | Discovery + multi-provider out of the box | Manages its own Django-session login, not our JWT cookie flow — we'd bolt minting onto its signals; `SocialApp` config is tied to `django.contrib.sites` and the Django admin, not our singleton admin page (Test connection, Rotate, domain allow-list, auto-create); awkward per-provider PKCE; pulls in a provider matrix and email-verification flows that overlap our membership model |
| Hand-rolled JWT/JWKS crypto | No dependency | Reinventing signature/`exp`/`aud`/`nonce` validation is exactly where auth bugs live — rejected; use PyJWT `PyJWKClient` |
| Token in callback URL fragment | Simplest SPA handoff | Leaks the credential into history/referer/logs — rejected; callback sets the refresh cookie and the SPA refreshes |

## Consequences

**Easier:**
- Self-hosters get login federation as OSS table stakes; the "SSO tax" objection
  disappears.
- The entire SSO session **is** the existing cookie-JWT session — no second token
  surface to secure, and logout/refresh/rotation already work.
- Enterprise builds group-mapping, enforced-SSO, and SCIM entirely in its own repo
  against the two stable seams + the ADR-0029 slot, with zero OSS change.

**Harder / risks:**
- We own a security-critical RP. **`threat-model` + `security-review` are
  mandatory** at implementation (state/CSRF, PKCE, redirect-URI allow-list, ID-token
  validation, account-linking-on-existing-email takeover, secret-at-rest).
- **Account linking by verified email** is the sharpest risk: a hostile-or-misconfigured
  IdP asserting a victim's email could take over a victim's password account.
  Mitigations baked into §2: require `email_verified`; trust only the single
  admin-configured IdP; gate by domain allow-list; and persist `(issuer, sub)` as the
  durable identity so subsequent logins do not re-resolve by mutable email. The
  threat-model must sign this off.
- A new direct dependency on **PyJWT[crypto]** (today transitive) — runs through the
  `dependency` agent (license/CVE) at implementation; it is already in the tree.

### Durable Execution

1. **Broker-down behaviour:** N/A — login/callback are synchronous request/response;
   no async dispatch, no outbox.
2. **Drain task / orphan window / outbox cleanup:** N/A — no queued work.
3. **Service layer:** `apps/sso/services.py` (state issue/verify, token exchange,
   ID-token validation, identity resolution, membership creation);
   `apps/sso/extensions.py` (the two `register_*_provider` seams).
4. **Idempotency:** `state` is single-use (deleted on read); a replayed callback with
   a consumed `state` fails closed. Provider registrations are idempotent
   (single-slot replace), safe under reload.
5. **State store:** `state`/PKCE verifier/nonce live in the cache (Valkey) with a
   short TTL, not the DB — they are ephemeral and single-use.

## Implementation Notes

- **Affected packages:** `api` (new `apps/sso`: model, endpoints, services,
  extension seams, migration; reuse `apps/integrations/encryption.py`), `web`
  (#1392: login flow + admin page; fix the stub), `mobile` (#1406, later).
- **Migration required:** Yes — one migration for `OIDCProvider` (+ `OIDCIdentity`
  link table). Workspace-scoped FK; defaults on every column.
- **API changes:** Yes — `GET /auth/oidc/discover`, `GET /auth/oidc/login`,
  `GET /auth/oidc/callback`, `POST /workspace/sso/test-connection`, and the
  `/workspace/sso/` singleton config + Rotate action. **`api-docs` + `api-design`**
  at implementation; regenerate `docs/api/openapi.json` (merge `origin/main` first).
- **New dependency:** promote **PyJWT** to a direct dep with the `[crypto]` extra
  (already transitive + `cryptography` present) — `dependency` agent gate. **No**
  new dependency for secret-at-rest (reuse Fernet/ADR-0049).
- **Settings:** reuse `INTEGRATION_ENCRYPTION_KEY` (or add a dedicated
  `TRUEPPM_OIDC_ENCRYPTION_KEY` if key separation is wanted — decide at impl);
  `FRONTEND_BASE_URL` already exists for the SPA completion redirect; the public API
  origin (for `redirect_uri` derivation) must be resolvable — confirm an existing
  setting or add `TRUEPPM_PUBLIC_API_BASE_URL`.
- **OSS or Enterprise:** **OSS** (`trueppm-suite`). The governance layer that
  consumes the seams is **Enterprise**.
- **Docs:** `docs/administration/` OIDC setup page (issuer, client id/secret,
  redirect URI, allowed domains, auto-create) in the **same MR** as the backend
  (#1405) — `docs-writer` gate.

### Implementation outcome (#1405 backend)

The pre-implementation `threat-model` (STRIDE on the RP flow) drove two design
divergences from the body above, folded into the shipped code:

- **JWKS fetched through the SSRF-guarded egress, not `PyJWKClient`.** `PyJWKClient`
  opens its own socket via urllib — it follows redirects and re-resolves DNS,
  bypassing the `apps/integrations/http` egress chokepoint that protects every other
  outbound call. `services._signing_key_for()` instead fetches the JWKS through
  `egress.get`, parses it with `PyJWKSet.from_dict`, and selects the key by `kid` /
  `use`. The signature is then verified by `jwt.decode` against an asymmetric-only
  algorithm allow-list (`RS*`/`ES*`); `none` and `HS*` are rejected (alg-confusion).
- **State is browser-bound by a hardened cookie.** The server-side single-use `state`
  only proves *we* issued it; it does not prove the **same browser** began the flow.
  `/login` sets a `SameSite=Lax`, httpOnly, host-scoped cookie carrying the state, and
  `/callback` requires it to match the query `state` (constant-time compare) **before**
  consuming the server-side entry — defeating login-CSRF / session-fixation. Lax (not
  Strict) is required because the callback navigation arrives top-level from the IdP.

Other mitigations in code: https-only issuer outside DEBUG; `oidc_login` and
`oidc_callback` scoped throttles; identity keyed durably on `(issuer, sub)` with
verified-email account-linking only; `discover` never touches the user table (no
enumeration); the client secret is Fernet-encrypted and never serialized back.

**Enforced-SSO posture in code:** OSS stores `allow_password_signin` and exposes
`register_local_login_policy_provider`, the serializer reports
`allow_password_signin_enforced: false` as a static informational field, and there is
**no upsell, teaser, or Enterprise badge** anywhere in the OSS surface.

### Boundary-compliance verification

- `grep -r "trueppm_enterprise" packages/` MUST return zero (CI `boundary:check`).
- OSS requests **only** `openid email profile`; **no** `groups` scope, **no**
  claim→role mapping, **no** enforced-SSO enforcement, **no** SCIM — each is an
  enterprise extension point, not OSS code.
- `oidc_role_for()` and `local_login_allowed()` return safe community defaults with
  no enterprise package installed; the community edition stays fully functional
  standalone.

## Open questions (🔴 blockers for Kelly)

1. **Enforced-SSO toggle as an extension point — RESOLVED (no upsell).** OSS stores
   the `allow_password_signin` flag and exposes the `register_local_login_policy_provider`
   seam, but **never enforces the OFF state and ships no commercial surface for it** —
   no upsell, no teaser, no Enterprise badge. The backend serializer reports
   `allow_password_signin_enforced: false` as a static informational field. The OFF
   *enforcement* and any UI that markets it are Enterprise-only. (Chosen over the
   earlier "gated upsell affordance" framing.)
2. **Mislabeled login stub — confirm correction lands in #1392.** Replace the
   "SSO available in Enterprise tier" tooltip + stub with the real SSO entry point +
   `OSSChip`, moving the three `LoginPage.test.tsx` assertions in the same commit.
3. **Provider-config storage decision — confirm.** `OIDCProvider` is a
   **singleton-aligned config row** (FK to the singleton `Workspace`), **not** a
   `VersionedModel` and **not** in the sync delta (dropping #1405's offhand
   `server_version`); secret Fernet-encrypted write-only at rest reusing ADR-0049.
   Endpoint is the **singleton** `/api/v1/workspace/sso/`, not `/workspaces/{id}/`.
4. **Account-linking policy — confirm the takeover mitigation.** Link an SSO identity
   to an existing password account **only** when `email_verified` is true, from the
   single trusted IdP, within the domain allow-list, and persist `(issuer, sub)` as
   the durable key. Threat-model signs this off at implementation.
5. **Encryption key separation — decide.** Reuse `INTEGRATION_ENCRYPTION_KEY` or add
   a dedicated `TRUEPPM_OIDC_ENCRYPTION_KEY`.

## Gate chain (post-ADR, at implementation)

- **Shared:** `threat-model` (🔴, mandatory — this stream touches auth) →
  `architect` (this ADR) is done.
- **#1405 backend:** `api-design` → implement → pre-MR batch (`security-review`,
  `rbac-check`, `perf-check`, `regression-check`, `migration-check`) → `api-docs` →
  `test-scaffold` (pytest) → `changelog` → `/mr`.
- **#1392 web:** `ux-design` (login layout A vs B) → implement → `ux-review` →
  `regression-check` → `test-scaffold` (vitest + Playwright) → `changelog` → `/mr`.
- **#1406 mobile (later):** blocked on the RN scaffold + #1405 → `mobile-design` →
  implement → `mobile-review` → tests → `changelog` → `/mr`.

## References

- Issues #1392 (web), #1405 (backend), #1406 (mobile)
- CLAUDE.md — Auth carve-out (basic SSO is OSS); Two-Repo Rule
- `enterprise-check` 2026-06-29 — boundary lock for this work
- ADR-0029 — frontend slot registry + edition detection (consumed by enterprise; OSS
  registers no enforced-SSO surface)
- ADR-0177 — extension-point registry idiom (the two backend login-policy seams)
- ADR-0049 — Fernet secret-at-rest (reused for the client secret)
- ADR-0049 §3 — Fernet credential encryption at rest (client-secret pattern)
- ADR-0141 — WebSocket short-lived ticket auth (the only prior auth ADR)
- ADR-0177 — OSS extension-point provider-registry idiom (the two SSO seams)
- `core/auth_views.py` (#897) — cookie-JWT session reused by the SSO callback
