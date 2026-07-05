---
title: Personal Access Tokens
description: Create a user-scoped API token to authenticate scripts and tools against TruePPM as yourself — with optional expiry, a 10-token cap, and automatic revocation on password change.
---

A **Personal Access Token (PAT)** is a credential that lets a script, notebook,
or command-line tool call the TruePPM API **as you**. It carries exactly your
permissions — everything you can see and do in the app, and nothing more. A PAT
is how a PMO analyst runs a weekly portfolio export, a Product Owner scripts a
roadmap dump, or a developer wires up CI tooling, without embedding a password or
holding a browser session open.

:::note[Edition]
Personal access tokens are part of the **Community (OSS)** edition. Session-free
personal API access is table-stakes developer and analyst tooling. Organization
identity governance — directory-driven provisioning, enforced org-wide SSO — is
the Enterprise line; a personal token you mint for yourself is not.
:::

## How a PAT differs from a project or program token

TruePPM has two token surfaces, and they answer different questions:

| | Personal access token | Project / program API token |
|---|---|---|
| Owned by | **You** (a user) | A project or a program |
| Acts as | You — your RBAC applies | The token's minter, scoped to that project/program |
| Minted from | **Settings → Personal access tokens** | Project/Program **Settings → Integrations** |
| Typical use | "Run this report as me" | CI or an integration pushing tasks into one project |

Both use the same `tppm_` bearer scheme. The difference is *whose* authority the
token carries.

## The bearer scheme

Send a PAT in the `Authorization` header on every request:

```
Authorization: Bearer tppm_<64 hex characters>
```

The `tppm_` prefix makes the token greppable by secret scanners (GitGuardian,
GitHub secret scanning). Only the random portion is secret; TruePPM stores just a
SHA-256 hash of the token, never the token itself.

## Creating a token

1. Open the user menu and choose **Personal access tokens**
   (`/me/settings/api-tokens`).
2. Click **Create token**.
3. Give it a descriptive **name** (e.g. "Power BI export") so you can tell your
   tokens apart later.
4. Optionally set an **expiration** date. Leave it blank for a token that never
   expires.
5. Click **Create token**.

The raw token is shown **exactly once**, with a copy button. Copy it now and
store it somewhere safe — TruePPM cannot show it again, because it only keeps the
hash. If you lose it, revoke the token and create a new one.

## The 10-token cap

You can hold up to **10 active tokens** at a time. "Active" means not revoked and
not past its expiry — revoking a token or letting one expire frees a slot. The
create button is disabled once you reach the cap; the page shows a live
"N of 10 active tokens" indicator. The cap bounds the blast radius if your
account is ever compromised and keeps your token list navigable.

## Expiry

An optional expiration date lets a token retire itself. Once a token is past its
`expires_at`, TruePPM rejects it exactly as if it had been revoked — the request
fails authentication with a generic `401`. Tokens without an expiry never expire
on their own; revoke them when you no longer need them.

## Revoking a token

On the Personal access tokens page, click **Revoke** next to any active token and
confirm. Revocation takes effect immediately: any script or tool using that token
starts failing authentication on its next request. Revocation is permanent — you
cannot un-revoke a token, only create a new one.

## A password change revokes every PAT

When you reset your password, **all of your personal access tokens are revoked
automatically**. A password reset is you asserting that your credentials may be
compromised, so TruePPM cuts off not only your live sessions but every long-lived
personal credential you minted. You will need to create new tokens afterward.

This does **not** touch project or program API tokens — those are shared team
assets minted by a project or program admin, not personal credentials, so a
password change never breaks a team's CI integration.

## Security notes

- A PAT is a **full-authority** bearer of your account. Treat it like a password:
  never commit it to source control, paste it into a shared document, or send it
  over chat.
- A PAT is **not** a superuser credential. It acts strictly as you — a Viewer's
  token can only read what a Viewer sees.
- TruePPM stores only a SHA-256 hash of each token, so a database compromise does
  not expose usable tokens.
- Every mint and revoke is written to an append-only audit log.

## Related

- [Inbound task sync](/features/inbound-task-sync) — project/program tokens for
  pushing tasks in from an external system.
- [Connected accounts](/features/connected-accounts) — connect your own GitLab or
  GitHub account for read-only task-link previews.
- [MCP server](/features/mcp-server) — point an MCP client at your instance with a
  read-only token.
