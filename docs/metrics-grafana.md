# Real-time metrics → Grafana

Setting `K6_PROMETHEUS_RW_SERVER_URL` on any of the load/breakpoint targets makes k6 push metrics in real time to Prometheus remote-write. Works the same whether the endpoint is Prometheus itself or Alloy acting as a receiver.

## Quick start

```sh
# Direct Prometheus (needs --web.enable-remote-write-receiver on the Prom side):
K6_PROMETHEUS_RW_SERVER_URL=https://prom.internal:9090/api/v1/write make breakpoint

# Alloy with a prometheus.receive_http component:
K6_PROMETHEUS_RW_SERVER_URL=https://alloy.internal:9090/api/v1/write make breakpoint
```

The Makefile auto-tags every series with `run_id=$RUN_ID` so different runs are distinguishable in Grafana. Set `RUN_ID=capacity-2026-06-04-baseline` (or similar) before invoking and you can overlay runs in the dashboard.

## Auth and TLS knobs

k6's standard env vars (the Makefile passes them through unchanged):

| Env var | Use |
|---|---|
| `K6_PROMETHEUS_RW_USERNAME` / `K6_PROMETHEUS_RW_PASSWORD` | Basic auth (Mimir multi-tenant uses this) |
| `K6_PROMETHEUS_RW_BEARER_TOKEN` | Bearer token |
| `K6_PROMETHEUS_RW_INSECURE_SKIP_TLS_VERIFY=true` | Self-signed certs (federal envs often need this) |
| `K6_PROMETHEUS_RW_PUSH_INTERVAL` | Flush cadence (default `5s`; lower for finer dashboard resolution) |

## Grafana dashboard

Import dashboard ID [`19665`](https://grafana.com/grafana/dashboards/19665) — the official k6 Prometheus dashboard. It picks up the metrics k6 pushes and gives you VU count, RPS, error rate, latency curves out of the box.

## Helm chart equivalent

When deploying via the Helm chart, set `metrics.prometheusRemoteWrite.url` and the auth values:

```sh
helm install lt ./chart \
  --set metrics.prometheusRemoteWrite.url=https://prom.internal:9090/api/v1/write \
  --set metrics.prometheusRemoteWrite.username=k6 \
  --set metrics.prometheusRemoteWrite.password='...' \
  --set metrics.prometheusRemoteWrite.insecureSkipTLSVerify=true
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

The chart `fail`s template rendering if both inline `username` AND `bearerToken` are set — k6's behavior with both auth modes is undefined. **Auth-mode hygiene with `existingSecret`**: the chart cannot validate Secret contents, so a pre-created secret containing both `PROM_USERNAME`/`PROM_PASSWORD` AND `PROM_BEARER_TOKEN` will still set both env vars. Operator responsibility: keep your existingSecret to one auth mode.

## summary.json compatibility under k6 v2

As of k6 2.0.0, the default summary format changed and `--summary-mode=legacy` is no longer available. `summary.json` from this repo therefore reflects the v2 format. If you have downstream consumers (custom dashboards, CI parsers, the `benc-uk/k6-reporter` HTML reporter, etc.) that were built against k6 0.x output, validate them against the v2 schema before relying on the file — fields like `metrics.<name>.values` are still present, but several auxiliary fields were renamed or removed. The [k6 v2 migration guide](https://grafana.com/docs/k6/latest/get-started/migrating-to-v2/) is the source of truth.

## What's NOT streamed

`summary.json` is a static end-of-run artifact, NOT a real-time metrics stream. Grafana dashboards are fed by the remote-write integration above. The summary file is for CI assertions, post-run analysis, and archival.
