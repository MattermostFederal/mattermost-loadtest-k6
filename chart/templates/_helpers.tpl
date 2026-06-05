{{/*
Standard name helpers.
*/}}
{{- define "mmlt.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "mmlt.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "mmlt.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "mmlt.labels" -}}
helm.sh/chart: {{ include "mmlt.chart" . }}
app.kubernetes.io/name: {{ include "mmlt.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{- end -}}

{{- define "mmlt.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mmlt.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "mmlt.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "mmlt.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Resolve the script filename that k6 should run.
   load-readonly is load.js with READ_ONLY=true. Everything else maps 1:1. */}}
{{- define "mmlt.scriptFile" -}}
{{- if eq .Values.script "load-readonly" -}}
load.js
{{- else -}}
{{ .Values.script }}.js
{{- end -}}
{{- end -}}

{{/* Prometheus remote-write env vars + the -o argument. Empty when no URL
   is configured, so the resulting Job has no metrics output. */}}
{{- define "mmlt.metricsArgs" -}}
{{- if .Values.metrics.prometheusRemoteWrite.url -}}
- "-o"
- "experimental-prometheus-rw"
- "--tag"
- "run_id={{ .Release.Name }}"
{{- end -}}
{{- end -}}

{{- define "mmlt.metricsEnv" -}}
{{- if .Values.metrics.prometheusRemoteWrite.url -}}
{{- $secret := .Values.metrics.prometheusRemoteWrite.existingSecret | default (printf "%s-prom" (include "mmlt.fullname" .)) -}}
- name: K6_PROMETHEUS_RW_SERVER_URL
  value: {{ .Values.metrics.prometheusRemoteWrite.url | quote }}
- name: K6_PROMETHEUS_RW_PUSH_INTERVAL
  value: {{ .Values.metrics.prometheusRemoteWrite.pushInterval | quote }}
{{- if .Values.metrics.prometheusRemoteWrite.insecureSkipTLSVerify }}
- name: K6_PROMETHEUS_RW_INSECURE_SKIP_TLS_VERIFY
  value: "true"
{{- end }}
{{- if or .Values.metrics.prometheusRemoteWrite.username .Values.metrics.prometheusRemoteWrite.existingSecret }}
- name: K6_PROMETHEUS_RW_USERNAME
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: PROM_USERNAME
      optional: true
- name: K6_PROMETHEUS_RW_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: PROM_PASSWORD
      optional: true
{{- end }}
{{- if or .Values.metrics.prometheusRemoteWrite.bearerToken .Values.metrics.prometheusRemoteWrite.existingSecret }}
- name: K6_PROMETHEUS_RW_BEARER_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: PROM_BEARER_TOKEN
      optional: true
{{- end }}
{{- end -}}
{{- end -}}

{{/* Name of the users secret (either user-provided or chart-created). */}}
{{- define "mmlt.usersSecretName" -}}
{{- if .Values.users.existingSecret -}}
{{- .Values.users.existingSecret -}}
{{- else -}}
{{- printf "%s-users" (include "mmlt.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* Key inside the users secret. */}}
{{- define "mmlt.usersSecretKey" -}}
{{- if .Values.users.existingSecret -}}
{{- .Values.users.existingSecretKey -}}
{{- else if eq .Values.users.format "csv" -}}
users.csv
{{- else -}}
users.json
{{- end -}}
{{- end -}}

{{/* USERS_FILE env value (path inside the container). */}}
{{- define "mmlt.usersFilePath" -}}
{{- printf "/users/%s" (include "mmlt.usersSecretKey" .) -}}
{{- end -}}

{{/*
cleanup-posts env block — used both as initContainer (when teardown is also
active) and as the main container (when only cleanup runs). Keeping it in
one place prevents drift between the two invocation sites in job-cleanup.yaml.
*/}}
{{- define "mmlt.cleanupEnv" -}}
- name: MM_URL
  value: {{ .Values.mattermost.url | quote }}
- name: RUN_ID
  value: {{ .Release.Name | quote }}
{{- if .Values.bootstrap.enabled }}
# Mode B: admin creds drive cleanup.js's admin path (single login,
# scoped to the bootstrap team, no user file or BOOTSTRAP_NUM_USERS).
{{- include "mmlt.adminEnv" . | nindent 0 }}
{{- else }}
- name: USERS_FILE
  value: {{ include "mmlt.usersFilePath" . | quote }}
{{- end }}
- name: CLEANUP_PASSES
  value: {{ .Values.cleanup.passes | quote }}
- name: CLEANUP_PASS_DELAY_SEC
  value: {{ .Values.cleanup.passDelaySec | quote }}
{{- /* When teardownMode=hard, permanent post delete cleans files. */}}
{{- if and .Values.bootstrap.enabled (eq .Values.cleanup.teardownMode "hard") }}
- name: CLEANUP_PERMANENT
  value: "true"
{{- end }}
{{- if .Values.bootstrap.enabled }}
# Helm pre-delete hook is idempotent — a re-run after the team is already
# gone (post-uninstall, partial bootstrap) should exit 0 cleanly. The
# script defaults to false (loud abort) for safer local CLI use; we
# explicitly opt in here.
- name: CLEANUP_ALLOW_MISSING_TEAM
  value: "true"
{{- end }}
{{- end -}}

{{/*
cleanup-teardown env block. Mirror of cleanupEnv so each cleanup hook
container references one canonical helper.
*/}}
{{- define "mmlt.teardownEnv" -}}
- name: MM_URL
  value: {{ .Values.mattermost.url | quote }}
- name: RUN_ID
  value: {{ .Release.Name | quote }}
- name: TEARDOWN_MODE
  value: {{ .Values.cleanup.teardownMode | quote }}
{{ include "mmlt.adminEnv" . }}
{{- end -}}

{{/*
Admin env vars (ADMIN_EMAIL, ADMIN_PASSWORD) wired from the admin secret.
The secret is either user-provided or chart-managed.
*/}}
{{- define "mmlt.adminEnv" -}}
{{- $secret := .Values.admin.existingSecret | default (printf "%s-admin" (include "mmlt.fullname" .)) -}}
- name: ADMIN_EMAIL
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: ADMIN_EMAIL
- name: ADMIN_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: ADMIN_PASSWORD
{{- end -}}
