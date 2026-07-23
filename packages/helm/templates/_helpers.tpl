{{/*
Expand the name of the chart.
*/}}
{{- define "trueppm.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this
(by the DNS naming spec).
*/}}
{{- define "trueppm.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart label value — used in the "helm.sh/chart" label.
*/}}
{{- define "trueppm.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to every resource.
*/}}
{{- define "trueppm.labels" -}}
helm.sh/chart: {{ include "trueppm.chart" . }}
{{ include "trueppm.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels — used in matchLabels and pod template labels.
*/}}
{{- define "trueppm.selectorLabels" -}}
app.kubernetes.io/name: {{ include "trueppm.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Build a list of env vars from values.env for use in container specs.

Each entry in .Values.env may be either:
  - a scalar (string / number / bool) → rendered as a literal `value:`
  - a map with a `secretKeyRef` key → rendered as `valueFrom: secretKeyRef`,
    e.g.  MY_VAR: { secretKeyRef: { name: my-secret, key: my-key } }

The secretKeyRef form lets the chart point env vars at chart-generated Secrets
(DATABASE_URL, REDIS_URL) so no credential is ever rendered in plaintext into a
Deployment manifest, and an operator `--set` of a sub-chart password can't cause
a split-brain between the URL string and the running database.
*/}}
{{- define "trueppm.envVars" -}}
{{- range $key, $value := .Values.env }}
{{- if kindIs "map" $value }}
- name: {{ $key }}
  valueFrom:
    secretKeyRef:
      name: {{ $value.secretKeyRef.name }}
      key: {{ $value.secretKeyRef.key }}
{{- else }}
- name: {{ $key }}
  value: {{ $value | quote }}
{{- end }}
{{- end }}
{{- end }}

{{/*
OpenTelemetry env vars, rendered from the structured observability.otlp.* values
into the standard OTEL_* / TRUEPPM_OTEL_* variables the API reads (ADR-0223, #708).
Included in the api AND celery-worker deployments so traces/metrics from the
Beat-driven worker carry the same resource attributes as the web tier. Emits
NOTHING when observability.otlp.endpoint is empty (the default) — telemetry is
opt-in with no default endpoint, so the provider stays a strict no-op. The
optional headers Secret keeps auth tokens (e.g. a SaaS OTLP bearer token) out of
the rendered manifest.
*/}}
{{- define "trueppm.observabilityEnv" -}}
{{- with .Values.observability.otlp }}
{{- if .endpoint }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .endpoint | quote }}
- name: OTEL_EXPORTER_OTLP_PROTOCOL
  value: {{ .protocol | default "grpc" | quote }}
- name: OTEL_SERVICE_NAME
  value: {{ .serviceName | default "trueppm-api" | quote }}
- name: TRUEPPM_OTEL_ENABLED
  value: {{ .enabled | default true | quote }}
- name: TRUEPPM_OTEL_TRACES_ENABLED
  value: {{ .tracesEnabled | default true | quote }}
- name: TRUEPPM_OTEL_METRICS_ENABLED
  value: {{ .metricsEnabled | default true | quote }}
{{- if .tracesSampler }}
- name: OTEL_TRACES_SAMPLER
  value: {{ .tracesSampler | quote }}
{{- end }}
{{- if .tracesSamplerArg }}
- name: OTEL_TRACES_SAMPLER_ARG
  value: {{ .tracesSamplerArg | quote }}
{{- end }}
{{- if .headersSecret.name }}
- name: OTEL_EXPORTER_OTLP_HEADERS
  valueFrom:
    secretKeyRef:
      name: {{ .headersSecret.name }}
      key: {{ .headersSecret.key | default "headers" }}
{{- else if .headers }}
- name: OTEL_EXPORTER_OTLP_HEADERS
  value: {{ .headers | quote }}
{{- end }}
{{/* Live export-health strip (ADR-0601, #2109). The pod name comes from the
     downward API so each pod's record carries a stable, human-readable identity
     (the app falls back to gethostname():pid without it). The three tuning knobs
     render only when explicitly set, so an unset value keeps the app default. */}}
- name: TRUEPPM_POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: TRUEPPM_OTEL_EXPORT_HEALTH_ENABLED
  value: {{ dig "exportHealth" "enabled" true . | quote }}
{{- with .exportHealth }}
{{- if .stalenessSeconds }}
- name: TRUEPPM_OTEL_EXPORT_HEALTH_STALENESS_SECONDS
  value: {{ .stalenessSeconds | quote }}
{{- end }}
{{- if .healthyWithinSeconds }}
- name: TRUEPPM_OTEL_EXPORT_HEALTH_HEALTHY_WITHIN_SECONDS
  value: {{ .healthyWithinSeconds | quote }}
{{- end }}
{{- if .windowSeconds }}
- name: TRUEPPM_OTEL_EXPORT_HEALTH_WINDOW_SECONDS
  value: {{ .windowSeconds | quote }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Application logging env (#1899). Threads the operator-chosen root Django log level
into the api, celery-worker, and celery-beat containers via DJANGO_LOG_LEVEL so a
single values knob (logging.level) tunes verbosity across every tier. Emits nothing
when the value is empty, letting the app fall back to its own default.
*/}}
{{- define "trueppm.loggingEnv" -}}
{{- with .Values.logging }}
{{- if .level }}
- name: DJANGO_LOG_LEVEL
  value: {{ .level | quote }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Standard app env block shared by the api, celery-worker, and celery-beat
containers: the operator env, the chart-owned connection Secret, the bundled-DB
security posture, OpenTelemetry, and the log-level knob. Kept as one helper so the
three long-lived Python processes stay wired identically (a drifted beat that
missed a new env var was the #1892 failure mode this consolidates against).
*/}}
{{- define "trueppm.appEnv" -}}
{{ include "trueppm.envVars" . }}
{{ include "trueppm.connectionEnv" . }}
{{ include "trueppm.datastoreSecurityEnv" . }}
{{ include "trueppm.observabilityEnv" . }}
{{ include "trueppm.loggingEnv" . }}
{{- end -}}

{{/*
Celery liveness/readiness exec probe (#1904). `celery inspect ping` round-trips a
control-plane message over the broker and exits non-zero if the target does not
answer, so it detects a wedged event loop that a bare process-alive check would
miss AND confirms the pod can reach the broker.

`destination` selects the semantics:
  - a node name (e.g. "celery@$HOSTNAME") pings THIS pod's own worker — the true
    self-liveness check used on the worker Deployment;
  - empty pings the whole fleet — used on the beat Deployment, which runs no worker
    control plane of its own, so the probe there asserts broker reachability from
    the beat pod (a generous failureThreshold keeps a brief worker blip from
    killing beat).

Value-tunable per component under .Values.probes.<component>. `app` names the
Celery application (matches the worker/beat -A argument).
Usage: include "trueppm.celeryProbe" (dict "probe" .Values.probes.worker "app" "trueppm_api.celery" "destination" "celery@$HOSTNAME")
*/}}
{{- define "trueppm.celeryProbe" -}}
{{- $timeout := .probe.timeoutSeconds | default 10 -}}
{{- $dest := "" -}}
{{- if .destination }}{{- $dest = printf "--destination %s " .destination -}}{{- end -}}
exec:
  # Wrapped in `sh -c` so a $HOSTNAME-derived node name expands at probe time (an
  # exec command array is run without a shell, so the literal would never resolve).
  command:
    - sh
    - -c
    - {{ printf "celery -A %s inspect ping %s--timeout %v" .app $dest $timeout | quote }}
initialDelaySeconds: {{ .probe.initialDelaySeconds | default 30 }}
periodSeconds: {{ .probe.periodSeconds | default 60 }}
timeoutSeconds: {{ add ($timeout | int) 5 }}
failureThreshold: {{ .probe.failureThreshold | default 3 }}
{{- end }}

{{/*
Name of the chart-owned Secret holding the connection URLs (DATABASE_URL,
REDIS_URL) and the raw DB/cache passwords. Derived from `.Release.Name` only —
NOT from trueppm.fullname — so the bundled subcharts (which can't see the
parent's nameOverride / fullnameOverride) can reconstruct the exact same name
from `.Release.Name` alone and reference this one Secret as the single credential
source of truth. Mirrors the subchart naming convention (`<release>-postgresql`,
`<release>-valkey-primary`).
*/}}
{{- define "trueppm.urlSecretName" -}}
{{- printf "%s-trueppm-connection" .Release.Name -}}
{{- end -}}

{{/*
DATABASE_URL / REDIS_URL env entries, sourced from the chart-owned connection
Secret via secretKeyRef. Used by the API and Celery worker containers so the
password is never rendered into the Deployment manifest in plaintext.
*/}}
{{- define "trueppm.connectionEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "trueppm.urlSecretName" . }}
      key: DATABASE_URL
- name: REDIS_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "trueppm.urlSecretName" . }}
      key: REDIS_URL
{{- end -}}

{{/*
Bundled-datastore dev/demo posture env (#1716). Auto-enables the app's
unencrypted-DB boot-guard escape hatch (TRUEPPM_ALLOW_UNENCRYPTED_DB) — but ONLY
for the exact dev/demo shape: the bundled PostgreSQL is in use AND a NetworkPolicy
is enforcing that only the API/worker pods can reach it.

Why this is needed: the chart-built bundled DATABASE_URL (trueppm.databaseUrl)
carries no sslmode — the bundled Postgres speaks plaintext on the pod network — so
settings.prod's #1550 boot guard would otherwise crash-loop a default
`helm install`. The safe reconciliation is to grant the escape hatch precisely
when the network layer already isolates that plaintext hop, NOT to train operators
to disable the check by hand.

Why it fails closed everywhere else:
  - External DB (postgresql.enabled=false): emits nothing, so the operator's
    DATABASE_URL must still carry sslmode=require — the #1550 guard stays live.
  - NetworkPolicy disabled: emits nothing, so a bundled plaintext DB on a flat pod
    network fails the guard, forcing transport security to be a deliberate choice.

Operator precedence: if .Values.env.TRUEPPM_ALLOW_UNENCRYPTED_DB is set, it is
rendered by trueppm.envVars and this helper stays silent, so the operator's value
wins and no duplicate env key is emitted.
*/}}
{{- define "trueppm.datastoreSecurityEnv" -}}
{{- if and .Values.postgresql.enabled .Values.networkPolicy.enabled (not (hasKey .Values.env "TRUEPPM_ALLOW_UNENCRYPTED_DB")) }}
- name: TRUEPPM_ALLOW_UNENCRYPTED_DB
  value: "true"
{{- end }}
{{- end -}}

{{/*
Resolve the PostgreSQL password (generate-if-unset), memoized.

Single source of truth = the chart-owned connection Secret. Resolution order:
  1. explicit `.Values.postgresql.auth.password`
  2. the password already persisted in the connection Secret (so repeat
     `helm upgrade` runs never churn the password and orphan the database PVC)
  3. a fresh `randAlphaNum 32`

The result is memoized on `.Values._resolved` so that every template that needs
it (the connection Secret, the subchart, the URL builders) sees the *same* value
within a single render. Without memoization each `randAlphaNum` call on a fresh
install would mint a different password per template, splitting the DB password
from the URL. Lookup keys off the connection Secret — not the subchart Secret —
because the connection Secret is the one object everything else derives from.
*/}}
{{- define "trueppm.postgresqlPassword" -}}
{{- if not .Values._resolved -}}
{{- $_ := set .Values "_resolved" dict -}}
{{- end -}}
{{- if not (hasKey .Values._resolved "pgPassword") -}}
{{- $pw := "" -}}
{{- if .Values.postgresql.auth.password -}}
{{- $pw = .Values.postgresql.auth.password -}}
{{- else -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "trueppm.urlSecretName" .) -}}
{{- if and $existing $existing.data (index $existing.data "POSTGRES_PASSWORD") -}}
{{- $pw = index $existing.data "POSTGRES_PASSWORD" | b64dec -}}
{{- else -}}
{{- $pw = randAlphaNum 32 -}}
{{- end -}}
{{- end -}}
{{- $_ := set .Values._resolved "pgPassword" $pw -}}
{{- end -}}
{{- get .Values._resolved "pgPassword" -}}
{{- end -}}

{{/*
Resolve the Valkey password (generate-if-unset, memoized — same pattern as
PostgreSQL). Only meaningful when `.Values.valkey.auth.enabled` is true.
*/}}
{{- define "trueppm.valkeyPassword" -}}
{{- if not .Values._resolved -}}
{{- $_ := set .Values "_resolved" dict -}}
{{- end -}}
{{- if not (hasKey .Values._resolved "valkeyPassword") -}}
{{- $pw := "" -}}
{{- if .Values.valkey.auth.password -}}
{{- $pw = .Values.valkey.auth.password -}}
{{- else -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "trueppm.urlSecretName" .) -}}
{{- if and $existing $existing.data (index $existing.data "valkey-password") -}}
{{- $pw = index $existing.data "valkey-password" | b64dec -}}
{{- else -}}
{{- $pw = randAlphaNum 32 -}}
{{- end -}}
{{- end -}}
{{- $_ := set .Values._resolved "valkeyPassword" $pw -}}
{{- end -}}
{{- get .Values._resolved "valkeyPassword" -}}
{{- end -}}

{{/*
Server-side DATABASE_URL. Built from the resolved PostgreSQL password and the
subchart's service fullname when the bundled DB is enabled; falls back to an
operator-supplied `.Values.env.DATABASE_URL` when postgresql.enabled is false
(managed-DB / production path). Never rendered into a Deployment in plaintext —
it is stored only in the connection Secret.
*/}}
{{- define "trueppm.databaseUrl" -}}
{{- if .Values.postgresql.enabled -}}
{{- $host := printf "%s-postgresql" .Release.Name -}}
{{- $u := .Values.postgresql.auth.username -}}
{{- $p := include "trueppm.postgresqlPassword" . -}}
{{- $db := .Values.postgresql.auth.database -}}
{{- printf "postgres://%s:%s@%s:5432/%s" $u $p $host $db -}}
{{- else -}}
{{- required "postgresql.enabled is false: set env.DATABASE_URL to your managed database URL" (index .Values.env "DATABASE_URL") -}}
{{- end -}}
{{- end -}}

{{/*
Server-side REDIS_URL. When the bundled Valkey is enabled the host is derived
from the subchart fullname (so it stays correct on non-`trueppm` release names),
and the password is interpolated only when valkey.auth is enabled. Falls back to
operator-supplied `.Values.env.REDIS_URL` when valkey.enabled is false.
*/}}
{{- define "trueppm.redisUrl" -}}
{{- if .Values.valkey.enabled -}}
{{- $host := printf "%s-valkey-primary" .Release.Name -}}
{{- if .Values.valkey.auth.enabled -}}
{{- printf "redis://:%s@%s:6379" (include "trueppm.valkeyPassword" .) $host -}}
{{- else -}}
{{- printf "redis://%s:6379" $host -}}
{{- end -}}
{{- else -}}
{{- required "valkey.enabled is false: set env.REDIS_URL to your managed Redis/Valkey URL" (index .Values.env "REDIS_URL") -}}
{{- end -}}
{{- end -}}
