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
