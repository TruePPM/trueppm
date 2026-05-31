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
- **Opt-in NetworkPolicy** (`networkPolicy.enabled: true`) restricting ingress
  to the bundled PostgreSQL (5432) and Valkey (6379) to only the API and Celery
  worker pods. Off by default because it requires a CNI that enforces
  NetworkPolicy; a silently-unenforced policy is worse than an explicit opt-in.

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
| `networkPolicy.enabled` | `false` | Opt-in; requires a NetworkPolicy-enforcing CNI. |
| `podSecurityContext` | `runAsNonRoot`, uid 1000 | Pod-level security context for API/worker. |
| `containerSecurityContext` | restricted profile | Container-level hardening for API/worker. |
| `resources.api` / `resources.worker` | 512Mi req / 2Gi limit | Per-container resources. |
| `env.DATABASE_URL` / `env.REDIS_URL` | unset (built by chart) | Required only when the bundled datastores are disabled. |
| `global.trueppm.connectionSecretName` | `""` (derived) | Override only if you renamed the connection Secret. |

## Production (managed datastores)

```bash
helm install trueppm packages/helm \
  -f packages/helm/values-prod.yaml \
  --set env.DATABASE_URL="postgres://user:pass@your-db:5432/trueppm" \
  --set env.REDIS_URL="redis://your-cache:6379"
```

`values-prod.yaml` disables the bundled `postgresql` and `valkey` subcharts. When
they are disabled you **must** supply `env.DATABASE_URL` and `env.REDIS_URL`
(point them at your managed services); the chart fails the render with a clear
message otherwise. Prefer injecting these via an external Secret rather than
`--set` so they don't land in shell history.

`SECRET_KEY` and `ALLOWED_HOSTS` must always be provided via a Kubernetes Secret
referenced through `env` / `envFrom` — see `values.yaml` for the pattern.
