---
title: Single sign-on (OIDC)
description: Configure basic single sign-on so your team logs in through your own OIDC identity provider — issuer, client credentials, redirect URI, allowed domains, and optional member auto-creation. Part of the open-source core.
---

:::note[Basic SSO lands in 0.4]
Self-service single sign-on **ships in 0.4** (TruePPM's first beta). It is part
of the **open-source core** — no Enterprise license is required. Before 0.4,
users sign in with email and password only.
:::

Basic single sign-on lets your team log in through the OIDC identity provider you
already run — Keycloak, Authentik, Authelia, Zitadel, or a hosted provider such
as Google, GitHub, or GitLab. TruePPM acts as an OpenID Connect **relying party**
using the Authorization Code flow with PKCE, and mints its normal session on a
successful sign-in — there is no separate token to manage.

## What is in the open-source core (and what is not)

The line is one sentence: **log in via your own IdP → open-source core; provision,
deprovision, and govern accounts from a directory → Enterprise.**

| Capability | Edition |
| --- | --- |
| Log in with your own OIDC provider | ✅ Open-source core |
| Single-provider admin config, Test connection, redirect-URI display | ✅ Open-source core |
| Auto-create a member on first sign-in (single default role, domain-gated) | ✅ Open-source core |
| Group → role mapping (`groups` scope / custom claims) | Enterprise |
| Enforced SSO (disable password sign-in / disable local accounts) | Enterprise |
| SCIM provisioning, LDAP/AD directory sync, SAML federation, auth-event audit trail | Enterprise |

The open-source core requests only the `openid email profile` scopes — never a
`groups` scope. On the sign-in policy, password and SSO sign-in are **both**
allowed; turning password sign-in *off* (enforced SSO) is an Enterprise
capability.

## Configuring a provider

Open **Workspace → Settings → Single sign-on** as a workspace admin. If no
provider is connected yet, choose **Connect OIDC provider** to reveal the form.

1. **Display name** — the label shown on the sign-in screen (e.g. "Acme SSO").
2. **Issuer URL** — the discovery base of your provider, e.g.
   `https://id.example.com`. TruePPM appends
   `/.well-known/openid-configuration` itself — paste the issuer, not the
   discovery URL.
3. **Client ID** and **Client secret** — the credentials of the OIDC client you
   register in your provider for TruePPM. The secret is **write-only**: it is
   encrypted at rest and never displayed again. Leave the field blank on later
   edits to keep the stored secret; enter a new value to **rotate** it.
4. **Redirect URI** — copy the read-only value shown here into your provider's
   list of allowed redirect URIs. It is derived from your public API origin
   (`{origin}/api/v1/auth/oidc/callback/`).
5. **Allowed email domains** — only users whose email is in one of these domains
   may sign in via SSO. This also gates member auto-creation.
6. **Auto-create members** *(optional)* — when on, a user signing in for the
   first time from an allowed domain is created as a member at the **default
   role** you choose (Member or Admin; SSO can never grant Owner). Leave it off to
   require that accounts be invited first.

Use **Test connection** at any time to verify that the issuer's discovery
document and signing keys are reachable before you enable sign-in. When the
configuration is complete, turn **SSO sign-in** on and save.

To turn SSO off, use **Disable SSO**, which removes the provider configuration;
users fall back to password sign-in.

## How users sign in

On the sign-in screen a user enters their work email and chooses **Continue with
SSO**. TruePPM matches the email's domain to your configured provider and, on a
match, hands off to your identity provider. After the user authenticates there,
they are returned to TruePPM and dropped into their workspace.

If a user authenticates successfully at your provider but has no TruePPM account
(and auto-create is off, or their domain is not allowed), they see a clear
"verified, but not a member yet" message with the code `SSO_NO_MEMBER` — ask an
admin to invite them, then have them sign in again.

## Security notes

- The client secret is encrypted at rest and is never returned to any client.
- The login flow is protected against login-CSRF / session fixation with a
  single-use, browser-bound `state` value; the ID token's signature, issuer,
  audience, and nonce are all validated before a session is minted.
- The callback never places a token in the URL — it sets the same hardened,
  httpOnly refresh cookie used by password login.
- Discovery, token, and JWKS requests to your provider are subject to TruePPM's
  outbound SSRF guard.
