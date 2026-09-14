---
title: "API authentication"
description: "Logging in, refreshing and revoking access tokens, project-scoped API tokens, personal access tokens, and single sign-on."
documentedFor: "0.4"
---

TruePPM uses JWT auth with a split-token model: the short-lived **access** token
is returned in the JSON body and held in memory by the client, while the
long-lived **refresh** token is delivered in an `httpOnly`, `Secure`,
`SameSite=Strict` cookie that JavaScript can never read. This protects the
high-value refresh credential from theft via XSS — an injected script can ride
the current session but cannot exfiltrate the refresh token.

Because the refresh token lives in a cookie, browser clients **must** send
credentials on the auth requests (`fetch(..., { credentials: "include" })` or
`xhr.withCredentials = true`).

The access token is short-lived by design: **15 minutes** (`SIMPLE_JWT["ACCESS_TOKEN_LIFETIME"]`).
Clients are expected to refresh well before it expires rather than wait for a
`401` — see [Refresh the access token](#refresh-the-access-token) below.

## Log in

```http
POST /api/v1/auth/token/
Content-Type: application/json

{"username": "...", "password": "...", "remember_me": false}
```

:::note[Ships in 0.4]
The email-as-identifier behavior described next ships in **TruePPM 0.4**. In
`v0.3.0-alpha.3` (the latest release) `username` is matched against the username
column only, so a user signing in with their email address is refused.
:::

`username` accepts **either** the account's username **or** the email address on
the account. The username is matched first and the email is tried only if that
fails, so an existing username-based integration is unaffected — and an account
whose username is itself email-shaped is never displaced by a different account
carrying that string as its email. The field keeps its name for wire
compatibility; there is no second field and no second endpoint.

Email resolution is deliberately narrow, because Django's user model puts no
uniqueness constraint on the email column:

- An address held by **more than one account is refused**, not resolved to
  either. Signing a caller into an account they did not name is the failure this
  avoids, and it is the reason the endpoint does not simply pick the lowest id.
- Every refusal is the **same `401` with the same body** — wrong password, no
  such email, and an ambiguous email are indistinguishable, so the endpoint is
  not an account-existence oracle. The response never names the resolved
  username.
- Both login throttles still bound the attempt, and the per-account throttle
  counts **and enforces** against the account rather than the address — an
  email-form attempt is refused with `429` once the account's budget is spent,
  in whichever order the two identifiers were tried. Answering to two identifiers
  does not buy an attacker two guess budgets.

Returns **only** the access token in the body:

```json
{"access": "<jwt>"}
```

The refresh token is set in a response cookie (default name `trueppm_refresh`),
scoped to `Path=/api/v1/auth/token/refresh/` so it is sent only on the refresh
request and never on ordinary API calls:

```http
Set-Cookie: trueppm_refresh=<jwt>; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth/token/refresh/
```

Pass the access token on all subsequent requests:

```http
Authorization: Bearer <access_token>
```

### `remember_me` and refresh-token lifetime (ADR-0544)

The optional `remember_me` boolean on the login body controls **both** the
refresh JWT's `exp` and whether the refresh cookie survives browser close. The
lifetime is **conditional on the flag** — it is not simply "long-lived":

| `remember_me` | Refresh token `exp` | Cookie | Behavior |
|----------------|---------------------|--------|----------|
| `true` | **30 days** (`TRUEPPM_REFRESH_TOKEN_REMEMBER_DAYS`, default 30) | Persistent (`Max-Age` set) | Survives browser close; a deliberate opt-in to a long-lived credential on a trusted device. |
| `false` (default, or omitted) | **12 hours**, sliding (`TRUEPPM_REFRESH_TOKEN_SESSION_HOURS`, default 12) | Session cookie (no `Max-Age`) | Dies when the browser closes. Each refresh rotates the token and re-mints the 12h window, so an actively-used session never expires mid-work — the 12h ceiling only bites after 12h of idle time with the browser still open. |

The choice is carried as a `remember` claim inside the refresh JWT itself (not
server-side state), so it survives rotation automatically. SSO logins
(below) have no checkbox and are always session-scoped (`remember_me` is
implicitly `false`). A refresh token minted before this behavior shipped (no
`remember` claim) keeps the legacy 7-day persistent cookie unchanged — nobody
already logged in is forced to re-authenticate or silently downgraded to a
session cookie.

## Refresh the access token

```http
POST /api/v1/auth/token/refresh/
```

The refresh endpoint reads the refresh token **from the cookie** — it is no
longer accepted in the request body, so the request has no body. It returns a
new access token:

```json
{"access": "<jwt>"}
```

A request that arrives without a valid refresh cookie returns `401`. When refresh
rotation is enabled the cookie is re-issued (rotated) on each successful refresh;
the previous token is blacklisted if the blacklist app is installed.

> The `TokenRefresh` / `TokenRefreshRequest` body schemas are intentionally gone
> from the OpenAPI document — the refresh endpoint takes no request body.

## Log out

```http
POST /api/v1/auth/logout/
```

Clears the refresh cookie and best-effort blacklists the presented refresh token
(when the blacklist app is installed). Idempotent — always returns `205 Reset
Content`, whether or not a cookie was present.

The legacy bare `AUTH_REFRESH_COOKIE_*` names are still accepted as fallbacks.

| Setting | Default | Purpose |
|---------|---------|---------|
| `TRUEPPM_AUTH_REFRESH_COOKIE_NAME` | `trueppm_refresh` | Cookie name for the refresh token. |
| `TRUEPPM_AUTH_REFRESH_COOKIE_PATH` | `/api/v1/auth/` | Restricts the cookie to the auth endpoints that read it (refresh and logout). |
| `TRUEPPM_AUTH_REFRESH_COOKIE_SAMESITE` | `Strict` | CSRF posture — the cookie is never sent cross-site. |
| `TRUEPPM_AUTH_REFRESH_COOKIE_SECURE` | `True` | HTTPS-only cookie. Set `False` only for non-TLS local development. |

## Project-scoped API token (`projectApiTokenAuth`)

The [inbound task-sync](/features/inbound-task-sync/) surface (and the
CI acceptance-result ingest endpoint, `POST /api/v1/projects/{id}/acceptance-results/`,
ADR-0148 — see [Acceptance criteria](/api/reference/tasks/#acceptance-criteria)) use a separate,
non-JWT scheme. Mint a token in **Project settings → API tokens**; it is scoped
to a single project (or, for `programs/{id}/api-tokens/`, to every project in a
program) and authorizes only these two endpoints (ADR-0068). Send it as a
bearer token:

```http
POST /api/v1/projects/{project_id}/task-sync/
Authorization: Bearer tppm_<64-hex>
```

The schema advertises this scheme as `projectApiTokenAuth`. It is deliberately
**not** interchangeable with the JWT session — a logged-in user cannot call
task-sync with their normal credentials, so every inbound push is attributable
to a minted token. A token whose project does not match the URL returns `401`
(not `403`) so callers cannot enumerate project existence.

:::note[Ships in 0.4]
The archived-project refusal described next ships in **TruePPM 0.4**. In
`v0.3.0-alpha.3` (the latest release) a push into an archived project still
succeeds and creates or updates the task, so on 0.3 archiving a plan is not what
stops an integration writing into it — revoke the token.
:::

**A push into an archived project is refused with a `403`, and writes nothing** —
no task, no external-link row, no audit entry. Archiving makes a plan read-only,
and that is a property of the plan rather than of the caller, so the refusal
clears for no token and no scope: re-minting a `legacy:full` token will not get
past it and neither will retrying. The project has to be unarchived, after which
the same push succeeds unchanged. The `401` above is checked first, so a token
that does not authorize the URL project never learns whether it is archived
(#3413).

The only scope this endpoint mints is **`legacy:full`**. Sending
`{"scopes": ["mcp:read"]}` to `POST /api/v1/projects/{id}/api-tokens/` (or the
program equivalent) is a `400`: a token minted at project or program scope has no
owner, and the MCP read surface accepts owner-scoped (personal) tokens only, so
such a token could read nothing at all. Mint MCP credentials from
[`POST /api/v1/me/api-tokens/`](#personal-access-tokens-apiv1meapi-tokens-adr-0214)
instead.

## Personal Access Tokens (`/api/v1/me/api-tokens/`, ADR-0214)

```http
GET    /api/v1/me/api-tokens/
POST   /api/v1/me/api-tokens/
DELETE /api/v1/me/api-tokens/{id}/
```

A **Personal Access Token** (PAT) is a `tppm_`-prefixed, user-owned credential
minted from your own account rather than a project or program. `POST` returns
the raw token exactly once; it is never retrievable again. Two scopes on
create (`scopes`, defaulting to `["legacy:full"]`): **`legacy:full`** (acts as
you, no expiry required) or **`mcp:read`** (safe methods only, expiry
required). Capped at 10 active tokens per user, and every PAT is revoked
automatically when the owning account's password changes. `DELETE`
soft-revokes; both mint and revoke are audited. See
[Personal Access Tokens](/features/personal-access-tokens/) for the full
walkthrough (creating, scope picker, the MCP-client config snippet) and
[MCP server](/features/mcp-server/) for connecting an AI client with an
`mcp:read` token.

:::note[Ships in 0.4]
The general-endpoint PAT authentication described below (`personalApiTokenAuth`,
#2547) ships in **TruePPM 0.4**. In `v0.3.0-alpha.3` (the latest release),
`ProjectApiTokenAuthentication` is not in the default authentication stack at
all, so a `legacy:full` PAT has no endpoint to use outside the read-only MCP
surface described further below — the general CRUD API and the two token-sync
endpoints are unreachable with a personal token until 0.4.
:::

**A `legacy:full` PAT authenticates the general API — reads and writes — exactly
as your own session would** (`personalApiTokenAuth` in the schema, #2547).
`OwnerScopedApiTokenAuthentication` is in the API's default authentication
stack (prepended before JWT): it accepts an owner-scoped token carrying
`legacy:full` on any endpoint your JWT session could already reach, subject to
the identical RBAC — a Viewer's PAT can only read what a Viewer sees, and a
PAT never elevates its owner's role. Two narrower surfaces are unaffected by
this and keep their existing, more restrictive rules:

- **`mcp:read`-only tokens** stay confined to `McpReadableViewMixin`. That mixin
  is **not** a list of fifteen read-only endpoints: it is mixed onto the primary
  CRUD viewsets — Task, Project, Risk, Label, Sprint, Program, backlog item,
  board config — plus a dozen read-only views (your profile, project/program
  overview, forecast, schedule derivation, Monte Carlo, search, My Work,
  workspace assets) — close to 200 routes once each viewset's actions are
  counted, not fifteen. What the mixin adds is a set of **agent** guards, and
  that distinction is the whole contract:

  - an **`mcp:read`** token gets safe methods only (writes `403`), must be
    owner-scoped, and is subject to the instance kill switch and the per-project
    agent opt-out — see [MCP server](/administration/mcp-server/);
  - a **`legacy:full`** token reads *and writes* here exactly as on any other
    endpoint, governed by the same RBAC as its owner's session. It is not an
    agent credential, so none of the agent controls apply to it (#2877).

  A project- or program-scoped token is rejected on this surface outright
  (`401`), whatever its scope. And an `mcp:read`-only token is rejected
  *everywhere else* — it is deliberately **not** interchangeable with
  `OwnerScopedApiTokenAuthentication`.

- **Token management is session-only.** `/me/api-tokens/`,
  `/projects/{id}/api-tokens/`, `/programs/{id}/api-tokens/` and the two
  `api-token-audit/` reads refuse *any* token-authenticated caller with a `403`,
  whatever its scope (#2878). A token cannot mint a token, list its siblings, or
  revoke one, so revoking a leaked credential is actual containment rather than a
  step an attacker has already worked around. Manage tokens from a signed-in
  session; for an operator-side sweep see
  [`revoke_api_tokens`](/administration/management-commands/).
- **SSO provider configuration is session-only too.**
  `/workspace/sso/providers/`, `/workspace/sso/providers/{slug}/` and
  `/workspace/sso/providers/{slug}/test-connection/` refuse token callers the same
  way, on **every** method including the reads. Provider configuration decides who
  may become a member and at what role, so a token that could widen a provider's
  allowed domains and switch on auto-create at the Admin default role would turn one
  leaked credential into a durable admin account that revoking the token does not
  reach. Configure providers from a signed-in session.

  The refused `403` carries the same body in both cases: a `detail` string plus a
  `refusal` envelope of `{"verdict": "refused", "reason": "policy", "constraint":
  "capability_scope"}`. A token that is revoked, expired, or carries the wrong
  scope never reaches that check — the authenticator answers `401` with
  `reason: identity` first.
- **`TaskSyncView`** and the acceptance-result ingest endpoint (above) still
  require `IsTokenForProject` — the token's `project`/`program` FK must
  resolve to the URL's project. A personal token has neither set, so a PAT
  still cannot authenticate inbound sync or CI acceptance ingestion; those
  two endpoints remain project/program-token-only by design (they attribute
  every push to a minted, team-visible integration credential, not an
  individual's personal one).

## Single sign-on (OIDC / OAuth2)

Self-service login against your own identity provider (built-in presets for
Keycloak, Authentik, Zitadel, Okta, Auth0, Microsoft Entra ID, Google, GitLab and
GitHub, plus Generic OIDC for any other OIDC-compliant IdP such as Authelia) is a
three-endpoint browser redirect flow, configured per-provider under
**Workspace settings → SSO providers**. All three are unauthenticated and
public by design — they *are* the login flow:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/auth/oidc/discover/?email=` | Which enabled provider(s) apply to an email's domain (or all enabled providers with no `email`). Always `200`; never reveals whether an account exists. |
| GET | `/api/v1/auth/oidc/login/?provider=<slug>` | Starts the flow for one provider: mints a single-use state/PKCE/nonce and `302`s to the IdP's authorization endpoint. |
| GET | `/api/v1/auth/oidc/callback/?code=&state=` | The IdP redirects here. On success: validates state, exchanges the code, verifies the ID token (or fetches GitHub userinfo), resolves or creates the local user, sets the refresh cookie, and `302`s to the SPA completion route — no token ever appears in a URL. On failure it `302`s to the same completion route with a non-sensitive `?error=` code (see [SSO error codes](/api/errors/#sso-error-codes)). |

SSO-authenticated sessions are always session-scoped (12h sliding, session
cookie) — there is no `remember_me` checkbox in an IdP redirect, so the safe
default applies unconditionally. The admin-facing provider CRUD
(`/api/v1/workspace/sso/providers/`) is a separate, authenticated surface — workspace
Admin on every method, and **session/JWT only**: it refuses API tokens, reads
included (see the [top of this page](#_top)). See
[Workspace Settings](/administration/workspace-settings/) and
[Single sign-on](/administration/single-sign-on/).

This is deliberately basic, self-service login federation — OSS per the
[auth carve-out](/license/): an admin points TruePPM at their own IdP and users
log in through it. SAML federation, SCIM provisioning, LDAP/AD directory sync,
enforced org-wide SSO, and group→role mapping are Enterprise org-identity
governance, not part of this surface.
