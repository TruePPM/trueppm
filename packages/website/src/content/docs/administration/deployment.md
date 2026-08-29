---
title: Deployment
description: Deploy TruePPM with Docker Compose, the Kubernetes Helm chart, or a single server managed by systemd — plus how to verify image and chart signatures.
documentedFor: "0.4"
---

:::caution[Pre-GA]
TruePPM 0.3 has shipped (as the `0.3.0-alpha.1` pre-release) and is suitable for evaluation and early-adopter deployments; the release line stays alpha through 0.3, and 0.4 is planned as the first beta. 0.4 arrives as a beta directly — the next tag on the line is `0.4.0-beta.1`, with no alpha step in between ([how the 0.4 line is numbered](/overview/roadmap/#how-the-04-line-is-numbered)). Expect API contract changes across 0.x point releases; a stable contract arrives at 1.0.
:::

:::tip[Before a production install, read Networking]
[Networking](/administration/networking/) covers the prerequisites this page
assumes: the DNS records to create, the four variables that must all name the
same origin, where TLS terminates in each topology, what a proxy has to forward
for WebSockets, which health-check path an external load balancer should use, and
the full ports/firewall matrix.
:::

## Docker Compose (recommended for evaluation)

The fastest way to get TruePPM running. A single command starts all six services.

```bash
git clone git@gitlab.com:trueppm/trueppm.git
cd trueppm
docker compose up -d
```

| Service | Port | Purpose |
|---------|------|---------|
| `db` | 5432 | PostgreSQL 16 |
| `valkey` | 6379 | Celery broker + Django Channels layer ([Valkey](https://valkey.io) — BSD-licensed Redis fork, wire-compatible) |
| `api` | 8000 | Django ASGI (uvicorn) |
| `celery` | — | CPM auto-scheduling worker |
| `celery-beat` | — | Periodic task runner (Beat) |
| `web` | 5173 | React frontend (Vite dev server) |

Migrations and the `create_admin` bootstrap run automatically when the `api` container starts. Retrieve the generated admin password as described in [Admin password setup](/administration/admin-password/):

```bash
docker compose exec api cat /tmp/trueppm_admin_password
```

**Good for:** local development, evaluation, small teams, demos.

### Public read-only demo (`docker-compose.demo.yml`)

`docker-compose.demo.yml` is a **separate, hardened** stack for a public hosted
demo (the mechanism behind `try.trueppm.com`, which goes live at the 0.4 tag) —
not the dev stack above. It seeds the sample **without** persona logins, so the
instance has **zero user accounts and no authenticated write path**; the only way
in is the product's own anonymous, tokenized, read-only
[schedule share link](/administration/sharing-and-access/).

That no-accounts invariant is what makes the stack's baked demo `SECRET_KEY` safe,
so the demo's reverse proxy (`nginx/demo.conf.template`) treats the API surface as
an **explicit allowlist**, not a blanket proxy. Only these routes reach the API
container from the public internet:

| Public route | Why it is open |
|---|---|
| `GET /api/v1/share/{schedule,board}/<token>/` | The anonymous, read-only, throttled share-link projections — the demo's only data plane. |
| `GET /api/v1/health/` | Liveness probe for an upstream load balancer / ingress. |
| `/static/` | Django-collected static assets (admin CSS, etc.). |
| `/admin/` | Django admin — additionally restricted to loopback; reach it via an SSH tunnel. |

Every **other** `/api/` route — `auth/token` and the rest of the auth surface,
every project viewset, the Admin-only share-link *management* endpoints, workspace
SSO, and the OpenAPI schema/docs — returns **404**, as does the live-collaboration
WebSocket (`/ws/`), which the read-only share pages never open. The authenticated
API is simply *not there* from the public internet.

This posture is a deliberate decision, not an accident of configuration: a CI gate
(`scripts/check-demo-nginx-allowlist.sh`) fails the pipeline if the demo template
ever regresses to proxying anything beyond this allowlist. Production
(`nginx/app-http.conf.template`) intentionally proxies **all** of `/api/` — correct
there, because production is authenticated and has real accounts.

## Kubernetes with Helm

The Helm chart in `packages/helm/` deploys TruePPM on any Kubernetes cluster
(kind, k3s, EKS, GKE, AKS, or bare-metal) with bundled sub-charts for
PostgreSQL and Valkey (the BSD-licensed Linux Foundation fork of Redis;
wire-compatible). The bundled datastores are intended for dev / demo / CI; for
production, disable them and point at managed services (see below).

```bash
helm lint packages/helm
helm install trueppm packages/helm -f packages/helm/values-dev.yaml
```

Separate `values-dev.yaml` and `values-prod.yaml` overlays are provided. The
chart [README](https://gitlab.com/trueppm/trueppm/-/blob/main/packages/helm/README.md)
is the full value reference.

**Good for:** production deployment, horizontal scaling, enterprise environments.

For preliminary hardware sizing guidance at 50 / 100 / 200 users, see [Deployment Sizing](/administration/sizing/).

### Production install walkthrough

Prerequisites: Helm 3.14+, `kubectl` compatible with your cluster, and a
running Kubernetes cluster 1.27+.

**Get the chart.** Through 0.3 (alpha), install from the chart source in the
repository:

```bash
git clone https://gitlab.com/trueppm/trueppm.git
cd trueppm
helm dependency update packages/helm
```

The 0.4 beta will publish the chart to a public OCI registry
(`oci://ghcr.io/trueppm/charts`) as an additional path — the clone-based
install above keeps working after 0.4 too. Once that lands, the same install
will work straight from GHCR, no clone needed:
`helm install trueppm oci://ghcr.io/trueppm/charts/trueppm --version <version>`.

**Prepare your values file.** Download the production values template and
fill in your settings:

```bash
curl -sL https://gitlab.com/trueppm/trueppm/-/raw/main/packages/helm/values-prod.yaml \
  -o my-values.yaml
```

**Create the application Secret.** TruePPM validates four values at startup and
**refuses to boot** without them — the pod crash-loops in the `migrate` init
container before the API ever runs, so this is not an optional hardening step:

| Key | What it is |
|-----|-----------|
| `SECRET_KEY` | Django signing key, 32 characters minimum |
| `ALLOWED_HOSTS` | Comma-separated hostnames the app will answer on — see the callout below, it must cover more than your public name |
| `INTEGRATION_ENCRYPTION_KEY` | Fernet key that encrypts integration credentials at rest |
| `TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE` **or** `TRUEPPM_DEFAULT_FILE_STORAGE` + `TRUEPPM_S3_BUCKET_NAME` | Where task attachments are stored |

```bash
kubectl create secret generic trueppm-env --namespace trueppm \
  --from-literal=SECRET_KEY="$(openssl rand -base64 48)" \
  --from-literal=ALLOWED_HOSTS=trueppm.example.com,trueppm-api \
  --from-literal=INTEGRATION_ENCRYPTION_KEY="$(python3 -c \
    'import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode())')" \
  --from-literal=TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true
```

:::caution[`ALLOWED_HOSTS` must cover every name a request arrives under]
Django validates the `Host` header inside `get_host()` — before any view runs —
and answers **400 DisallowedHost** on a miss. Nothing in that response names
`ALLOWED_HOSTS`, so it reads like a routing or ingress fault.

Two internal callers reach the API under a name that is *not* your public
hostname:

- **The `helm test` connection probe** curls the API Service by its DNS name
  (`<release>-trueppm-api`), so that name belongs in the list.
- **kubelet's liveness and readiness probes** connect by pod IP. The chart
  handles this for you — it sets an explicit `Host` header on both probes,
  resolved from `ingress.hosts[0].host` (override with
  `probes.api.hostHeader`). Keep that value in `ALLOWED_HOSTS`: if the two
  disagree, `/readyz` returns 400, the pod never becomes Ready, the Service
  gets no endpoints, and the Ingress serves 503.

If you deploy without an Ingress — a `LoadBalancer` Service, or a service mesh —
set `probes.api.hostHeader` explicitly and add the same value here.
:::

`TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true` puts task attachments on the pod's
ephemeral disk, where they are **lost on restart**. It is the right choice for a
first install you are evaluating, and the wrong one for anything you intend to
keep — swap it for the S3 pair when you are ready (see
[object storage](/administration/configuration/#object-storage-s3--minio)).

At minimum, your values file then needs:

```yaml
# my-values.yaml
# Point the chart at the Secret created above. This reaches the API, the Celery
# worker, AND the migrate/bootstrap init containers — all of which import the
# same settings module and so hit the same startup checks.
envFrom:
  - secretRef:
      name: trueppm-env

# Recommended for production: disable the bundled datastores and point at managed
# services. When they are disabled, env.DATABASE_URL and env.REDIS_URL are
# REQUIRED — the chart fails the render with a clear message if either is missing.
postgresql:
  enabled: false
valkey:
  enabled: false
# env:
#   # sslmode=require is REQUIRED on an external database — TruePPM refuses to
#   # boot on a connection string that does not ask for TLS. If TLS is already
#   # enforced at the network layer (service mesh, private encrypted link), set
#   # env.TRUEPPM_ALLOW_UNENCRYPTED_DB: "true" to downgrade that check to a warning.
#   DATABASE_URL: "postgres://trueppm:<password>@<host>:5432/trueppm?sslmode=require"
#   REDIS_URL: "redis://:<password>@<host>:6379"
```

With the bundled datastores **enabled** (dev / demo) instead, leave
`postgresql.auth.password` and `valkey.auth.password` empty — see
[Secure by default](#secure-by-default) below for what the chart generates on
its own. The chart also satisfies the database-TLS check for you on that path, so
the bundled install needs no `DATABASE_URL` of its own.

**Install:**

```bash
helm install trueppm packages/helm \
  --namespace trueppm \
  --create-namespace \
  -f my-values.yaml
```

If anything required is still missing, the install's own output says so: the
chart's post-install notes name the exact keys the app will refuse to start
without, and `helm upgrade --reuse-values` fixes it without a reinstall.

Keep secrets in the Kubernetes Secret rather than in `my-values.yaml` or `--set`:
values files get committed and `--set` lands in shell history. `DATABASE_URL` and
`REDIS_URL` for a managed datastore belong in the same Secret for the same reason
— add them as extra `--from-literal` keys instead of the commented `env:` block
above.

:::note[Bring your own Ingress]
The chart's `Ingress` template is off by default — it exposes the API as a
ClusterIP Service. Enable it (see [Ingress and edge TLS](#ingress-and-edge-tls)
below) or put your own Ingress controller / LoadBalancer in front of the
`<release>-api` Service to terminate TLS and route external traffic.
:::

**Post-install.** Migrations run automatically in an init container. Retrieve
the generated admin password from the pod:

```bash
kubectl exec -n trueppm deployment/trueppm-api -- \
  cat /run/trueppm/admin_password
```

When using the bundled PostgreSQL, retrieve the generated database password
from the chart-owned connection Secret:

```bash
kubectl get secret trueppm-trueppm-connection -n trueppm \
  -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d
```

**Verify:**

```bash
kubectl get pods -n trueppm
# All pods should be Running / Completed
```

### Verifying image and chart signatures

Starting with the 0.4 beta, every published image and chart will be signed
with [Cosign](https://docs.sigstore.dev/) keyless (Sigstore) in CI, Trivy-scanned,
and CycloneDX SBOM-attested — so once GHCR publishing lands you will be able to
confirm an artifact was built by the TruePPM release pipeline before you run
it. Verify against the GitLab CI OIDC issuer and the release-tag identity:

```bash
# API and web images (repeat for web)
cosign verify \
  --certificate-identity-regexp '^https://gitlab.com/trueppm/trueppm//.gitlab-ci.yml@refs/tags/v.*$' \
  --certificate-oidc-issuer https://gitlab.com \
  ghcr.io/trueppm/api:<version>

# CycloneDX SBOM attestation
cosign verify-attestation --type cyclonedx \
  --certificate-identity-regexp '^https://gitlab.com/trueppm/trueppm//.gitlab-ci.yml@refs/tags/v.*$' \
  --certificate-oidc-issuer https://gitlab.com \
  ghcr.io/trueppm/api:<version>

# Helm OCI chart
cosign verify \
  --certificate-identity-regexp '^https://gitlab.com/trueppm/trueppm//.gitlab-ci.yml@refs/tags/v.*$' \
  --certificate-oidc-issuer https://gitlab.com \
  ghcr.io/trueppm/charts/trueppm:<version>
```

A verified signature proves the image came from a TruePPM release tag; the
attestation lets you pull the exact CycloneDX SBOM for that digest.

### Secure by default

A default install needs no extra security flags. The chart:

- **Generates** the PostgreSQL and Valkey passwords on first install and stores
  them in a chart-owned **connection Secret** (`<release>-trueppm-connection`,
  annotated `helm.sh/resource-policy: keep`). Re-renders read the existing
  password back rather than churning it, and the Secret survives `helm uninstall`
  so a reinstall does not orphan the database PVC.
- **Injects** `DATABASE_URL` / `REDIS_URL` via `secretKeyRef` — they are never
  rendered into a Deployment manifest in plaintext.
- Enables **cache authentication** by default (`valkey.auth.enabled: true`).
- Runs the API, Celery worker, Celery beat, and web pods with a **restricted
  security context** (`readOnlyRootFilesystem`, dropped capabilities,
  `RuntimeDefault` seccomp, `runAsNonRoot`) and `automountServiceAccountToken:
  false`, with default resource requests/limits.
- Enables a **default-on NetworkPolicy** (`networkPolicy.enabled: true`) that
  limits datastore ingress to the API and worker pods and applies default-deny
  egress to the bundled datastore pods. This **requires a NetworkPolicy-enforcing
  CNI** (Calico, Cilium, Antrea, Weave, …); on a cluster whose CNI does not enforce
  policy the objects are accepted but silently unenforced.

Retrieve the generated database password:

```bash
kubectl get secret <release>-trueppm-connection \
  -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d
```

See [Security](/administration/security/#helm-secure-by-default) for the full
operator reference.

### Ingress and edge TLS

The chart ships a chart-managed `Ingress` template, **off by default** because the
correct ingress class, hostnames, and certificate source are cluster-specific.
Enable it and supply your host(s) and a TLS Secret to expose TruePPM over HTTPS at
the edge. Each host's paths route by their `service:` key: `/api` and `/ws` go to
the Django API `Service`, and `/` goes to the nginx **web** `Service` (the compiled
React SPA). Both `Service`s stay `ClusterIP`; the `Ingress` is the sole
externally-facing object and the TLS termination point. When the web tier is
disabled (`web.enabled=false`), a `service: web` path falls back to the API.

The default `ingress.hosts` already encodes the `/api`, `/ws` → API and `/` → web
split, so a typical install only overrides the host, class, and TLS Secret:

```bash
helm install trueppm packages/helm \
  -f packages/helm/values-prod.yaml \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.hosts[0].host=trueppm.example.com \
  --set ingress.hosts[0].paths[0].path=/api \
  --set ingress.hosts[0].paths[0].service=api \
  --set ingress.hosts[0].paths[1].path=/ws \
  --set ingress.hosts[0].paths[1].service=api \
  --set ingress.hosts[0].paths[2].path=/ \
  --set ingress.hosts[0].paths[2].service=web \
  --set ingress.tls[0].secretName=trueppm-tls \
  --set ingress.tls[0].hosts[0]=trueppm.example.com
```

For anything beyond a single host it is far cleaner to set `ingress.hosts` in a
values file than to enumerate paths on the command line.

With cert-manager, add the issuer under `ingress.annotations`
(`cert-manager.io/cluster-issuer: <issuer>`) and cert-manager provisions the
named TLS Secret automatically — [Networking](/administration/networking/#cert-manager)
has a complete `ClusterIssuer` for both HTTP-01 and DNS-01, the paired
annotations, and a `kubectl create secret tls` path for a certificate you already
hold. Add the WebSocket timeout annotations from
[WebSockets behind a proxy](/administration/networking/#idle-timeouts) at the same
time. Leaving `ingress.tls` empty renders an HTTP-only
Ingress — acceptable only for a dev/demo cluster, never production. `settings.prod`
already trusts `X-Forwarded-Proto` (`SECURE_PROXY_SSL_HEADER`), so the app sets
secure cookies and HSTS correctly behind edge TLS; the `/api/v1/health/` and
`/api/v1/edition/` probe paths stay exempt from the optional HTTP→HTTPS redirect.

### Bundled datastores are dev/demo only

The bundled PostgreSQL and Valkey pods speak **plaintext** on the pod network — the
chart-built `DATABASE_URL` carries no `sslmode`. This is safe **only** because the
default-on NetworkPolicy isolates those pods so that just the API and worker can
reach them. To keep that posture coherent, the chart automatically sets
`TRUEPPM_ALLOW_UNENCRYPTED_DB=true` **only** when the bundled database is in use
**and** the NetworkPolicy is enabled — so a default `helm install` boots without
crash-looping the app's DB-encryption guard, and without any operator ever being
told to "disable the security check."

For production, use managed datastores with TLS instead (below). When
`postgresql.enabled=false`, the chart injects **no** auto flag, so your
`env.DATABASE_URL` **must** include `sslmode=require` — the app refuses to boot on
a plaintext external database.

### Managed (external) datastores

For production, disable the bundled subcharts and point at managed services.
When `postgresql.enabled` / `valkey.enabled` are `false`, `env.DATABASE_URL` and
`env.REDIS_URL` become **required** — the chart fails the render with a clear
message if either is missing. (Setting either one while the matching bundled
datastore is still enabled also fails the render: the chart-built URL always
wins, so your value would be silently ignored.) Managed Redis services (AWS
ElastiCache, GCP Memorystore, Azure Cache, etc.) work via the `redis://` scheme.

**Prefer a Secret you manage.** Referencing one keeps the credential out of Helm
altogether — out of your values file, your shell history, and the Helm release
Secret. The chart wires every consumer (API, worker, beat, the `migrate` and
`bootstrap` init containers, the backup CronJob) straight at your Secret:

```bash
kubectl create secret generic trueppm-db \
  --from-literal=url='postgres://user:pass@your-db:5432/trueppm?sslmode=require'
kubectl create secret generic trueppm-cache \
  --from-literal=url='redis://:pass@your-cache:6379'
```

```yaml
# values-my-prod.yaml
env:
  DATABASE_URL:
    secretKeyRef:
      name: trueppm-db
      key: url
  REDIS_URL:
    secretKeyRef:
      name: trueppm-cache
      key: url
```

```bash
helm install trueppm packages/helm \
  -f packages/helm/values-prod.yaml -f values-my-prod.yaml
```

A plain URL string also works. The chart stores it in the chart-owned connection
Secret and injects it from there, so it never reaches a Deployment manifest — but
it passed through Helm, so it persists wherever it was held (the values file,
`--set` in shell history, the Helm release Secret):

```bash
helm install trueppm packages/helm \
  -f packages/helm/values-prod.yaml \
  --set env.DATABASE_URL="postgres://user:pass@your-db:5432/trueppm?sslmode=require" \
  --set env.REDIS_URL="redis://:pass@your-cache:6379"
```

The `sslmode=require` parameter is **mandatory** on an external `DATABASE_URL`:
`settings.prod` refuses to boot without it (database connections would otherwise
fall back to whatever the server negotiates, which may be plaintext). If — and only
if — TLS is already enforced between the app and database at the network layer
(a service-mesh sidecar or a private encrypted link), set
`env.TRUEPPM_ALLOW_UNENCRYPTED_DB=true` to acknowledge that and downgrade the guard
to a warning.

Prefer injecting `DATABASE_URL` / `REDIS_URL` via an external Secret rather than
`--set` so they don't land in shell history. `SECRET_KEY` and `ALLOWED_HOSTS`
must always be supplied via a Kubernetes Secret referenced through `env`.

### Workload tiers, probes, and disruption budgets

The chart renders four workload tiers: the **API**, the **Celery worker**, a
single-replica **Celery beat** scheduler, and the **web** SPA (nginx). Beat runs
exactly one replica with a `Recreate` strategy — it is the one process that fires
the periodic drains, so two overlapping beats would double-dispatch every job.

Health probes ship on every tier and are value-tunable under `probes.*`:

- The **API** readiness probe points at the deep `/api/v1/readyz` check (it also
  verifies the database and cache are reachable), so a pod only joins the `Service`
  once it can actually serve; liveness stays on the shallow `/api/v1/health/` so a
  transient dependency blip cannot restart-loop the pod.
- The **worker** and **beat** use a `celery inspect ping` exec probe — a
  control-plane round-trip that catches a wedged event loop a bare process-alive
  check would miss.

For multi-replica production the chart also ships an optional
`PodDisruptionBudget` (`podDisruptionBudget.enabled=true`, api + worker) and an
optional `HorizontalPodAutoscaler` (`autoscaling.enabled=true`, api by default,
worker optional). Both are **off by default**: the PDB is only meaningful at
`replicaCount >= 2`, and the HPA needs `metrics-server` installed. These, along
with the beat and web tiers, the probe hardening, the `DJANGO_LOG_LEVEL` and OTLP
trace-sampler knobs, and the starter Grafana dashboard / Prometheus alerts, **ship
in 0.4** (the first beta).

### Verifying a deploy

After `helm install` (or `helm upgrade`), confirm the release actually booted end
to end — that the `migrate` → `bootstrap` init sequence completed, the supplied
secrets satisfied the `settings.prod` boot guards, and the API is serving:

```bash
helm test trueppm
```

This runs a bundled connection probe (a short-lived Pod, created only by
`helm test` and never during a normal install) that reaches the API's
`/api/v1/health/` and migration-aware `/api/v1/readyz` endpoints and fails if
either is unreachable within the rollout window. (For an *external* load
balancer's own health check, point it at `/api/v1/readyz` — note the missing
trailing slash — and set the `Host` header; see
[Health checks](/administration/networking/#health-checks-for-an-external-load-balancer).) A green `helm test` is the
single strongest signal that the whole boot chain succeeded. Retrieve the
generated admin password with `kubectl exec` against the shared password volume
as described in [Admin password setup](/administration/admin-password/).

The same install-and-`helm test` drill runs in CI (`helm:install`, on any chart
change plus a nightly schedule), alongside a static gate (`helm:template`) that
renders the chart, validates every object against the Kubernetes schema with
`kubeconform`, and asserts the deploy contract (init-container order, secret
propagation to the init containers, the shared admin-password volume). Together
they catch a chart regression before it reaches a cluster.

:::note
The Helm chart is functional with dev and prod values overlays and was hardened
for secure-by-default installs; further updates landed in 0.2 (available since the `0.2.0-alpha.1` pre-release).
Large-scale production hardening (HA Postgres, dedicated Valkey) remains on the
pre-1.0 roadmap.
:::

## Single server with systemd

For production on a single Linux server without Kubernetes. Uses the pre-built
release images with Docker Compose, managed by systemd so the stack restarts
with the machine.

**Prerequisites:**

- A Linux server (Ubuntu 22.04+ or Debian 12+)
- Docker 24+ and Docker Compose plugin
- A domain name with an `A` (and optionally `AAAA`) record pointing at the
  server's public IP, resolving **before** you run `init-prod.sh` — ACME HTTP-01
  validation needs it. See [DNS](/administration/networking/#dns).
- Inbound ports 80 and 443 open, plus the outbound rules in
  [Ports and firewall](/administration/networking/#ports-and-firewall)

**Steps:**

```bash
git clone https://gitlab.com/trueppm/trueppm.git
cd trueppm
cp .env.example .env
```

Edit `.env` and fill in all required values:

```bash
# Required minimums — see .env.example for full list
DOMAIN=trueppm.example.com
TLS_MODE=letsencrypt
CERTBOT_EMAIL=ops@example.com
SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))")
DB_PASSWORD=$(python3 -c "import secrets; print(secrets.token_urlsafe(24))")
REDIS_PASSWORD=$(python3 -c "import secrets; print(secrets.token_urlsafe(24))")

# Encrypts stored integration credentials at rest. The API refuses to start
# without it, so this is required even if you never connect an integration.
INTEGRATION_ENCRYPTION_KEY=$(python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")

# Attachment storage — the API refuses to start until you choose one.
# (a) Recommended: object storage, which survives container replacement.
TRUEPPM_DEFAULT_FILE_STORAGE=storages.backends.s3.S3Storage
TRUEPPM_S3_BUCKET_NAME=trueppm-attachments
# (b) Local disk instead — see the warning below before choosing this.
# TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true

APP_VERSION=0.2.0
```

:::caution[Three values the API refuses to start without]
`SECRET_KEY`, `INTEGRATION_ENCRYPTION_KEY`, and an attachment-storage choice are
each enforced at import time, not on first use. Omitting any one of them
crash-loops the `api` container with a `Refusing to start:` message naming the
missing value — check `docker compose -f docker-compose.prod.yml logs api` if the
stack does not come up.

On the local-disk option: this stack runs the `api` container with a read-only
root filesystem and mounts no attachments volume, so
`TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true` lets the container boot but leaves
uploads failing at write time. Choose it only if you have added a persistent,
writable volume for attachments yourself. See
[Configuration](/administration/configuration/) for the full S3 variable list,
including non-AWS endpoints such as MinIO or Ceph.
:::

You do not need to set `sslmode` on a database URL here. The stack composes its
own `DATABASE_URL` for the bundled PostgreSQL and sets
`TRUEPPM_ALLOW_UNENCRYPTED_DB=true` alongside it, because that container
publishes no host port and is reachable only over the private Compose bridge
network. If you repoint the stack at an external database, remove that flag from
the compose file and put `?sslmode=require` on your own URL — the guard is what
keeps a database hop across the network from falling back to plaintext.

Run the one-time setup (obtains a TLS certificate and starts the stack):

```bash
chmod +x init-prod.sh
./init-prod.sh
```

Retrieve the admin password:

```bash
docker compose -f docker-compose.prod.yml exec api \
  cat /run/trueppm/admin_password
```

This exact path is drilled in CI. On any change to `docker-compose.prod.yml`,
`init-prod.sh`, `.env.example`, or the nginx templates — plus a nightly schedule
— a `compose:prod` job fills `.env.example` with generated values, runs
`init-prod.sh` against images built from that commit, and fails the pipeline
unless the API clears all three start-up guards, `/api/v1/readyz` reports ready
through nginx, `/api/v1/health/beat/` returns 200 (which proves the scheduler is
genuinely dispatching, not merely declared), and the stack survives restarting
the API container. It is the Compose counterpart to the `helm:install` drill
described under [Kubernetes with Helm](#kubernetes-with-helm).

A sibling `compose:prod:tls` job boots the same stack a second time with
`TLS_MODE=selfsigned`, which is what puts the HTTPS nginx template — a different
file from the plain-HTTP one, and previously started by nothing but a human on
release day — under a real boot. On top of the checks above it asserts that HTTPS
serves the app on 443, that port 80 redirects to it, that HSTS is set, and that
`/.well-known/acme-challenge/` is served from the webroot over plain HTTP rather
than swallowed by the redirect. That last one is the contract `certbot renew
-a webroot` depends on: break it and your certificate still issues, then quietly
fails to renew about 60 days later.

What CI still cannot cover is the ACME exchange itself — the first `--standalone`
issuance and the authenticator switch recorded in the renewal lineage both need a
real domain. **If you run `TLS_MODE=letsencrypt`, verify the first renewal
manually** rather than waiting for expiry to tell you:

```bash
docker compose -f docker-compose.prod.yml run --rm certbot \
  renew --dry-run -a webroot --webroot-path=/var/www/certbot
```

**systemd auto-start.** Create `/etc/systemd/system/trueppm.service`:

```ini
[Unit]
Description=TruePPM
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/trueppm
EnvironmentFile=/opt/trueppm/.env
ExecStart=/usr/bin/docker compose -f docker-compose.prod.yml up -d
ExecStop=/usr/bin/docker compose -f docker-compose.prod.yml down
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now trueppm
```

:::caution[Keep `COMPOSE_PROFILES=letsencrypt` in `.env`]
The certificate-renewal container is gated behind a Compose profile, so it is
only created while that profile is active. `init-prod.sh` writes
`COMPOSE_PROFILES=letsencrypt` into `.env` for you when `TLS_MODE=letsencrypt`,
and Docker Compose reads it from `.env` on every invocation — which is what
carries the setting into the unit above, since neither `ExecStart` nor a manual
`docker compose up -d` passes `--profile`.

If you delete that line, the stack still starts and serves HTTPS normally, and
then stops renewing. The failure is invisible until the certificate expires
roughly 90 days later. Confirm renewal is running with:

```bash
docker compose -f docker-compose.prod.yml ps certbot
```

An empty result means the profile is not active. Certbot renews through the
webroot every 12 hours, and nginx reloads every 6 hours to pick up a renewed
certificate without dropping connections.
:::

**Good for:** production on a single box, no Kubernetes cluster available.

## Services

TruePPM runs as a set of cooperating services:

| Service | Technology | Purpose |
|---------|-----------|---------|
| **API** | Django 5.2 (ASGI via uvicorn) | REST API, WebSocket connections, authentication |
| **Celery worker** | Celery 5.4 | Background CPM scheduling, async task processing |
| **Celery beat** | Celery 5.4 (Beat) | Single-replica scheduler for periodic drains, retention purge, and the beat heartbeat |
| **PostgreSQL** | PostgreSQL 16 | Primary data store, ltree WBS hierarchy |
| **Valkey** | Valkey 8 (Redis-compatible) | Celery task broker, Django Channels layer, scheduling locks |
| **Web** | React 19 (Vite build, served via nginx) | Browser-based user interface |

All services share the same Valkey instance. Celery-originated broadcasts (e.g., `cpm_complete`) reach WebSocket clients connected to any API container, making horizontal scaling of the API safe.

## Backups

PostgreSQL is the only stateful service. Back up the `trueppm` database on your preferred schedule.

Valkey holds no authoritative data, so it is never restored from a backup — but whether it *persists* differs by artifact, and it is worth knowing which you run: the Helm sub-chart runs `valkey-server --appendonly yes` against a 2Gi PVC (~1 s broker RPO at the default `appendfsync everysec`), while `docker-compose.prod.yml` mounts `/data` as a `tmpfs` with no AOF and loses the queue on every container restart. Either way the work itself survives — fourteen outbox drains re-dispatch pending rows every 30 seconds and every task carries `acks_late` — and WebSocket connections simply drop and reconnect. See [Durability & Redundancy](/administration/durability/#broker-persistence-per-artifact).

TruePPM ships tested backup and restore scripts (`scripts/backup.sh` / `scripts/restore.sh`) and an opt-in Helm backup CronJob. See [Backup & Restore](/administration/backup-restore/) for the full runbook: manual backups on Compose and Helm, restoring onto a fresh stack, what is and isn't captured, and the restore-drill cadence.

## Database migrations & rollback

Schema migrations run automatically on container start (`manage.py migrate`). The
migration graph is linear and every schema change is reversible **except two
intentional one-way data migrations** — reverting past them is a no-op, not a
restore:

- `notifications.0004_clean_unknown_matrix_keys` — strips invalid keys from
  notification-preference matrices. The dropped keys carried no meaning, so there
  is nothing to restore on reverse.
- `projects.0019_backfill_wbs_paths` — backfills WBS `ltree` paths. The
  pre-backfill state was empty paths; reverse accepts that data loss.

- `projects.0148_task_unique_task_wbs_path_per_project_live` — repairs duplicate
  WBS paths before adding the constraint that forbids them (see below). Reverse
  drops the constraint, which makes the old state legal again, but does not put
  the repaired rows back.

To roll back across any of these, restore the PostgreSQL backup taken before
the upgrade rather than relying on `migrate <app> <prior>`. All other migrations
reverse cleanly.

### Upgrading to 0.4: duplicate WBS paths are repaired automatically

:::note[Ships in 0.4]
One item on this page — this section — ships in **TruePPM 0.4**, the first beta,
and is **not** in `v0.3.0-alpha.3`, the latest release. Everything else on this
page describes the current release.
:::

A task's `wbs_path` is the only thing that records its place in the work
breakdown; there is no `parent_id` column. Before 0.4 nothing stopped two live
tasks in one project from being written to the same path, and several code paths
did exactly that. 0.4 adds a database constraint that forbids it.

That constraint is **validated against every existing row** when it is created, so
on a database that already holds a duplicate the upgrade would otherwise fail —
and because migrations run on container start, it would fail on every restart.

So the migration repairs first, rather than refusing:

- One row keeps the path: the one that reached the project's write sequence
  earliest.
- Every other row moves to the next free path **among its own siblings** — a
  duplicate at `4.2` becomes `4.9`, not a new top-level item — so it stays inside
  the phase it was planned in.
- **Rows underneath a duplicated path do not move.** A row at `4.2.1` is a child
  of "the `4.2` in this project"; when there were two of those, nothing in the
  data says which. The whole subtree stays with the row that kept the path.

**Every move is logged at `WARNING`** with the project, the task, and the old and
new path. Capture the migration output on upgrade — it is the only record of what
changed:

```
wbs_path repair (#3068): project=<uuid> task=<uuid> moved 4.2 -> 4.9 (kept task=<uuid>)
```

Most databases have no duplicates, and for those the step is a single query and a
no-op. If the log shows moves, review the named tasks afterwards: their numbering
changed, and if any of them owned a subtree, that subtree is now attached to the
task that kept the original path.

One further note for large installs: the constraint is an `EXCLUDE USING GIST`,
which PostgreSQL cannot build concurrently. It takes an `ACCESS EXCLUSIVE` lock on
the task table for the duration of the index build, blocking reads as well as
writes. Plan a maintenance window proportional to your task count.

## Monitoring

### Auto-scheduling health

The Celery worker runs CPM recalculation automatically after every task or dependency write. It uses a per-project Valkey lock to prevent redundant concurrent recalculations. If the lock is held, the task re-queues with a 10-second countdown.

Monitor the Celery worker logs for scheduling errors. If Valkey becomes unavailable, scheduling updates will queue and retry when the connection is restored.

### Celery Beat liveness

In a single-pod deployment there is exactly one Celery Beat process driving every
periodic drain. If it dies silently, async work stops accumulating signal. TruePPM
exposes a heartbeat endpoint (`GET /api/v1/health/beat/`) so monitoring can detect a
dead Beat. See [Beat Liveness](/administration/beat-liveness/) for how to wire
it into Prometheus or Kubernetes.

### Outbox & record retention

The outbox and audit tables (schedule requests, imports, webhook deliveries, object
history, task runs) are bounded by nightly purges. See
[Outbox & Record Retention](/administration/retention/) for the tunable retention
windows and how to disable a purge safely.

### WebSocket connections

WebSocket connections authenticate with a short-lived, single-use ticket (`?ticket=<ticket>` on the connection URL), minted via `POST /api/v1/ws/ticket/` — no JWT ever appears in the URL or access logs. The legacy `?token=<jwt>` handshake is disabled by default and opt-in only via `TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED` (deprecated, removed next release). Viewers (role=1) are rejected with close code 4003. Monitor the Django Channels logs for connection errors.
