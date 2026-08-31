# TruePPM Helm chart

Production-ready Helm 3 chart for deploying TruePPM on Kubernetes.

## Quickstart

`settings.prod` refuses to boot without four values, so the chart alone is not a
complete install — create the app-env Secret first, then reference it with
`envFrom`. Without it the `migrate` init container crash-loops before the API ever
starts (details: [Required secrets](#required-secrets-prod-refuses-to-boot-without-them)).

```bash
# 1. the four values settings.prod enforces at import time
kubectl create secret generic trueppm-env \
  --from-literal=SECRET_KEY="$(openssl rand -base64 48)" \
  --from-literal=ALLOWED_HOSTS=trueppm.example.com,trueppm-api,localhost,127.0.0.1 \
  --from-literal=INTEGRATION_ENCRYPTION_KEY="$(python3 -c \
    'import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode())')" \
  --from-literal=TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true

# 2. install, pointing the chart at it
helm install trueppm packages/helm \
  --set 'envFrom[0].secretRef.name=trueppm-env' \
  --set persistence.media.enabled=true \
  --set persistence.media.accessMode=ReadWriteOnce
```

`TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true` is the no-object-store choice, and
it needs somewhere to write: the pods run with `readOnlyRootFilesystem`, so
without `persistence.media.enabled=true` there is no writable attachment path and
the API **refuses to start** rather than accept uploads it would lose (#3184).

`ReadWriteOnce` is correct for a single-node evaluation cluster and nothing more.
An RWO claim binds to one node, and the api, celery-worker, and celery-beat pods
are three separate Deployments that all mount it — so above one node, or above
one API replica, use `ReadWriteMany` (the chart default, and what the render
refuses to skip past when `replicaCount > 1`) or move attachments to object
storage with the S3 pair (`TRUEPPM_DEFAULT_FILE_STORAGE` +
`TRUEPPM_S3_BUCKET_NAME`) — see
[Required secrets](#required-secrets-prod-refuses-to-boot-without-them).

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
  are *always* injected via `secretKeyRef` — on the bundled path, on the
  managed-datastore path, and in the API, worker, beat, init, backup, and
  demo-seed containers alike. They are never rendered into a Deployment, Job, or
  CronJob manifest. With the bundled datastores the chart builds both URLs
  server-side from the credentials it generated, and the subcharts source their
  password from the same connection Secret, so the database server credential and
  the URL string can never drift apart (no `--set` split-brain).

  **Caveat for a managed datastore supplied as a URL string.** If you pass
  `env.DATABASE_URL` as a plaintext string, the chart stores it in the
  chart-owned connection Secret and injects it from there — so it stays out of
  the Deployment, but it did pass through Helm on the way, and it therefore
  persists in whatever held it: your values file, your shell history if you used
  `--set`, and the Helm release Secret. To keep the credential out of Helm
  entirely, point at a Secret you manage instead
  ([Production](#production-managed-datastores)).
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
| `web.securityHeaders.enabled` | `true` | Send `X-Frame-Options` / `X-Content-Type-Options` / CSP on everything the web tier serves. Django's middleware cannot do this — `index.html` and the JS bundles come off disk from nginx and never reach Django. Set `false` only when a trusted upstream already sets the same headers (nginx cannot deduplicate them). |
| `web.securityHeaders.frameOptions` | `DENY` | `X-Frame-Options` value. |
| `web.securityHeaders.contentTypeOptions` | `nosniff` | `X-Content-Type-Options` value. |
| `web.securityHeaders.contentSecurityPolicy` | `default-src 'self'; …; frame-ancestors 'none'` | CSP for the SPA document, matching `nginx/app.conf.template`. Tunable because a CSP that breaks the app is worse than none — widen it for off-origin fonts/images or a split-origin API ([SPA security headers](https://trueppm.com/administration/helm-values/#spa-security-headers)). |
| `web.securityHeaders.strictTransportSecurity` | `""` (off) | HSTS. Off by default: TLS terminates at the Ingress in the default topology and most controllers emit HSTS themselves. Set `"max-age=63072000; includeSubDomains"` when this tier *is* your TLS edge. |
| `celeryWorker.concurrency` | `2` | **Pinned** prefork pool size. Unset, Celery's `cpu_count()` reads the node's cores, not the cgroup limit, and OOM-kills the worker. |
| `celeryWorker.maxTasksPerChild` | `100` | Recycle prefork children to bound RSS growth on long tasks; `0` disables. |
| `celeryWorker.extraArgs` | `[]` | Extra `celery worker` flags, appended in order. |
| `image.webRepository` | `.../web` | Web tier image (shares `image.tag`/`pullPolicy` with the API). |
| `image.tag` | `""` | Empty resolves to `v<appVersion>` (e.g. `v0.4.0`) — release images are published under v-prefixed tags. A value set here is used verbatim. |
| `probes.api.readinessPath` | `/api/v1/readyz` | Deep API readiness check; liveness stays on `probes.api.livenessPath` (`/api/v1/health/`). |
| `probes.api.hostHeader` | `""` → first ingress host | `Host` header kubelet sends on both api probes. kubelet dials by pod IP, so without it Django validates `<podIP>:8000` against `ALLOWED_HOSTS` and answers 400 — the pod never turns Ready and the Ingress serves 503. Empty resolves to `ingress.hosts[0].host`. Set it explicitly when deploying without an Ingress, and keep it in `ALLOWED_HOSTS`. |
| `probes.worker.enabled` / `probes.beat.enabled` | `true` | `celery inspect ping` exec probe on the worker/beat tiers. |
| `logging.level` | `""` | Root Django log level (`DJANGO_LOG_LEVEL`) for api/worker/beat. Empty = app default. |
| `observability.otlp.tracesSampler` / `tracesSamplerArg` | `""` | Trace sampling → `OTEL_TRACES_SAMPLER[_ARG]`. |
| `podDisruptionBudget.enabled` | `false` | PDB for api + worker (meaningful at `replicaCount >= 2`). |
| `autoscaling.enabled` | `false` | Optional HPA for the API (and `autoscaling.worker.enabled` for the worker). Needs metrics-server. |
| `dashboards.enabled` | `false` | Ship the starter Grafana dashboard as a labeled ConfigMap. |
| `alerts.enabled` | `false` | Ship async/outbox `PrometheusRule` alerts. Requires the Prometheus Operator CRDs. |
| `env.DATABASE_URL` / `env.REDIS_URL` | unset (built by chart) | Required when the bundled datastores are disabled, and **rejected** while they are enabled. Either a `secretKeyRef` map (preferred) or a URL string — see [Production](#production-managed-datastores). `env.REDIS_URL` is not required when `valkey.sentinel.enabled` is true. |
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

**A destination is required.** With none, `backup.outputDir` was backed by an
`emptyDir`: the Job dumped, exited 0, the artifact died with the pod, and the
CronJob reported success forever. The chart now refuses to render that — set one
of `backup.persistence.enabled`, `backup.persistence.existingClaim`,
`backup.s3.enabled`, or `backup.extraVolumes` **together with**
`backup.mediaDir` (`extraVolumes` is ignored unless `mediaDir` is set, so alone
it silently falls back to the `emptyDir`).

The CronJob runs an **inlined command**, not `scripts/backup.sh` — the lean
application image carries no `pg_dump`. Both producers write the same `MANIFEST`
field set and `restore.sh` consumes either artifact; `run_context` says which
one you are holding.

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
Deployment creates one on every deploy — it simply has no public login surface.

That is safe on the chart and was not on `docker-compose.demo.yml`: this path
uses the operator's own `SECRET_KEY` from their Secret, while the compose demo
bakes a public one, so a superuser there had tokens anyone could forge from a
value printed in the repository. The compose demo no longer creates that account
(#3187) — do not read this paragraph as saying it still does.

To reach Django admin on a demo release:

```bash
kubectl port-forward svc/<release>-trueppm-api 8000:8000
```

**Never enable this against an instance holding real data.** The hook runs
`load_sample_project`, which is destructively idempotent: on every install *and every
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
database is in use **and** the NetworkPolicy is enabled. This is why the bundled
datastores satisfy the DB-encryption guard on their own, **without** any operator
being told to disable a security check by hand. It clears that one guard only —
the chart generates *datastore* credentials, but the *application* env secrets in
[Required secrets](#required-secrets-prod-refuses-to-boot-without-them) still have
to be supplied, and an install without them crash-loops in the migrate init
container.

If you disable the NetworkPolicy, the chart stops injecting that flag and a
bundled plaintext database fails the boot guard — by design: an unprotected
plaintext datastore on a flat pod network should fail closed.

For anything beyond dev/demo, use managed datastores with TLS (below). When
`postgresql.enabled=false` the chart injects no auto flag, so your external
`DATABASE_URL` **must** carry `sslmode=require`.

## Production (managed datastores)

`values-prod.yaml` disables the bundled `postgresql` and `valkey` subcharts. When
they are disabled you **must** supply `env.DATABASE_URL` and `env.REDIS_URL`
(point them at your managed services); the chart fails the render with a clear
message otherwise. The inverse is also enforced: setting either one *while* the
matching bundled datastore is enabled fails the render, because the chart-built
URL always wins and your value would be silently ignored.

There are two supported shapes. Both inject the URL by `secretKeyRef`, so neither
puts a credential in a Deployment — they differ in whether the credential passes
through Helm at all.

### Recommended: a Secret you manage

Create the Secret out of band (or with external-secrets / sealed-secrets), then
point the chart at it. Helm never sees the URL, so it is absent from your values
file, your shell history, and the Helm release Secret:

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

Every container that needs the URL — API, Celery worker, Celery beat, the
`migrate` / `bootstrap` init containers, and the backup CronJob — reads it
straight from your Secret. The chart does not copy it into its own connection
Secret.

### Alternative: a URL string

```bash
helm install trueppm packages/helm \
  -f packages/helm/values-prod.yaml \
  --set env.DATABASE_URL="postgres://user:pass@your-db:5432/trueppm?sslmode=require" \
  --set env.REDIS_URL="redis://your-cache:6379"
```

The chart stores the string in the chart-owned connection Secret and injects it
from there, so it still never lands in a Deployment — but it passed through Helm,
so it persists wherever it was held (the values file, `--set` in shell history,
the Helm release Secret). Use the Secret form above if that matters to you.

### TLS on the external database

The external `DATABASE_URL` **must** include `sslmode=require` — `settings.prod`
refuses to boot on a plaintext external database. The chart cannot check this for
the `secretKeyRef` form (it never sees the value), so there the guard is the
app's alone, at boot. Only if TLS is already enforced at the network layer
(service mesh / private encrypted link) set `env.TRUEPPM_ALLOW_UNENCRYPTED_DB=true`
to downgrade that guard to a warning.

## Required secrets (prod refuses to boot without them)

`settings.prod` enforces these at import time — a missing or empty value
crash-loops the pod (the migrate/bootstrap init containers fail first). Provide
them via a Kubernetes Secret referenced through the chart's `envFrom` value (the
API, Celery worker, **and** the init containers all consume it):

| Key | Why | Issue |
|-----|-----|-------|
| `SECRET_KEY` | ≥ 32 chars; Django signing | #566 |
| `ALLOWED_HOSTS` | comma-separated hostnames | Must cover every name a request arrives under, not just your public one: the `helm test` probe curls the api Service by DNS name (`<release>-trueppm-api`, collapsed to `trueppm-api` **only** when the release name already contains "trueppm" — `helm install ppm` needs `ppm-trueppm-api`), the kubelet probes send the `probes.api.hostHeader` value, and a `kubectl port-forward` browser session arrives as `localhost` because the web tier's nginx proxies `/api/` with `Host $host`. A miss is a 400 DisallowedHost, which reads like a routing fault. |
| `INTEGRATION_ENCRYPTION_KEY` | Fernet key; encrypts integration PATs at rest | #1002 |
| `TRUEPPM_DEFAULT_FILE_STORAGE` + `TRUEPPM_S3_BUCKET_NAME` *or* `TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true` **with `persistence.media.enabled=true`** | attachment storage choice. The local opt-in is verified at boot from 0.4: the pods have a read-only root filesystem, so without the claim there is no writable path and the API refuses to start rather than fail on the first upload. | #775, #2559, #3184 |

```bash
kubectl create secret generic trueppm-env \
  --from-literal=SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))") \
  --from-literal=ALLOWED_HOSTS=trueppm.example.com,trueppm-api,localhost,127.0.0.1 \
  --from-literal=INTEGRATION_ENCRYPTION_KEY=$(python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())") \
  --from-literal=TRUEPPM_DEFAULT_FILE_STORAGE=storages.backends.s3.S3Storage \
  --from-literal=TRUEPPM_S3_BUCKET_NAME=trueppm-attachments
```

That is the durable-storage form, and the only one that is correct above one
node. The [Quickstart](#quickstart) substitutes
`TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true` for the last two keys and pairs it
with `persistence.media.enabled=true`, which needs no bucket but puts the files
on a claim that api, celery-worker, and celery-beat all mount. `ReadWriteOnce`
therefore only works while all three land on the same node; see
[attachment storage](https://docs.trueppm.com/administration/helm-values/#attachment-storage-persistencemedia)
for why, and for the `ReadWriteMany` alternative.

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
