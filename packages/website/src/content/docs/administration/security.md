---
title: Security
description: Security considerations for deploying and operating TruePPM.
documentedFor: "0.4"
---

## Authentication

:::note[Ships in 0.4]
Six items on this page ship in **TruePPM 0.4**, the first beta, and are **not**
in `v0.3.0-alpha.3`, the latest release:

- **Session-only "Remember me"** — in 0.3 the checkbox is present but inert; every
  login gets the long-lived persistent cookie regardless of the choice.
- **A separate `JWT_SIGNING_KEY`** — in 0.3 JWTs are always signed with
  `SECRET_KEY`, so the rotate-to-sign-everyone-out lever below rotates session
  and CSRF signing with it.
- **Per-account login lockout** — in 0.3 only the per-IP login throttle exists.
- **A denied-by-default `/admin/` on the web tier** — in 0.3 the Helm chart
  proxies Django admin unrestricted and unthrottled, and `web.adminAccess` does
  not exist. On 0.3 restrict `/admin/` at your own edge.
- **SPA security headers on the Helm and published-image paths** — in 0.3 only
  the Docker Compose templates set `X-Frame-Options`, `X-Content-Type-Options`,
  and a CSP on the SPA document; a Helm install serves it with none of them, and
  the published `web` image proxies `/admin/` wide open. Both are fixed in 0.4.
- **The `revoke_api_tokens` sweep** in the breach-recovery procedure below — in
  0.3 there is no bulk revocation command, so after rotating the signing key you
  must revoke each leaked API token by hand from its owner's personal settings
  page. The warning that key rotation does not reach API tokens applies to 0.3
  as well; only the remedy is new.

Everything else on this page describes 0.3 behavior and is current.
:::

TruePPM uses JWT (JSON Web Tokens) via `djangorestframework-simplejwt`:

- **Access token** — short-lived (15 minutes by default), held in browser memory
  only and sent on every API request as `Authorization: Bearer <token>`. The
  short lifetime bounds the blast radius of a leaked access token.
- **Refresh token** — exchanged for new access tokens via
  `POST /api/v1/auth/token/refresh/`. It rides in an **httpOnly, Secure,
  SameSite=Strict cookie** — never in `localStorage` and never readable by
  JavaScript, so an XSS bug cannot exfiltrate it. The refresh endpoint reads the
  token from the cookie.
- **Session persistence ("Remember me")** — the login form's *Keep me signed in*
  choice controls how long the session lasts. **Checked** issues a persistent
  cookie (survives browser close) with a long-lived token (30 days by default).
  **Unchecked (the default)** issues a **session cookie** that the browser drops
  on close, with a short sliding idle lifetime (12 hours by default) — so "don't
  remember me" on a shared machine is honored. SSO logins are always
  session-scoped. Both windows are tunable (`TRUEPPM_REFRESH_TOKEN_REMEMBER_DAYS`,
  `TRUEPPM_REFRESH_TOKEN_SESSION_HOURS`).
- **Rotation and revocation** — refresh tokens rotate on every use
  (`ROTATE_REFRESH_TOKENS`). The `token_blacklist` app ships in `INSTALLED_APPS`
  by default, so revocation-on-rotation (`BLACKLIST_AFTER_ROTATION`) is active:
  once a refresh token is rotated, the previous token is **rejected on replay**
  rather than living out its remaining TTL. Logging out (`POST /api/v1/auth/logout/`)
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

WebSocket connections authenticate with a short-lived, single-use **ticket**
(`?ticket=<ticket>`), minted via `POST /api/v1/ws/ticket/`, so no JWT ever
reaches a URL or an access log. The legacy `?token=<jwt>` handshake is disabled
by default and opt-in only via `TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED`
(deprecated). See [WebSocket connections](/administration/deployment/#websocket-connections).

### Login rate limiting and per-account lockout

The login endpoint carries **two stacked throttles**, because one of them alone
leaves a hole:

| Scope | Keyed on | Default | Bounds |
|---|---|---|---|
| `login` | client IP | `10/min`, fixed | Guesses from a single source address |
| `login_account` | hashed, normalized submitted username | `5/min`, tunable via `TRUEPPM_THROTTLE_LOGIN_ACCOUNT_RATE` | Guesses against **one account**, from any number of addresses |

The per-IP throttle on its own is not a lockout. A credential-stuffing run from
a rotating IP pool gets the full per-IP allowance from **every fresh address**,
so attempts against a single account are unbounded in aggregate — which is
exactly the shape of a real attack. `login_account` keys on the submitted
username instead, so targeting one account stays expensive no matter how many
addresses participate. The username is hashed before it becomes a cache key: the
key needs to be stable and collision-resistant, not reversible.

A request carrying no username skips `login_account` entirely rather than being
charged against an empty-string bucket — the per-IP throttle still applies to
those.

This is brute-force hardening, not an org-wide lockout **policy**. Admin-configurable
escalation, unlock workflows, and the auth-event audit trail are Enterprise
capabilities; what is described here is the table-stakes protection every
self-hosted install gets.

:::caution[Django admin is not covered]
Both throttles are DRF scopes on the API login view. Django admin is a plain
Django view, so neither applies to it and there is no account-lockout backend
behind it — which is why the Helm chart
[denies `/admin/` at the edge by default](#reaching-django-admin).
:::

### Single sign-on (OIDC / OAuth2)

Basic single sign-on — pointing TruePPM at your own identity provider so your
team logs in through it — ships in the OSS core at 0.4. Nine providers have a
built-in preset (Keycloak, Authentik, Zitadel, Okta, Auth0, Microsoft Entra ID,
Google, GitLab, GitHub), and any other standards-compliant OIDC provider —
Authelia, for instance — is configured through Generic OIDC with its issuer URL.
It is login federation only: no directory sync, no provisioning. The org
identity-*governance* layer (SAML 2.0, SCIM provisioning, LDAP/AD directory sync, enforced org-wide SSO) is an
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

### The SPA document is a separate control

Django's CSP, `X-Frame-Options`, and `X-Content-Type-Options` middleware decorate
responses **Django** produces — the API. The SPA's `index.html` and its
JavaScript bundles are served off disk by nginx and never reach Django, so a
correctly-configured API does **not** protect the document that runs the
application. Those headers are set by whichever nginx config your deployment
uses, and every shipped path sets the same baseline:

| Deployment path | Where the headers are set |
|---|---|
| Helm | `web.securityHeaders.*` — see [SPA security headers](/administration/helm-values/#spa-security-headers) |
| Docker Compose (TLS) | `nginx/app.conf.template`, plus `Strict-Transport-Security` |
| Docker Compose (HTTP) | `nginx/app-http.conf.template` |
| Published `web` image, run directly | baked `packages/web/nginx.conf` |

If you replace the web tier with your own nginx, CDN, or object-store hosting,
those headers become yours to set — nothing in the application can add them.
`scripts/check-nginx-security-headers.sh` (CI job `nginx:headers`) asserts the
shipped configs never drift apart on this baseline.

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

## Browser-side third-party requests (none)

The two sections above cover requests the **server** makes. This one covers the
end user's **browser**, which is a separate egress surface: a request made from
there carries the user's own IP and referrer, and no server-side egress proxy or
NetworkPolicy can see it, let alone stop it.

**Loading a page of the TruePPM web app makes zero requests to any host other than
your own.** No font CDN, no analytics, no error-reporting service, no remote
scripts or stylesheets. The three typefaces (Space Grotesk, Inter, JetBrains Mono)
are vendored into the bundle and served from your origin under `/fonts/`, licensed
SIL OFL 1.1 which expressly permits redistribution.

This matters twice over for a self-hosted install:

- **Air-gapped and network-restricted deployments render correctly.** Nothing about
  the app's appearance depends on reaching the public internet. Previously a
  blocked font request meant the whole type scale silently fell back to a
  substitute face, with no warning to the operator (#2419).
- **No undisclosed third-party data flow.** An operator who deployed TruePPM
  specifically to keep data on their own infrastructure is not quietly emitting a
  per-page-load request to someone else.

A Playwright assertion (`e2e/self-hosted-fonts.spec.ts`) fails the build if any
third-party request appears on a page load, so this cannot regress silently. It is
a whole-origin check, not a font allowlist — the next accidental CDN reference will
not be a font one.

**Features you turn on can still make outbound calls**, and they are opt-in by
design and documented where they live: client telemetry and OTLP export
([Observability](/administration/observability/)), SMTP delivery
([Email](/administration/email/)), an external identity provider
([Single sign-on](/administration/single-sign-on/)), and outbound webhooks. Nothing
in that list is enabled by default.

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

:::danger[Key rotation does not revoke API tokens]
Rotating the signing key cuts **sessions and JWTs only**. An
[API token](/features/personal-access-tokens/) — personal, project- or
program-scoped — carries no signature: it is resolved by a SHA-256 hash lookup
against the token table, so no key material is anywhere in its authentication
path. Rotate the key and every leaked token is still live, at its owner's full
permissions, indefinitely (a personal token's expiry is optional).

**Breach recovery is therefore two steps, not one.** After rotating the key, sweep
the tokens as well:

```bash
# Preview first — this is a dry run and changes nothing.
python manage.py revoke_api_tokens --all-personal

# Then commit. Revocation is one-way; nothing un-revokes a token.
python manage.py revoke_api_tokens --all-personal --commit
```

Use `--user <username-or-email>` to scope the sweep to one departing or
compromised account, or `--all` to include project- and program-scoped
integration tokens — which will break every inbound sync until an admin re-mints
them, so reach for it only on a full-instance compromise. Every revocation is
written to the token audit log tagged `operator_bulk_revoke`. See
[`revoke_api_tokens`](/administration/management-commands/#maintenance-commands).

Two routine paths already revoke personal tokens on their own and need no manual
step: a **password reset** and **deactivating or removing a member** each revoke
that account's personal tokens in the same transaction, and both are audited.
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
- **NetworkPolicy on by default** (`networkPolicy.enabled: true`) restricting
  ingress to the bundled PostgreSQL (5432) and Valkey (6379) to only the pods that
  legitimately open them — the API, Celery worker, Celery beat, backup, and
  demo-seed tiers — and applying a default-deny **egress** posture to the datastore
  pods themselves. See [datastore network isolation](#datastore-network-isolation)
  for what enforcement requires and how it is verified.
- **Django admin denied at the edge** (`web.adminAccess.allowCIDRs: []`). The web
  tier's nginx answers `403` for `/admin/` from every source until you name one,
  and rate-limits the surface at 5 requests/minute per IP. See
  [Reaching Django admin](#reaching-django-admin).

### Reaching Django admin

The web tier **denies `/admin/` by default**, and this is deliberate rather than
conservative. Django admin is a plain Django view, so neither of the API's
[login throttles](#login-rate-limiting-and-per-account-lockout) applies to it —
including the per-account lockout — and there is no account-lockout backend in
the dependency set; and the [admin bootstrap](/administration/admin-password/)
creates a superuser on every deploy. An unrestricted `/admin/` on an
ingress-exposed install is therefore an unthrottled credential-guessing surface
against a known-present privileged account.

**The recommended access path needs no chart change and no exposure at all.**
Port-forward straight to the API Service, bypassing the web tier:

```bash
# Resolve the API Service by label — the chart's fullname helper collapses the
# release name when it already contains "trueppm", so `helm install trueppm ...`
# yields `trueppm-api` while `helm install foo ...` yields `foo-trueppm-api`.
kubectl port-forward "svc/$(kubectl get svc \
  -l app.kubernetes.io/component=api \
  -o jsonpath='{.items[0].metadata.name}')" 8000:8000
# then visit http://localhost:8000/admin/
```

This is the in-cluster equivalent of the SSH tunnel the Docker Compose
deployment documents inline (`ssh -L 8443:127.0.0.1:443 user@yourserver`), and it
is the right answer for the occasional administrative task.

If you genuinely need `/admin/` on the public listener — a jump host or an office
egress range, for example — allowlist it explicitly:

```yaml
web:
  adminAccess:
    allowCIDRs:
      - 203.0.113.0/24
```

:::caution[Allowlists and proxied client IPs]
nginx matches `allowCIDRs` against `$remote_addr`. Behind an Ingress controller
that is the **controller's pod IP**, not the operator's address — so an allowlist
can be simultaneously useless (your real address never matches) and dangerously
permissive (the whole cluster pod CIDR matches). It is only meaningful when the
web tier sees real client addresses: a `LoadBalancer` with
`externalTrafficPolicy: Local`, a `hostPort`, or an ingress configured to
preserve the source IP. When in doubt, leave it empty and port-forward.
:::

To remove the path from the public listener entirely — nginx returns `404`
instead of `403`, so the surface is not even advertised — set:

```yaml
web:
  adminAccess:
    enabled: false
```

Port-forwarding still works, because it never traverses nginx.

:::danger[This control does not apply when `web.enabled: false`]
`adminAccess` is enforced by the web tier's nginx. If you disable the web tier
to front the SPA from your own CDN, the chart-managed Ingress routes `/`
**straight to the API Service**, and Django serves `/admin/` there with no
allowlist and no rate limit — the same exposure this setting exists to prevent.

If you run `web.enabled: false` with a public Ingress, you must restrict
`/admin/` at your own edge (ingress-controller annotation, WAF, or CDN rule).
The same applies if you change `service.type` away from `ClusterIP`, or add an
`ingress.hosts[].paths[]` entry that targets `service: api` — any path that
reaches the API Service directly bypasses the nginx control.
:::

### Datastore network isolation

The bundled PostgreSQL and Valkey pods speak **plaintext** on the pod network, so
the NetworkPolicy is the transport-security boundary for the bundled dev/demo
posture — not a defense-in-depth extra. The chart leans on it directly: it
auto-injects `TRUEPPM_ALLOW_UNENCRYPTED_DB` whenever
`postgresql.enabled && networkPolicy.enabled`, which relaxes the API's
unencrypted-database boot guard **on the strength of this isolation**.

**Enforcement requires a CNI that implements NetworkPolicy** — Calico, Cilium,
Antrea, or similar. On a cluster whose CNI does not, the policy objects are
accepted by the API server and then silently ignored, leaving the datastores
reachable from any pod. This is a property of the cluster, not of the chart, and
nothing in the chart can detect it.

:::caution
If your cluster has no policy-enforcing CNI, do not put anything sensitive in the
bundled datastores. Use managed external datastores with TLS
(`values-prod.yaml`) instead.
:::

#### How this is verified

Two CI gates cover the policy, and they cover different things:

| Gate | Cluster | What it proves |
|---|---|---|
| `helm:template` | none (render only) | The policy objects render, with valid schema, for the current values. |
| `helm:install` | kind, **default CNI** | The chart boots with the policy enabled. **Does not prove enforcement** — kind's default CNI (kindnetd) does not implement NetworkPolicy, by design, so the objects are admitted and ignored. |
| `helm:netpol` | kind + **Calico** | Enforcement itself. Positive probes (every allowed tier reaches the datastores), negative probes (an unlabeled pod, and a pod with the chart's labels but a non-client component, are both denied), datastore egress default-deny, and two controls proving a denial came from the policy rather than a broken CNI. |

`helm:netpol` runs on every merge request that touches the chart, on `main`, and
nightly. It is the gate that makes the `TRUEPPM_ALLOW_UNENCRYPTED_DB`
auto-injection defensible; before it existed, the isolation the chart relies on was
never actually tested.

#### Adding a component that talks to a datastore

The policy allow-lists clients by `app.kubernetes.io/component`. A new Deployment,
Job, or CronJob that opens PostgreSQL or Valkey **must be added to the
corresponding list** in `templates/networkpolicy.yaml`, or its connections are
dropped on any enforcing cluster — while `helm lint`, `helm template`, and
`helm:install` all stay green. `helm:netpol` is scoped to the whole chart precisely
so that adding such a template triggers it.

### External (managed) datastores

When you disable the bundled subcharts (`postgresql.enabled: false` /
`valkey.enabled: false`) to use managed services, the chart can no longer build
the connection strings for you, so `env.DATABASE_URL` and `env.REDIS_URL` become
**required** — the render fails with a clear message if either is missing.

Both supported shapes are injected via `secretKeyRef`, so neither renders a
credential into a Deployment, Job, or CronJob. They differ in whether the
credential passes through Helm:

- **`secretKeyRef` map** (preferred) — the chart points every consumer at a
  Secret you manage and never sees the URL, so it is absent from your values
  file, your shell history, and the Helm release Secret.
- **URL string** — the chart moves it into the chart-owned connection Secret and
  injects it from there. It stays out of the workload manifests, but it persists
  in whatever held it on the way in.

See [Deployment](/administration/deployment/),
[Helm values](/administration/helm-values/#managed-external-datastores), and the
chart README.

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
