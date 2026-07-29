---
title: Auth architecture
description: How TruePPM's password login, OIDC/OAuth single sign-on, and the WebSocket handshake fit together — the cookie-JWT bridge, why allauth is a library and not the flow, and the short-lived ticket that keeps a raw JWT out of access logs.
---

[Single sign-on](/administration/single-sign-on/) is the setup guide for
configuring an identity provider. This page is the architecture behind it: why
the auth stack is shaped the way it is, what `django-allauth` is and is not
responsible for, and how a browser session, a mobile client, and a WebSocket
connection each end up authenticated from the same underlying credential.

:::note[Scope]
This page covers the auth **architecture** — the mechanisms and the reasoning
behind them. The auth API surface itself (request/response shapes for
`/api/v1/auth/...`) is reference material owned by the [API
reference](/api/reference/); link there for endpoint-level detail rather than
duplicating it here.
:::

## The credential: a JWT pair behind an httpOnly cookie

Every session, regardless of how it began (password, OIDC, GitHub), ends the
same way: TruePPM mints a `simplejwt` access/refresh pair and hands the browser
only the access token in the response body. The refresh token never appears in
JSON at all — it is set directly as a cookie:

- **httpOnly** — unreadable by JavaScript, so an XSS payload can ride the
  current access token but cannot exfiltrate the long-lived refresh credential.
- **`SameSite=Strict`**, **`Secure`** by default.
- **Path-scoped** to the refresh endpoint only (`/api/v1/auth/token/refresh/`),
  so it is never attached to an ordinary API call — only to the one request
  that needs it.

This is the design choice that makes "log in via password" and "log in via
your own IdP" converge onto one session mechanism: an OIDC or GitHub login
does not mint a separate kind of token. It runs `RefreshToken.for_user(user)`
and sets the identical cookie a password login would, then redirects the
browser to a frontend completion route that calls the ordinary refresh
endpoint. From the moment a session exists, the rest of the application cannot
tell how it began.

A short-lived access token (minutes, not hours) limits the blast radius of a
token that does leak somewhere the refresh cookie doesn't reach — a server log
line, a support screenshot, a browser extension with page-script access. The
refresh token is rotated on every use and the prior one blacklisted, so a
stolen refresh token is a single-use window, not a standing credential.

## Why `django-allauth` is a library here, not the login flow

TruePPM's SSO design went through two generations, and the reasoning for the
second is worth carrying forward because it is easy to accidentally undo in a
future change.

**Generation 1** was a hand-rolled OpenID Connect relying party: TruePPM's own
code did discovery, PKCE, token exchange, and ID-token validation, with no
`allauth` involvement. It worked, and it established every security property
the design still has today — but it was OIDC-only. GitHub has no OIDC
discovery document, no JWKS, no ID token; representing it meant either
building a second, GitHub-shaped relying-party path by hand, or adopting a
library that already understands GitHub's OAuth2 shape.

**Generation 2** adopts `allauth.socialaccount` — but strictly as a **provider
registry and metadata source**, not as the flow itself. TruePPM never mounts
`allauth.urls`; there is no `/accounts/...` route, and no request is ever
handled by allauth's own views. Every OIDC identity provider (generic,
Google, Microsoft Entra ID, GitLab, Keycloak, Authentik, Zitadel, Okta, Auth0)
registers as a named `openid_connect` provider app; GitHub is the one entry
using allauth's dedicated `github` module, since it has no OIDC surface to
speak of. TruePPM's own views own the callback path, and that path is
**identical for every provider** — `/api/v1/auth/oidc/callback/` — because the
provider is disambiguated by a `slug` carried in server-side login state, not
by a URL segment. A stable callback path matters beyond tidiness: it is what
keeps an operator's provider allow-list, the redirect-URI instructions in
[Single sign-on](/administration/single-sign-on/), and OpenTelemetry's
query-param redaction rule all correct without per-provider special-casing.

The reason plain allauth was not adopted wholesale is that five security
properties the bespoke relying party carried would otherwise be lost:

1. **Egress control.** Every outbound request the flow makes — discovery
   document, token exchange, JWKS fetch — passes through the same SSRF guard
   described below. Allauth's own provider code makes these requests directly
   and does not know about that guard.
2. **Secret-at-rest.** Allauth's `SocialApp.secret` field is plaintext.
   TruePPM stores the client secret Fernet-encrypted on a side-row
   (`SsoProviderPolicy`) instead and leaves `SocialApp.secret` empty.
3. **Stable, redactable callback path** — covered above.
4. **ID-token validation discipline** — an explicit algorithm allow-list
   (asymmetric algorithms only; `none` and `HS*` are rejected outright, closing
   the classic alg-confusion attack), a fail-closed allowed-domain gate, and a
   browser-binding cookie (below) — none of which allauth's generic OIDC
   provider enforces on its own.
5. **The JWT bridge** — the SPA needs the simplejwt refresh cookie described
   above, not a Django session, which is what allauth mints unassisted.

So the rule going forward is: **allauth supplies provider metadata; it never
opens a socket.** Any change that routes a request through allauth's own
client code instead of TruePPM's `egress` module would silently reintroduce
the SSRF gap generation 1 closed.

## Authorization Code + PKCE, and the durable identity binding

For an OIDC provider, TruePPM acts as a relying party using the Authorization
Code flow with PKCE — mandatory, not optional, on every configured provider.
The flow that matters architecturally:

1. **Login start** mints a single-use `state`, a PKCE verifier/challenge pair
   (S256), and a `nonce`; stores them server-side keyed by `state` (5-minute
   TTL); and additionally sets a **browser-binding cookie** carrying the same
   `state` value, httpOnly, `SameSite=Lax`.
2. **Callback** compares the `state` query parameter against that cookie
   (constant-time) *before* consuming the server-side state. This is a
   distinct check from state-replay protection: server-side state proves the
   server issued this authorization response; the cookie proves the *same
   browser* that started the flow is the one completing it. Without it, an
   attacker could complete their own login at the identity provider and hand
   the resulting callback URL to a victim, silently signing the victim into
   the attacker's account — a login-CSRF / session-fixation class of attack.
   `SameSite=Lax` (not `Strict`) is required here because the callback is a
   top-level navigation arriving from the identity provider's origin, which
   `Strict` would otherwise strip.
3. **ID-token validation** checks signature (against the provider's JWKS,
   fetched through the SSRF guard — deliberately *not* using PyJWT's own
   `PyJWKClient`, which opens its own socket and follows redirects, bypassing
   the guard entirely), issuer, audience, expiry, and the `nonce` bound at
   login.

The identity that then resolves to a TruePPM account is bound to the durable
**`(issuer, subject)`** pair, never to the mutable claimed email. A subject
already linked under one issuer that reappears under a *different* issuer
fails closed rather than silently re-linking — this is what makes re-pointing
a provider to a new issuer a "remove and re-add" operation
([Single sign-on](/administration/single-sign-on/#removing-a-provider))
rather than an in-place edit: an in-place issuer change would otherwise let an
unrelated account at the new issuer, whose subject happens to collide with an
old binding, take over that binding.

## The WebSocket ticket

A browser cannot attach an `Authorization` header to a WebSocket upgrade
request, so some form of credential has to travel in the connection URL
itself — and a URL is exactly the part of a request that access logs, load
balancers, and proxies routinely persist. A 15-minute access token sitting in
a query string is therefore a 15-minute window of credential exposure in
every log that captured it, which is a materially worse trade than the same
token in a header nothing logs by default.

The fix is a purpose-built, single-use ticket, not the access token itself:

1. `POST /api/v1/ws/ticket/` (any authenticated caller) mints a
   256-bit random ticket, stores it directly in Redis — not Django's cache
   framework, because the Channels consumer runs in a separate process from
   the request that would populate an in-process cache — keyed
   `ws:ticket:<ticket>` → the caller's user id, with a **30-second TTL**.
2. The client opens the socket with `?ticket=<id>` in place of a token.
3. The consumer consumes the ticket with an atomic Redis `GETDEL` —
   read-and-delete in one operation, so the ticket is **single-use** by
   construction. A replayed or raced second attempt to consume the same
   ticket resolves to nothing, even if a log somewhere captured the URL: by
   the time anyone reads that log, the ticket has already been spent.

The ticket authenticates the connection; it does not authorize it. Once the
consumer has resolved a user from the ticket, it still runs the project-role
gate described in [RBAC and permission architecture](/architecture/rbac/#websocket-connection-enforcement)
before admitting the connection — minting a ticket proves who you are, not
that you may join this particular project's channel.

A raw `?token=<jwt>` query parameter is still accepted as a deliberately
temporary, off-by-default fallback (behind an operator flag), logged as a
deprecation warning whenever it's used, so operators can find any client
still depending on it before it is removed.

## Outbound requests are never trusted by default

Every outbound call the auth stack makes on an operator- or user-influenced
URL — an OIDC provider's discovery document, its JWKS, its token endpoint,
GitHub's API — passes through the same egress guard the rest of the platform
uses for webhook delivery, personal-access-token verification, and git-link
status checks. It resolves the target hostname and refuses to proceed if any
resolved address is not globally routable — covering private (RFC1918),
loopback, link-local, and cloud-metadata (`169.254.169.254`) address space —
and disables redirect-following so an already-validated URL cannot bounce the
request somewhere unvalidated afterward.

The one case this guard has to make room for is an identity provider an
operator runs *inside* their own cluster, which by definition resolves to a
private address. `TRUEPPM_EGRESS_ALLOWLISTED_HOSTS` is the escape hatch —
see [Single sign-on](/administration/single-sign-on/#running-the-identity-provider-inside-your-cluster)
for how to configure it, and note there that the allow-list applies to every
outbound integration sharing the guard, not just SSO, so it should name only a
host at least as trusted as the identity provider itself.

## OSS and Enterprise

The dividing line is the same one used everywhere else in TruePPM: **log in
via your own identity provider → open-source core; provision, deprovision, and
govern accounts from a directory → Enterprise.** Single sign-on — multiple
OIDC providers plus GitHub, configured independently, with auto-created
membership at a single fixed default role — **ships in 0.4** as part of the
open-source core described here. Group-to-role claim mapping, enforced SSO
(disabling local password accounts), SCIM provisioning, and LDAP/AD directory
sync are Enterprise; the two extension seams this architecture exposes for
that boundary — `oidc_role_for(claims, policy)` and
`local_login_allowed(user)` — resolve to the open-source default (ignore
claims; always allow local login) unless Enterprise registers an override.
See [SSO is not Enterprise](/overview/sso-is-not-enterprise/) for the full
reasoning behind where this line sits.

## Where to go next

- [Single sign-on](/administration/single-sign-on/) — configuring a provider,
  the sign-in experience, and operator-facing security notes.
- [RBAC and permission architecture](/architecture/rbac/) — what happens after
  a caller is authenticated: the role and object-level checks, and how the
  WebSocket ticket above hands off into the project-role gate.
- [Architecture Decision Records](/architecture/decisions/) — ADR-0141 (the
  WebSocket ticket), ADR-0187 (the original bespoke OIDC relying party, since
  superseded), and ADR-0517 (adopting allauth as a provider registry) are the
  primary records behind this page.
