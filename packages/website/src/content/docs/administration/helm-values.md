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
`env.REDIS_URL` at managed services. See [Valkey High
Availability](/administration/valkey-ha/).
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
| `env.DATABASE_URL` / `env.REDIS_URL` | unset | **Required** when the bundled datastores are disabled — the chart fails the render if either is missing. Supply via an external Secret. `env.REDIS_URL` is **not** required when `valkey.sentinel.enabled` is true. |
| `valkey.sentinel.enabled` | `false` | Use a Valkey Sentinel topology instead of a single endpoint. Only honored when `valkey.enabled` is `false`. |
| `valkey.sentinel.nodes` | `""` | Comma-separated `host:port` Sentinel list. **Required** when `valkey.sentinel.enabled` is true. |
| `valkey.sentinel.masterName` | `""` | Name the Sentinels monitor the primary under. **Required** when `valkey.sentinel.enabled` is true. |
| `valkey.sentinel.password` / `.sentinelPassword` | `""` | Data-node and Sentinel-node passwords. Routed through the chart-owned connection Secret, never rendered into a Deployment. |
| `valkey.sentinel.tls` | `false` | Use TLS to the Valkey data nodes. |
| `env.TRUEPPM_FRONTEND_BASE_URL` | `""` | Public origin for absolute deep-links in notification emails. |
| `env.TRUEPPM_THROTTLE_ANON_RATE` / `_USER_RATE` | `60/min` / `1000/min` | API rate limits; probe endpoints are always exempt. |
| `env.TRUEPPM_NUM_PROXIES` | `"1"` | Trusted reverse-proxy depth for real-client-IP extraction. A wrong value lets clients spoof `X-Forwarded-For`. |
| `env.TRUEPPM_RATE_LIMIT_ENABLED` | `"true"` | Global API rate-limiting kill switch. Leave `"true"` in production. Disabling also requires `TRUEPPM_RATE_LIMIT_DISABLE_ACK`; for load testing only ([details](/administration/configuration/#disabling-rate-limiting-entirely)). |
| `env.TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS` | `"30"` | Trashed-project hard-delete window. |
| `envFrom` | `[]` | Bulk-inject env vars from existing Secrets/ConfigMaps (e.g. `- secretRef: {name: trueppm-env}`) into the API, Celery worker, **and** the bootstrap/migrate init containers. This is the supported way to supply `SECRET_KEY`, `ALLOWED_HOSTS`, and `INTEGRATION_ENCRYPTION_KEY` — the values `prod` refuses to boot without — without rendering them in plaintext into `env`. An explicit `env:` key of the same name (e.g. the chart-built `DATABASE_URL`) always takes precedence over an `envFrom` entry. |

## Observability

| Key | Default | What it does |
|---|---|---|
| `observability.otlp.endpoint` | `""` | OTLP collector endpoint. Empty ⇒ telemetry off. |
| `observability.otlp.protocol` | `grpc` | `grpc` (4317) or `http/protobuf` (4318). |
| `observability.otlp.serviceName` | `trueppm-api` | Resource `service.name` reported on every exported span/metric. |
| `observability.otlp.enabled` | `true` | Master export switch (only exports when an endpoint is also set). |
| `observability.otlp.tracesEnabled` / `metricsEnabled` | `true` / `true` | Per-signal export toggles, consulted only when `enabled` is true and an endpoint is set. Turn one off to export only the other. |
| `observability.otlp.tracesSampler` / `Arg` | `""` | Trace sampling for busy instances, e.g. `parentbased_traceidratio` + `0.1`. Empty keeps the SDK default (`parentbased_always_on`). |
| `observability.otlp.headers` | `""` | Comma-separated `key=value` OTLP headers (e.g. an auth token), rendered inline. Prefer `headersSecret` below for anything sensitive. |
| `observability.otlp.headersSecret` | unset | Prefer this over inline `headers` so auth tokens never render into a plaintext manifest. |
| `observability.otlp.exportHealth.enabled` | `true` | Master switch for the live export-health recorder (ADR-0601). When on, each pod records per-signal export success/error/counts into Valkey DB 2 so the System Health → Telemetry card shows a cross-process live strip. `false` reverts the card to a config-only posture; export itself is unaffected either way. **Requires the Valkey DB 2 instance to run `maxmemory-policy noeviction`** — the same requirement the rate-limit counters already impose. |
| `observability.otlp.exportHealth.stalenessSeconds` | `""` (app default `600`) | How long a pod counts as live after its last export; beyond this a silent pod reads "never" instead of stalled. |
| `observability.otlp.exportHealth.healthyWithinSeconds` | `""` (app default `150`) | A success newer than this reads healthy; older (but still live) reads stalled (metrics) / idle (traces). **Must stay below `stalenessSeconds`**, or the stalled/idle states become unobservable. Set all three `exportHealth` tuning keys together, or none. |
| `observability.otlp.exportHealth.windowSeconds` | `""` (app default `60`) | Rolling window the exported-item counts cover; the System Health card labels the strip from it (e.g. "last 60s"). |
| `dashboards.enabled` | `false` | Ship the starter Grafana dashboard as a labeled ConfigMap (needs a Grafana sidecar watching for the label below). |
| `dashboards.label` / `labelValue` | `grafana_dashboard` / `"1"` | Label key/value your Grafana sidecar watches for auto-import. Defaults match the upstream kube-prometheus-stack sidecar convention. |
| `dashboards.annotations` | `{}` | Extra annotations on the dashboard ConfigMap. |
| `alerts.enabled` | `false` | Ship starter PrometheusRule alerts (**requires the Prometheus Operator CRDs**) covering beat staleness, outbox depth/age, and dead-letter. Thresholds tunable under `alerts.thresholds` below. |
| `alerts.labels` | `{}` | Extra labels stamped on the PrometheusRule, e.g. `release: kube-prometheus-stack` so the operator's `ruleSelector` picks it up. |
| `alerts.thresholds.beatStaleFor` | `2m` | How long the Beat heartbeat must read stale (via the `/api/v1/health/beat/` Blackbox probe) before the alert fires. |
| `alerts.thresholds.outboxDepth` | `500` | Outbox row-count threshold that starts the `outboxDepthFor` clock. |
| `alerts.thresholds.outboxDepthFor` | `10m` | How long `outboxDepth` must stay breached before the alert fires. |
| `alerts.thresholds.outboxOldestAgeSeconds` | `900` | Age (seconds) of the oldest pending outbox row that starts the `outboxOldestAgeFor` clock. |
| `alerts.thresholds.outboxOldestAgeFor` | `10m` | How long `outboxOldestAgeSeconds` must stay breached before the alert fires. |
| `alerts.thresholds.deadLetter` | `0` | Dead-letter gauge value that starts the `deadLetterFor` clock — any dead-lettered message is worth alerting on. |
| `alerts.thresholds.deadLetterFor` | `5m` | How long the dead-letter gauge must stay above `deadLetter` before the alert fires. |
| `otelCollector.enabled` | `false` | Documentation-only reminder — the chart bundles no Collector; deploy one as a sibling release. |

## `helm test`

| Key | Default | What it does |
|---|---|---|
| `tests.image.repository` / `tag` | `curlimages/curl` / `8.11.1` | Image for the `helm test` connection-check Job. Only pulled when you run `helm test <release>`, never during a normal install/upgrade. Runs under the same restricted `securityContext` as the app containers. |
| `tests.probeReadyz` | `true` | Whether the connection check also probes `/api/v1/readyz` in addition to `/api/v1/health/`. Set `false` only when testing this chart against an app image that predates `readyz` (e.g. a CI drill pinned to the last released image while the chart is ahead of it) — otherwise the probe 404s on an endpoint that image doesn't have yet. |

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

## Public read-only demo mode

Turns a release into a throwaway public demo. A post-install/post-upgrade hook Job
seeds the bundled sample project and mints two anonymous, read-only share links — one
schedule, one board — which become the only publicly reachable way in. Demo mode also
swaps the web tier's nginx config for an allowlist: `/admin/`, `/ws/` and every
`/api/` route other than the share projections and the liveness probe return 404, and
every response carries `X-Robots-Tag: noindex` alongside a `Disallow: /` robots.txt.

| Value | Default | Effect |
|-------|---------|--------|
| `demo.enabled` | `false` | Master switch. Everything else in the block is inert while false. |
| `demo.baseUrl` | `""` | Public origin, no trailing slash. **Required** when enabled — it cannot be inferred from inside the cluster. |
| `demo.shareToken.schedule` | `""` | Pinned token for the schedule link. **Required** when enabled. |
| `demo.shareToken.board` | `""` | Pinned token for the board link. **Required** when enabled, and must differ from the schedule token. |
| `demo.backoffLimit` | `2` | Seed Job retries. Exhaustion fails the release deliberately — a demo without data is broken. |
| `demo.resources` | see `values.yaml` | Requests/limits for the short-lived seed Job. |

```bash
helm install trueppm ./packages/helm \
  -f packages/helm/values-demo.yaml \
  --set demo.baseUrl=https://demo.example.com \
  --set demo.shareToken.schedule="$(openssl rand -base64 32 | tr -d '=+/')" \
  --set demo.shareToken.board="$(openssl rand -base64 32 | tr -d '=+/')"
```

:::danger[Never enable this against real data]
`demo.enabled` runs `seed_demo_project` on every install **and every upgrade**, which
deletes the demo projects it previously created and re-seeds them. That is what stops a
demo from drifting. The reset is scoped to the seeder's own output — it will not reap a
real project that shares the demo name, nor a resource assigned to real work — but a
demo deployment also publishes unauthenticated read-only share links and is configured
for evaluation, not production. Keep it on its own instance.
:::

Two things that are easy to get wrong:

- **Both tokens are required and must differ.** Share-link hashes are globally unique,
  so one token cannot back both links. The chart refuses to render otherwise.
- **Pinning is mandatory, not cosmetic.** Because the seed is destructive and share
  links cascade with their project, an unpinned link would change its public URL on
  every `helm upgrade`.

A bootstrap superuser still exists on a demo release — the API creates one on every
deploy — but it has no public login surface, because the allowlist closes `/admin/`.
Reach it with `kubectl port-forward svc/<release>-trueppm-api 8000:8000`.

Ready-made overlay: `packages/helm/values-demo.yaml`, which also sizes Celery down and
disables autoscaling, the PodDisruptionBudget, and backups.

## Related

- [Deployment Sizing](/administration/sizing/) — how many of each to run, with the team-of-25 and team-of-250 profiles.
- [Configuration](/administration/configuration/) — the full application environment-variable catalog.
- [Deployment](/administration/deployment/) — the stateful services and Docker Compose topology.
- [Backup & Restore](/administration/backup-restore/) — the backup CronJob runbook.
