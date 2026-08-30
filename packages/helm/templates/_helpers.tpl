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
Tag for the first-party api / web images (#2811).

`.Values.image.tag` wins when set. When it is empty the chart pins itself to its
own appVersion — but the tag it must ask for is `v<appVersion>`, NOT the bare
version, because that is the only form the release pipeline ever pushes to the
registry this chart points at: api:publish / web:publish push
`${CI_REGISTRY_IMAGE}/<img>:${CI_COMMIT_TAG}` (v-prefixed) and `:latest`. The
bare `${VERSION}` tag exists only on ghcr.io, a different registry.

Rendering the bare appVersion — which the chart did until 0.4 — therefore made a
stock `helm install` permanently unresolvable: ImagePullBackOff on the `migrate`
init container, before the app logs anything an operator can act on.

Pushing an extra bare-version tag to the GitLab registry would also "fix" the
render, but it is the wrong side of the seam: the container-registry cleanup
policy keeps `^v.*$|^latest$` (#2803), so a bare `0.4.0` tag would fail the
keep-regex and be deleted by the daily sweep — a release image that pulls for a
few days and then 404s, which is the exact defect that policy was set to stop.
Keeping the chart on v-prefixed tags also matches what
scripts/check-release-images.sh probes.

Usage: {{ include "trueppm.imageTag" . }}
*/}}
{{- define "trueppm.imageTag" -}}
{{- .Values.image.tag | default (printf "v%s" .Chart.AppVersion) -}}
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
NetworkPolicy ingress `from:` podSelector list for a bundled datastore (#2560).

Emits one podSelector per component name in `.components`, each matching this
release's chart-level selector labels plus that component's
`app.kubernetes.io/component`. Factored out because the list was previously
duplicated verbatim across both datastore policies, and every duplicate is a place
for a component to be forgotten — which is exactly what happened: the `backup`
CronJob and `demo-seed` Job both open PostgreSQL but neither was listed, so with an
enforcing CNI their connections were dropped. Nothing caught it because the only
cluster the chart is installed on (kind, kindnetd) does not enforce NetworkPolicy
at all.

Usage: include "trueppm.datastoreClientSelectors" (dict "root" . "components" (list "api" "backup"))
*/}}
{{- define "trueppm.datastoreClientSelectors" -}}
{{- $root := .root -}}
{{- range .components }}
- podSelector:
    matchLabels:
      {{- include "trueppm.selectorLabels" $root | nindent 6 }}
      app.kubernetes.io/component: {{ . }}
{{- end }}
{{- end }}

{{/*
Build a list of env vars from values.env for use in container specs.

Each entry in .Values.env may be either:
  - a scalar (string / number / bool) → rendered as a literal `value:`
  - a map with a `secretKeyRef` key → rendered as `valueFrom: secretKeyRef`,
    e.g.  MY_VAR: { secretKeyRef: { name: my-secret, key: my-key } }

The secretKeyRef form lets an operator point any env var (e.g.
EMAIL_HOST_PASSWORD) at a Secret they already manage, so no credential is ever
rendered in plaintext into a Deployment manifest.

DATABASE_URL and REDIS_URL are deliberately EXCLUDED here (#2810). They are owned
end to end by trueppm.connectionEnv, which resolves whichever shape the operator
supplied to a single secretKeyRef. Emitting them here too produced two defects at
once: a duplicate env key (Kubernetes keeps the last, so the entry written here
never took effect anyway) and — for the plaintext string form on the managed-DB
path — the database password rendered verbatim into every api/worker/beat/init
container, which is exactly what the chart's "no plaintext credentials in any
Deployment" guarantee promises never happens.
*/}}
{{- define "trueppm.envVars" -}}
{{- range $key, $value := .Values.env }}
{{- if has $key (list "DATABASE_URL" "REDIS_URL") }}
{{- /* owned by trueppm.connectionEnv — see the note above */}}
{{- else if kindIs "map" $value }}
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
{{/* Actor attributes on the request span (#2880) — trueppm.user.id / .user.role.
     Rendered only when explicitly disabled, so the default path adds no env var
     and the app default (on) stands. */}}
{{- if hasKey . "actorAttributes" }}
{{- if not .actorAttributes }}
- name: TRUEPPM_OTEL_ACTOR_ATTRIBUTES_ENABLED
  value: "false"
{{- end }}
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
{{/*
Pod placement and scheduling (#3188).

None of nodeSelector / tolerations / affinity / topologySpreadConstraints /
imagePullSecrets / priorityClassName existed, and because values.schema.json
closes the root with additionalProperties:false they were not merely absent —
they were actively REJECTED. `--set imagePullSecrets[0].name=regcred` failed
schema validation, which meant an operator mirroring our images into a private
registry could not install the chart at all without forking it. There was no
air-gapped path.

Usage: include "trueppm.podPlacement" (dict "root" . "component" "api")

`component` is what makes topologySpreadConstraints correct rather than
decorative. A spread constraint needs a labelSelector, and a single global list
applied verbatim to four Deployments would spread whichever tier the operator's
selector happened to name and silently no-op on the rest. So the chart FILLS IN
the selector per tier — this release's selectorLabels plus that tier's
component — and honors an explicit labelSelector if the operator supplies one.
Write the constraint once; it means the right thing on every tier.
*/}}
{{/*
Graceful shutdown (#3188). Usage:
  include "trueppm.terminationGrace" (dict "root" . "tier" "api")
  include "trueppm.preStop"          (dict "root" . "tier" "api")

The preStop sleep runs `sleep` from the container's own shell rather than
Kubernetes' `sleep` lifecycle action, which is 1.29+ and behind a feature gate on
1.29-1.30 — the chart's floor is lower than that (Chart.yaml kubeVersion).
Emitted only when the tier's preStopSleepSeconds is > 0, so a tier that does not
want the hook gets no `lifecycle:` block at all rather than a no-op one.
*/}}
{{- define "trueppm.terminationGrace" -}}
{{- $tier := index .root.Values.lifecycle .tier -}}
{{- with $tier.terminationGracePeriodSeconds }}
terminationGracePeriodSeconds: {{ . }}
{{- end }}
{{- end -}}

{{- define "trueppm.preStop" -}}
{{- $tier := index .root.Values.lifecycle .tier -}}
{{- if gt (int $tier.preStopSleepSeconds) 0 }}
lifecycle:
  preStop:
    exec:
      # Endpoints/ingress deregistration is asynchronous with SIGTERM, so this
      # covers the window where the pod is terminating but still being routed
      # to — a race the application cannot win from inside.
      command: ["/bin/sh", "-c", "sleep {{ int $tier.preStopSleepSeconds }}"]
{{- end }}
{{- end -}}

{{- define "trueppm.podPlacement" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- with $root.Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $root.Values.priorityClassName }}
priorityClassName: {{ . | quote }}
{{- end }}
{{- with $root.Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $root.Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $root.Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $root.Values.topologySpreadConstraints }}
topologySpreadConstraints:
{{- range . }}
  - {{- if .labelSelector }}
    {{- toYaml . | nindent 4 }}
    {{- else }}
    {{- toYaml . | nindent 4 }}
    labelSelector:
      matchLabels:
        {{- include "trueppm.selectorLabels" $root | nindent 8 }}
        app.kubernetes.io/component: {{ $component }}
    {{- end }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "trueppm.appEnv" -}}
{{ include "trueppm.envVars" . }}
{{ include "trueppm.connectionEnv" . }}
{{ include "trueppm.datastoreSecurityEnv" . }}
{{ include "trueppm.mediaEnv" . }}
{{ include "trueppm.observabilityEnv" . }}
{{ include "trueppm.loggingEnv" . }}
{{- end -}}

{{/*
Attachment/media volume (#3184).

Four defines, because the media claim has to reach every container that imports
Django settings, not just the ones that serve uploads: settings/prod.py probes
MEDIA_ROOT for writability at import time, so an unmounted migrate init container
crash-loops the api pod before the api container is ever created.

  trueppm.mediaEnv          TRUEPPM_MEDIA_ROOT, derived from mountPath so the app
                            and the volume cannot disagree. Yields to an explicit
                            env.TRUEPPM_MEDIA_ROOT.
  trueppm.mediaVolume       the pod-level `volumes:` entry
  trueppm.mediaVolumeMount  the container-level `volumeMounts:` entry
  trueppm.mediaClaimName    chart-created claim, or the operator's existingClaim

The access-mode guard lives in mediaVolume so it fires from every workload that
mounts the claim, and only for a claim the chart itself creates — the mode of an
existingClaim is not ours to police and cannot be read at render time.
*/}}
{{- define "trueppm.mediaClaimName" -}}
{{- if .Values.persistence.media.existingClaim -}}
{{- .Values.persistence.media.existingClaim -}}
{{- else -}}
{{- printf "%s-media" (include "trueppm.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "trueppm.mediaEnv" -}}
{{- if and .Values.persistence.media.enabled (not (hasKey .Values.env "TRUEPPM_MEDIA_ROOT")) }}
- name: TRUEPPM_MEDIA_ROOT
  value: {{ .Values.persistence.media.mountPath | quote }}
{{- end -}}
{{- end -}}

{{- define "trueppm.mediaVolume" -}}
{{- if .Values.persistence.media.enabled -}}
{{- $media := .Values.persistence.media -}}
{{- if and (not $media.existingClaim) (ne $media.accessMode "ReadWriteMany") -}}
{{- if or (gt (int .Values.replicaCount) 1) .Values.autoscaling.enabled -}}
{{- fail (printf "persistence.media.accessMode is %q with more than one API replica (replicaCount=%d, autoscaling.enabled=%t). A ReadWriteOnce claim binds to one node, so an upload accepted by one API pod is a 404 from every other one. Use accessMode: ReadWriteMany, or put attachments on object storage (TRUEPPM_DEFAULT_FILE_STORAGE + TRUEPPM_S3_BUCKET_NAME) and set persistence.media.enabled=false." $media.accessMode (int .Values.replicaCount) .Values.autoscaling.enabled) -}}
{{- end -}}
{{- end -}}
- name: media
  persistentVolumeClaim:
    claimName: {{ include "trueppm.mediaClaimName" . }}
{{- end -}}
{{- end -}}

{{- define "trueppm.mediaVolumeMount" -}}
{{- if .Values.persistence.media.enabled -}}
- name: media
  mountPath: {{ .Values.persistence.media.mountPath | quote }}
{{- end -}}
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
Is DATABASE_URL supplied as a reference to a Secret the OPERATOR owns (the map
form, `env.DATABASE_URL: {secretKeyRef: {name:…, key:…}}`) rather than as a
string the chart must store for them? Non-empty output = true.

Only meaningful on the managed-DB path: when the bundled PostgreSQL is enabled
the chart builds the URL itself and env.DATABASE_URL is rejected outright (see
trueppm.databaseUrl).
*/}}
{{- define "trueppm.databaseUrlIsExternalRef" -}}
{{- if not .Values.postgresql.enabled -}}
{{- if kindIs "map" (index (.Values.env | default dict) "DATABASE_URL") -}}
true
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Same question for REDIS_URL against the bundled Valkey. Honored even under
Sentinel: the app ignores REDIS_URL entirely when TRUEPPM_VALKEY_SENTINELS is
set, so an operator-supplied reference is harmless there and it is better to
pass their value through than to silently substitute the chart's placeholder.
*/}}
{{- define "trueppm.redisUrlIsExternalRef" -}}
{{- if not .Values.valkey.enabled -}}
{{- if kindIs "map" (index (.Values.env | default dict) "REDIS_URL") -}}
true
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
The `secretKeyRef` body (name + key, no indentation of its own) that a connection
URL env var is injected from. Two sources, and exactly one is used per URL:

  - the chart-owned connection Secret — the default, and the only option on the
    bundled path. The operator's string URL is stored there by templates/secret.yaml.
  - a Secret the operator already manages, when they supplied the map form.
    The chart then never sees, stores, or re-emits the credential at all.

Usage: include "trueppm.connectionSecretRef" (dict "root" . "var" "DATABASE_URL" "external" (include "trueppm.databaseUrlIsExternalRef" .))
*/}}
{{- define "trueppm.connectionSecretRef" -}}
{{- if .external -}}
{{- $ref := (index .root.Values.env .var).secretKeyRef | default dict -}}
name: {{ required (printf "env.%s is a map, so it must be the secretKeyRef form: set env.%s.secretKeyRef.name to the Secret holding the URL" .var .var) $ref.name }}
key: {{ required (printf "env.%s is a map, so it must be the secretKeyRef form: set env.%s.secretKeyRef.key to the key inside that Secret" .var .var) $ref.key }}
{{- else -}}
name: {{ include "trueppm.urlSecretName" .root }}
key: {{ .var }}
{{- end -}}
{{- end -}}

{{/*
DATABASE_URL / REDIS_URL env entries. ALWAYS a secretKeyRef — never a literal
value — so the password is never rendered into a Deployment manifest in
plaintext, whichever shape the operator configured (#2810). This helper is the
single owner of these two keys; trueppm.envVars deliberately skips them.

The Valkey Sentinel block is appended here rather than in each Deployment so it
reaches every container that already receives REDIS_URL. Adding it per-workload
would silently miss one — and a worker that resolves a different primary from the
API is exactly the split-brain this issue set out to remove.
*/}}
{{- define "trueppm.connectionEnv" -}}
{{- include "trueppm.databaseUrlEnv" . }}
- name: REDIS_URL
  valueFrom:
    secretKeyRef:
      {{- include "trueppm.connectionSecretRef" (dict "root" . "var" "REDIS_URL" "external" (include "trueppm.redisUrlIsExternalRef" .)) | nindent 6 }}
{{- include "trueppm.valkeySentinelEnv" . }}
{{- end -}}

{{/*
Just the DATABASE_URL env entry. Split out of trueppm.connectionEnv so the backup
CronJob — which needs the database and nothing else — resolves it identically. A
second hand-written copy there is how the map form would come back broken for
backups only, silently, on the one workload nobody watches until a restore.
*/}}
{{- define "trueppm.databaseUrlEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      {{- include "trueppm.connectionSecretRef" (dict "root" . "var" "DATABASE_URL" "external" (include "trueppm.databaseUrlIsExternalRef" .)) | nindent 6 }}
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

Scope: this clears the #1550 DB-encryption guard ONLY. settings.prod has four
other import-time guards — SECRET_KEY, ALLOWED_HOSTS, the attachment-storage
choice, and INTEGRATION_ENCRYPTION_KEY — that no chart default can satisfy,
because their values are the operator's secrets. An install that supplies no
app-env source still crash-loops in the migrate init container; NOTES.txt says so
at install time.

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
Server-side DATABASE_URL, for storage in the chart-owned connection Secret. Built
from the resolved PostgreSQL password and the subchart's service fullname when the
bundled DB is enabled; falls back to an operator-supplied string
`.Values.env.DATABASE_URL` when postgresql.enabled is false (managed-DB /
production path). Never rendered into a Deployment in plaintext — it is stored
only in the connection Secret.

NOT called when the operator supplied the secretKeyRef map form: that URL lives in
their own Secret and the chart must not copy it (templates/secret.yaml guards on
trueppm.databaseUrlIsExternalRef). Calling it there would stringify the map into
`map[secretKeyRef:map[…]]`, which is exactly the crash-loop #2810 fixed.
*/}}
{{- define "trueppm.databaseUrl" -}}
{{- if .Values.postgresql.enabled -}}
{{- if hasKey (.Values.env | default dict) "DATABASE_URL" -}}
{{- fail "postgresql.enabled is true, so the chart builds DATABASE_URL from the bundled database's own generated credentials — env.DATABASE_URL would be silently ignored. Remove it, or set postgresql.enabled=false to point at a managed database." -}}
{{- end -}}
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
Server-side REDIS_URL, for storage in the chart-owned connection Secret. When the
bundled Valkey is enabled the host is derived from the subchart fullname (so it
stays correct on non-`trueppm` release names), and the password is interpolated
only when valkey.auth is enabled. Falls back to an operator-supplied string
`.Values.env.REDIS_URL` when valkey.enabled is false.

Not called for the secretKeyRef map form — same contract as trueppm.databaseUrl.
*/}}
{{- define "trueppm.redisUrl" -}}
{{- if .Values.valkey.enabled -}}
{{- if hasKey (.Values.env | default dict) "REDIS_URL" -}}
{{- fail "valkey.enabled is true, so the chart builds REDIS_URL from the bundled Valkey's own generated credentials — env.REDIS_URL would be silently ignored. Remove it, or set valkey.enabled=false to point at a managed Valkey/Redis." -}}
{{- end -}}
{{- $host := printf "%s-valkey-primary" .Release.Name -}}
{{- if .Values.valkey.auth.enabled -}}
{{- printf "redis://:%s@%s:6379" (include "trueppm.valkeyPassword" .) $host -}}
{{- else -}}
{{- printf "redis://%s:6379" $host -}}
{{- end -}}
{{- else if (include "trueppm.valkeySentinelEnabled" .) -}}
{{/* Sentinel mode discovers the primary from the sentinels, so there is no
     single URL to supply. Emit the app's own default rather than requiring one;
     settings ignores REDIS_URL entirely when TRUEPPM_VALKEY_SENTINELS is set,
     and its trueppm.valkey.W001 check warns if a stale value is left behind. */}}
{{- printf "redis://redis:6379" -}}
{{- else -}}
{{- required "valkey.enabled is false: set env.REDIS_URL to your managed Valkey/Redis URL, or configure valkey.sentinel" (index .Values.env "REDIS_URL") -}}
{{- end -}}
{{- end -}}

{{/*
Whether external Valkey Sentinel is configured. Non-empty string = true (Helm's
truthiness convention for template output). Sentinel REPLACES the bundled pod, so
it is only honored when valkey.enabled is false — otherwise an operator who set
both would get a chart that renders bundled-pod credentials while the app talks
to a completely different cluster, with nothing to signal the mismatch.
*/}}
{{- define "trueppm.valkeySentinelEnabled" -}}
{{- if and (not .Values.valkey.enabled) .Values.valkey.sentinel .Values.valkey.sentinel.enabled -}}
{{- required "valkey.sentinel.enabled is true: set valkey.sentinel.nodes to a comma-separated host:port list" .Values.valkey.sentinel.nodes | trim | trunc 0 -}}
{{- required "valkey.sentinel.enabled is true: set valkey.sentinel.masterName to the name the sentinels monitor (e.g. mymaster)" .Values.valkey.sentinel.masterName | trim | trunc 0 -}}
true
{{- end -}}
{{- end -}}

{{/*
Non-secret Valkey Sentinel env for the API and worker containers. The two
passwords are deliberately NOT here — they go through the chart-owned connection
Secret via trueppm.valkeySentinelSecretEnv so they are never rendered in
plaintext into a Deployment manifest.
*/}}
{{- define "trueppm.valkeySentinelEnv" -}}
{{- if (include "trueppm.valkeySentinelEnabled" .) }}
- name: TRUEPPM_VALKEY_SENTINELS
  value: {{ .Values.valkey.sentinel.nodes | quote }}
- name: TRUEPPM_VALKEY_MASTER_NAME
  value: {{ .Values.valkey.sentinel.masterName | quote }}
- name: TRUEPPM_VALKEY_USE_TLS
  value: {{ .Values.valkey.sentinel.tls | default false | quote }}
{{- if .Values.valkey.sentinel.password }}
- name: TRUEPPM_VALKEY_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "trueppm.urlSecretName" . }}
      key: TRUEPPM_VALKEY_PASSWORD
{{- end }}
{{- if .Values.valkey.sentinel.sentinelPassword }}
- name: TRUEPPM_VALKEY_SENTINEL_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "trueppm.urlSecretName" . }}
      key: TRUEPPM_VALKEY_SENTINEL_PASSWORD
{{- end }}
{{- end }}
{{- end -}}

{{/*
Boot-guard preflight for NOTES.txt (#2812).

settings.prod enforces four values at IMPORT time (packages/api/src/trueppm_api/
settings/prod.py): ALLOWED_HOSTS, SECRET_KEY, an attachment-storage choice, and
INTEGRATION_ENCRYPTION_KEY. gunicorn/uvicorn workers never run `manage.py check`,
so a missing value is not a warning — it raises at settings import and crash-loops
the pod, and because the migrate/bootstrap init containers import the same settings
the failure lands there first, before any app log an operator would think to read.

The chart cannot supply these (they are the operator's secrets) and cannot fail the
render on them either: an `envFrom` Secret's keys are invisible at render time, so
a hard render guard would block the correct configuration. The check is therefore
deliberately narrow — warn only when NO app-env source is configured at all:
`envFrom` is empty AND the key is absent from `.Values.env`. That is exactly the
shape every documented minimal install had, and it is unambiguously broken. A
notice that fires on a correctly-configured release is a notice nobody reads.

`len(envFrom) > 0` is a WEAK signal and #2879 is why: `envFrom` is a LIST, so a
values file that sets it REPLACES the operator's entry rather than appending to it.
A release whose only source became an unrelated Secret (the telemetry card used to
emit `envFrom: [{secretRef: {name: trueppm-otel-auth}}]`) still passes the length
test and still crash-loops. The chart cannot tell which Secret carries which key —
so instead of guessing, the quiet branch NAMES every source it is trusting and says
the list is replace-not-merge. An operator who lost `trueppm-env` can then see it
missing from a line they will actually read, which is the most the render can honestly do.

Factored out of NOTES.txt so the logic is reachable by `helm template` — see the
note at the top of NOTES.txt for why `helm install --dry-run` cannot test it.
*/}}
{{- define "trueppm.bootGuardNotice" -}}
{{- $env := .Values.env | default dict }}
{{- $envFrom := .Values.envFrom | default list }}
{{- $hasEnvFrom := gt (len $envFrom) 0 }}
{{- $sources := list }}
{{- range $envFrom }}
  {{- if .secretRef }}{{ $sources = append $sources (printf "Secret/%s" .secretRef.name) }}{{ end }}
  {{- if .configMapRef }}{{ $sources = append $sources (printf "ConfigMap/%s" .configMapRef.name) }}{{ end }}
{{- end }}
{{- $missing := list }}
{{- if not $hasEnvFrom }}
  {{- if not (hasKey $env "SECRET_KEY") }}{{ $missing = append $missing "SECRET_KEY" }}{{ end }}
  {{- if not (hasKey $env "ALLOWED_HOSTS") }}{{ $missing = append $missing "ALLOWED_HOSTS" }}{{ end }}
  {{- if not (hasKey $env "INTEGRATION_ENCRYPTION_KEY") }}{{ $missing = append $missing "INTEGRATION_ENCRYPTION_KEY" }}{{ end }}
  {{- if and (not (hasKey $env "TRUEPPM_DEFAULT_FILE_STORAGE")) (not (hasKey $env "TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE")) }}
    {{- $missing = append $missing "TRUEPPM_DEFAULT_FILE_STORAGE (+ TRUEPPM_S3_BUCKET_NAME) or TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true" }}
  {{- end }}
{{- end }}
{{- if $missing }}
##############################################################################
##  THIS RELEASE WILL NOT START — required application secrets are missing  ##
##############################################################################

No app-env source is configured: `envFrom` is empty and none of the required keys
are set under `env`. settings.prod validates these at import time, so the pod will
crash-loop in the `migrate` init container before the API ever runs.

Missing:
{{- range $missing }}
  - {{ . }}
{{- end }}

Fix it without reinstalling — create the Secret, then `helm upgrade` to reference it:

  kubectl create secret generic trueppm-env -n {{ .Release.Namespace }} \
    --from-literal=SECRET_KEY="$(openssl rand -base64 48)" \
    --from-literal=ALLOWED_HOSTS=trueppm.example.com \
    --from-literal=INTEGRATION_ENCRYPTION_KEY="$(python3 -c \
      'import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode())')" \
    --from-literal=TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true

  helm upgrade {{ .Release.Name }} <chart> -n {{ .Release.Namespace }} \
    --reuse-values --set 'envFrom[0].secretRef.name=trueppm-env'

TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true keeps task attachments on the pod's
ephemeral disk — they are LOST on restart. For durable attachments set
TRUEPPM_DEFAULT_FILE_STORAGE=storages.backends.s3.S3Storage and
TRUEPPM_S3_BUCKET_NAME instead.

Full reference: packages/helm/README.md, "Required secrets (prod refuses to boot
without them)".
{{- else }}
Required application secrets: configured{{ if $hasEnvFrom }} via envFrom{{ end }}.
{{- if $hasEnvFrom }}
App-env sources this release trusts for SECRET_KEY, ALLOWED_HOSTS,
INTEGRATION_ENCRYPTION_KEY and the attachment-storage choice:
{{- range $sources }}
  - {{ . }}
{{- end }}
If a Secret you expected is NOT listed, a values file replaced the list: `envFrom`
is a list, so Helm REPLACES it wholesale instead of merging. Re-list every source
you need in one place. The chart cannot read a Secret's keys at render time, so this
list is the only check available before the pod starts.
{{- end }}
{{- if not .Values.postgresql.enabled }}
Using an external database — settings.prod refuses to boot unless env.DATABASE_URL
carries `sslmode=require` (or TRUEPPM_ALLOW_UNENCRYPTED_DB=true when TLS is
enforced at the network layer).
{{- end }}
{{- end }}
{{- end -}}

{{/*
Host header for the api container's HTTP probes (#3183).

kubelet connects to a probe by POD IP, so without an explicit Host header it
sends `Host: <podIP>:8000`. Django validates that against ALLOWED_HOSTS *before*
any view runs — in HttpRequest.get_host(), which no SECURE_REDIRECT_EXEMPT entry
reaches — so a correct, documented `ALLOWED_HOSTS=trueppm.example.com` makes
/readyz return 400 DisallowedHost. The pod never turns Ready, the Service never
gets an endpoint, and the Ingress serves 503 with nothing in the output naming
ALLOWED_HOSTS.

Resolution order: an explicit probes.api.hostHeader, else the first ingress host
(the name the operator already had to put in ALLOWED_HOSTS to serve traffic at
all). Empty renders NO header, preserving the by-pod-IP behavior for a wildcard
ALLOWED_HOSTS dev install.
*/}}
{{- define "trueppm.probeHostHeader" -}}
{{- if .Values.probes.api.hostHeader -}}
{{- .Values.probes.api.hostHeader -}}
{{- else if .Values.ingress.hosts -}}
{{- (first .Values.ingress.hosts).host | default "" -}}
{{- end -}}
{{- end -}}
