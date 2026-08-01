# TruePPM Helm chart

Production-ready Helm 3 chart for deploying TruePPM on Kubernetes.

```bash
helm install trueppm packages/helm
```

The bundled PostgreSQL and Valkey subcharts are for **dev / demo / CI only**. For
production, disable both and point at managed services (see
[Production](#production-managed-datastores)).

## Security defaults (secure by default)

As of the chart hardening pass (#886) a default install is secure with no extra
flags:

- **Generated datastore credentials.** `postgresql.auth.password` and
  `valkey.auth.password` are empty by default. The chart generates a strong
  random password (`randAlphaNum 32`) on first install and persists it in a
  chart-owned **connection Secret** (`<release>-trueppm-connection`) annotated
  `helm.sh/resource-policy: keep`. Re-renders read the existing password back
  rather than churning it, so `helm upgrade` never orphans the database PVC.
  Setting an explicit `postgresql.auth.password` / `valkey.auth.password` is
  honored verbatim.
- **Valkey auth is ON by default** (`valkey.auth.enabled: true`).
- **No plaintext credentials in any Deployment.** `DATABASE_URL` and `REDIS_URL`
  are built server-side from the generated credentials and injected via
  `secretKeyRef` against the connection Secret. They are never rendered into a
  Deployment manifest. The bundled subcharts source their password from the same
  connection Secret, so the database server credential and the URL string can
  never drift apart (no `--set` split-brain).
- **Hardened containers.** The API and Celery worker run with
  `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`,
  `capabilities: { drop: [ALL] }`, `seccompProfile: RuntimeDefault`, and
  `runAsNonRoot: true`. Writable `emptyDir` mounts are provided at `/tmp`
  (tempfile + Django upload buffering), `/app/staticfiles` (collectstatic), and
  `/run/trueppm` (admin bootstrap password). The bundled datastores apply the
  same profile minus `readOnlyRootFilesystem` (their images need a writable root
  for runtime sockets/AOF spill).
- **`automountServiceAccountToken: false`** on the API and worker pods — they
  make no in-cluster Kubernetes API calls.
- **Default resource requests/limits** for every workload.
- **Default-on NetworkPolicy** (`networkPolicy.enabled: true`, #1715)
  restricting ingress to the bundled PostgreSQL (5432) and Valkey (6379) to only
  the API and Celery worker pods, plus default-deny egress on the datastore pods.
  The bundled datastores speak **plaintext** on the pod network, so this policy —
  not in-transit TLS — is the transport-security boundary for the dev/demo posture.
  **Requires a CNI that enforces NetworkPolicy** (Calico, Cilium, Antrea, Weave, …);
  on a cluster whose CNI does not enforce policy these objects are accepted but
  silently unenforced. If your cluster lacks one, do not use the bundled datastores
  for anything sensitive — use managed external datastores with TLS instead.

### Retrieving the generated database password

```bash
kubectl get secret <release>-trueppm-connection \
  -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d
```

## Key values

| Value | Default | Notes |
|-------|---------|-------|
| `postgresql.auth.password` | `""` (generated) | Set to pin an explicit DB password. |
| `valkey.auth.enabled` | `true` | Valkey requires a password by default. |
| `valkey.auth.password` | `""` (generated) | Set to pin an explicit cache password. |
| `ingress.enabled` | `false` | Chart-managed Ingress + edge TLS. Enable and set `hosts`/`tls` to expose over HTTPS. |
| `ingress.className` | `""` | IngressClass to bind (e.g. `nginx`). Empty uses the cluster default. |
| `ingress.tls` | `[]` | TLS Secret + host list for edge termination. Empty renders HTTP-only (dev/demo). |
| `networkPolicy.enabled` | `true` | Default-on; requires a NetworkPolicy-enforcing CNI. |
| `podSecurityContext` | `runAsNonRoot`, uid 1000 | Pod-level security context for API/worker. |
| `containerSecurityContext` | restricted profile | Container-level hardening for API/worker. |
| `resources.api` / `resources.worker` / `resources.beat` / `resources.web` | see values.yaml | Per-container resources. |
| `web.enabled` | `true` | Render the nginx-served React SPA tier + `Service`. |
| `web.adminAccess.enabled` | `true` | Render the `/admin/` proxy; `false` returns `404` instead. |
| `web.adminAccess.allowCIDRs` | `[]` | Sources allowed to reach `/admin/`. **Empty = deny all** — port-forward to the API Service instead ([Reaching Django admin](https://trueppm.com/administration/security/#reaching-django-admin)). Only binds while `web.enabled` is true. |
| `web.adminAccess.rateLimit.*` | `5r/m`, burst `2` | nginx `limit_req` on the admin login surface (no DRF throttle covers Django admin). |
| `celeryWorker.concurrency` | `2` | **Pinned** prefork pool size. Unset, Celery's `cpu_count()` reads the node's cores, not the cgroup limit, and OOM-kills the worker. |
| `celeryWorker.maxTasksPerChild` | `100` | Recycle prefork children to bound RSS growth on long tasks; `0` disables. |
| `celeryWorker.extraArgs` | `[]` | Extra `celery worker` flags, appended in order. |
| `image.webRepository` | `.../web` | Web tier image (shares `image.tag`/`pullPolicy` with the API). |
| `probes.api.readinessPath` | `/api/v1/readyz` | Deep API readiness check; liveness stays on `probes.api.livenessPath` (`/api/v1/health/`). |
| `probes.worker.enabled` / `probes.beat.enabled` | `true` | `celery inspect ping` exec probe on the worker/beat tiers. |
| `logging.level` | `""` | Root Django log level (`DJANGO_LOG_LEVEL`) for api/worker/beat. Empty = app default. |
| `observability.otlp.tracesSampler` / `tracesSamplerArg` | `""` | Trace sampling → `OTEL_TRACES_SAMPLER[_ARG]`. |
| `podDisruptionBudget.enabled` | `false` | PDB for api + worker (meaningful at `replicaCount >= 2`). |
| `autoscaling.enabled` | `false` | Optional HPA for the API (and `autoscaling.worker.enabled` for the worker). Needs metrics-server. |
| `dashboards.enabled` | `false` | Ship the starter Grafana dashboard as a labeled ConfigMap. |
| `alerts.enabled` | `false` | Ship async/outbox `PrometheusRule` alerts. Requires the Prometheus Operator CRDs. |
| `env.DATABASE_URL` / `env.REDIS_URL` | unset (built by chart) | Required only when the bundled datastores are disabled. `env.REDIS_URL` is not required when `valkey.sentinel.enabled` is true. |
| `valkey.sentinel.enabled` | `false` | **Experimental** (0.4). Use an external Valkey Sentinel topology. Requires `valkey.enabled: false`, `valkey.sentinel.nodes`, and `valkey.sentinel.masterName`. Not yet verified against a live quorum failover. |
| `global.trueppm.connectionSecretName` | `""` (derived) | Override only if you renamed the connection Secret. |
| `backup.enabled` | `false` | Opt-in scheduled `pg_dump` backup CronJob (see below). |
| `backup.schedule` | `0 2 * * *` | Cron schedule (cluster timezone). |
| `backup.keepDaily` / `backup.keepWeekly` | `7` / `4` | Retention for the **local** output directory only. Neither ever deletes from a bucket — use the object store's lifecycle policy for remote retention. |
| `backup.persistence.enabled` | `false` | Mount a chart-managed PVC at `backup.outputDir`. |
| `backup.s3.enabled` | `false` | Upload each finished artifact to an S3-compatible bucket. Adds a second container to the job (the PostgreSQL image has no S3 client). A failed upload fails the job. |
| `backup.s3.endpoint` | `""` | Leave empty for real AWS S3. Set it for MinIO — a custom endpoint forces path-style addressing. |
| `backup.s3.allowPlaintext` | `false` | Silence the warning logged when `endpoint` is `http://` and doesn't look in-cluster/private (see [Backup & Restore](https://trueppm.com/administration/backup-restore/#off-cluster-plaintext-warning)). The upload is never blocked either way — this only controls the log line. |
| `backup.s3.prefix` | `""` | Optional key prefix; the object key is `<prefix>/trueppm-backup-<UTC>.tar.gz`. |
| `backup.s3.image.repository` / `.tag` | `amazon/aws-cli` / `2.17.0` | Image for the upload container. Must provide `aws`. |

## Scheduled backups (opt-in)

`backup.enabled=true` renders a CronJob that runs `pg_dump --format=custom` against
the database (using the same chart-owned connection Secret as the API — no second
password copy) and writes a single timestamped artifact to `backup.outputDir`,
pruning that directory to `backup.keepDaily`. It is **off by default** so enabling it
never creates a PersistentVolumeClaim you did not ask for.

Adding `backup.s3.enabled=true` uploads each artifact off-cluster. The job then runs
in two phases — an initContainer dumps (it needs `pg_dump`, so it uses the PostgreSQL
image) and the main container uploads (it needs an S3 client, so it uses
`backup.s3.image`). No stock image carries both, which is why the upload cannot share
a container with the dump. **If the upload fails the job fails**, so a green job means
the artifact really did leave the cluster.

Retention splits along the same line: `keepDaily` prunes the local directory and never
touches the bucket. Set bucket retention with a lifecycle policy on the bucket itself.

Restore is a deliberate manual action with `scripts/restore.sh`, which can pull
straight back from the bucket (`--from-s3 latest`). Full runbook: docs →
Administration → Backup & Restore.

## Public read-only demo mode (#2440, ADR-0658)

`demo.enabled=true` turns a release into a **throwaway public demo**: a
post-install/post-upgrade hook Job seeds the bundled sample project and mints two
anonymous, read-only share links — one schedule, one board — which are the only
publicly reachable way in.

Demo mode also replaces the web tier's nginx config with an **allowlist** that
mirrors `nginx/demo.conf.template` (#1763): only the two share projections and the
liveness probe are proxied, while `/admin/`, `/ws/` and every other `/api/` route
return 404. That is the actual control. A bootstrap superuser still exists — the api
Deployment creates one on every deploy, as the compose demo does — it simply has no
public login surface. To reach Django admin on a demo release:

```bash
kubectl port-forward svc/<release>-trueppm-api 8000:8000
```

**Never enable this against an instance holding real data.** The hook runs
`seed_demo_project`, which is destructively idempotent: on every install *and every
upgrade* it deletes the demo data it previously created and re-seeds it. That is what
keeps a demo from drifting. The reset is scoped to the seeder's own output — a real
project sharing the demo name, or a resource assigned to real work, is left alone — but
a demo deployment also publishes unauthenticated read-only share links, so it belongs on
its own instance regardless.

```bash
SCHEDULE_TOKEN=$(openssl rand -base64 32 | tr -d '=+/')
BOARD_TOKEN=$(openssl rand -base64 32 | tr -d '=+/')

helm install trueppm ./packages/helm \
  -f packages/helm/values-demo.yaml \
  --set demo.baseUrl=https://demo.example.com \
  --set demo.shareToken.schedule="$SCHEDULE_TOKEN" \
  --set demo.shareToken.board="$BOARD_TOKEN"
```

The links are printed by the hook Job and are also derivable from the tokens:
`<baseUrl>/share/schedule/<token>` and `<baseUrl>/share/board/<token>`. To re-read
them later:

```bash
kubectl logs job/<release>-trueppm-demo-seed
```

Four things worth knowing before you run it:

- **Both tokens are required and must differ.** `ShareLink.token_hash` is globally
  unique, so one token cannot back both links. The chart refuses to render otherwise.
- **Pinning is mandatory, not cosmetic.** Because the seed is destructive and share
  links cascade with their project, an unpinned link would silently change its public
  URL on every `helm upgrade`. Pinned tokens restore the same URLs every time.
- **Demo mode does not weaken the app.** Celery stays enabled (sized down) so the
  deployment matches production topology, and the seeder never creates persona
  logins. The share endpoints remain gated by the instance-wide
  `TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED` switch, which `values-demo.yaml` asserts.
- **The chart does not terminate TLS.** Front it at your ingress or load balancer, as
  with any other deployment (see below).

Demo mode also adds `X-Robots-Tag: noindex, nofollow, noarchive` and a
`Disallow: /` robots.txt to the web tier, so a public demo does not end up in search
results.

## Ingress and edge TLS (#1714)

The chart ships a chart-managed `Ingress`, **off by default** — the correct
ingress class, hostnames, and certificate source are cluster-specific, so a
default-on ingress would render a broken object. Enable it and supply your
host(s) and a TLS Secret to expose TruePPM over HTTPS at the edge. Each path routes
by its `service:` key — `/api` and `/ws` to the API, `/` to the web SPA (the
default `ingress.hosts` below already encodes that split). Both `Service`s stay
`ClusterIP`; the `Ingress` is the sole externally-facing object and the TLS
termination point.

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: trueppm.example.com
      paths:
        - path: /api
          pathType: Prefix
          service: api
        - path: /ws
          pathType: Prefix
          service: api
        - path: /
          pathType: Prefix
          service: web
  tls:
    - secretName: trueppm-tls
      hosts:
        - trueppm.example.com
```

With cert-manager, the issuer annotation provisions the named TLS Secret
automatically. Leaving `ingress.tls` empty renders an **HTTP-only** Ingress —
acceptable only for a dev/demo cluster, never production. `settings.prod` trusts
`X-Forwarded-Proto` (`SECURE_PROXY_SSL_HEADER`), so the app sets secure cookies
and HSTS correctly behind edge TLS; the `/api/v1/health/` and `/api/v1/edition/`
probe paths stay exempt from the optional HTTP→HTTPS redirect.

## Bundled datastores are dev/demo only (#1715, #1716)

The bundled PostgreSQL and Valkey subcharts are for **dev / demo / CI only**. They
speak **plaintext** on the pod network — the chart-built `DATABASE_URL` carries no
`sslmode`. That is safe **only** because the default-on NetworkPolicy isolates the
datastore pods so that just the API and worker can reach them (and a
policy-enforcing CNI is present).

To keep that posture coherent with the app's DB-encryption boot guard, the chart
automatically sets `TRUEPPM_ALLOW_UNENCRYPTED_DB=true` **only** when the bundled
database is in use **and** the NetworkPolicy is enabled. This is why a default
`helm install` boots without crash-looping and **without** any operator being told
to disable a security check by hand. If you disable the NetworkPolicy, the chart
stops injecting that flag and a bundled plaintext database fails the boot guard —
by design: an unprotected plaintext datastore on a flat pod network should fail
closed.

For anything beyond dev/demo, use managed datastores with TLS (below). When
`postgresql.enabled=false` the chart injects no auto flag, so your external
`DATABASE_URL` **must** carry `sslmode=require`.

## Production (managed datastores)

```bash
helm install trueppm packages/helm \
  -f packages/helm/values-prod.yaml \
  --set env.DATABASE_URL="postgres://user:pass@your-db:5432/trueppm?sslmode=require" \
  --set env.REDIS_URL="redis://your-cache:6379"
```

`values-prod.yaml` disables the bundled `postgresql` and `valkey` subcharts. When
they are disabled you **must** supply `env.DATABASE_URL` and `env.REDIS_URL`
(point them at your managed services); the chart fails the render with a clear
message otherwise. The external `DATABASE_URL` **must** include `sslmode=require`
— `settings.prod` refuses to boot on a plaintext external database. Only if TLS is
already enforced at the network layer (service mesh / private encrypted link) set
`env.TRUEPPM_ALLOW_UNENCRYPTED_DB=true` to downgrade that guard to a warning.
Prefer injecting these via an external Secret rather than `--set` so they don't
land in shell history.

## Required secrets (prod refuses to boot without them)

`settings.prod` enforces these at import time — a missing or empty value
crash-loops the pod (the migrate/bootstrap init containers fail first). Provide
them via a Kubernetes Secret referenced through the chart's `envFrom` value (the
API, Celery worker, **and** the init containers all consume it):

| Key | Why | Issue |
|-----|-----|-------|
| `SECRET_KEY` | ≥ 32 chars; Django signing | #566 |
| `ALLOWED_HOSTS` | comma-separated hostnames | — |
| `INTEGRATION_ENCRYPTION_KEY` | Fernet key; encrypts integration PATs at rest | #1002 |
| `TRUEPPM_DEFAULT_FILE_STORAGE` + `TRUEPPM_S3_BUCKET_NAME` *or* `TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true` | attachment storage choice | #775, #2559 |

```bash
kubectl create secret generic trueppm-env \
  --from-literal=SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))") \
  --from-literal=ALLOWED_HOSTS=trueppm.example.com \
  --from-literal=INTEGRATION_ENCRYPTION_KEY=$(python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())") \
  --from-literal=TRUEPPM_DEFAULT_FILE_STORAGE=storages.backends.s3.S3Storage \
  --from-literal=TRUEPPM_S3_BUCKET_NAME=trueppm-attachments
```

The API image bundles the S3 backend, so those two keys are all an AWS S3 deploy
needs — credentials resolve from IRSA or the instance profile. For MinIO or
another non-AWS endpoint add `TRUEPPM_S3_ENDPOINT_URL`,
`TRUEPPM_S3_ADDRESSING_STYLE=path`, and an access/secret key pair **scoped to the
attachments bucket** — not the MinIO root account. The bucket name is
**required** whenever the backend is S3: startup fails with `trueppm.E008` if it
is missing, instead of booting and failing on the first upload. GCS and Azure Blob
backends are **not** bundled — see
[object storage](https://trueppm.com/administration/configuration/#object-storage-s3--minio).

Reference it in your values override (this is the `envFrom` pattern the templates
render — explicit `env:` entries such as the chart-built `DATABASE_URL` always
take precedence over an `envFrom` key of the same name):

```yaml
envFrom:
  - secretRef:
      name: trueppm-env
```
