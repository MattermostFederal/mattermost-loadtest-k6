# mattermost-loadtest-k6

k6-based load test for Mattermost. Simulates realistic user activity (initial sync → websocket → weighted random actions including reads, posts, reactions, searches, threads) with per-user idle-time variance.

## TL;DR for operators

**What this is:** a load-test toolkit, not a monitoring tool. You point it at a Mattermost instance, it pretends to be N users doing realistic things, and it tells you how the server performed.

**Pick a mode:**

| Mode | When to use | Admin needed? |
|---|---|---|
| **A — bring your own users** (default) | Locked-down environments; you pre-create the test users via `mmctl` or admin UI | No |
| **B — bootstrap** | Ephemeral / on-demand testing where you want the tool to create and remove its own state | Yes (admin email/password) |

**Five `make` targets cover ~95% of real use:**

```sh
make preflight        # verify your config before any real test
make load             # realistic-user load (TARGET_VUS=50 default)
make breakpoint       # ramp until write p95 > threshold, report capacity
make teardown-hard    # permanent delete of Mode B bootstrap state
make recover-flags    # operational recovery when teardown died mid-run
```

**Exit codes the CI/Helm reader should know:**

| Code | Meaning |
|---|---|
| `0` | Success |
| `99` | A k6 threshold failed (e.g., `http_req_duration{kind:write}` p95 over SLO) |
| `108` | `exec.test.abort()` fired — investigate before retrying. Common triggers: hard-teardown restore failed, projection over soft limit, missing user source, concurrent teardown detected. See [docs/troubleshooting.md](docs/troubleshooting.md). |

**Critical sysadmin requirement for `hard` mode:** Mattermost's API silently drops `EnableAPI*Deletion` config writes from non-`system_admin` callers (even granular `sysconsole_write_*` admins). The tool detects this via verify-after-patch and aborts cleanly — but the constraint is real. If your dev admin only has granular RBAC roles, hard mode won't work.

**Per-environment guidance:**

| Environment | Mode | What to know |
|---|---|---|
| Local-disk single-VM dev | A or B | `load-attachments` defaults to 6 MB total upload (safe on small disk). Bump via `ATTACHMENT_SIZE_BYTES` only if disk has headroom. |
| Helm + S3-backed MM | B | Set `metrics.prometheusRemoteWrite.url` for real-time Grafana view. Hard mode does full file cleanup including blob removal. |
| Mattermost Cloud / managed | A | Hard mode won't work (`PUT /config` is disabled). Use `teardown-soft` or `cleanup.teardownMode=none`. |
| Federal air-gapped | A or B | Run `make airgap-bundle` on a connected machine, scp the tarball. See [docs/air-gap.md](docs/air-gap.md). |

## Prerequisites

- [k6 v2.0.0+](https://k6.io/docs/get-started/installation/) (`brew install k6` on macOS, `apt-get install k6` on Debian/Ubuntu)
- GNU Make (default on Linux/macOS; BSD users install `gmake`; Windows users use WSL)
- A Mattermost instance you can reach over HTTP(S)
- A pool of pre-created Mattermost user accounts (Mode A) OR sysadmin credentials (Mode B)

## 5-minute quickstart

### Mode A (bring your own users)

```sh
export MM_URL=https://mattermost.example.com
cp config/users.example.json config/users.json   # fill in real creds
make preflight                                    # verify config
make load
```

### Mode B (chart-managed bootstrap)

```sh
export MM_URL=https://mattermost.example.com
export ADMIN_EMAIL=sysadmin@example.com
export ADMIN_PASSWORD='YourAdminPassword!'
export RUN_ID=$(date +%s)
export BOOTSTRAP_NUM_USERS=50

make bootstrap        # creates team/channels/users
make load             # the actual test
make teardown-hard    # permanent removal including files
```

See [docs/modes.md](docs/modes.md) for the full per-mode setup.

## Common scenarios

### "I want to find the maximum VUs this MM can handle"

```sh
export MM_URL=https://mattermost.example.com
cp config/users.example.json config/users.json
make preflight
make breakpoint        # ramps to 1000 VUs over 30m, aborts at write p95 > 1s
```

The summary line at the abort point tells you the capacity. Tune via `BREAKPOINT_MAX_VUS`, `BREAKPOINT_WRITE_P95_MS`. See [docs/capacity-testing.md](docs/capacity-testing.md).

### "I want to watch metrics in Grafana while the test runs"

```sh
export K6_PROMETHEUS_RW_SERVER_URL=https://prom.internal:9090/api/v1/write
make breakpoint        # or any load* target
```

Import Grafana dashboard ID **19665**. Series are tagged with `run_id` so you can overlay runs. See [docs/metrics-grafana.md](docs/metrics-grafana.md).

### "Cleanup-only — I just want the marker posts gone"

```sh
make cleanup           # Mode A: needs USERS_FILE
# OR Mode B:
ADMIN_EMAIL=... ADMIN_PASSWORD=... RUN_ID=... make cleanup
```

### "A teardown died and I'm worried about flags being stuck"

```sh
export MM_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD='...'

RECOVER_DRY_RUN=true make recover-flags    # show what would change, no writes
make recover-flags                          # reset all 4 deletion flags to false
```

See [docs/cleanup-teardown.md#recovery](docs/cleanup-teardown.md#recovery).

### "Run on Kubernetes via Helm"

See [chart/README.md](chart/README.md) for the Helm-specific quickstart, or [docs/air-gap.md](docs/air-gap.md#air-gapped-kubernetes-helm-chart) for air-gapped K8s.

## Documentation

| Topic | Read |
|---|---|
| Mode A vs B, Mattermost requirements, setup steps | [docs/modes.md](docs/modes.md) |
| Capacity testing, targeted stressors, SLO thresholds, bottleneck attribution | [docs/capacity-testing.md](docs/capacity-testing.md) |
| Real-time metrics → Grafana via Prometheus / Alloy | [docs/metrics-grafana.md](docs/metrics-grafana.md) |
| Cleanup, teardown modes, hard-mode lifecycle, recovery, complete-teardown runbook | [docs/cleanup-teardown.md](docs/cleanup-teardown.md) |
| Failure modes + exit codes | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Air-gapped / offline deployment | [docs/air-gap.md](docs/air-gap.md) |
| Complete env var reference, action weights, output interpretation, file layout | [docs/configuration.md](docs/configuration.md) |
| Helm chart specifics | [chart/README.md](chart/README.md) |
