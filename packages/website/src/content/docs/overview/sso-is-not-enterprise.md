---
title: SSO Is Not an Enterprise Feature
description: Identity federation is table stakes for self-hosting. TruePPM ships OIDC/OAuth2 login in the OSS core — here is how that compares to the open-core competition, and where the enterprise line actually falls.
---

Single sign-on is the most-cited grievance in self-hosted communities: you stand up an
open-source tool on your own infrastructure, wire up your own identity provider, and then
discover that letting your team log in through it costs money. The "SSO tax" gates the one
thing every self-hoster expects to work — logging in with the accounts they already run —
behind a paid tier.

TruePPM does not charge the SSO tax. **Basic single sign-on ships in the OSS core.** You point
TruePPM at your own identity provider — Keycloak, Authentik, Authelia, Zitadel, Google, GitHub,
or GitLab — and your whole team logs in through it. No plugin to hunt down, no enterprise
license, no per-seat upcharge for the login screen.

:::note[Version status]
Basic OIDC / OAuth2 login federation **ships in 0.4**, TruePPM's first beta. Until 0.4 tags,
treat this page as a statement of intent, not of shipped behavior. See the
[roadmap](/overview/roadmap/) for the authoritative Shipped / Underway / Planned status.
:::

## Where the line actually falls

The enterprise boundary is not "SSO." It is **governance**. The distinction is one sentence:

> **Log in via your own IdP → OSS. Provision, deprovision, and govern accounts from a directory → Enterprise.**

Everything a single self-hosting team needs to authenticate against their own IdP is OSS.
The things an *organization* needs to enforce identity policy across many teams — those are the
enterprise edition:

| Capability | Edition |
| --- | --- |
| OIDC / OAuth2 login against your own IdP | **OSS core** (ships in 0.4) |
| Self-service account linking | **OSS core** (ships in 0.4) |
| SAML 2.0 federation | Enterprise |
| SCIM provisioning / deprovisioning | Enterprise |
| LDAP / Active Directory directory sync | Enterprise |
| Enforced org-wide SSO (disable local accounts) | Enterprise |
| Group → role mapping with an auth-event audit trail | Enterprise |

The test: if it *authenticates a user who already has an account*, it is OSS. If it *creates,
disables, or governs accounts from a directory of record*, it is enterprise. A PM and their team
must be able to log in through their own IdP without an enterprise license — anything less is the
SSO tax, and the SSO tax kills adoption before a prospect ever feels the product.

## How the open-core competition gates login

The open-core project-management field is uneven on this. Some tools reserve first-class login
federation for their paid tier; others push it to a third-party plugin. The table below reflects
each project's **current** gating. Claims are cited and dated — re-verify against the linked
source before quoting, because vendor packaging changes.

| Tool | OIDC / OAuth login | SAML | Built-in or plugin | Verified |
| --- | --- | --- | --- | --- |
| **TruePPM (OSS core)** | **Free — OSS core** (ships in 0.4) | Enterprise | **Built-in** | 2026-07-03 |
| OpenProject | Enterprise add-on [^op] | Enterprise add-on [^op] | Built-in (paid) | 2026-07-03 |
| Plane | Paid / Commercial editions only [^plane] | Paid / Commercial editions only [^plane] | Built-in (paid) | 2026-07-03 |
| Leantime | Free in the open-source core [^lean] | Paid marketplace add-on [^lean] | Built-in (OIDC) | 2026-07-03 |
| Redmine | Free — third-party community plugin [^redmine] | Third-party plugin | Plugin (not built-in) | 2026-07-03 |
| Taiga | Third-party community plugin [^taiga] | Third-party community plugin [^taiga] | Plugin (not built-in) | 2026-07-03 |

A few honest nuances the table flattens:

- **OpenProject** and **Plane** are the clearest examples of the SSO tax: both build OIDC and SAML
  directly into the product, then gate it behind the Enterprise / Commercial tier. On OpenProject,
  "single sign-on is an Enterprise add-on and can only be activated for Enterprise cloud and
  Enterprise on-premises." [^op] On Plane, SSO is a Pro / Commercial-edition feature; the AGPL
  Community edition ships without it. [^plane]
- **Leantime** is fairer: OIDC (and LDAP) login is free in the open-source core, and only SAML is
  a paid marketplace add-on. [^lean]
- **Redmine** and **Taiga** do not charge for SSO, but neither ships it in the box — login
  federation lives in third-party community plugins whose maintenance varies. [^redmine] [^taiga]
  Free, but not first-class, and not something you can rely on being maintained.

TruePPM's position is the one line none of them draw cleanly: **first-class, built-in OIDC /
OAuth2 login in the OSS core, with no plugin to source and no paid tier to unlock.** The
enterprise edition earns its price on *governance* — directory sync, provisioning, enforced policy
— not on the login screen.

## Setting it up

Once 0.4 ships, configuring an identity provider is an administration task — see
[Security → Authentication](/administration/security/#authentication) for how TruePPM issues and
rotates tokens, and the [Configuration](/administration/configuration/) reference for the
environment variables that register your IdP. The member-list `sso` and `two_fa` fields described
in [Workspace Settings](/administration/workspace-settings/) refer to *governed* SSO/2FA
enforcement — the enterprise-edition governance layer — not to whether OSS login federation is
available.

[^op]: OpenProject, "Authentication FAQ" and "OpenID providers (Enterprise add-on)":
    <https://www.openproject.org/docs/system-admin-guide/authentication/authentication-faq/>,
    <https://www.openproject.org/docs/system-admin-guide/authentication/openid-providers/>,
    <https://www.openproject.org/docs/system-admin-guide/authentication/saml/>. Verified 2026-07-03.

[^plane]: Plane, "Understanding Plane's editions" and self-hosting SSO docs:
    <https://developers.plane.so/self-hosting/editions-and-versions>,
    <https://developers.plane.so/self-hosting/govern/oidc-sso>,
    <https://developers.plane.so/self-hosting/govern/saml-sso>. Verified 2026-07-03.

[^lean]: Leantime, open-source auth provider install and "Advanced Authentication" marketplace
    add-on (SAML): <https://marketplace.leantime.io/product/installation-auth-provider/>,
    <https://marketplace.leantime.io/product/advanced-auth/>. Verified 2026-07-03.

[^redmine]: Redmine, community OpenID Connect plugins (MIT-licensed, third-party) in the official
    plugin directory: <https://www.redmine.org/plugins/redmine_oidc>. Verified 2026-07-03.

[^taiga]: Taiga, community SAML / OpenID Connect authentication plugins (third-party, maintenance
    varies): <https://github.com/jgiannuzzi/taiga-contrib-saml-auth>,
    <https://community.taiga.io/t/authentik-integration-options-oidc-saml-forward-auth/8537>.
    Verified 2026-07-03.
