---
title: Security
description: Security considerations for deploying and operating TruePPM.
documentedFor: "0.4"
---

This page is the security reference for operating a self-hosted install: how
TruePPM authenticates and rate-limits, what to check before exposing it to the
internet, and the procedure to follow after a suspected credential leak (see
[Secret management](#secret-management)). Read it once at deploy time for the
[Helm secure-by-default](#helm-secure-by-default) checklist, and come back to
[Reporting vulnerabilities](#reporting-vulnerabilities) or the breach-recovery
steps if something goes wrong later.

## Authentication

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
escalation and unlock workflows are Enterprise capabilities; what is described here is
the table-stakes protection every self-hosted install gets.

Auth events themselves are **not** an Enterprise capability. Recording of single
sign-on administration — `sso_provider_created`, `sso_provider_updated` (with a
per-field before/after diff), `sso_provider_deleted`, `sso_secret_rotated` — and of
`sso_account_linked` in the [audit log](/administration/audit-log/), together with
structured `trueppm.auth` lines for login success and failure, **shipped in 0.4** in the
community edition. What stays Enterprise is the *governed* trail layered on top: an
immutable, signed, retained trail with SOC 2 evidence export, plus the auth events of
the identity-governance layer itself (group→role mapping, enforced org-wide SSO).

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

### One origin only

TruePPM must be served from a **single hostname** — the SPA, the API, and the
WebSocket endpoint routed by path on one origin. There is no CORS support in the
codebase (no `django-cors-headers`, no `CORS_*` setting), so a browser blocks
every cross-origin request from a SPA served elsewhere, and no combination of
`CSRF_TRUSTED_ORIGINS`, `AUTH_REFRESH_COOKIE_SAMESITE`, or `CSP_CONNECT_SRC`
changes that. The secure defaults — `SameSite=Strict` on the refresh cookie and
`connect-src 'self' wss:` — are correct as shipped for that topology and need no
relaxing. See [Split-origin deploys](/administration/configuration/storage-and-networking/#split-origin-deploys)
and [One origin, four variables](/administration/networking/#one-origin-four-variables).

## Content-Security-Policy

The API sends a strict `Content-Security-Policy` header on **every** response,
including `frame-ancestors 'none'` (the app cannot be framed — clickjacking
protection) and `default-src 'self'`. The `connect-src` directive defaults to
`'self' wss:` so the SPA can open same-origin XHR and the WebSocket
collaboration channel.

That default is complete for the supported single-origin topology. Widen
`CSP_CONNECT_SRC` only for a genuinely external destination — an analytics
endpoint, or an object store you serve attachment downloads from directly.
Serving the SPA from a different origin than the API is not supported and cannot
be fixed here; see [Configuration](/administration/configuration/storage-and-networking/#split-origin-deploys).

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

TruePPM does not terminate TLS itself — the API container speaks plain HTTP on
`:8000`, always. In production, place a reverse proxy in front of the API and web
services:

- **nginx** — `proxy_pass` to the API container; the shipped Compose templates
  are a working reference
- **Caddy** — automatic TLS with Let's Encrypt
- **Cloud load balancer** — AWS ALB, GCP HTTPS LB, etc.
- **Kubernetes** — the chart's `Ingress`, with cert-manager or your own TLS Secret

Two things must be right whichever you pick, and both have their own failure
mode: the proxy has to forward the WebSocket `Upgrade` / `Connection` headers and
raise its idle timeout, and it has to set `X-Forwarded-Proto` correctly —
`settings.prod` trusts that header unconditionally, so the API Service must not
be reachable directly. [Networking](/administration/networking/#tls) has the
topology table, a complete cert-manager `ClusterIssuer` for HTTP-01 and DNS-01,
bring-your-own-certificate recipes, and the WebSocket timeout knob for each
proxy.

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

### Verifying before deploy

Django's deploy check enforces the key rules at boot, so you can prove a
deployment will start *before* you roll it:

```bash
DJANGO_SETTINGS_MODULE=trueppm_api.settings.prod \
  SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))") \
  ALLOWED_HOSTS=example.com \
  python manage.py check --deploy --fail-level=ERROR
```

Each failure has its own id, so the output says which rule you broke: an empty
key is `trueppm.E001`, one still carrying the Django `django-insecure-`
placeholder prefix is `trueppm.E002`, and one shorter than 32 characters is
`trueppm.E003`. Any of them exits non-zero.

`secrets.token_urlsafe(50)` produces a ~67-character URL-safe string; store it in
your `.env` (mode `0600`) or, on Kubernetes, set the `secrets.djangoSecretKey`
Helm value.

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
them, so reach for it only on a full-instance compromise. `--all` also revokes
**every active board share link and clears every configured git-automation
webhook secret**, instance-wide — the two durable grants a leaked token or
compromised session can mint that no other lever reaches, so a full-compromise
sweep also breaks every public share link until an Admin re-shares. Every
token revocation is written to the token audit log tagged `operator_bulk_revoke`.
See [`revoke_api_tokens`](/administration/management-commands/#maintenance-commands).

Two routine paths already revoke personal tokens on their own and need no manual
step: a **password reset** and **deactivating or removing a member** each revoke
that account's personal tokens in the same transaction, and both are audited.
Both also revoke any board share link *that account personally minted* and clear
any git-automation webhook secret *they configured* — the project's other admins
keep their own. A public share link also stops serving as soon as its creator's
account is deactivated by any means (including outside the app, such as the
Django admin or a script), even before a password reset or off-boarding runs.
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
- **Default-deny ingress on the app tier itself** (`api`, `web`,
  `celery-worker`, `celery-beat`) — this one is *not* gated by
  `postgresql.enabled` / `valkey.enabled`, so it renders on the recommended
  production overlay (`values-prod.yaml`, managed datastores) as well as the
  bundled-subchart topology. `api` and `web` admit only the configured ingress
  controller (`networkPolicy.ingressControllerSelector`) plus each other where
  the chart's own topology needs it; `celery-worker` and `celery-beat` have no
  Service and admit nothing. Egress is unaffected — this control is
  ingress-only, same caveat as the datastore policy above. In-cluster monitoring
  (Prometheus or Blackbox scraping the api Service from another namespace) is
  dropped unless you name it in `networkPolicy.monitoringSelector`. The first
  upgrade that adds these policies refuses to render on the default controller
  selector until you confirm it; see [Upgrading to
  0.4](/getting-started/upgrade/#helm-the-api-and-web-pods-get-a-default-deny-ingress-networkpolicy).
- **Django admin denied at the edge** (`web.adminAccess.allowCIDRs: []`). The web
  tier's nginx answers `403` for `/admin/` from every source until you name one,
  and rate-limits the surface at 5 requests/minute per IP. See
  [Reaching Django admin](#reaching-django-admin).

### Reaching Django admin

Django admin is a plain Django view, which means **none of the API's login
defenses reach it by inheritance**. The
[login throttles](#login-rate-limiting-and-per-account-lockout) are applied by
Django REST Framework, which never sees a request to `/admin/login/`; the
`auth.login_failed` / `auth.login_succeeded` audit lines are emitted by TruePPM's
own login view; and the enforced-SSO policy hook that
[single sign-on](#single-sign-on-oidc--oauth2) hangs off is consulted there too.
There is also no account-lockout backend in the dependency set. Meanwhile the
[admin bootstrap](/administration/admin-password/) creates a superuser on first
deploy — so an unrestricted `/admin/` is a guessing surface against a
*known-present* privileged account.

**From 0.4 the admin is off unless you ask for it.** Every `/admin/` path answers
`404` — not `403`, so the path is not even advertised — unless the API is started
with:

```bash
TRUEPPM_DJANGO_ADMIN_ENABLED=true
```

This is an **application** control, not an edge one, so it holds on every
topology: Docker Compose, a bare single-server install, a Helm release with the
web tier disabled, and a `kubectl port-forward` straight at the API pod. The
`web.adminAccess` deny below is unchanged and still correct — it is the edge half
of the same posture — but it only governs traffic that traverses the web tier's
nginx, and Compose and bare deploys have no such tier.

:::caution[This changes behavior for existing installs]
If you are upgrading to 0.4 and you use Django admin, set
`TRUEPPM_DJANGO_ADMIN_ENABLED=true` before the rollout, or `/admin/` will `404`
after it. Nothing else in TruePPM depends on the admin: user and role management
live in [Workspace settings](/administration/workspace-settings/) and
[RBAC](/administration/rbac/), and password rotation is
[`changepassword`](/administration/admin-password/#rotate-the-password-after-first-run).
:::

**When you do turn it on, the door is hardened rather than bare.** The admin login
then carries the same controls as `POST /api/v1/auth/token/`:

- **The same two throttle buckets** — the per-IP `login` scope and the per-account
  `login_account` lockout, sharing one allowance with the API login rather than
  each door handing out its own. An attacker who spends the budget on one door
  finds the other already spent. A refused attempt answers `429` with
  `Retry-After`.
- **The same audit lines.** A failed admin login emits `auth.login_failed` with
  the hashed identifier and client IP; a successful one emits
  `auth.login_succeeded` with `method=admin`. Both land on the `trueppm.auth`
  logger, so one alerting rule covers both doors — see
  [Login rate limiting and per-account lockout](#login-rate-limiting-and-per-account-lockout).
- **The same enforced-SSO seam.** An account an enterprise policy has blocked from
  password sign-in is refused here too, with the session torn down again rather
  than merely a `403` body over a live cookie.

**The recommended access path needs no chart change and no exposure at all.**
Port-forward straight to the API Service, bypassing the web tier (the API must
have been started with `TRUEPPM_DJANGO_ADMIN_ENABLED=true` for this to answer):

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
**straight to the API Service**, with no allowlist and no nginx rate limit — the
same exposure this setting exists to prevent.

If you run `web.enabled: false` with a public Ingress, you must restrict
`/admin/` at your own edge (ingress-controller annotation, WAF, or CDN rule).
The same applies if you change `service.type` away from `ClusterIP`, or add an
`ingress.hosts[].paths[]` entry that targets `service: api` — any path that
reaches the API Service directly bypasses the nginx control.

From 0.4 this is a narrower hole than it was, because the API no longer serves
the admin at all unless `TRUEPPM_DJANGO_ADMIN_ENABLED=true` — a bypassed edge
reaches a `404`. It is not a substitute for the edge rule: the moment you enable
the admin for legitimate use, the bypass is live again, now against a login that
is throttled and audited but still reachable from the internet.
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

The app-tier default-deny ingress policies (`api`/`web`/`celery-worker`/
`celery-beat`, described above) are covered by `helm:template` only —
render-and-assert, not a live CNI-enforcement drill like `helm:netpol` runs for
the datastores. Enforcement still depends on your cluster's CNI the same way;
nothing chart-side proves it beyond the render.

#### What the policy does NOT cover

The chart restricts the **bundled datastore** pods only. It deliberately does not
restrict ingress to, or egress from, the API and Celery worker pods: their
outbound endpoints (your identity provider, SMTP relay, object store, OTLP
collector) are deployment-specific, so a chart-imposed allow-list would break real
installs.

Two gaps are therefore yours to close at the platform layer:

- **API pod ingress.** `settings.prod` trusts `X-Forwarded-Proto` unconditionally,
  so anything that can open a socket to the API pod on `:8000` can claim its
  request arrived over HTTPS. Restrict that port to the ingress controller / edge.
  The **host** is not taken from a header at all — `USE_X_FORWARDED_HOST` is
  pinned `False`, so `X-Forwarded-Host` is ignored and your edge must preserve the
  original `Host`. That keeps the host bounded by `ALLOWED_HOSTS` rather than by
  this network rule; see
  [The scheme comes from the proxy; the host does not](/administration/networking/#tls).
- **API and worker egress.** Restrict it to the destinations you actually use.

[Ports and firewall](/administration/networking/#ports-and-firewall) is the full
source → destination → port matrix to build both allow-lists from, including every
optional egress need (SMTP, OIDC, S3/MinIO, OTLP, image registry, ACME, outbound
webhooks).

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

### Interactive demo mode

`demo.interactive` publishes a real login and lets a visitor tour the whole app,
read-only. It is a different shape from the plain [share-link demo](/administration/helm-values/#public-read-only-demo-mode)
(`demo.enabled`), which publishes no login at all — see
[ADR-1197](https://gitlab.com/trueppm/trueppm-suite/-/blob/main/docs/adr/1197-interactive-demo-read-only-is-a-deployment-mode-not-a-role.md)
for the full design. Four layers combine to make it safe to expose:

1. **The write fence is server-side and role-independent.** `DemoReadOnlyMiddleware`
   refuses every unsafe HTTP method under `/api/` except sign-in, token refresh
   and sign-out — regardless of the visitor's role. This is the guarantee; the
   remaining three layers are defense in depth over it.
2. **A method fence at the edge.** The web tier's nginx renders a third server
   block for this mode: `limit_except GET HEAD OPTIONS` over `/api/`, with the
   same three sign-in paths exact-matched around it. `/admin/` and `/ws/` still
   return `404`. A request refused here never reaches Django.
3. **Egress-deny on the api and celery-worker pods.** This mode needs no outbound
   access at all — no IdP, no SMTP, no object storage, no OTLP — so the chart
   restricts their egress to DNS and the bundled PostgreSQL/Valkey pods only, the
   one exception to the "API and worker egress stays open" rule described in
   [Ports and firewall](/administration/networking/#ports-and-firewall). It also
   covers the *outbound effects* of comments and webhooks, not only the obvious
   integration path.
4. **Per-account throttles re-aimed for a shared, published credential.** Every
   visitor authenticates as the same account, so a throttle keyed on the account
   rather than the caller's IP bounds the whole crowd together. The login-lockout
   scope described in [Login rate limiting](#login-rate-limiting-and-per-account-lockout)
   is raised in this mode from its ordinary credential-stuffing posture to one
   sized for concurrent visitors — the per-IP `login` and `anon` scopes stay the
   real limiters **for the sign-in request itself only**. They do not bound a
   signed-in visitor's ordinary reads: DRF's stock anonymous throttle skips
   authenticated requests, so once a visitor is signed in, the shared `"user"`
   scope (`demo.throttle.userRate`) is the *only* throttle on their traffic, with
   no independent per-IP ceiling. It is set high enough to be effectively
   lifted — a bucket shared by every visitor fails all of them at once when it
   trips, so it cannot protect any one of them. This is a shared-fate
   resource-consumption tradeoff, not a per-visitor fairness guarantee: the real
   bounds are the api pod's capacity and whatever edge sits in front of the host
   (see the Cloudflare Access caveat below). The demo's login page tells
   visitors the limits are lifted for the demo account only. See the `demo.throttle.*` keys
   in [Helm values](/administration/helm-values/#public-read-only-demo-mode).

None of that makes the following true, and the design is deliberately **not**
built assuming they are:

- **A hostname gate in front of the demo (Cloudflare Access or similar) is bot
  reduction and an email list, not a security control.** It is passed by anyone
  with any working email address and mitigates none of the threat model's
  findings. Run one if you want fewer automated signups; do not treat it as a
  reason to skip the layers above.
- **The scheduled reset (`demo.reset`) bounds contamination — it prevents
  nothing.** It caps how long a successful write or a piece of vandalism stays
  visible at one reset interval. It is not a control and must not be cited as
  mitigating any finding above; with the write fence armed there is normally
  nothing for it to clean up in the first place.
- **Host isolation from your CI runners is a precondition this chart cannot
  verify.** Give the interactive demo its own host, separate from anything a CI
  job can reach — no chart flag, render-time guard, or CI job can check this for
  you, because it depends on infrastructure outside the release. Treat it as a
  deployment requirement with a human owner, the same way you would treat "do
  not point this at your production database."

No writable media path is rendered for the api pod in this mode either way — see
`persistence.media` in [Helm values](/administration/helm-values/#attachment-storage-persistencemedia).
The bundled Atlas sample's task attachments are external-link references, not
uploaded files, so nothing is lost by that restriction.

## RBAC enforcement

All API endpoints enforce role-based access control. See the [RBAC documentation](/administration/rbac/) for the full permission matrix.

Key security properties:
- **No global admin role** — permissions are scoped to individual projects
- **Role escalation prevention** — you can only assign roles below your own
- **IDOR prevention** — querysets are scoped to the user's project memberships; non-members see empty results, not 403 errors
- **Last-Owner guard** — prevents accidental removal of all project owners

## Supply-chain verification

Every artifact TruePPM publishes — the `api` and `web` images, the Helm chart,
and the `trueppm-scheduler` / `trueppm-mcp` / `trueppm-api` PyPI packages — is
signed in the release pipeline before it is published. This has been live
since the 0.4 beta (GHCR publishing, #939) for the images, chart, and the
`trueppm-scheduler` / `trueppm-mcp` packages. `trueppm-api`'s CI job was
migrated onto the same Trusted Publishing + attestation flow in #3943, but the
release-tag job that runs it is unproven until the next `v*` tag — every
`trueppm-api` wheel/sdist on PyPI through `0.4.0-beta.3` was published with a
static upload token and carries no attestation; only versions published
**after** #3943's tag are covered by the claims below. Scanning and SBOM
inventory are narrower: see [Vulnerability scanning](#vulnerability-scanning)
and [SBOM](#sbom-software-bill-of-materials) below for exactly what each
covers — `trueppm-api`'s PyPI package is signed but does not carry a
CycloneDX SBOM.

### Vulnerability scanning

[Trivy](https://trivy.dev) scans the `api` and `web` images and **fails the
release** on any fixable HIGH/CRITICAL CVE. Base-image CVEs with no available
patch (`--ignore-unfixed`) do not block, since they are not actionable by the
operator.

### Signing

Every image, the Helm chart, and all three PyPI packages are signed
**keyless** — Sigstore, via GitLab's own ambient OIDC identity, no key
material to manage or leak. Verify what you pull actually came from this
pipeline:

```bash
# Docker images (api, web)
cosign verify \
  --certificate-identity-regexp 'https://gitlab\.com/trueppm/trueppm' \
  --certificate-oidc-issuer https://gitlab.com \
  ghcr.io/trueppm/api:<version>

# Helm chart
cosign verify \
  --certificate-identity-regexp 'https://gitlab\.com/trueppm/trueppm' \
  --certificate-oidc-issuer https://gitlab.com \
  ghcr.io/trueppm/charts/trueppm@<digest>
```

The `trueppm-scheduler`, `trueppm-mcp`, and `trueppm-api` wheels and sdists
carry [PEP 740](https://peps.python.org/pep-0740/) provenance attestations
instead — visible under "View details" on each release's PyPI page — rather
than a Cosign signature, since they publish through PyPI's own Trusted
Publishing attestation flow.

### SBOM (Software Bill of Materials)

Every published artifact carries a CycloneDX SBOM **except the `trueppm-api`
PyPI package**, which is signed (see above) but does not yet generate one:

| Artifact | Generated by | Where to find it |
|---|---|---|
| `api` / `web` images | [Syft](https://github.com/anchore/syft), against the exact published image | Attached as a Cosign attestation on the image digest (`cosign verify-attestation --type cyclonedx ...`, same identity flags as above) — no GitLab access needed — and as a non-expiring `api-sbom-<tag>` / `web-sbom-<tag>` CI job artifact |
| Helm chart | Generated from the chart's own dependency graph (`helm dependency list` — the bundled `postgresql`/`valkey` subcharts and their versions; it does not describe the container images those subcharts reference) | Attached as a Cosign attestation on the chart digest, and as a non-expiring `helm-sbom-<tag>` CI job artifact |
| `trueppm-scheduler` / `trueppm-mcp` | [cyclonedx-py](https://github.com/CycloneDX/cyclonedx-python), against the locked `uv.lock` runtime closure | Attached to the package's [GitLab Release](https://gitlab.com/trueppm/trueppm/-/releases) (`scheduler-v<version>` / `mcp-v<version>`) as a **CycloneDX SBOM** asset link, served from the Generic Package Registry at a stable, versioned URL: `https://gitlab.com/api/v4/projects/trueppm%2Ftrueppm/packages/generic/trueppm-scheduler-sbom/<version>/sbom.cdx.json` (and `trueppm-mcp-sbom`), where `<version>` is the PyPI version — `0.4.0b1`, not the tag. Still retained as a non-expiring CI job artifact (`packages/scheduler/dist/sbom.cdx.json`, `packages/mcp/dist/sbom.cdx.json`) as a second copy. It is not attached to the PyPI upload itself, which carries [PEP 740](https://peps.python.org/pep-0740/) attestations rather than an SBOM. The automation attaches this Release asset starting with the first package tag cut after `0.4.0-beta.1`; `scheduler-v0.4.0b1` and `mcp-v0.4.0b1` were cut before that automation existed and were backfilled manually onto their Release pages — for any version published before `0.4.0b1`, use the tag pipeline's artifact |

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
