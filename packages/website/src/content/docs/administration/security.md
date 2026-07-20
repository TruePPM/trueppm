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

### Single sign-on (OIDC / OAuth2)

Basic single sign-on — pointing TruePPM at your own identity provider (Keycloak,
Authentik, Authelia, Zitadel, Google, GitHub, GitLab) so your team logs in
through it — ships in the OSS core at 0.4. It is login federation only: no
directory sync, no provisioning. The org identity-*governance* layer (SAML 2.0,
SCIM provisioning, LDAP/AD directory sync, enforced org-wide SSO) is an
enterprise-edition feature. For why that line falls where it does, and how it
compares to the open-core competition, see
[SSO Is Not an Enterprise Feature](/overview/sso-is-not-enterprise/).

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

**Encrypt the database connection.** TruePPM does not force TLS on the database
link — the `sslmode` is whatever your `DATABASE_URL` specifies. For any
deployment where the API and PostgreSQL are not on the same trusted host, append
`?sslmode=require` (or stricter — `verify-ca` / `verify-full` with a CA bundle)
to `DATABASE_URL`. When the API boots in a production configuration
(`DEBUG=False`) with a `DATABASE_URL` that has no `sslmode`, it logs an advisory
warning so the gap is visible in your logs rather than silent.

The Helm chart generates a strong random password for the bundled PostgreSQL on
first install rather than shipping a default credential — see
[Helm secure-by-default](#helm-secure-by-default) below.

## Outbound requests (SSRF boundary)

Features that fetch a user- or admin-supplied URL — currently the outbound
webhook delivery path — run behind an egress guard that rejects requests
resolving to private, loopback, link-local, or otherwise non-public address
ranges, blocking the common server-side request forgery (SSRF) vectors.

The OSS guard validates the resolved address at request time. It does **not**
pin that address for the life of the connection, so a name that resolves to a
public IP at check time and a private IP a moment later (DNS-rebinding) is a
residual, admin-gated risk accepted by design (ADR-0049 §6). Mitigate it at the
network layer: run the API's outbound traffic through an egress proxy or
NetworkPolicy that denies the internal ranges you care about, rather than
relying on the application guard alone. Connection-time IP pinning is an
Enterprise hardening.

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
| `SECRET_KEY` | Django session/CSRF signing; JWT signing when `JWT_SIGNING_KEY` is unset | Full account takeover — attacker can forge any session or token |
| `JWT_SIGNING_KEY` *(optional)* | Access/refresh JWT signing only | Token forgery for any user — but a leak no longer also compromises session/CSRF signing |
| `DATABASE_URL` | PostgreSQL connection | Full data access |
| `REDIS_URL` | Celery broker, Channels layer | Task injection, event spoofing |

:::danger
Never commit secrets to version control. Use environment variables, Docker secrets, or a secrets manager (Vault, AWS Secrets Manager, etc.).
:::

### Separating the JWT signing key and forcing a global sign-out

By default the JWT signing key **is** `SECRET_KEY`. Setting a dedicated
`JWT_SIGNING_KEY` (optional; same strength rules — ≥ 32 chars, not the
`django-insecure-` placeholder, enforced at boot in production) decouples the
two so that:

- a leaked `SECRET_KEY` alone can no longer forge tokens; and
- you gain a **rotate-to-sign-everyone-out** lever that does not also churn
  Django's session/CSRF signing.

**To force every user to sign in again** (after a suspected token leak or an
admin offboarding), rotate the JWT signing key: set `JWT_SIGNING_KEY` to a fresh
value and restart the API and Celery workers. Every outstanding access and
refresh token immediately fails signature verification; the web app treats the
next call as a `401`, attempts one (also-failing) refresh, and routes users to
the sign-in screen. No data is lost. If you have not set a separate
`JWT_SIGNING_KEY`, rotating `SECRET_KEY` has the same effect but also rotates
session/CSRF signing.

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

## Container image supply-chain

Every published `api` and `web` image is scanned and inventoried in the release
pipeline before it is pushed:

- **Vulnerability scan** — [Trivy](https://trivy.dev) scans each built image and
  **fails the release** on any fixable HIGH/CRITICAL CVE. Base-image CVEs with no
  available patch (`--ignore-unfixed`) do not block, since they are not
  actionable by the operator.
- **SBOM** — [Syft](https://github.com/anchore/syft) generates a CycloneDX SBOM
  (`sbom/api-<version>.cdx.json`, `sbom/web-<version>.cdx.json`) for the exact
  image tarball that is published. The SBOM is retained as a non-expiring CI
  artifact on the release pipeline so you can audit the full dependency inventory
  of any image you run.

**Signing.** Cosign signatures and SBOM attestations on the public images and
Helm chart land alongside GHCR image publishing (planned for the 0.4 beta) —
until then, verify images by matching the published digest and the attached SBOM
artifact.

## Reporting vulnerabilities

If you discover a security vulnerability in TruePPM, please report it privately —
**do not open a public issue.** Report through either channel:

- **Email** — **security@trueppm.com** (preferred).
- **Confidential GitLab issue** — open an issue in the
  [GitLab repository](https://gitlab.com/trueppm/trueppm/-/issues/new) and tick
  **"This issue is confidential"** so it is visible only to project members.

Our full policy — supported versions, response SLAs (2 business days to
acknowledge), coordinated-disclosure process, and **safe-harbor terms** for
good-faith research — lives in
[`SECURITY.md`](https://gitlab.com/trueppm/trueppm/-/blob/main/SECURITY.md) at
the repository root. We publish a GitLab Security Advisory and credit reporters
(unless anonymity is requested) when a fix ships.
