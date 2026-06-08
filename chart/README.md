# mattermost-loadtest-k6 (Helm chart)

Runs the [mattermost-loadtest-k6](..) scripts as a Kubernetes Job. The chart can also bootstrap the test team / channels / users on install and tear them down on uninstall.

For non-Helm operation (local `make` targets, bare Linux, air-gap), see the [top-level README](../README.md).

## Two ways to use it

### Mode A — secure (you pre-create users, no admin needed)

Best when you can't or don't want to give the chart admin credentials.

```sh
helm install lt ./chart \
  --set mattermost.url=https://mattermost.example.com \
  --set-file users.file=./users.json
```

`users.file` is the raw contents of a JSON or CSV file you supply at install time. Helm stores it as a Secret in the cluster. No admin access required during the run.

### Mode B — full lifecycle (chart manages everything)

Best for ephemeral / on-demand load tests where you want a clean install/uninstall cycle.

```sh
helm install lt ./chart \
  --set mattermost.url=https://mattermost.example.com \
  --set bootstrap.enabled=true \
  --set bootstrap.numUsers=100 \
  --set bootstrap.numChannels=10 \
  --set admin.email=sysadmin@example.com \
  --set admin.password='YourAdminPassword!'
```

What happens:

1. **Pre-run (initContainer)**: `bootstrap.js` logs in as admin and creates 1 public team (`lt-<release-name>`), N public channels, N users — all named with `lt-<release-name>-` prefix.
2. **Main container**: `k6 run /scripts/load.js` with `RUN_ID=<release-name>`. Users derived from RUN_ID — no users file needed.
3. **On `helm uninstall`**: pre-delete hook runs:
   - `cleanup-posts` as initContainer — deletes posts marked `[lt-<release-name>]`
   - `cleanup-teardown` as main container — runs the teardown sweep when `cleanup.teardownMode != none`

For deletion mode semantics (none/soft/hard) including the writeFilter gotcha and recovery procedure, see [../docs/cleanup-teardown.md](../docs/cleanup-teardown.md).

## Picking the script

Set `script` to one of:

| Value | What it runs |
|---|---|
| `load` (default) | Full weighted-action scenario |
| `load-readonly` | Same scenario, all writes are no-ops |
| `smoke` | 1 VU for 30s — sanity check |
| `preflight` | Confirms each user has teams + channels |
| `cleanup` | Just runs the post cleanup (without uninstalling) |
| `breakpoint` | Ramp until write p95 > `breakpoint.writeP95Ms`, abort. Capacity discovery in one run. |
| `load-search` | Search-heavy mix — stresses Elasticsearch |
| `load-attachments` | File-upload-heavy mix — stresses S3 / MinIO / local disk |
| `load-realtime` | WebSocket-fanout-heavy mix — stresses the Go app server |

```sh
# Capacity discovery example:
helm install lt ./chart \
  --set script=breakpoint \
  --set bootstrap.enabled=true \
  --set admin.email=... --set admin.password=... \
  --set breakpoint.maxVUs=2000 --set breakpoint.duration=45m \
  --set breakpoint.writeP95Ms=800
```

See [../docs/capacity-testing.md](../docs/capacity-testing.md) for the four scenarios in detail.

## Streaming metrics to Grafana

Set `metrics.prometheusRemoteWrite.url` to a remote-write endpoint (Prometheus with `--web.enable-remote-write-receiver`, Mimir, Cortex, or Alloy with `prometheus.receive_http`):

```sh
helm install lt ./chart \
  --set metrics.prometheusRemoteWrite.url=https://prom.internal:9090/api/v1/write \
  --set metrics.prometheusRemoteWrite.username=k6 \
  --set metrics.prometheusRemoteWrite.password='...'
```

For production, pre-create a secret instead of passing the password through `--set`:

```sh
kubectl create secret generic mm-prom \
  --from-literal=PROM_USERNAME=k6 \
  --from-literal=PROM_PASSWORD='...'

helm install lt ./chart \
  --set metrics.prometheusRemoteWrite.url=https://prom.internal:9090/api/v1/write \
  --set metrics.prometheusRemoteWrite.existingSecret=mm-prom
```

> **Auth-mode hygiene with `existingSecret`**: when inline `username`+`bearerToken` are both set, the chart `fail`s template rendering. The chart cannot validate `existingSecret` contents — if your pre-created secret contains both `PROM_USERNAME`/`PROM_PASSWORD` AND `PROM_BEARER_TOKEN`, k6 will receive both env vars. Keep your existingSecret to one auth mode.

Import Grafana dashboard ID **19665**. See [../docs/metrics-grafana.md](../docs/metrics-grafana.md) for full details.

## SLO thresholds

All load/breakpoint scripts share `scripts/lib/thresholds.js`. Override per-environment via `metrics.slo.*`:

```yaml
metrics:
  slo:
    writeP95Ms: 800           # tighter than default for prod
    readP95Ms: 300
    httpReqFailed: 0.01
```

Leave `metrics.slo: {}` to use the script defaults. See [../docs/capacity-testing.md#shared-slo-thresholds](../docs/capacity-testing.md#shared-slo-thresholds).

## Bootstrap verification

Every load/breakpoint script calls `verifyBootstrap()` from `setup()` — when bootstrap mode is on and admin creds are present, the test does one admin login + check for `lt-<release-name>-u1` before any VU starts. Set `extraEnv: [{name: VERIFY_BOOTSTRAP, value: "false"}]` to skip.

## Common values

```yaml
mattermost:
  url: https://mattermost.example.com
  insecureSkipTLSVerify: false        # set true for self-signed certs

bootstrap:
  enabled: false                       # set true for Mode B
  numUsers: 50
  numChannels: 5

admin:
  email: ""                            # required if bootstrap.enabled
  password: ""
  existingSecret: ""                   # OR pre-create a secret with ADMIN_EMAIL/ADMIN_PASSWORD

users:                                 # only used if bootstrap.enabled = false
  file: ""                             # set via --set-file
  format: json                         # or csv
  existingSecret: ""

load:
  targetVUs: 50
  rampUpSec: 60
  steadySec: 300
  rampDownSec: 30

cleanup:
  posts: true                          # delete [lt-<release>] posts on uninstall
  passes: 1
  passDelaySec: 30
  teardownMode: none                   # none | soft | hard
```

Full reference: see `values.yaml` and [../docs/configuration.md](../docs/configuration.md).

## Operating

```sh
# install
helm install lt ./chart -f my-values.yaml

# watch
kubectl get jobs -l app.kubernetes.io/instance=lt -w
kubectl logs -f job/lt-mattermost-loadtest-k6 -c k6          # main run
kubectl logs -f job/lt-mattermost-loadtest-k6 -c bootstrap   # if bootstrap is on

# uninstall — triggers MM-side cleanup
helm uninstall lt
```

## What gets created in the cluster

- `Job/<release>-mattermost-loadtest-k6` — the load run (initContainer runs bootstrap when enabled)
- `ConfigMap/<release>-mattermost-loadtest-k6-scripts` — the JS scripts
- `Secret/<release>-mattermost-loadtest-k6-users` — only if `users.file` is set (Mode A)
- `Secret/<release>-mattermost-loadtest-k6-admin` — only if `admin.email/password` is set
- `Secret/<release>-mattermost-loadtest-k6-prom` — only if `metrics.prometheusRemoteWrite.username` or `bearerToken` is set
- `ServiceAccount/<release>-mattermost-loadtest-k6` — if `serviceAccount.create`
- `Job/<release>-mattermost-loadtest-k6-cleanup` — appears briefly during `helm uninstall`

All cleaned by `helm uninstall`. The main Job auto-deletes itself `ttlSecondsAfterFinished` seconds (default 300) after completion.

## Troubleshooting

See [../docs/troubleshooting.md](../docs/troubleshooting.md) for the full failure-mode index.

Common Helm-specific issues:

- **Pre-delete hook stuck** — `kubectl logs job/<release>-mattermost-loadtest-k6-cleanup -c cleanup-posts` (initContainer) and `-c cleanup-teardown` (main). If init failed, teardown never runs (by design).
- **`ErrImagePull` in air-gap** — `image.tag: latest` won't work; pin to `2.0.0` or whatever you mirrored.
- **"Either users.file or users.existingSecret must be set"** — turn bootstrap on, or supply `users.file`/`users.existingSecret`.

## Updating the bundled scripts

The chart vendors `../scripts/` into `chart/files/scripts/`. After editing scripts:

```sh
make chart-sync     # copy scripts/ -> chart/files/scripts/
make chart-lint     # helm lint
make chart-package  # builds dist/mattermost-loadtest-k6-x.y.z.tgz
```
