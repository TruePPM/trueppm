{{/*
Service / workload name. Must resolve to `<release>-valkey-primary` so the
parent's REDIS_URL host (`trueppm-valkey-primary`) keeps working unchanged
(this mirrors the Bitnami valkey chart's `-primary` suffix).
*/}}
{{- define "valkey.fullname" -}}
{{- printf "%s-valkey-primary" .Release.Name -}}
{{- end -}}

{{- define "valkey.labels" -}}
app.kubernetes.io/name: valkey
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "valkey.selectorLabels" -}}
app.kubernetes.io/name: valkey
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Name of the parent TruePPM chart's connection Secret — the single credential
source of truth shared with REDIS_URL. Reconstructed from `.Release.Name` (same
convention as trueppm.urlSecretName); a parent-set
`global.trueppm.connectionSecretName` overrides it.
*/}}
{{- define "valkey.parentConnectionSecret" -}}
{{- if and .Values.global .Values.global.trueppm .Values.global.trueppm.connectionSecretName -}}
{{- .Values.global.trueppm.connectionSecretName -}}
{{- else -}}
{{- printf "%s-trueppm-connection" .Release.Name -}}
{{- end -}}
{{- end -}}

{{/*
True when rendered under the TruePPM parent chart (detected via the presence of
the parent's global block).
*/}}
{{- define "valkey.hasParent" -}}
{{- if and .Values.global .Values.global.trueppm -}}true{{- end -}}
{{- end -}}
