---
title: Connected Accounts & Git-Aware Links
description: Connect your own GitLab, GitHub, or generic Git account to track live MR, PR, and issue status directly on TruePPM tasks.
---

TruePPM lets each contributor connect their **own** Git host credentials and
then track the live status of merge requests, pull requests, and issues from the
task detail panel. The credential is per-user — a personal access token (PAT)
belongs to *you*, not to a project or program — and it is read-only: TruePPM
fetches status, it never writes back.

:::note[Edition]
Connected accounts and git-aware task links are part of the **Community (OSS)**
edition. They register against the `TASK_LINK_PROVIDERS` registry (ADR-0049), so
the Enterprise edition can add richer providers (Jira, ServiceNow, Bitbucket,
Azure DevOps, …) without any OSS code change.
:::

This page covers the two *user-scoped* surfaces. For the *project*- and
*program*-scoped integration surfaces, see:

- [Webhooks](/features/webhooks/) — outbound HTTP callbacks for project and
  program events (Slack, CI, custom tooling).
- [Inbound Task Sync](/features/inbound-task-sync/) — authenticated API tokens
  that let external systems push tasks into a project.

A workspace-level "manage all integrations across all programs" surface — the
**Integration Hub** with bidirectional connectors, OAuth bots, and a
cross-program audit trail — is part of the Enterprise edition.

## Connected accounts

Per-user PATs for GitLab, GitHub, and generic Git hosts are managed at
**User → Settings → Connected Accounts** (`/me/settings/connected-accounts`).
Credentials are per-user, not per-project or per-program — a PAT authorizes
status fetches that preview links into issues, merge requests, and pull requests
on tasks.

### What the page does

- Lists one section per provider registered against the `TASK_LINK_PROVIDERS`
  registry — **GitLab**, **GitHub**, and a catch-all **generic** provider.
- For each provider, surfaces the connection state (Connected / Not connected),
  the optional self-hosted host URL, the credential's expiration if you recorded
  one, and the last time the credential was used by the task-link refresh
  endpoint.
- Provides per-provider **Connect**, **Rotate**, and **Revoke** actions. Connect
  and Rotate share the same upsert API — one row per `(user, provider)` pair,
  never duplicated.
- **Connect and Rotate verify the token before storing it.** GitLab and GitHub
  credentials are checked against the provider's `/user` endpoint; a wrong,
  expired, wrong-scope, or wrong-host token (for example a github.com PAT pasted
  into the GitLab section) is rejected with a clear error and **nothing is
  stored**. The generic provider is accepted without a live check, since there
  is no known endpoint to verify it against.
- Renders a deep-link anchor per provider —
  `/me/settings/connected-accounts#github` scrolls straight to the GitHub
  section. The project Integrations page links here.

### Security guarantees

- Secrets are encrypted at rest with `INTEGRATION_ENCRYPTION_KEY` (set in the
  Helm values, generated with
  `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`).
- The encrypted ciphertext is **never** returned by any API endpoint, not even
  to the credential's owner. The list response exposes only metadata: `exists`,
  `base_url`, `created_at`, `updated_at`, `last_used_at`, `expires_at`, and
  `requires_credential`.
- Cross-user access is impossible by construction — the viewset's queryset is
  scoped to `request.user`, so neither the URL path nor the request body can
  address another user's row.
- Token verification and the task-link refresh both make outbound HTTP calls
  through a single SSRF-guarded egress helper. It resolves the target host and
  refuses any URL that resolves to a private, loopback, link-local, or
  cloud-metadata address, so a self-hosted host URL cannot be used to probe
  internal services. Calls are time-bounded and do not follow redirects.

The connected credential is consumed by **git-aware task links** to fetch live
status.

## Git-aware task links

Paste a GitLab, GitHub, or any URL onto a task and track its live status from
the task detail panel. Links are managed in the **External links** section of
the task drawer.

:::note
Git-aware links are distinct from the static **pinned links** described under
[Task Collaboration](/features/task-collaboration/). A pinned link is a plain
attachment (a Figma or Confluence URL with no live state); a git-aware link
resolves an MR, PR, or issue and shows its current status badge.
:::

### What the section does

- **Add a link** — paste a URL; the provider is detected automatically from the
  host (gitlab.com → GitLab, github.com → GitHub, anything else → a *generic*
  link). For a self-hosted GitLab CE/EE or GitHub Enterprise Server instance, a
  link on that host routes to the matching provider when you have a credential
  connected with that host as its base URL. The provider is always resolved
  server-side — the typed hint is only a preview.
- **Status badge** — each git link shows a cached status: **open**, **draft**,
  **merged**, **closed**, or **unknown**. A new link starts *unknown* — there is
  **no background polling**; status is fetched only when you refresh.
- **Refresh** — the per-link refresh button fetches live status synchronously
  (5-second timeout) from the provider's API using your connected personal access
  token, mapping the PR/MR/issue state onto the badge. Merge requests and pull
  requests resolve to merged/closed/draft/open; issues to open/closed; commits
  and branches stay *unknown*. The fetch is SSRF-guarded (it refuses any host
  that resolves to a private/loopback/link-local/cloud-metadata address) and does
  not follow redirects.
- **Connect prompt** — if the link's provider needs a personal access token you
  haven't connected, refresh points you to **User → Settings → Connected
  Accounts** to connect one, rather than failing silently. Generic links need no
  credential and have no live status.
- **Remove** — delete a link with an inline confirm.

### API

| Action | Endpoint | Min role |
|---|---|---|
| List links | `GET /api/v1/projects/{id}/tasks/{task_id}/links/` | Viewer |
| Add link | `POST /api/v1/projects/{id}/tasks/{task_id}/links/` | Member |
| Refresh status | `POST /api/v1/projects/{id}/tasks/{task_id}/links/{link_id}/refresh/` | Viewer |
| Remove link | `DELETE /api/v1/projects/{id}/tasks/{task_id}/links/{link_id}/` | Member |

Adding and removing follow task-edit permission; listing and refreshing follow
task-read. Links inherit offline-sync parity with tasks, so add/remove/status
changes reach the mobile client through the project sync delta.

## Related ADRs

- **ADR-0049** — External Integration Extension Points (the OSS registries)
- **ADR-0050** — Task Detail Drawer Section Extension Points (where
  `task_detail.external_links` registers)
- **ADR-0076** — Integration Management Surface Boundary
