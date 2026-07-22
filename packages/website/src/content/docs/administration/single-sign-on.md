---
title: Single sign-on (OIDC & GitHub)
description: Configure single sign-on so your team logs in through the identity providers you already run — multiple OIDC providers and GitHub at once, with per-provider credentials, a shared redirect URI, allowed domains, and optional member auto-creation. Part of the open-source core.
---

:::note[Single sign-on lands in 0.4]
Self-service single sign-on **ships in 0.4** (TruePPM's first beta). It is part
of the **open-source core** — no Enterprise license is required. Before 0.4,
users sign in with email and password only.
:::

Single sign-on lets your team log in through the identity providers you already
run. You can configure **more than one provider at the same time** — several OIDC
providers (Keycloak, Authentik, Zitadel, Google, GitLab, Microsoft Entra ID,
Okta, Auth0, or any standards-compliant OIDC provider) alongside **GitHub**. For
OIDC providers TruePPM acts as an OpenID Connect **relying party** using the
Authorization Code flow with PKCE; GitHub uses OAuth 2.0. In both cases TruePPM
mints its normal session on a successful sign-in — there is no separate token to
manage.

Under the hood, login federation is backed by
[django-allauth](https://docs.allauth.org/)'s provider registry, while TruePPM
keeps its own hardened callback flow (SSRF-guarded outbound requests, encrypted
client secrets, and a single unchanged redirect URI). Basic SSO remains part of
the open-source core.

## What is in the open-source core (and what is not)

The line is one sentence: **log in via your own IdP → open-source core; provision,
deprovision, and govern accounts from a directory → Enterprise.**

| Capability | Edition |
| --- | --- |
| Log in with your own OIDC provider(s) and GitHub | ✅ Open-source core |
| Multiple providers configured at once | ✅ Open-source core |
| Per-provider admin config, Test connection, redirect-URI display | ✅ Open-source core |
| Auto-create a member on first sign-in (single default role, domain-gated) | ✅ Open-source core |
| Group → role mapping (`groups` scope / custom claims) | Enterprise |
| Enforced SSO (disable password sign-in / disable local accounts) | Enterprise |
| SCIM provisioning, LDAP/AD directory sync, SAML federation, auth-event audit trail | Enterprise |

For OIDC, the open-source core requests only the `openid email profile` scopes —
never a `groups` scope. For GitHub it requests only `read:user user:email`. On
the sign-in policy, password and SSO sign-in are **both** allowed; turning
password sign-in *off* (enforced SSO) is an Enterprise capability.

## Provider types

When you add a provider you first pick its **type**. Each type already knows its
endpoints, so you supply only credentials plus a small provider-specific field.
The issuer is composed for you and shown before you save.

| Provider | Type | What you supply |
| --- | --- | --- |
| Generic OIDC | OIDC | Issuer URL |
| Google | OIDC | *(nothing — issuer is auto-configured)* |
| Microsoft Entra ID | OIDC | Tenant ID |
| GitLab | OIDC | Instance URL |
| Keycloak | OIDC | Base URL + Realm |
| Authentik | OIDC | Base URL + Application slug |
| Zitadel | OIDC | Instance URL |
| Okta | OIDC | Org domain |
| Auth0 | OIDC | Tenant domain |
| GitHub | OAuth 2.0 | *(optional)* Organization |

Every provider also takes a **Client ID** and **Client secret** from the OAuth/OIDC
application you register in that provider for TruePPM.

## Configuring a provider

Open **Workspace → Settings → Single sign-on** as a workspace admin, then choose
**Add provider**. (When no provider is configured yet, the same button appears in
the empty state.)

1. **Provider type** — pick the provider from the list. For an OIDC provider,
   fill in the type-specific field(s) and TruePPM composes the **issuer** for you,
   showing the resolved value as you type. For **Generic OIDC**, enter the issuer
   directly (its discovery base, e.g. `https://id.example.com` — TruePPM appends
   `/.well-known/openid-configuration` itself, so paste the issuer, not the
   discovery URL). For **GitHub**, no issuer is needed.
2. **Display name** — the label shown on the sign-in button (e.g. "Acme SSO").
3. **Client ID** and **Client secret** — the credentials of the application you
   register in your provider for TruePPM. The secret is **write-only**: it is
   encrypted at rest and never displayed again. Leave the field blank on later
   edits to keep the stored secret; enter a new value to **rotate** it.
4. **Redirect URI** — copy the read-only value shown here into your provider's
   list of allowed redirect (callback) URIs. It is derived from your public API
   origin and is **the same for every provider**
   (`{origin}/api/v1/auth/oidc/callback/`), so you never have to change the
   allow-list when you add another provider.
5. **Allowed email domains** — only users whose email is in one of these domains
   may sign in via this provider. This also gates member auto-creation.
6. **Auto-create members** *(optional)* — when on, a user signing in for the
   first time from an allowed domain is created as a member at the **default
   role** you choose (Member or Admin; SSO can never grant Owner). Leave it off to
   require that accounts be invited first.
7. **Enable this provider** — turn it on once the configuration is complete, then
   save. A provider cannot be enabled until it is fully configured.

Once a provider is saved, use **Test connection** on it (via **Edit**) to verify
that — for OIDC — the issuer's discovery document and signing keys are reachable,
or — for GitHub — that the GitHub API is reachable.

The **Scopes** shown on the form are fixed by the open-source core
(`openid email profile` for OIDC, `read:user user:email` for GitHub) and cannot be
widened.

### GitHub specifics

GitHub uses OAuth 2.0 rather than OIDC, so there is no issuer or discovery
document. A few things differ:

- **No issuer URL** — GitHub's endpoints are configured automatically.
- **Verified email only** — TruePPM reads the user's **verified primary** email
  from the GitHub user API. A user with no verified primary email cannot sign in.
- **Organization restriction** *(optional)* — set an **Organization** to allow
  only members of that GitHub organization to sign in. When set, membership is
  checked on every sign-in and the check fails closed.

## How users sign in

On the sign-in screen, each **enabled** provider shows its own **Continue with
{provider}** button. A user chooses their provider, authenticates there, and is
returned to TruePPM and dropped into their workspace. If no provider is
configured, the sign-in screen shows only the email-and-password form.

If a user authenticates successfully at their provider but has no TruePPM account
(and auto-create is off, or their domain is not allowed), they see a clear
"verified, but not a member yet" message with the code `SSO_NO_MEMBER` — ask an
admin to invite them, then have them sign in again.

## Removing a provider

Use **Remove** on a provider to delete its configuration. This also unlinks
anyone who signed in through it; they fall back to password sign-in until the
provider is set up again. Removing one provider does not affect the others.

:::caution[Re-pointing a provider to a new issuer]
Each OIDC sign-in is durably bound to the identity provider's **issuer**. If you
need to move a provider to a *different* issuer, **remove and re-add** it rather
than editing the issuer in place — users then re-link by their verified email on
next sign-in. Editing the issuer of a provider that already has linked accounts is
refused for security (it would otherwise allow a subject-collision takeover across
issuers).
:::

## Security notes

- Client secrets are encrypted at rest and are never returned to any client.
- The OIDC login flow is protected against login-CSRF / session fixation with a
  single-use, browser-bound `state` value; the ID token's signature (an
  asymmetric-algorithm allow-list), issuer, audience, and nonce are all validated
  before a session is minted.
- Sign-in is bound to the durable `(issuer, subject)` pair, never to a mutable
  email; a subject already bound to a different issuer fails closed.
- The callback never places a token in the URL — it sets the same hardened,
  httpOnly refresh cookie used by password login. The callback path is identical
  for every provider.
- Discovery, token, and JWKS requests (OIDC) and all GitHub API requests are
  subject to TruePPM's outbound SSRF guard.

## Running the identity provider inside your cluster

TruePPM's outbound SSRF guard blocks requests to private, loopback, and
link-local addresses by default. That is the right posture for a public issuer,
but it also blocks an **identity provider you run inside the same cluster** — for
example Keycloak reachable only at a private service address such as
`keycloak.sso.svc.cluster.local`. Left unset, discovery, token exchange, and JWKS
fetches to that issuer fail with a "provider unreachable" error and the **Test
connection** button reports the issuer as unreachable.

To allow it, name the exact hostnames you trust in the
`TRUEPPM_EGRESS_ALLOWLISTED_HOSTS` environment variable (comma-separated). Those
hosts — and only those — bypass the private-address check:

```bash
# Permit an in-cluster Keycloak; every other private host stays blocked.
TRUEPPM_EGRESS_ALLOWLISTED_HOSTS=keycloak.sso.svc.cluster.local
```

Matching is an **exact, case-insensitive hostname** compare — no wildcards and no
suffix matching, so allow-listing `keycloak.sso.svc.cluster.local` never admits a
lookalike host. Leave the variable unset (the default) unless you actually run an
IdP on a private address; a public issuer needs no allow-list. This setting is
operator configuration only and is never influenced by user input.

:::caution[The allow-list applies to *all* outbound requests]
An allow-listed host is exempt from the private-address check for **every** TruePPM
outbound integration — not only SSO, but also personal-access-token verification,
git-link status refresh, webhook delivery, and SMTP relay checks, some of which
take user-supplied URLs. Only allow-list a host that is at least as trusted as your
identity provider, and list the specific IdP host — never a broad internal name.
:::
