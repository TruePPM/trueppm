# ADR-0517: Adopt `allauth.socialaccount` as the SSO provider registry behind our own hardened views

## Status

Accepted (2026-07-17)

> **Supersedes [ADR-0187](0187-basic-sso-oidc-oauth2-login.md).** ADR-0187 shipped a
> purpose-built OIDC relying party (`apps/sso`: hand-rolled discovery / JWKS / PKCE /
> ID-token validation) backed by a single `OIDCProvider` config row. This ADR adopts
> `allauth.socialaccount` **as a library — the provider registry + per-provider
> endpoint/claim machinery — behind our existing hardened views and URL surface**. It
> does **not** hand allauth the whole flow. The **auth carve-out**, the **cookie-JWT
> session reuse**, the **SSRF-guarded egress**, the **Fernet secret-at-rest bar**, the
> **OTel query-param redaction**, and the two **enterprise seams** (`oidc_role_for`,
> `local_login_allowed`) from ADR-0187 are all **retained**. Issue #2108. SSO is a
> **0.4 OSS roadmap commitment and is unshipped** — all version claims are future tense.

## Context

ADR-0187 (#1392/#1405) delivered basic SSO as a **hand-rolled OIDC relying party**.
`apps/sso/services.py` owns ~560 lines of security-critical code: OIDC discovery,
JWKS fetch + key selection, PKCE `S256`, `state`/`nonce` minting and single-use
consumption, ID-token signature + `iss`/`aud`/`exp`/`nonce` validation, and identity
resolution. It works and is threat-modeled — but #2108 forces two structural limits:

1. **It is generic-OIDC-only.** The flow assumes an issuer publishing
   `/.well-known/openid-configuration`. The single most-requested self-hoster IdP —
   **GitHub** — is **OAuth2 without OIDC discovery**: no discovery document, no
   `jwks_uri`, no ID token; identity comes from the `GET /user` API. The bespoke RP
   **cannot represent GitHub at all**, and every named provider (Google, GitLab,
   Okta, Auth0, Entra, Keycloak, Authentik, Zitadel) would need per-provider
   issuer-derivation and quirk handling we write and maintain ourselves.

2. **We own the provider matrix.** Every provider we add widens the surface we alone
   maintain and threat-model.

Meanwhile the platform **already ships django-allauth** (**65.18.0**): `allauth` and
`allauth.account` are in `INSTALLED_APPS` (`settings/base.py` ~L46), `AccountMiddleware`
is wired (~L111), `SITE_ID = 1` (~L1083). **`allauth.socialaccount` — the provider
framework — is installed but not enabled.** Its provider registry has exactly the
maintained per-provider endpoint knowledge we lack, **and covers GitHub OAuth2**.

### The security controls the bespoke RP carries that allauth does NOT provide

The bespoke `apps/sso` is not just "OIDC crypto" — it carries five TruePPM-specific
controls that plain allauth does **not** provide out of the box. Any adoption must
**preserve every one** (this ADR accepts **no** regression):

1. **SSRF-guarded egress.** Discovery, token exchange, and JWKS fetches all route
   through `apps/integrations/http` (`egress`). `services._signing_key_for` deliberately
   avoids `PyJWKClient` **specifically** to keep the guard. allauth's providers fetch
   via their own `requests` client, **bypassing egress entirely** — a real regression
   (webhook-SSRF hardening exists elsewhere, ADR-0187 Boundary 6 / #1628).
2. **Encrypted client secret at rest.** `OIDCProvider.client_secret_ciphertext` is
   Fernet-encrypted (`apps/integrations/encryption`, ADR-0049 §3). allauth
   `SocialApp.secret` is **plaintext** — below our bar.
3. **OTel query-param redaction.** `/api/v1/auth/oidc/callback/?code=…&state=…` has
   `code`/`state` redacted (tested in `observability/test_otel_instrumentation.py`).
   Changing the callback path breaks this **and** operator IdP allow-lists **and**
   docs **and** the OpenAPI schema.
4. **ID-token `alg` allow-list** (RS/ES 256/384/512; `none`/`HS*` rejected), the
   **fail-closed `allowed_email_domains` gate**, and the **`trueppm_oidc_state`
   browser-binding cookie** (login-CSRF / session-fixation defense).
5. **The JWT bridge seam** (`apps/sso/views.py:246-248`): `RefreshToken.for_user(user)`
   + `_set_refresh_cookie` on a 302 to `/auth/sso/complete`. The SPA needs the
   **simplejwt refresh cookie**, not allauth's Django session cookie.

These controls are the reason the decision below adopts allauth as a **library behind
our views**, not as a framework that owns the flow.

### What we keep from ADR-0187 (unchanged)

The cookie-JWT session as the only token surface; the auth carve-out (per-provider
login OSS, identity governance Enterprise); the Fernet secret-at-rest bar; the two
enterprise seams (`oidc_role_for`, `local_login_allowed`, ADR-0177); OSS requesting
only `openid email profile` and assigning a single `default_role` (MEMBER/ADMIN);
Workspace-as-singleton in OSS with the FK kept for enterprise multi-tenancy.

## Decision

**Adopt `allauth.socialaccount` as the provider registry + per-provider endpoint/claim
library, and keep our own hardened views, URL surface, egress, encryption, and JWT
bridge in front of it.** Do **not** mount `allauth.urls` at `/accounts/` and do **not**
hand allauth the login flow. Concretely:

- **Retain the URL surface** `/api/v1/auth/oidc/{discover,login,callback}/` and the
  admin `/api/v1/workspace/sso/...` — unchanged callback path (§3.5) → OTel redaction,
  operator allow-lists, docs, and OpenAPI all stay valid.
- **Retain the security layer:** `egress` for **every** outbound call, the ID-token
  `alg` allow-list + nonce check, the JWKS-via-egress fetch, the fail-closed domain
  gate, the browser-binding state cookie, the Fernet-encrypted secret, and the JWT
  bridge — all as-is.
- **Adopt allauth for what it is genuinely better at:** the **provider registry**
  (maintained per-provider endpoint/issuer knowledge), **GitHub OAuth2**
  (`GET /user` identity, no OIDC), and the **`openid_connect` multi-app config** that
  lets many OIDC IdPs coexist. Config is stored in allauth's **`SocialApp`** rows;
  per-user bindings in allauth's **`SocialAccount`**; multiple providers run
  simultaneously.

### 1. Enable `allauth.socialaccount` + exactly two provider modules (as a library)

allauth 65.18.0 ships **dedicated** provider modules for only `google`, `github`,
`gitlab`, `microsoft`, `okta`, `auth0`, and `openid_connect`. It does **not** ship
`keycloak`, `authentik`, or `zitadel` — those are configured through the generic
`openid_connect` provider, whose `APPS` list supports **multiple named OIDC apps**,
each with its own `provider_id` + `server_url`.

Given that, lock the **uniform** provider mapping: use **`openid_connect`** for **every**
OIDC IdP (generic, Google, Entra, GitLab, Keycloak, Authentik, Zitadel, Okta, Auth0)
as named `APPS` entries keyed by our registry id, and use **only** the dedicated
**`github`** module for GitHub (the one non-OIDC OAuth2 IdP). One OIDC code path; the
per-IdP "preset" is UI sugar filling `server_url` + client creds into one
`openid_connect` app. (The rejected mixed alternative — dedicated modules for the six
that have them + `openid_connect` for the rest — buys two adapter paths for no gain,
and matters less here anyway because our views drive the flow, not allauth's URLs.)

Add to `THIRD_PARTY_APPS` (after `allauth.account`) — **only two** provider modules:

```text
"allauth.socialaccount",
"allauth.socialaccount.providers.openid_connect",   # ALL OIDC IdPs, as named APPS
"allauth.socialaccount.providers.github",           # OAuth2, no OIDC — the reason we re-platform
```

`django.contrib.sites` is already implied by `SITE_ID = 1`; add it to `DJANGO_APPS`
if not present (`SocialApp` is M2M to `Site`). We do **not** set
`LOGIN_REDIRECT_URL`/`SOCIALACCOUNT_ADAPTER` to drive allauth's own flow — our views
own it. `SOCIALACCOUNT_PROVIDERS` is used purely as the provider **config registry**:

```python
SOCIALACCOUNT_PROVIDERS = {
    "openid_connect": {
        "APPS": [
            # One entry per configured OIDC IdP; provider_id == our registry slug.
            # client_id + server_url come from admin config; the secret is NEVER put
            # here (it lives Fernet-encrypted on SsoProviderPolicy, §3.1). Illustrative
            # of the shape our config layer synthesizes, not a static literal.
            {
                "provider_id": "keycloak",
                "name": "Acme Keycloak",
                "client_id": "…",
                "settings": {"server_url": "https://idp.acme.example/realms/acme"},
            },
            # …google / entra / gitlab / authentik / zitadel / okta / auth0 / generic
        ],
        "OAUTH_PKCE_ENABLED": True,
        "SCOPE": ["openid", "email", "profile"],       # server-fixed in OSS (§3.4)
    },
    "github": {"SCOPE": ["read:user", "user:email"]},   # OIDC-equivalent scopes
}
```

Because our views drive the flow, we use allauth's provider classes as **metadata +
parsers**: endpoint/issuer derivation, GitHub's `GET /user` profile shape, and claim
extraction. **allauth never performs the outbound HTTP** — §3.2 routes every fetch
through `egress`.

### 2. Provider registry (fixed, server-defined)

The admin picks a provider **type** from a **fixed registry** (approved Claude Design
handoff). It maps each `slug` to its allauth provider (**`openid_connect` for every
OIDC IdP, `github` for GitHub**) and to how `server_url`/identity is **derived** from
a few admin-entered fields. The `slug` **is** the `openid_connect` `provider_id`:

| Registry slug | allauth provider | Admin enters | `server_url` / identity derived from |
|---|---|---|---|
| `generic` | `openid_connect` (`generic`) | issuer URL | `{issuer}/.well-known/openid-configuration` (ADR-0187 path, preserved) |
| `google` | `openid_connect` (`google`) | — | fixed issuer `https://accounts.google.com` |
| `entra` | `openid_connect` (`entra`) | tenant id (or `common`) | `https://login.microsoftonline.com/{tenant}/v2.0` |
| `gitlab` | `openid_connect` (`gitlab`) | instance base URL | derived instance (`https://gitlab.com` or self-managed) |
| `keycloak` | `openid_connect` (`keycloak`) | base URL + realm | `{base}/realms/{realm}` |
| `authentik` | `openid_connect` (`authentik`) | base URL + application slug | `{base}/application/o/{slug}` |
| `zitadel` | `openid_connect` (`zitadel`) | instance URL | derived instance |
| `okta` | `openid_connect` (`okta`) | Okta domain | `https://{domain}` |
| `auth0` | `openid_connect` (`auth0`) | Auth0 domain | `https://{domain}` |
| `github` | `github` | — (+ optional org restriction) | **OAuth2** — `GET /user` identity, no OIDC discovery |

Each OIDC IdP persists as a `SocialApp` (`provider="openid_connect"`,
`provider_id=<slug>`, `client_id`, `settings.server_url`) + a `SsoProviderPolicy` side
row (§3.1). GitHub is one `SocialApp` (`provider="github"`). Multiple apps may be
enabled at once (Google **and** GitHub **and** a Keycloak realm simultaneously) — a
capability the ADR-0187 singleton could not express.

### 3. Locked design decisions

#### 3.1 Data migration + client-secret at rest

**Model mapping:**

| ADR-0187 (delete after migration) | New home |
|---|---|
| `OIDCProvider` — singleton per-workspace RP config | **`SocialApp`** (per-provider `client_id`, `provider`, `provider_id`, `settings.server_url`) + a **`SsoProviderPolicy`** side model (1:1 to `SocialApp`) for the TruePPM policy fields that have no `SocialApp` home: `enabled`, `allowed_email_domains`, `auto_create_members`, `default_role`, `allow_password_signin`, and the **Fernet secret ciphertext** (§below). |
| `OIDCIdentity` — durable `(issuer, subject) → user` binding | **`SocialAccount`** (`provider`, `uid=subject`, `user`, `extra_data={"iss": issuer}` to preserve the issuer disambiguator allauth's `(provider, uid)` key lacks). Same account-takeover-resistant "resolve by stable subject, never mutable email" property. |

A **data migration** in `apps/sso` reads each `OIDCProvider` → creates the matching
`SocialApp` (`provider="openid_connect"`, `provider_id="generic"`, `client_id`,
`settings.server_url=issuer`) + `SsoProviderPolicy` (copying the policy fields and
**re-encrypting** the secret into the side row), then rewrites each `OIDCIdentity`
into a `SocialAccount`, and drops `sso_oidc_provider` / `sso_oidc_identity`. Because
SSO is **unshipped**, there are no production rows to migrate on any real install; the
migration is for dev-DB parity and is a **no-op on a fresh install**.

**Client secret at rest — DECISION: keep Fernet; do NOT accept allauth's plaintext.**
allauth stores `SocialApp.secret` as plaintext — a regression against ADR-0049 §3 that
ADR-0187 explicitly inherited. We hold the bar:

- `SocialApp.secret` is **left empty** at rest. The real secret is stored
  Fernet-encrypted (`encrypt_secret`/`decrypt_secret`) in
  **`SsoProviderPolicy.secret_ciphertext`** (`BinaryField`, write-only, never
  serialized back — the read serializer exposes only `secret_set: bool`, exactly as
  ADR-0187).
- Because **our** token-exchange code (not allauth) makes the outbound call (§3.2),
  the decrypted secret is read from the side row **at exchange time only** and handed
  to the egress `post_form` — it is never persisted in plaintext and never needs to be
  injected into an allauth-owned network path.

#### 3.2 Where the outbound HTTP + custom logic live (control 1 preserved)

**Every outbound call stays in our egress-backed service layer** — this is how the
SSRF guard survives:

- **Discovery / JWKS / OIDC token exchange:** keep `apps/sso/services.py`'s
  `egress.get` / `egress.post_form` calls. allauth's `openid_connect` provider is used
  only to **derive** the `server_url`/endpoints and to **parse** the userinfo/claims —
  it never opens a socket. **We keep our own `validate_id_token`** (alg allow-list +
  `nonce` + `iss`/`aud`/`exp`, JWKS via egress) rather than delegating to allauth's
  verification, which would fetch JWKS off-egress and not enforce our alg allow-list.
- **GitHub OAuth2 (new):** allauth's `github` adapter supplies the authorize/token/
  profile URLs and the `GET /user` + `/user/emails` parsing shape; **our** client
  performs those fetches through `egress` and hands the JSON to allauth's parser (or a
  thin local equivalent). Identity `uid` = the GitHub numeric user id; email from the
  verified-primary `/user/emails` entry (GitHub's `email_verified` analog), feeding the
  same fail-closed domain gate.
- **If a future path must invoke an allauth network method directly,** it is only
  permitted with an **egress-backed `requests` session/transport injected** into
  allauth's `OAuth2Client`, so the guard still holds. The default (above) avoids this
  by keeping the network in our services. See 🔴 blocking question 1.

The TruePPM **policy** logic stays in our retained service layer, unchanged from
ADR-0187: `resolve_user` (durable-subject-first resolution, verified-email link,
unambiguous-match-only, auto-create at `oidc_role_for(claims, provider)`), the
fail-closed `allowed_email_domains` gate, and the `record_audit_event(MEMBER_ADDED,
via="sso")` audit — now writing `SocialAccount`/`SsoProviderPolicy` instead of
`OIDCIdentity`/`OIDCProvider`. The two **enterprise seams** (`oidc_role_for`,
`local_login_allowed`) are **unchanged** and called from the same points; enterprise
still registers against them with zero OSS change.

#### 3.3 JWT bridge — unchanged (control 5 preserved)

The callback still ends at `apps/sso/views.py`'s
`RefreshToken.for_user(user)` + `_set_refresh_cookie(response, str(refresh))` → 302 to
`{FRONTEND_BASE_URL}/auth/sso/complete`, which calls `/api/v1/auth/token/refresh/`.
allauth's Django session login is **not** used; the SPA session is the simplejwt
cookie. **No token in any URL or fragment.** This seam does not change.

#### 3.4 Admin config API

CRUD a `SocialApp` (+ its `SsoProviderPolicy`) per provider under the **retained**
`/api/v1/workspace/sso/` namespace, moving from singleton to collection:
`GET/POST /workspace/sso/providers/`, `GET/PUT/DELETE
/workspace/sso/providers/{slug}/`, and the retained `POST
/workspace/sso/providers/{slug}/test-connection/`. A DRF `ViewSet` over `SocialApp`
(filtered to the singleton workspace's `Site`) — **not** the Django admin (allauth's
default `SocialApp` admin stays hidden; config is our API, like every workspace
setting). Permission: **`IsWorkspaceAdminStrict`** on every method (a GET discloses
IdP topology). Scopes stay **server-fixed** (`openid email profile`; GitHub
`read:user user:email`) — the admin cannot widen them; `groups`/custom claims remain
an enterprise widening. Client secret write-only (PUT rotates), never returned.

#### 3.5 Redirect URI — UNCHANGED (controls 3 + operator allow-lists preserved)

Because we keep our own views and do **not** mount `allauth.urls`, the callback stays
**`/api/v1/auth/oidc/callback/`** for **every** provider (a `provider`/`slug` query or
path segment disambiguates which `SocialApp` is completing). This is the decisive win
of the hybrid: **the OTel redaction rule keeps matching**, operators do **not**
re-register redirect URIs, and the docs/OpenAPI callback contract is untouched. (Full
`allauth.urls` adoption would have forced per-provider `/accounts/oidc/<id>/login/
callback/` paths, breaking all three — see Alternatives.)

### 4. OSS / Enterprise boundary

The adoption **does not move the boundary**. Per-provider self-service login is **OSS**
(auth carve-out); `allauth.socialaccount` and the two provider modules do only login
federation. allauth's OSS `socialaccount` provides **no** SAML federation, **no** SCIM,
**no** LDAP/AD sync, **no** enforced org-wide SSO, and **no** group→role governance —
those remain the Enterprise identity-governance layer, attaching through the
**unchanged** `oidc_role_for` / `local_login_allowed` seams and the ADR-0029 slot. OSS
requests only `openid email profile`, assigns a single MEMBER/ADMIN `default_role`,
stores-but-never-enforces `allow_password_signin`, and ships **no** commercial surface
for the excluded capabilities. `grep -r "trueppm_enterprise" packages/` stays **zero**.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **allauth.socialaccount as a library behind our own views/URLs/egress (chosen)** | Unblocks GitHub + every named IdP via maintained provider knowledge; multi-provider; **preserves all five controls** (egress, encrypted secret, OTel redaction, alg allow-list/domain gate/state cookie, JWT bridge); **redirect URI unchanged**; allauth already installed | We use allauth as a metadata/parser layer, not its flow — slightly against the grain; a data migration + a policy side model; must be disciplined that no allauth call opens an off-egress socket |
| **Mount `allauth.urls` and hand allauth the whole flow** | Least glue code; canonical allauth usage | **Regresses controls 1–3**: allauth fetches off-egress (SSRF guard lost), `SocialApp.secret` plaintext, and the callback path changes to `/accounts/oidc/<id>/login/callback/` — breaking OTel redaction, operator allow-lists, docs, and OpenAPI. Re-implementing all three on top of allauth (egress-wrapped session, encrypted-field, redaction re-mapping) is more work and more fragile than keeping our views. **Rejected.** |
| **Keep the bespoke RP and add per-provider presets** | No new framework; no path change | **Does not solve GitHub** (OAuth2/no-OIDC still bespoke); keeps the entire provider matrix as our code to maintain and threat-model — the exact cost #2108 exists to shed. **Rejected.** |
| **Accept allauth's plaintext `SocialApp.secret`** | Zero custom secret handling | Regresses ADR-0049 §3. **Rejected** (§3.1 — keep Fernet). |
| **`python-social-auth` / `mozilla-django-oidc`** | Also multi-provider | A *new* dependency and a *second* auth framework beside the allauth already vendored — no reason. **Rejected.** |

## Consequences

The centerpiece trade-off is **library-behind-our-views vs. full-allauth-flow**, and
we chose the former **specifically to preserve the five controls**:

**Easier:**
- **GitHub and every named IdP work** (the #2108 driver), via maintained upstream
  provider knowledge rather than code we write.
- **Multiple providers at once** on the login screen — impossible under the ADR-0187
  singleton.
- **Redirect URI, OTel redaction, operator allow-lists, docs, and OpenAPI are all
  unchanged** — the hybrid's biggest operational win.
- Enterprise still attaches via the **unchanged** seams; the boundary is unmoved.

**Harder / risks (each tied to a preserved control):**
- **Control 1 (SSRF) is the sharp edge.** The whole point of the hybrid is that
  outbound HTTP stays in our egress layer. Discipline required: **no** allauth provider
  method may be invoked in a way that opens its own socket. `security-review` +
  `threat-model` must confirm every outbound path (OIDC discovery/token/JWKS, GitHub
  `/user` + `/user/emails`) runs on `egress`. Flagged 🔴 (question 1) until proven that
  either (a) we keep the network in our services for all providers — the default — or
  (b) allauth's `OAuth2Client` is cleanly egress-wrappable where we do lean on it.
- **Control 2 (secret at rest):** `SocialApp.secret` must stay empty; a test asserts
  the at-rest column is blank and the exchange still succeeds from the encrypted side
  row.
- **Control 4 (ID-token validation):** we keep our `validate_id_token` (alg allow-list
  + nonce) rather than allauth's — a deliberate non-delegation that must be documented
  so a later "simplify by using allauth's verification" refactor does not silently
  weaken it.
- **Account-linking-by-verified-email takeover** is the same risk as ADR-0187 and must
  be re-verified on the new models: require verified email, gate by domain allow-list,
  resolve by `SocialAccount(provider, uid=subject)` never mutable email, fail closed on
  ambiguous matches.

### Durable Execution

1. **Broker-down:** N/A — login/callback are synchronous request/response.
2. **Drain / orphan / outbox:** N/A — no queued work.
3. **Service layer:** the egress-backed `apps/sso/services.py` (discovery, token
   exchange, ID-token validation, GitHub userinfo, identity resolution) is **retained**;
   `apps/sso/extensions.py` seams unchanged. allauth provides provider metadata/parsers
   only.
4. **Idempotency:** `state` remains single-use (browser-bound cookie + server entry);
   a replayed callback fails closed. Provider registries idempotent.
5. **State store:** `state`/PKCE verifier/nonce stay in the cache (Valkey) with a short
   TTL, single-use — unchanged from ADR-0187.

## Implementation Notes

- **Affected packages:** `api` (enable `socialaccount` + `openid_connect` + `github`
  as a library; `SsoProviderPolicy` model with encrypted `secret_ciphertext`; data
  migration `OIDCProvider`/`OIDCIdentity` → `SocialApp`/`SocialAccount`/`SsoProviderPolicy`;
  drop the bespoke tables; adapt `services.py` to allauth provider metadata + GitHub;
  rewrite the `/workspace/sso/providers/` API; **keep** the flow views + JWT bridge +
  egress), `web` (admin SSO page: registry picker, per-provider config; login screen:
  multiple provider buttons), `docs` (`docs/administration/` SSO — registry slugs; the
  callback URI is **unchanged**).
- **Migration required:** Yes — one migration (create `SsoProviderPolicy` + encrypted
  column, copy into `SocialApp`/`SocialAccount`/`SsoProviderPolicy`, drop
  `sso_oidc_provider`/`sso_oidc_identity`). No `NOT NULL` without default; batch to one
  (`migration-check`). No-op on a fresh install.
- **API changes:** `/workspace/sso/providers/` collection + item + `test-connection`;
  the flow endpoints keep their paths. `api-design` + `api-docs`; regenerate
  `docs/api/openapi.json` (merge `origin/main` first).
- **New dependency:** **None** — `allauth.socialaccount` + the two provider modules ship
  inside the already-installed `django-allauth`. PyJWT[crypto] stays (we keep our own
  ID-token validation).
- **Settings:** enable `django.contrib.sites`; `SOCIALACCOUNT_PROVIDERS` as the config
  registry (per-provider scopes/derivation); reuse `INTEGRATION_ENCRYPTION_KEY` (or the
  dedicated key from ADR-0187 open question 5) for the secret; `FRONTEND_BASE_URL` /
  `TRUEPPM_PUBLIC_API_BASE_URL` reused. Do **not** set allauth flow settings
  (`LOGIN_REDIRECT_URL`/`SOCIALACCOUNT_ADAPTER`) to own the flow.
- **OSS or Enterprise:** **OSS** (`trueppm-suite`). The governance layer is Enterprise.
- **Docs:** `docs/administration/` SSO page updated for the registry + per-provider
  config in the **same MR** (`docs-writer`). Callback URI unchanged → no allow-list churn.

## Boundary-compliance verification

- `grep -r "trueppm_enterprise" packages/` MUST return zero (CI `boundary:check`).
- OSS requests **only** `openid email profile` (GitHub `read:user user:email`); **no**
  `groups` scope, **no** claim→role mapping, **no** enforced-SSO, **no** SCIM/SAML/LDAP.
- `oidc_role_for()` / `local_login_allowed()` return safe community defaults with no
  enterprise package installed; the community edition stays fully functional standalone.

## Open questions (🔴 blockers for Kelly)

1. **SSRF egress vs. allauth's HTTP client — confirm the seam (control 1).** The
   default preserves the guard by keeping **all** outbound HTTP in our egress-backed
   `services.py` (allauth used only for endpoint metadata + claim/userinfo parsing,
   never for the network call). This is fully resolvable and is the recommended
   posture. The only decision to ratify is whether we ever invoke an allauth provider
   **network** method directly (e.g. leaning on its GitHub token-exchange path) — if so
   it **must** be given an egress-backed `requests` session, and `security-review` must
   prove no off-egress socket remains. **Confirm: keep the network entirely in our
   services (recommended), or approve the egress-wrapped-allauth-client path where
   convenient.** No other option preserves the SSRF guard, so this is the one truly
   blocking item.

2. **Client-secret-at-rest — confirm Fernet on the side row.** Direction is locked
   (keep Fernet; do **not** accept plaintext `SocialApp.secret`, per ADR-0049 §3). The
   secret lives Fernet-encrypted on `SsoProviderPolicy.secret_ciphertext`,
   `SocialApp.secret` stays empty, and our token exchange reads/decrypts it at call
   time. Confirm this side-row approach (no allauth-model patching needed because our
   code makes the call).

## References

- **Supersedes ADR-0187** — basic SSO OIDC/OAuth2 login (the bespoke RP adapted here)
- Issue #2108 (this adoption); ADR-0187 issues #1392 (web), #1405 (backend)
- CLAUDE.md — Auth carve-out (basic SSO is OSS); Two-Repo Rule
- ADR-0049 §3 — Fernet secret-at-rest (retained for the client secret)
- ADR-0177 — OSS extension-point provider-registry idiom (the two retained SSO seams)
- ADR-0029 — frontend slot registry + edition detection (enterprise governance seam)
- ADR-0141 — WebSocket short-lived ticket auth (prior auth ADR)
- `core/auth_views.py` (#897) — cookie-JWT session reused by the JWT bridge
- `apps/integrations/http` — SSRF egress chokepoint retained for every outbound call
- `apps/integrations/encryption` — Fernet at-rest for the client secret
- `observability/test_otel_instrumentation.py` — callback `code`/`state` redaction (preserved by the unchanged path)
- `apps/sso/{services,views,extensions}.py` — the retained hardened flow + enterprise seams
- django-allauth 65.18.0 `socialaccount` — provider registry (already vendored)
</content>
