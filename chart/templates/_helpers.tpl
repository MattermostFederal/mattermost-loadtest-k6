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

{{/* Resolve the script filename that k6 should run. */}}
{{- define "mmlt.scriptFile" -}}
{{- if eq .Values.script "load-readonly" -}}
load.js
{{- else -}}
{{ .Values.script }}.js
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
