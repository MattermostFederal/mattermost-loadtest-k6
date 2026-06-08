# Capacity and bottleneck testing

Beyond the fixed-load `make load` target, this repo ships four scenarios for capacity discovery and bottleneck attribution.

## `make breakpoint` — find the maximum

Ramps VU count steadily upward until `http_req_duration{kind:write}` p95 crosses the configured ceiling, then **aborts**. The summary line tells you the VU count and elapsed time at the abort — that's your capacity number under the chosen threshold.

```sh
# Default: 0 → 1000 VUs over 30 min, abort when write p95 > 1000 ms.
make breakpoint

# Override:
BREAKPOINT_MAX_VUS=5000 BREAKPOINT_DURATION=60m BREAKPOINT_WRITE_P95_MS=800 make breakpoint
```

`BREAKPOINT_DELAY_ABORT` (default `2m`) prevents an early outlier from aborting the test before meaningful load has built up. Tune lower if your environment warms up faster; never set to 0 unless you want to fail at t=10s with 3 VUs.

The summary lists which threshold tripped, plus per-`kind` and per-`endpoint` p95s up to the abort moment. **The endpoint that tripped first IS the coarse-grained bottleneck signal** — see [Bottleneck attribution](#bottleneck-attribution) below.

## Targeted bottleneck stressors

When the breakpoint summary says "write broke at 600 VUs," the next question is *which* part of the write path. These three scenarios drive a single subsystem hard while keeping the rest of the session realistic:

| Target | What it exercises | Watch for |
|---|---|---|
| `make load-search` | SearchPosts / SearchUsers / SearchChannels at ~50× normal weight | `search_posts` p95 — high means Elasticsearch (or DB full-text fallback) is saturated |
| `make load-attachments` | File upload + post-with-file, 10 KB payload each (safe default) | `upload_file` p95 — high means S3 / MinIO / local disk is saturated |
| `make load-realtime` | Short idles + post-heavy → high WebSocket fanout | `ws_connecting` p95 climbing, or `mm_ws_events_received` plateau on the k6 side |

All three accept the same `TARGET_VUS` / `STEADY_SEC` / `RAMP_*` env vars as `load`, plus their own knobs (`SEARCH_WEIGHT_MULTIPLIER`, `ATTACHMENT_SIZE_BYTES`, `ATTACHMENT_WEIGHT`, `POST_WEIGHT_MULTIPLIER`).

### `load-attachments` and disk safety

The script defaults to a conservative 6 MB projected total upload (`TARGET_VUS=10`, `ATTACHMENT_SIZE_BYTES=10240`, `STEADY_SEC=120`). A `setup()` pre-flight aborts if your overrides project past `ATTACHMENT_SOFT_LIMIT_MB` (default 500). Set `ATTACHMENT_CONFIRM_LARGE=true` to bypass the gate.

**File store dedup**: `load-attachments` reuses the same byte pattern across uploads by default — this triggers content-addressable storage to deduplicate, so subsequent uploads only stress the metadata path. If your file store uses dedup (some S3 configs, MinIO with dedup on), set `ATTACHMENT_RANDOM_BYTES=true` to defeat it. The random path uses a pool of `ATTACHMENT_RANDOM_POOL_SIZE` (default 8) pre-generated buffers and rotates through them per upload. Pool memory ≈ `POOL_SIZE × FILE_SIZE` per VU.

## Shared SLO thresholds

All load/breakpoint scripts pull threshold values from `scripts/lib/thresholds.js` so a single SLO change propagates everywhere. Override per environment via `SLO_*` env vars — no script edits needed:

| Env var | Default | Threshold it controls |
|---|---|---|
| `SLO_HTTP_REQ_FAILED` | `0.02` | Maximum HTTP error rate (0-1) |
| `SLO_AUTH_P95_MS` | `2000` | Auth endpoint p95 latency (ms) |
| `SLO_READ_P95_MS` | `500` | Read endpoint p95 latency (ms) |
| `SLO_WRITE_P95_MS` | `1000` | Write endpoint p95 latency (ms) |
| `SLO_WS_CONNECTING_P95_MS` | `2000` | WebSocket connection p95 latency (ms) |

```sh
# Tighter SLO for prod-like environments:
SLO_WRITE_P95_MS=600 SLO_READ_P95_MS=300 make load

# Relaxed SLO for a single-node dev box:
SLO_WRITE_P95_MS=2000 SLO_HTTP_REQ_FAILED=0.05 make load
```

This is the k6-idiomatic pattern (shared module + env-var override). For larger orgs running SLO-as-code (Sloth, OpenSLO), the `SLO_*` env vars are the integration seam — generate them from your SLO YAML and pass them in.

### Per-script SLO overrides

When a targeted stressor legitimately needs a different ceiling for an endpoint the base SLO doesn't model (or wants to relax a base SLO without affecting `make load`), each script exposes its own env vars:

| Script | Override env vars |
|---|---|
| `load-search` | `SEARCH_READ_P95_MS` (relax kind:read locally), `SEARCH_POSTS_P95_MS`, `SEARCH_USERS_P95_MS`, `SEARCH_CHANNELS_P95_MS` |
| `load-attachments` | `UPLOAD_FILE_P95_MS` |
| `load-realtime` | `REALTIME_WS_CONNECT_P95_MS`, `REALTIME_CREATE_POST_P95_MS` |

Each defaults to a value reasonable for a healthy backend. The override pattern is documented in `scripts/lib/thresholds.js`.

## Bootstrap verification (Mode B)

Every load/breakpoint script calls `verifyBootstrap()` from its `setup()` block. When both `BOOTSTRAP_NUM_USERS > 0` AND admin creds are set, the script does one admin login + `GET /users/username/lt-<RUN_ID>-u1` before any VU starts. If the user doesn't exist, the test aborts immediately:

```
verifyBootstrap: user lt-myrun-u1 not found on the server.
RUN_ID=myrun with BOOTSTRAP_NUM_USERS=50, but bootstrap-derived users
don't exist. Run `make bootstrap` with the same RUN_ID first, or set
VERIFY_BOOTSTRAP=false to skip this check.
```

This catches the "forgot to bootstrap" foot-gun before you wait 10 seconds watching all your VUs fail to log in. Set `VERIFY_BOOTSTRAP=false` to skip (saves one round-trip if you know bootstrap ran).

## Bottleneck attribution

k6 alone can't tell you *why* something broke — only *that* it did. Real attribution comes from running k6 with metrics streaming AND watching MM's own Prometheus metrics in the same Grafana instance:

| Symptom in k6 dashboard | Likely cause on MM-side dashboard |
|---|---|
| `create_post` / `edit_post` p95 climbs first | `mattermost_db_master_connections_total` saturated; Postgres-side `pg_stat_activity` count, slow inserts |
| `posts` / `posts_around_unread` p95 slow | DB read replica lag; `mattermost_db_replica_connections_total` |
| `search_posts` slow | Elasticsearch — heap, queue depth, indexing backlog; or DB full-text if ES is off |
| `login` slow | Session store contention, password-hash CPU |
| `upload_file` slow | File store backend (S3 / MinIO / disk I/O) |
| `ws_connecting` p95 spikes, WS events drop | `go_goroutines` non-linear inflection, WS hub lock contention |

Open two browser tabs during a capacity run — k6's dashboard for the client view, MM's dashboard for the server view. The bottleneck is whichever MM-side metric saturates at the moment k6's threshold tripped.

See [metrics-grafana.md](metrics-grafana.md) for the Prometheus / Alloy wiring.

## Tuning the load test thresholds (the abort signals in load.js)

The default thresholds in `scripts/load.js` are starting values. If you're on a slow network or testing against a small instance, expect to relax them. k6 exits 99 (non-zero) if any threshold fails; relax or remove individual entries to allow the run to "pass."

The same `kind` tags are applied in `scripts/lib/api.js` (`auth` / `read` / `write`), so you can also add per-endpoint thresholds like `'http_req_duration{endpoint:create_post}': ['p(95)<800']`.

## Rates distribution

By default each VU is assigned a rate multiplier from this distribution (matches `config.sample.json` in mattermost-load-test-ng):

| Multiplier | Share of VUs |
|---|---|
| 1.0x  | 5%  (very active) |
| 2.0x  | 10% |
| 3.0x  | 15% |
| 6.0x  | 40% |
| 30.0x | 30% (mostly idle) |

Idle is sampled from `[MIN_IDLE_MS, 2*AVG_IDLE_MS - MIN_IDLE_MS]` then multiplied by the VU's rate. Override:

```sh
RATES_DISTRIBUTION='[{"rate":1,"percentage":1.0}]' make load   # all VUs very active
```
