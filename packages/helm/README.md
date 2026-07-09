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
| `resources.api` / `resources.worker` | 512Mi req / 2Gi limit | Per-container resources. |
| `env.DATABASE_URL` / `env.REDIS_URL` | unset (built by chart) | Required only when the bundled datastores are disabled. |
| `global.trueppm.connectionSecretName` | `""` (derived) | Override only if you renamed the connection Secret. |
| `backup.enabled` | `false` | Opt-in scheduled `pg_dump` backup CronJob (see below). |
| `backup.schedule` | `0 2 * * *` | Cron schedule (cluster timezone). |
| `backup.keepDaily` / `backup.keepWeekly` | `7` / `4` | Retention: `keepDaily` is enforced in-job; `keepWeekly` is advisory for an off-cluster lifecycle policy. |
| `backup.persistence.enabled` | `false` | Mount a chart-managed PVC at `backup.outputDir`. |
| `backup.s3.enabled` | `false` | Inject S3-compatible env vars for an off-cluster destination. |

## Scheduled backups (opt-in)

`backup.enabled=true` renders a CronJob that runs `pg_dump --format=custom` against
the database (using the same chart-owned connection Secret as the API — no second
password copy) and writes a single timestamped artifact to a PVC or S3-compatible
bucket, pruning to `backup.keepDaily`. It is **off by default** so enabling it never
creates a PersistentVolumeClaim you did not ask for. Restore is a deliberate manual
action with `scripts/restore.sh`. Full runbook: docs → Administration → Backup &
Restore.

## Ingress and edge TLS (#1714)

The chart ships a chart-managed `Ingress`, **off by default** — the correct
ingress class, hostnames, and certificate source are cluster-specific, so a
default-on ingress would render a broken object. Enable it and supply your
host(s) and a TLS Secret to expose the API over HTTPS at the edge. The API
`Service` stays `ClusterIP`; the `Ingress` is the sole externally-facing object
and the TLS termination point.

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: trueppm.example.com
      paths:
        - path: /
          pathType: Prefix
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
| `TRUEPPM_DEFAULT_FILE_STORAGE` *or* `TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true` | attachment storage choice | #775 |

```bash
kubectl create secret generic trueppm-env \
  --from-literal=SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))") \
  --from-literal=ALLOWED_HOSTS=trueppm.example.com \
  --from-literal=INTEGRATION_ENCRYPTION_KEY=$(python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())") \
  --from-literal=TRUEPPM_DEFAULT_FILE_STORAGE=storages.backends.s3.S3Storage
```

Reference it in your values override (this is the `envFrom` pattern the templates
render — explicit `env:` entries such as the chart-built `DATABASE_URL` always
take precedence over an `envFrom` key of the same name):

```yaml
envFrom:
  - secretRef:
      name: trueppm-env
```
