---
title: Helm Values Reference
description: Every top-level value the TruePPM Helm chart exposes — what each knob does and its safe default — organized by block.
---

This page is the reference for the values the TruePPM Helm chart
(`packages/helm/values.yaml`) exposes: what each knob does and the value it ships
with. For *how many* of each resource to run at a given team size, see
[Deployment Sizing](/administration/sizing/); for the application environment
variables passed under `env`, see [Configuration](/administration/configuration/).

:::note[Secure by default]
A stock `helm install` renders a complete, secure instance: it generates and
persists the datastore passwords, enables Valkey auth, applies restricted pod
security contexts, and turns on a NetworkPolicy around the bundled datastores.
The blocks below note where a default is deliberately *off* because it is
cluster-specific (ingress, autoscaling, backup) or requires a CRD/operator that
may not be present.
:::

## Image and replicas

| Key | Default | What it does |
|---|---|---|
| `replicaCount` | `1` | API tier replica count. Raise to `2+` for production (the prod overlay sets 2). Request throughput scales with this because uvicorn runs one worker per pod by default. |
| `image.repository` | `registry.gitlab.com/trueppm/trueppm/api` | API container image. |
| `image.webRepository` | `registry.gitlab.com/trueppm/trueppm/web` | Web (nginx SPA) image; shares `tag`/`pullPolicy` with the API so a release deploys a matching pair. |
| `image.tag` | `""` | Empty pins the chart to its own `appVersion` for reproducible rollbacks. Override per-deploy with a concrete tag. |
| `image.pullPolicy` | `IfNotPresent` | Standard Kubernetes pull policy. |

## Service and web tier

| Key | Default | What it does |
|---|---|---|
| `service.type` / `service.port` | `ClusterIP` / `8000` | API Service. Stays ClusterIP; the Ingress is the sole external object. |
| `web.enabled` | `true` | Serve the compiled React SPA from an in-chart nginx tier. Disable if you front the SPA from your own CDN and want only the API + workers. |
| `web.replicaCount` | `1` | Web-tier replicas; falls back to `replicaCount` when unset. |
| `web.containerPort` | `8080` | Port the unprivileged nginx image listens on (satisfies `runAsNonRoot`). |
| `web.service.type` / `web.service.port` | `ClusterIP` / `80` | Web Service. |

## Ingress

Off by default — the ingress class, hostnames, and certificate source are
cluster-specific, so a default-on ingress would render a broken object.

| Key | Default | What it does |
|---|---|---|
| `ingress.enabled` | `false` | Render a chart-managed Ingress + edge TLS. |
| `ingress.className` | `""` | IngressClass to bind (`nginx`, `traefik`, …). Empty uses the cluster default. |
| `ingress.annotations` | `{}` | Controller / cert-manager annotations. |
| `ingress.hosts` | one example host | Virtual hosts; each path routes to `web` or `api`. List `/api` and `/ws` **before** `/` so they win longest-prefix matching. |
| `ingress.tls` | `[]` | TLS Secrets per host. Empty renders **HTTP-only** — dev/demo only, never production. |

## Bundled datastores

:::caution[Dev / demo only]
The bundled `postgresql` and `valkey` subcharts are single-node with small PVCs.
For production, set both to `enabled: false` and point `env.DATABASE_URL` /
`env.REDIS_URL` at managed services. See [Redis (Valkey) High
Availability](/administration/redis-ha/).
:::

| Key | Default | What it does |
|---|---|---|
| `postgresql.enabled` | `true` | Deploy the bundled PostgreSQL. |
| `postgresql.auth.username` / `.database` | `trueppm` / `trueppm` | Bundled DB credentials. |
| `postgresql.auth.password` | `""` | Empty ⇒ chart generates a strong random password and persists it in the connection Secret (never churned on re-render). Set explicitly only to control the credential. |
| `valkey.enabled` | `true` | Deploy the bundled Valkey. Load-bearing for Channels, the Celery broker, **and** the cache at once. |
| `valkey.auth.enabled` | `true` | Valkey auth on by default. |
| `valkey.auth.password` | `""` | Same generate-and-persist pattern as PostgreSQL. |
| `global.trueppm.connectionSecretName` | `""` | Override only if you renamed the chart-owned connection Secret. |

## Network and pod security

| Key | Default | What it does |
|---|---|---|
| `networkPolicy.enabled` | `true` | Restrict datastore ingress to the API/worker pods and default-deny datastore egress. **Requires a policy-enforcing CNI** (Calico, Cilium, Antrea, …) — silently unenforced without one. |
| `podSecurityContext` | `runAsNonRoot: true`, `runAsUser: 1000` | Pod-level restricted defaults. |
| `containerSecurityContext` | no-priv-escalation, read-only rootfs, drop `ALL` caps, `RuntimeDefault` seccomp | Container-level restricted defaults. |

## Resources

Per-tier requests/limits under `resources.<tier>` for `api`, `worker`, `beat`,
and `web`. Defaults are conservative single-team values (API/worker request
`250m / 512Mi`, limit `1 / 2Gi`; beat and web are light). Each includes an
`ephemeral-storage` request/limit for `/tmp` scratch (MS Project parse, export,
large request buffering). Tune per the [sizing profiles](/administration/sizing/).

## Health probes

| Key | Default | What it does |
|---|---|---|
| `probes.api.readinessPath` | `/api/v1/readyz` | Deep readiness: DB + cache reachable **and** no unapplied/in-flight migrations, so a rolling upgrade never routes traffic to a pod whose schema and code disagree. |
| `probes.api.livenessPath` | `/api/v1/health/` | Shallow liveness so a transient dependency blip can't restart-loop the pod. |
| `probes.api.readiness*/liveness*Seconds` | 10/10, 30/30 | Initial-delay and period tuning. |
| `probes.worker.*` | ping every 60s, `failureThreshold: 3` | `celery inspect ping` exec probe — catches a wedged event loop a process-alive check would miss. |
| `probes.beat.*` | ping every 60s, `failureThreshold: 5` | Beat ping targets broker reachability; generous threshold avoids restarts on a brief worker blip. |

## Scaling and availability

| Key | Default | What it does |
|---|---|---|
| `podDisruptionBudget.enabled` | `false` | PDBs for API/worker (`maxUnavailable: 1`). Only meaningful at `replicaCount >= 2`; beat is excluded (pinned singleton). |
| `autoscaling.enabled` | `false` | HorizontalPodAutoscaler for the API (and optionally worker). Overrides the static replica count and **requires metrics-server**. Defaults: API 2–6 replicas at 75% CPU. |
| `logging.level` | `""` | Fleet-wide `DJANGO_LOG_LEVEL` (DEBUG/INFO/WARNING/ERROR). Empty keeps the app default. |

## Application environment (`env`)

The `env` block passes application settings into the API/worker/beat containers.
The full catalog lives in [Configuration](/administration/configuration/); the
knobs operators reach for first:

| Key | Default | What it does |
|---|---|---|
| `env.DJANGO_SETTINGS_MODULE` | `trueppm_api.settings.prod` | Settings module. |
| `env.DATABASE_URL` / `env.REDIS_URL` | unset | **Required** when the bundled datastores are disabled — the chart fails the render if either is missing. Supply via an external Secret. |
| `env.TRUEPPM_FRONTEND_BASE_URL` | `""` | Public origin for absolute deep-links in notification emails. |
| `env.TRUEPPM_THROTTLE_ANON_RATE` / `_USER_RATE` | `60/min` / `1000/min` | API rate limits; probe endpoints are always exempt. |
| `env.TRUEPPM_NUM_PROXIES` | `"1"` | Trusted reverse-proxy depth for real-client-IP extraction. A wrong value lets clients spoof `X-Forwarded-For`. |
| `env.TRUEPPM_RATE_LIMIT_ENABLED` | `"true"` | Global API rate-limiting kill switch. Leave `"true"` in production. Disabling also requires `TRUEPPM_RATE_LIMIT_DISABLE_ACK`; for load testing only ([details](/administration/configuration/#disabling-rate-limiting-entirely)). |
| `env.TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS` | `"30"` | Trashed-project hard-delete window. |

## Observability

| Key | Default | What it does |
|---|---|---|
| `observability.otlp.endpoint` | `""` | OTLP collector endpoint. Empty ⇒ telemetry off. |
| `observability.otlp.protocol` | `grpc` | `grpc` (4317) or `http/protobuf` (4318). |
| `observability.otlp.enabled` | `true` | Master export switch (only exports when an endpoint is also set). |
| `observability.otlp.tracesSampler` / `Arg` | `""` | Trace sampling for busy instances, e.g. `parentbased_traceidratio` + `0.1`. |
| `observability.otlp.headersSecret` | unset | Prefer this over inline `headers` so auth tokens never render into a plaintext manifest. |
| `dashboards.enabled` | `false` | Ship the starter Grafana dashboard as a labeled ConfigMap (needs a Grafana sidecar). |
| `alerts.enabled` | `false` | Ship starter PrometheusRule alerts (**requires the Prometheus Operator CRDs**). Thresholds tunable under `alerts.thresholds`. |
| `otelCollector.enabled` | `false` | Documentation-only reminder — the chart bundles no Collector; deploy one as a sibling release. |

## Scheduled backups

Off by default — a backup CronJob needs a durable destination, so you turn it on
deliberately. This is logical backup only (`pg_dump`); see [Backup &
Restore](/administration/backup-restore/) for the full runbook.

| Key | Default | What it does |
|---|---|---|
| `backup.enabled` | `false` | Enable the backup CronJob. |
| `backup.schedule` | `"0 2 * * *"` | Cron schedule (cluster timezone). |
| `backup.image` | `postgres:16-alpine` | Client-capable image carrying `pg_dump`/`psql` (the lean app image has no client binaries). |
| `backup.outputDir` | `/backups` | In-container artifact path (the mounted volume when persistence is on). |
| `backup.mediaDir` | `""` | Include a local media/attachment PVC in the artifact. Leave empty when attachments live in object storage. |
| `backup.keepDaily` / `keepWeekly` | `7` / `4` | `keepDaily` is enforced in-job; `keepWeekly` is advisory for an external lifecycle policy. |
| `backup.persistence.*` | disabled, `10Gi` RWO | Chart-managed PVC destination. |
| `backup.s3.*` | disabled | S3-compatible off-cluster destination; the secret **must** come from a Kubernetes Secret via `existingSecret`. |
| `backup.extraVolumes` / `extraVolumeMounts` | `[]` | Mount your media PVC read-only when `mediaDir` is set. |
| `backup.resources` | `100m/256Mi` → `1/512Mi` | Backup job container resources. |

## Admin bootstrap

| Key | Default | What it does |
|---|---|---|
| `admin.passwordFile` | `/run/trueppm/admin_password` | Where the one-time bootstrap password is written. Retrieve with `kubectl exec <api-pod> -- cat /run/trueppm/admin_password`. |
| `admin.email` | `""` | Bootstrap admin email (defaults to `admin@trueppm.com`). |

## Related

- [Deployment Sizing](/administration/sizing/) — how many of each to run, with the team-of-25 and team-of-250 profiles.
- [Configuration](/administration/configuration/) — the full application environment-variable catalog.
- [Deployment](/administration/deployment/) — the stateful services and Docker Compose topology.
- [Backup & Restore](/administration/backup-restore/) — the backup CronJob runbook.
