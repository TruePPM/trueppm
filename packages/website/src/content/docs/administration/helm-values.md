---
title: Helm Values Reference
description: Every top-level value the TruePPM Helm chart exposes — what each knob does and its safe default — organized by block.
documentedFor: "0.4"
---

This page is the reference for the values the TruePPM Helm chart
(`packages/helm/values.yaml`) exposes: what each knob does and the value it ships
with. For *how many* of each resource to run at a given team size, see
[Deployment Sizing](/administration/sizing/); for the application environment
variables passed under `env`, see [Configuration](/administration/configuration/).

:::note[About half of this page ships in 0.4]
The chart in the latest release (`v0.3.0-alpha.3`) deploys the API and a Celery
worker and exposes fourteen top-level keys: `replicaCount`, `global`, `image`,
`service`, `ingress` (only `enabled`, and nothing renders from it), `postgresql`,
`valkey`, `networkPolicy`, `podSecurityContext`, `containerSecurityContext`,
`resources`, `env`, `envFrom`, and `admin`. Those sections — [Image and
replicas](#image-and-replicas), [Bundled datastores](#bundled-datastores),
[Network and pod security](#network-and-pod-security), [Resources](#resources),
[Application environment](#application-environment-env), and [Admin
bootstrap](#admin-bootstrap) — describe the released chart.

**Everything else on this page lands with the 0.4 beta and is not in the released
chart.** Namely:

- `values.schema.json` and the closed root that rejects unknown keys
  ([Unknown keys are rejected](#unknown-keys-are-rejected)) — the released chart
  accepts any key you write;
- the `web` tier (`web.*`): the nginx SPA, its `/admin/` allowlist, and its
  security headers ([Service and web tier](#service-and-web-tier), [Django admin
  exposure](#django-admin-exposure), [SPA security headers](#spa-security-headers));
- `celeryWorker.*` ([Celery worker tuning](#celery-worker-tuning)) — the released
  worker takes no chart-level concurrency, recycling, or extra-args knobs;
- every `ingress` key past `enabled` ([Ingress](#ingress)) — the released chart has
  no Ingress template at all, so `ingress.enabled: true` renders nothing;
- `probes.*` ([Health probes](#health-probes)), `podDisruptionBudget.*` and
  `autoscaling.*` ([Scaling and availability](#scaling-and-availability)) — and
  there is no Celery Beat deployment on the released chart for `probes.beat.*` to
  probe;
- `observability.*`, `otelCollector.*`, `dashboards.*`, `alerts.*`, and
  `logging.*` ([Observability](#observability)) — the released chart ignores an
  `observability` block entirely;
- `tests.*` ([`helm test`](#helm-test)), `backup.*` ([Scheduled
  backups](#scheduled-backups)), and the `demo` mode block ([Public read-only demo
  mode](#public-read-only-demo-mode));
- `valkey.sentinel.*` ([Managed datastores](#managed-external-datastores)) — the
  released chart's `valkey` block carries `enabled` and `auth` only. This is the
  one 0.4 addition inside a section that is otherwise released, and it is marked
  experimental besides.

Verify against your own chart with `helm show values` before writing a values file
on the released version.
:::

:::note[Secure by default]
A stock `helm install` renders a complete, secure instance: it generates and
persists the datastore passwords, enables Valkey auth, applies restricted pod
security contexts, and turns on a NetworkPolicy around the bundled datastores.
The blocks below note where a default is deliberately *off* because it is
cluster-specific (ingress, autoscaling, backup) or requires a CRD/operator that
may not be present.
:::

## Unknown keys are rejected

The chart ships a `values.schema.json` whose root is closed, so `helm upgrade`
**fails** on a values key no template reads instead of accepting it:

```
Error: values don't meet the specifications of the schema(s) in the following chart(s):
trueppm:
- at '': additional properties 'extraEnv' not allowed
```

This matters more than it sounds. Helm's default is to accept anything, so before the
schema a misspelled or invented key — copied from a blog post, another chart, or a
typo — applied cleanly, changed nothing on the pod, and left you comparing a UI that
said the setting was configured against a cluster where it was not. If a key you
believe in is rejected, it is not a key this chart reads; find the real one below.

Two blocks stay deliberately open because the chart is not the authority on their
contents: `global` (Helm's cross-chart channel) and anything passed straight through
to Kubernetes with `toYaml` — `resources.*`, `podSecurityContext`,
`containerSecurityContext`, `ingress.annotations`, `alerts.labels`, and
`backup.extraVolumes` / `extraVolumeMounts`.

## Image and replicas

| Key | Default | What it does |
|---|---|---|
| `replicaCount` | `1` | API tier replica count. Raise to `2+` for production (the prod overlay sets 2). Request throughput scales with this because uvicorn runs one worker per pod by default. |
| `image.repository` | `registry.gitlab.com/trueppm/trueppm/api` | API container image. |
| `image.webRepository` | `registry.gitlab.com/trueppm/trueppm/web` | Web (nginx SPA) image; shares `tag`/`pullPolicy` with the API so a release deploys a matching pair. |
| `image.tag` | `""` | Empty pins the chart to its own `appVersion` for reproducible rollbacks, resolving to `v<appVersion>` (e.g. `v0.4.0`) — released images are published under v-prefixed tags, so the `v` is part of the tag, not decoration. Override per-deploy with a concrete tag, which is used verbatim. |
| `image.pullPolicy` | `IfNotPresent` | Standard Kubernetes pull policy. |

## Service and web tier

| Key | Default | What it does |
|---|---|---|
| `service.type` / `service.port` | `ClusterIP` / `8000` | API Service. Stays ClusterIP; the Ingress is the sole external object. |
| `web.enabled` | `true` | Serve the compiled React SPA from an in-chart nginx tier. Disable if you front the SPA from your own CDN and want only the API + workers. |
| `web.replicaCount` | `1` | Web-tier replicas; falls back to `replicaCount` when unset. |
| `web.containerPort` | `8080` | Port the unprivileged nginx image listens on (satisfies `runAsNonRoot`). |
| `web.service.type` / `web.service.port` | `ClusterIP` / `80` | Web Service. |
| `web.maxBodySize` | `50M` | nginx `client_max_body_size` for the web tier. Inert in the default topology — the Ingress sends `/api` and `/ws` straight to the API Service, so uploads never traverse this nginx. It binds when you route everything through the web tier instead. See [Upload size limits](#upload-size-limits). |

## Django admin exposure

:::caution[Denied by default]
The web tier **denies `/admin/` from every source** unless you add a CIDR. Django
admin is a plain Django view, so none of the API's login throttles apply to it,
there is no account-lockout backend, and the [admin
bootstrap](/administration/admin-password/) guarantees a superuser exists to
guess against. Leaving it deny-by-default is deliberate — see
[Reaching Django admin](/administration/security/#reaching-django-admin).
:::

| Key | Default | What it does |
|---|---|---|
| `web.adminAccess.enabled` | `true` | Render the `/admin/` proxy at all. Set `false` to return `404` instead — removes the path from the public listener entirely. |
| `web.adminAccess.allowCIDRs` | `[]` | Source CIDRs permitted to reach `/admin/`. **Empty means deny everything.** Matched against nginx's `$remote_addr`, which behind an Ingress is the *controller's* pod IP, not the operator's — so this is only meaningful when the web tier sees real client addresses. |
| `web.adminAccess.rateLimit.enabled` | `true` | Apply an nginx `limit_req` zone to the admin login surface. |
| `web.adminAccess.rateLimit.rate` | `5r/m` | Requests per source IP, matching the Docker Compose deployment. |
| `web.adminAccess.rateLimit.burst` | `2` | Burst allowance above the sustained rate. |

## SPA security headers

:::caution[Django cannot set these for you]
The API's `Content-Security-Policy`, `X-Frame-Options`, and
`X-Content-Type-Options` middleware decorate responses **Django** produces. The
SPA's `index.html` and its JavaScript bundles are served straight off disk by the
web tier's nginx and never reach Django — so the headers below are the only ones
the document that runs the entire application ever carries. Leaving them off
means the app is framable and has no CSP, regardless of how the API is
configured.
:::

The chart ships the same set the Docker Compose deployment sets, and every value
is tunable: operators front this tier with their own ingress, WAF, or CDN, and a
CSP that breaks the app is worse than no CSP. Set any value to `""` to omit that
one header.

| Key | Default | What it does |
|---|---|---|
| `web.securityHeaders.enabled` | `true` | Render the header block at all. Only set `false` when a trusted upstream (an ingress `configuration-snippet`, a WAF, a CDN edge) already sets the same headers — nginx cannot merge or deduplicate a header the upstream also emits. |
| `web.securityHeaders.frameOptions` | `DENY` | `X-Frame-Options`. The SPA is never legitimately framed, so `DENY` rather than `SAMEORIGIN`. |
| `web.securityHeaders.contentTypeOptions` | `nosniff` | `X-Content-Type-Options`. Stops a browser re-typing a response as a script. |
| `web.securityHeaders.contentSecurityPolicy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self'; frame-ancestors 'none'` | `Content-Security-Policy`. `connect-src` includes `ws:`/`wss:` for the real-time collaboration socket. Widen it if you host fonts or images off-origin or add an analytics endpoint. Serving the SPA and API from different origins is **not supported** — see [Split-origin deploys](/administration/configuration/#split-origin-deploys). |
| `web.securityHeaders.strictTransportSecurity` | `""` (off) | `Strict-Transport-Security`. Off by default, unlike the Compose TLS template: in the chart's default topology TLS terminates at the Ingress and this nginx speaks plain HTTP, and most ingress controllers emit HSTS themselves. Turn it on — `"max-age=63072000; includeSubDomains"` — only when the web tier *is* your TLS edge, and note that `includeSubDomains` binds every sibling subdomain of the apex you serve from. |

All four render with nginx's `always` flag, so they are present on error
responses too, not just `200`s.

## Celery worker tuning

| Key | Default | What it does |
|---|---|---|
| `celeryWorker.concurrency` | `2` | Prefork pool size, **pinned**. Never left unset: Celery's `cpu_count()` default reads the *node's* core count rather than the cgroup CPU limit, so an unpinned worker forks a node-sized pool into a 2Gi pod and OOM-kills the whole background tier. Raise toward the pod's CPU limit per the [sizing profiles](/administration/sizing/). |
| `celeryWorker.maxTasksPerChild` | `100` | Recycle each prefork child after this many tasks so long-running jobs (workspace export, MS Project import) cannot accumulate RSS for the pod's lifetime. `0` disables recycling. |
| `celeryWorker.extraArgs` | `[]` | Extra `celery worker` flags, appended verbatim and in order — e.g. `["--queues=exports", "--prefetch-multiplier=1"]`. |

## Ingress

Off by default — the ingress class, hostnames, and certificate source are
cluster-specific, so a default-on ingress would render a broken object.

| Key | Default | What it does |
|---|---|---|
| `ingress.enabled` | `false` | Render a chart-managed Ingress + edge TLS. |
| `ingress.className` | `""` | IngressClass to bind (`nginx`, `traefik`, …). Empty uses the cluster default. |
| `ingress.annotations` | `nginx.ingress.kubernetes.io/proxy-body-size: "50m"` | Controller / cert-manager annotations. The shipped default raises the upload ceiling — see [Upload size limits](#upload-size-limits). Helm deep-merges this map, so your own keys are added alongside it. |
| `ingress.hosts` | one example host | Virtual hosts; each path routes to `web` or `api`. List `/api` and `/ws` **before** `/` so they win longest-prefix matching. |
| `ingress.tls` | `[]` | TLS Secrets per host. Empty renders **HTTP-only** — dev/demo only, never production. |

### Upload size limits

Two ceilings sit in front of every import, and they are enforced in different
places. Get the order wrong and a valid file is rejected by the proxy before the
application ever sees it.

| Layer | Where | Default |
|---|---|---|
| Ingress controller | `ingress.annotations` → `nginx.ingress.kubernetes.io/proxy-body-size` | `50m` |
| Web-tier nginx | `web.maxBodySize` | `50M` |
| Application | `MSPROJECT_MAX_UPLOAD_MB` (50), `JIRA_IMPORT_MAX_UPLOAD_MB` (25), `CSV_IMPORT_MAX_UPLOAD_MB` (10), `SEED_MAX_UPLOAD_MB` (5) | see [Configuration](/administration/configuration/) |

**The rule: keep every transport limit at or above the largest application cap.**
The application cap is the one that should reject an oversized file, because it
returns a validation error naming the limit and the format. A transport limit
returns a bare `413` with no explanation and nothing in the logs pointing at the
import.

The shipped defaults already satisfy this. If you raise `MSPROJECT_MAX_UPLOAD_MB`
above 50, raise both transport limits to match — otherwise the higher app cap is
unreachable.

:::caution[An explicit annotations map drops the default]
Helm deep-merges `ingress.annotations`, but only for keys you do not set. The
`proxy-body-size` default exists precisely because an empty map lets ingress-nginx
apply its own **1 MB** ceiling, and *every import above 1 MB then fails on an
otherwise-default install*. If you are carrying a values file that pins
`ingress.annotations` to your own map, confirm it includes `proxy-body-size` — an
explicit map that omits it inherits the 1 MB default again.
:::

**On other ingress controllers** the annotation is a no-op. Traefik uses a
`buffering` middleware with `maxRequestBodyBytes`; HAProxy uses
`haproxy.org/client-body-buffer-size`. Set the equivalent for your controller.

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
| `probes.api.readinessPath` | `/api/v1/readyz` | Deep readiness: DB + cache reachable **and** no unapplied/in-flight migrations, so a rolling upgrade never routes traffic to a pod whose schema and code disagree. Detection of the reverse direction — a database carrying migrations the running image does not ship, i.e. an image rolled back without restoring the schema — ships in 0.4 as `migration_state: ahead`, gated only for a pod that *booted* into it so a forward rolling upgrade never pulls the old pods out of the Service. Either way, schema presence is not data compatibility: rolling back across a destructive migration still needs a [restore from backup](/getting-started/upgrade/#rollback). |
| `probes.api.livenessPath` | `/api/v1/health/` | Shallow liveness so a transient dependency blip can't restart-loop the pod. |
| `probes.api.readiness*/liveness*Seconds` | 10/10, 30/30 | Initial-delay and period tuning. |
| `probes.api.hostHeader` | _(empty → `ingress.hosts[0].host`)_ | `Host` header kubelet sends on both api probes. kubelet dials by pod IP, so without this Django validates `<podIP>:8000` against `ALLOWED_HOSTS` in `get_host()` — before any view, and out of reach of `SECURE_REDIRECT_EXEMPT` — and answers 400 DisallowedHost. The pod never turns Ready, the Service gets no endpoints, and the Ingress serves 503, with nothing in the failure naming `ALLOWED_HOSTS`. Empty resolves to the first ingress host, which you already had to allow to serve traffic, so the common case needs no configuration. **Set it explicitly when you deploy without an Ingress** (a `LoadBalancer` Service, a service mesh) and `ALLOWED_HOSTS` is not a wildcard — and keep the two in step. See [Host names you must include](/administration/configuration/#host-names-you-must-include). |
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
| `env.DATABASE_URL` / `env.REDIS_URL` | unset | **Required** when the bundled datastores are disabled, and **rejected** while they are enabled (the chart-built URL always wins, so your value would be silently ignored) — the render fails either way, with a message saying which. Two supported shapes, both injected via `secretKeyRef` so neither reaches a Deployment: a **`secretKeyRef` map** naming a Secret you manage (preferred — the credential never passes through Helm), or a **URL string** (the chart stores it in its own connection Secret, but it persists in your values file / shell history / Helm release Secret on the way). `env.REDIS_URL` is **not** required when `valkey.sentinel.enabled` is true. See [Managed datastores](#managed-external-datastores). |
| `valkey.sentinel.enabled` | `false` | **Experimental** (0.4). Use a Valkey Sentinel topology instead of a single endpoint. Only honored when `valkey.enabled` is `false`. Validate a real failover in staging before depending on it. |
| `valkey.sentinel.nodes` | `""` | Comma-separated `host:port` Sentinel list. **Required** when `valkey.sentinel.enabled` is true. |
| `valkey.sentinel.masterName` | `""` | Name the Sentinels monitor the primary under. **Required** when `valkey.sentinel.enabled` is true. |
| `valkey.sentinel.password` / `.sentinelPassword` | `""` | Data-node and Sentinel-node passwords. Routed through the chart-owned connection Secret, never rendered into a Deployment. |
| `valkey.sentinel.tls` | `false` | Use TLS to the Valkey data nodes. |
| `env.TRUEPPM_FRONTEND_BASE_URL` | `""` | Public origin for absolute deep-links in notification emails. |
| `env.TRUEPPM_THROTTLE_ANON_RATE` / `_USER_RATE` | `60/min` / `1000/min` | API rate limits; probe endpoints are always exempt. |
| `env.TRUEPPM_NUM_PROXIES` | `"1"` | Trusted reverse-proxy depth for real-client-IP extraction. A wrong value lets clients spoof `X-Forwarded-For`. |
| `env.TRUEPPM_RATE_LIMIT_ENABLED` | `"true"` | Global API rate-limiting kill switch. Leave `"true"` in production. Disabling also requires `TRUEPPM_RATE_LIMIT_DISABLE_ACK`; for load testing only ([details](/administration/configuration/#disabling-rate-limiting-entirely)). |
| `env.TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS` | `"30"` | Trashed-project hard-delete window, in days. **Do not set `0`** — it is not "use the default", it puts the purge cutoff at the present moment and deletes every trashed project, with all child data, via CASCADE. From 0.4 the app will refuse to boot on `0` rather than losing the data silently. An empty string is invalid, not "disabled". To turn auto-purge off, leave this unset and disable the policy in Settings → System Health. See [Retention](/administration/retention/). |
| `envFrom` | `[]` | Bulk-inject env vars from existing Secrets/ConfigMaps (e.g. `- secretRef: {name: trueppm-env}`) into the API, Celery worker, **and** the bootstrap/migrate init containers. This is the supported way to supply `SECRET_KEY`, `ALLOWED_HOSTS`, and `INTEGRATION_ENCRYPTION_KEY` — the values `prod` refuses to boot without — without rendering them in plaintext into `env`. An explicit `env:` key of the same name always takes precedence over an `envFrom` entry. |

### Managed (external) datastores

With `postgresql.enabled: false` / `valkey.enabled: false`, the chart can no
longer build the connection strings, so you supply them. Both shapes below are
injected into every consumer — API, Celery worker, Celery beat, the `migrate` and
`bootstrap` init containers, and the backup CronJob — via `secretKeyRef`, so
neither renders a credential into a Deployment manifest.

**Preferred — a Secret you manage.** The URL never passes through Helm, so it is
absent from your values file, your shell history, and the Helm release Secret. The
chart points the containers straight at your Secret and does not copy the value
into its own:

```yaml
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

**Alternative — a URL string.** The chart moves it into the chart-owned
connection Secret and injects it from there, so it stays out of the Deployment;
but it passed through Helm, so it persists wherever it was held:

```yaml
env:
  DATABASE_URL: "postgres://user:pass@db.example.com:5432/trueppm?sslmode=require"
```

An external `DATABASE_URL` must carry `sslmode=require` — `settings.prod` refuses
to boot on a plaintext external database. The chart cannot check this for the
`secretKeyRef` form, since it never sees the value; there the guard is the app's
alone, at boot.

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
| `observability.otlp.actorAttributes` | `true` | Stamp `trueppm.user.id` (the acting account's opaque UUID) and `trueppm.user.role` (the symbolic project role the request was authorized under) on each request span. Nothing else about the person is exported — no email, username, display name, or client IP. Set `false` where a per-user identifier must not leave the instance even to your own collector; project/program/task ids are unaffected. |
| `observability.otlp.headersSecret` | unset | Prefer this over inline `headers` so auth tokens never render into a plaintext manifest. |
| `observability.otlp.exportHealth.enabled` | `true` | Master switch for the live export-health recorder (ADR-0601). When on, each pod records per-signal export success/error/counts into Valkey DB 2 so the Telemetry card at Settings → Workspace → Observability shows a cross-process live strip. `false` reverts the card to a config-only posture; export itself is unaffected either way. **Requires the Valkey DB 2 instance to run `maxmemory-policy noeviction`** — the same requirement the rate-limit counters already impose. |
| `observability.otlp.exportHealth.stalenessSeconds` | `""` (app default `600`) | How long a pod counts as live after its last export; beyond this a silent pod reads "never" instead of stalled. |
| `observability.otlp.exportHealth.healthyWithinSeconds` | `""` (app default `150`) | A success newer than this reads healthy; older (but still live) reads stalled (metrics) / idle (traces). **Must stay below `stalenessSeconds`**, or the stalled/idle states become unobservable. Set all three `exportHealth` tuning keys together, or none. |
| `observability.otlp.exportHealth.windowSeconds` | `""` (app default `60`) | Rolling window the exported-item counts cover; the Telemetry card labels the strip from it (e.g. "last 60s"). |
| `dashboards.enabled` | `false` | Ship the starter Grafana dashboard as a labeled ConfigMap (needs a Grafana sidecar watching for the label below). |
| `dashboards.label` / `labelValue` | `grafana_dashboard` / `"1"` | Label key/value your Grafana sidecar watches for auto-import. Defaults match the upstream kube-prometheus-stack sidecar convention. |
| `dashboards.annotations` | `{}` | Extra annotations on the dashboard ConfigMap. |
| `alerts.enabled` | `false` | Ship starter PrometheusRule alerts (**requires the Prometheus Operator CRDs**) covering beat staleness, outbox depth/age, dead-letter, outbound email, backups, and volume capacity. Thresholds tunable under `alerts.thresholds` below. |
| `alerts.labels` | `{}` | Extra labels stamped on the PrometheusRule, e.g. `release: kube-prometheus-stack` so the operator's `ruleSelector` picks it up. |
| `alerts.thresholds.beatStaleFor` | `2m` | How long the Beat heartbeat must read stale (via the `/api/v1/health/beat/` Blackbox probe) before the alert fires. |
| `alerts.thresholds.outboxDepth` | `500` | Outbox row-count threshold that starts the `outboxDepthFor` clock. |
| `alerts.thresholds.outboxDepthFor` | `10m` | How long `outboxDepth` must stay breached before the alert fires. |
| `alerts.thresholds.outboxOldestAgeSeconds` | `900` | Age (seconds) of the oldest pending outbox row that starts the `outboxOldestAgeFor` clock. |
| `alerts.thresholds.outboxOldestAgeFor` | `10m` | How long `outboxOldestAgeSeconds` must stay breached before the alert fires. |
| `alerts.thresholds.deadLetter` | `0` | Dead-letter gauge value that starts the `deadLetterFor` clock — any dead-lettered message is worth alerting on. |
| `alerts.thresholds.deadLetterFor` | `5m` | How long the dead-letter gauge must stay above `deadLetter` before the alert fires. |
| `alerts.thresholds.backup.jobFailedFor` | `5m` | How long a failed backup Job must persist before `TruePPMBackupJobFailed` fires. Rendered only when `backup.enabled`. |
| `alerts.thresholds.backup.staleAfterSeconds` | `172800` | Age (seconds) of the last **successful** backup that fires `TruePPMBackupStale`. 48h = 2x the default daily schedule, so one missed run is tolerated and two are not. **Raise this if you lengthen `backup.schedule`** — a weekly schedule under a 48h window alerts every week by construction. |
| `alerts.thresholds.backup.staleFor` | `30m` | How long `staleAfterSeconds` must stay breached before the alert fires. |
| `alerts.thresholds.backup.neverSucceededFor` | `26h` | How long the "no successful backup has ever been recorded" condition must hold before `TruePPMBackupNeverSucceeded` fires. Must exceed one full schedule period plus slack, or a fresh install alerts before its first scheduled run. |
| `alerts.thresholds.volumeAvailablePercent` | `15` | Free-space percentage below which `TruePPMVolumeFillingUp` starts its clock, for **every** claim in the namespace — database, Valkey, backups, media. |
| `alerts.thresholds.volumeAvailableFor` | `15m` | How long a volume must stay below `volumeAvailablePercent` before the alert fires. |
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

:::caution[`backup.enabled` alone is not a backup]
Setting `backup.enabled=true` without a destination used to render a CronJob
whose `backups` volume was an `emptyDir`: the Job dumped, exited 0, the artifact
died with the pod, and the CronJob reported success forever. From 0.4 the chart
**refuses to render** that combination. Pick one:

- `backup.persistence.enabled=true` — a chart-managed PVC
- `backup.persistence.existingClaim` — a claim you manage
- `backup.s3.enabled=true` — an off-cluster bucket
- `backup.extraVolumes` **together with** `backup.mediaDir` — your own volume.
  Both are required: `extraVolumes` is ignored unless `mediaDir` is set, so
  `extraVolumes` alone silently falls back to the `emptyDir` this guard exists
  to prevent.

Enabling backups is also what renders the `TruePPMBackupJobFailed`,
`TruePPMBackupStale`, and `TruePPMBackupNeverSucceeded` alerts (with
`alerts.enabled=true`) — a scheduled backup nobody is alerting on is the same
silent failure one step later.
:::

| Key | Default | What it does |
|---|---|---|
| `backup.enabled` | `false` | Enable the backup CronJob. |
| `backup.schedule` | `"0 2 * * *"` | Cron schedule (cluster timezone). |
| `backup.image` | `postgres:16-alpine` | Client-capable image carrying `pg_dump`/`psql` (the lean app image has no client binaries). |
| `backup.outputDir` | `/backups` | In-container artifact path (the mounted volume when persistence is on). |
| `backup.mediaDir` | `""` | Include a local media/attachment PVC in the artifact. Leave empty when attachments live in object storage. |
| `backup.keepDaily` / `keepWeekly` | `7` / `4` | `keepDaily` is enforced in-job. **`keepWeekly` is read by no template** — nothing promotes dailies to weeklies. It exists as the documented place to record the weekly retention your object store's lifecycle policy enforces, next to the schedule it belongs to; changing it changes nothing on the cluster. |
| `backup.persistence.*` | disabled, `10Gi` RWO | Chart-managed PVC destination. |
| `backup.s3.*` | disabled | S3-compatible off-cluster destination; the secret **must** come from a Kubernetes Secret via `existingSecret`. |
| `backup.extraVolumes` / `extraVolumeMounts` | `[]` | Mount your media PVC read-only when `mediaDir` is set. |
| `backup.resources` | `100m/256Mi` → `1/512Mi` | Backup job container resources. |

## Admin bootstrap

| Key | Default | What it does |
|---|---|---|
| `admin.passwordFile` | `/run/trueppm/admin_password` | Where the one-time bootstrap password is written. Retrieve with `kubectl exec <api-pod> -- cat /run/trueppm/admin_password`. |
| `admin.email` | `""` | Bootstrap admin email. Set it — left empty the bootstrap uses `admin@example.com`, a reserved domain that cannot receive password-reset mail. |

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
`demo.enabled` runs `load_sample_project` on every install **and every upgrade**, which
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
