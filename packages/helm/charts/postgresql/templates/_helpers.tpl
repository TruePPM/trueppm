{{/*
Service / workload name. Must resolve to `<release>-postgresql` so the parent's
DATABASE_URL host (`trueppm-postgresql`) keeps working unchanged.
*/}}
{{- define "postgresql.fullname" -}}
{{- printf "%s-postgresql" .Release.Name -}}
{{- end -}}

{{- define "postgresql.labels" -}}
app.kubernetes.io/name: postgresql
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "postgresql.selectorLabels" -}}
app.kubernetes.io/name: postgresql
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Name of the parent TruePPM chart's connection Secret — the single credential
source of truth shared with DATABASE_URL. Reconstructed from `.Release.Name`
(same convention as trueppm.urlSecretName) so the subchart binds to it without
needing a global threaded through. A parent-set
`global.trueppm.connectionSecretName` overrides it if present.
*/}}
{{- define "postgresql.parentConnectionSecret" -}}
{{- if and .Values.global .Values.global.trueppm .Values.global.trueppm.connectionSecretName -}}
{{- .Values.global.trueppm.connectionSecretName -}}
{{- else -}}
{{- printf "%s-trueppm-connection" .Release.Name -}}
{{- end -}}
{{- end -}}

{{/*
True when this subchart is rendered as part of the TruePPM parent chart (vs
standalone). We detect the parent by the presence of a global block — the parent
always supplies `global` (even if empty maps) via Helm's global propagation,
whereas a bare `helm template charts/postgresql` has no global.
*/}}
{{- define "postgresql.hasParent" -}}
{{- if and .Values.global .Values.global.trueppm -}}true{{- end -}}
{{- end -}}

