---
title: Security
description: Security considerations for deploying and operating TruePPM.
---

## Authentication

TruePPM uses JWT (JSON Web Tokens) via `djangorestframework-simplejwt`:

- **Access token** — short-lived (15 minutes by default), held in browser memory
  only and sent on every API request as `Authorization: Bearer <token>`. The
  short lifetime bounds the blast radius of a leaked access token.
- **Refresh token** — longer-lived (7 days by default), exchanged for new access
  tokens via `POST /api/v1/auth/token/refresh/`. It rides in an **httpOnly,
  Secure, SameSite=Strict cookie** — never in `localStorage` and never readable
  by JavaScript, so an XSS bug cannot exfiltrate it. The refresh endpoint reads
  the token from the cookie.
- **Rotation and revocation** — refresh tokens rotate on every use
  (`ROTATE_REFRESH_TOKENS`). The `token_blacklist` app ships in `INSTALLED_APPS`
  by default, so revocation-on-rotation (`BLACKLIST_AFTER_ROTATION`) is active:
  once a refresh token is rotated, the previous token is **rejected on replay**
  rather than living out its 7-day TTL. Logging out (`POST /api/v1/auth/logout/`)
  likewise blacklists the presented refresh token. A lean deployment that removes
  the `token_blacklist` app degrades gracefully to TTL-only expiry — the
  refresh/logout endpoints tolerate its absence.

Token lifetimes and the cookie attributes are configurable — see
[Configuration](/administration/configuration/) for `AUTH_REFRESH_COOKIE_*`.

### Blacklist tables and cleanup

With the `token_blacklist` app installed, every issued refresh token is recorded
in an `OutstandingToken` row, and rotated/revoked tokens add a `BlacklistedToken`
row. To stop these tables growing unbounded, a Celery Beat job
(`access.flush_expired_blacklisted_tokens`, nightly at 04:30 UTC) deletes rows
whose tokens have already expired — bounding the tables to roughly the active
refresh-token window. The job requires a running **Celery Beat** scheduler (the
same one that drives retention and outbox-drain jobs); deployments that run the
API without Beat should schedule the `flushexpiredtokens` management command
out-of-band instead. See [Management commands](/administration/management-commands/).

WebSocket connections authenticate via `?token=<jwt>` on the connection URL.

### Split-origin deploys

`SameSite=Strict` means the browser will not send the refresh cookie on a
cross-origin request. If you serve the web app from a different origin than the
API, relax `AUTH_REFRESH_COOKIE_SAMESITE` (to `Lax` or `None`) and add the API
origin to `CSP_CONNECT_SRC` so the browser can reach it. See
[Split-origin deploys](/administration/configuration/#split-origin-deploys).

## Content-Security-Policy

The API sends a strict `Content-Security-Policy` header on **every** response,
including `frame-ancestors 'none'` (the app cannot be framed — clickjacking
protection) and `default-src 'self'`. The `connect-src` directive defaults to
`'self' wss:` so the SPA can open same-origin XHR and the WebSocket
collaboration channel.

Operators serving the SPA from a different origin than the API, or behind a
proxy that rewrites origins, must add that origin (and its `wss://` origin) to
`CSP_CONNECT_SRC` — otherwise the browser blocks the connection. See
[Configuration](/administration/configuration/#split-origin-deploys).

## HTTPS

TruePPM does not terminate TLS itself. In production, place a reverse proxy in front of the API and web services:

- **nginx** — configure with `proxy_pass` to the API container
- **Caddy** — automatic TLS with Let's Encrypt
- **Cloud load balancer** — AWS ALB, GCP HTTPS LB, etc.

Ensure WebSocket upgrade headers are forwarded correctly.

## Database security

- PostgreSQL should not be exposed to the public internet
- Use network policies or firewall rules to restrict access to the API and Celery containers
- Use a strong, unique password for the `trueppm` database user
- Enable PostgreSQL SSL in production

The Helm chart generates a strong random password for the bundled PostgreSQL on
first install rather than shipping a default credential — see
[Helm secure-by-default](#helm-secure-by-default) below.

## Cache (Valkey/Redis) security

- The cache requires authentication by default in the Helm chart
  (`valkey.auth.enabled: true`); a generated password is injected via
  `requirepass`. When running your own Valkey/Redis, enable `requirepass` or
  keep it on a private network.
- The cache is used as a broker and Channels layer; it does not store persistent data
- If the cache is compromised, an attacker could inject WebSocket events or manipulate the Celery task queue

## Secret management

| Secret | Where it's used | Impact if leaked |
|--------|----------------|-----------------|
| `SECRET_KEY` | Django session signing, JWT signing | Full account takeover — attacker can forge any session or token |
| `DATABASE_URL` | PostgreSQL connection | Full data access |
| `REDIS_URL` | Celery broker, Channels layer | Task injection, event spoofing |

:::danger
Never commit secrets to version control. Use environment variables, Docker secrets, or a secrets manager (Vault, AWS Secrets Manager, etc.).
:::

## Helm secure-by-default

The Helm chart installs securely with no extra flags. The full reference lives in
the chart [README](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/helm/README.md);
the operator-facing highlights:

- **Generated datastore credentials.** Leave `postgresql.auth.password` and
  `valkey.auth.password` empty and the chart mints a strong random password on
  first install, persisting it in a chart-owned **connection Secret**
  (`<release>-trueppm-connection`) annotated `helm.sh/resource-policy: keep`.
  Re-renders read the existing password back, so `helm upgrade` never churns the
  credential or orphans the database PVC. The kept Secret also survives
  `helm uninstall`. Retrieve the DB password with:
  ```bash
  kubectl get secret <release>-trueppm-connection \
    -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d
  ```
- **No plaintext credentials in any manifest.** `DATABASE_URL` and `REDIS_URL`
  are built server-side and injected via `secretKeyRef` against the connection
  Secret — they are never rendered into a Deployment. The bundled datastores
  read their password from the same Secret, so the server credential and the URL
  can never drift apart.
- **Cache auth on by default** (`valkey.auth.enabled: true`).
- **Hardened containers.** API and worker run with `runAsNonRoot`,
  `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, all
  capabilities dropped, and the `RuntimeDefault` seccomp profile, with writable
  `emptyDir` mounts only where required (`/tmp`, `/app/staticfiles`,
  `/run/trueppm`). Tune via `podSecurityContext` / `containerSecurityContext`.
- **`automountServiceAccountToken: false`** on the API and worker pods.
- **Opt-in NetworkPolicy** (`networkPolicy.enabled: true`) restricting ingress
  to the bundled PostgreSQL (5432) and Valkey (6379) to only the API and worker
  pods. Off by default because it requires a CNI that enforces NetworkPolicy —
  a silently-unenforced policy is worse than an explicit opt-in.

### External (managed) datastores

When you disable the bundled subcharts (`postgresql.enabled: false` /
`valkey.enabled: false`) to use managed services, the chart can no longer build
the connection strings for you, so `env.DATABASE_URL` and `env.REDIS_URL` become
**required** — the render fails with a clear message if either is missing.
Inject them via an external Secret rather than `--set` so they don't land in
shell history. See [Deployment](/administration/deployment/) and the chart
README.

## RBAC enforcement

All API endpoints enforce role-based access control. See the [RBAC documentation](/administration/rbac/) for the full permission matrix.

Key security properties:
- **No global admin role** — permissions are scoped to individual projects
- **Role escalation prevention** — you can only assign roles below your own
- **IDOR prevention** — querysets are scoped to the user's project memberships; non-members see empty results, not 403 errors
- **Last-Owner guard** — prevents accidental removal of all project owners

## Reporting vulnerabilities

If you discover a security vulnerability in TruePPM, please report it responsibly via the [GitLab repository](https://gitlab.com/trueppm/trueppm). Do not open a public issue for security vulnerabilities.
