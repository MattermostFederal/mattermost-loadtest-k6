# Configuration reference

Complete env var index, action weights, rate distribution, and output interpretation.

## Common env vars

| Var | Default | Effect |
|---|---|---|
| `MM_URL` | `http://localhost:8065` | Mattermost base URL |
| `USERS_FILE` | *unset* | Credentials file path (.json or .csv). When unset AND `BOOTSTRAP_NUM_USERS=0`, scripts that need users (preflight, smoke, load*, breakpoint) abort with a clear error at test start. The Makefile and Helm chart inject a default for typical workflows — direct `k6 run` requires you to pass it explicitly. |
| `RUN_ID` | `default` | Unique tag for this run. Prefix for bootstrap resources and posts (`[lt-<RUN_ID>]`). Helm chart sets this to the release name automatically. |
| `TARGET_VUS` | 50 | Peak concurrent users |
| `RAMP_UP_SEC` | 60 | Time to reach peak |
| `STEADY_SEC` | 300 | Time held at peak |
| `RAMP_DOWN_SEC` | 30 | Time to ramp back to 0 |
| `SESSION_SEC` | 180 | Per-VU iteration length (websocket lifetime) |
| `MIN_IDLE_MS` | 1000 | Minimum idle between actions |
| `AVG_IDLE_MS` | 20000 | Average idle between actions |
| `PERCENT_REPLIES` | 0.18 | Of posts, fraction that are replies (not root) |
| `PERCENT_URGENT` | 0.001 | Of root posts, fraction marked priority=urgent |
| `READ_ONLY` | false | If true, write actions are no-ops |
| `RATES_DISTRIBUTION` | (see below) | JSON array overriding the per-VU rate distribution |

## Mode B (bootstrap + teardown)

| Var | Default | Effect |
|---|---|---|
| `ADMIN_EMAIL` | — | Sysadmin email (required by bootstrap.js, teardown.js, cleanup.js admin path) |
| `ADMIN_PASSWORD` | — | Sysadmin password |
| `BOOTSTRAP_NUM_USERS` | 0 (off) | When > 0: bootstrap creates this many users; load.js generates their creds from RUN_ID instead of reading USERS_FILE |
| `BOOTSTRAP_NUM_CHANNELS` | 5 | Public channels to create |
| `BOOTSTRAP_TEAM_DISPLAY_NAME` | `Load test <RUN_ID>` | Human-readable team display name |
| `TEARDOWN_MODE` | `none` | `none` = skip teardown; `soft` = archive channels/team + deactivate users; `hard` = permanent delete (toggles ServiceSettings.EnableAPI*Deletion flags around the sweep, then restores them) |
| `TEARDOWN_DELETE_TEAM` | true | If false, teardown leaves the team intact and only removes channels + users |
| `TEARDOWN_ALLOW_PRE_ENABLED_FLAGS` | false | When true, hard teardown proceeds even if `EnableAPI*Deletion` flags are already true at snapshot. Use only if your environment legitimately runs with these flags always-on by policy. Disables the concurrent-teardown safety check. |
| `CLEANUP_ALLOW_MISSING_TEAM` | false (local), true (Helm) | When admin creds are set but the `lt-<RUN_ID>` team doesn't exist: `false` aborts loudly (catches mixed-config misconfiguration); `true` exits cleanly as an idempotent no-op (what Helm uninstall expects). Chart sets it to `true` via `mmlt.cleanupEnv`. |
| `VERIFY_BOOTSTRAP` | true | When false, skip the pre-test admin lookup of `lt-<RUN_ID>-u1`. Set to false if you know bootstrap ran and want to save one HTTP round-trip. |

## Cleanup-only

| Var | Default | Effect |
|---|---|---|
| `CLEANUP_PASSES` | 1 | Number of post-cleanup passes. >1 helps catch stragglers when MM's search index lags behind the writes |
| `CLEANUP_PASS_DELAY_SEC` | 30 | Delay between cleanup passes |
| `CLEANUP_PERMANENT` | false | When true (and admin path is taken), uses `DELETE /posts/{id}?permanent=true`. Removes FileInfo + file blob in one call. Auto-on when `cleanup.teardownMode=hard` in Helm. Requires `EnableAPIPostDeletion` (managed by the script). |

## SLO thresholds

All `SLO_*` vars are read by `scripts/lib/thresholds.js` and apply to load and breakpoint scripts.

| Env var | Default | Threshold it controls |
|---|---|---|
| `SLO_HTTP_REQ_FAILED` | `0.02` | Maximum HTTP error rate (0-1) |
| `SLO_AUTH_P95_MS` | `2000` | Auth endpoint p95 latency (ms) |
| `SLO_READ_P95_MS` | `500` | Read endpoint p95 latency (ms) |
| `SLO_WRITE_P95_MS` | `1000` | Write endpoint p95 latency (ms) |
| `SLO_WS_CONNECTING_P95_MS` | `2000` | WebSocket connection p95 latency (ms) |

## Capacity testing knobs

| Env var | Default | Effect |
|---|---|---|
| `BREAKPOINT_MAX_VUS` | 1000 | Peak VU count for breakpoint test |
| `BREAKPOINT_DURATION` | `30m` | Ramp duration |
| `BREAKPOINT_WRITE_P95_MS` | 1000 | Threshold that triggers the abort |
| `BREAKPOINT_DELAY_ABORT` | `2m` | Wait before evaluating thresholds (avoids cold-start outliers tripping the abort) |

## Targeted stressor knobs

`load-search`:
| Env var | Default | Effect |
|---|---|---|
| `SEARCH_WEIGHT_MULTIPLIER` | 50 | Search action weight multiplier |
| `SEARCH_READ_P95_MS` | 1500 | Read SLO override (searches are heavier than typical reads) |
| `SEARCH_POSTS_P95_MS` | 2000 | search_posts endpoint SLO |
| `SEARCH_USERS_P95_MS` | 1000 | search_users endpoint SLO |
| `SEARCH_CHANNELS_P95_MS` | 1000 | search_channels endpoint SLO |

`load-attachments`:
| Env var | Default | Effect |
|---|---|---|
| `ATTACHMENT_SIZE_BYTES` | 10240 (10 KB) | Per-upload payload size |
| `ATTACHMENT_WEIGHT` | 2 | CreatePostWithFile action weight (vs CreatePost default 1.0) |
| `ATTACHMENT_RANDOM_BYTES` | false | When true, generate random bytes per upload (defeats file-store dedup) |
| `ATTACHMENT_RANDOM_POOL_SIZE` | 8 | Pool size when `ATTACHMENT_RANDOM_BYTES=true` |
| `ATTACHMENT_SOFT_LIMIT_MB` | 500 | Projected upload soft limit; setup() aborts if exceeded |
| `ATTACHMENT_CONFIRM_LARGE` | false | When true, bypass the soft limit gate |
| `UPLOAD_FILE_P95_MS` | 3000 | Endpoint SLO for upload_file |

`load-realtime`:
| Env var | Default | Effect |
|---|---|---|
| `POST_WEIGHT_MULTIPLIER` | 10 | CreatePost weight multiplier |
| `REALTIME_WS_CONNECT_P95_MS` | 3000 | ws_connecting SLO |
| `REALTIME_CREATE_POST_P95_MS` | 1500 | create_post endpoint SLO |

## Prometheus remote-write

| Env var | Effect |
|---|---|
| `K6_PROMETHEUS_RW_SERVER_URL` | Remote-write endpoint (Prometheus or Alloy). When set, k6 streams metrics in real time. |
| `K6_PROMETHEUS_RW_USERNAME` / `K6_PROMETHEUS_RW_PASSWORD` | Basic auth |
| `K6_PROMETHEUS_RW_BEARER_TOKEN` | Bearer token |
| `K6_PROMETHEUS_RW_INSECURE_SKIP_TLS_VERIFY` | Self-signed certs |
| `K6_PROMETHEUS_RW_PUSH_INTERVAL` | Flush cadence (default `5s`) |

## Recovery

| Env var | Effect |
|---|---|
| `RECOVER_SNAPSHOT_JSON` | JSON of the desired state for `EnableAPI*Deletion` flags. When unset, defaults to all-false. |
| `RECOVER_DRY_RUN` | When true, print the delta but don't patch. |

## Helm chart values

Top-level chart values (see `chart/values.yaml` for full reference):

| Path | Default | Effect |
|---|---|---|
| `image.repository` | `grafana/k6` | k6 image |
| `image.tag` | `"2.0.0"` | Pinned (must match Makefile `K6_VERSION`) |
| `script` | `load` | Which scenario to run: `load` / `load-readonly` / `smoke` / `preflight` / `cleanup` / `breakpoint` / `load-search` / `load-attachments` / `load-realtime` |
| `mattermost.url` | `http://mattermost.example.com:8065` | MM target |
| `mattermost.insecureSkipTLSVerify` | false | For self-signed certs |
| `bootstrap.enabled` | false | When true, run bootstrap as initContainer before the main load |
| `bootstrap.numUsers` | 50 | Users to create in Mode B |
| `bootstrap.numChannels` | 5 | Channels per team |
| `admin.email` / `admin.password` | "" | Mode B admin creds (or use `admin.existingSecret`) |
| `users.file` | "" | Mode A — raw users JSON/CSV (set via `--set-file`) |
| `users.existingSecret` | "" | Mode A — pre-created Secret name |
| `load.targetVUs` | 50 | Peak VU count |
| `cleanup.posts` | true | Run cleanup-posts in pre-delete hook |
| `cleanup.passes` | 1 | `CLEANUP_PASSES` value |
| `cleanup.passDelaySec` | 30 | `CLEANUP_PASS_DELAY_SEC` value |
| `cleanup.teardownMode` | `none` | `none` / `soft` / `hard` |
| `metrics.prometheusRemoteWrite.url` | "" | Enable Prometheus streaming |
| `metrics.slo.writeP95Ms` (etc.) | (matches `lib/thresholds.js`) | SLO overrides at chart level |
| `breakpoint.maxVUs` | 1000 | Breakpoint scenario cap |
| `stressors.load-search.weightMultiplier` | 50 | Per-script stressor knob |

## Action list and weights

Weights are taken directly from `mattermost-load-test-ng`'s simulcontroller and reflect real-world MM client activity:

| Action | Weight | Notes |
|---|---|---|
| SwitchChannel | 6.5219 | Full chain: getChannel + getChannelMember + getChannelStats + getPostsAroundLastUnread + view |
| ScrollChannel | 1.9873 | Fetch older posts |
| UnreadCheck | 1.0 | GET teams unread |
| CreatePost | 1.0 | With `user_typing` precursor, replies, urgent |
| ViewGlobalThreads | 0.6023 | GET user threads |
| UpdateThreadRead | 0.3236 | PUT thread read marker |
| ViewThread | 0.2841 | GET specific thread |
| AddReaction | 0.1306 | Random emoji to last seen post |
| GetStatuses | 0.05 | POST status/ids |
| EditPost | 0.04 | PUT last post with new content |
| SearchUsers | 0.0320 | POST users/search |
| SearchPosts | 0.0218 | POST posts/search |
| SearchChannels | 0.0150 | POST channels/search |
| DeletePost | 0.0049 | DELETE last post |

## Coverage vs mattermost-load-test-ng

| Original action | Covered here | Notes |
|---|---|---|
| SwitchChannel, ScrollChannel, UnreadCheck, CreatePost, AddReaction, EditPost, DeletePost, ViewGlobalThreads, ViewThread, UpdateThreadRead, Search* | ✅ | Same weights |
| Typing notifications | ✅ | Sent over WS before posting |
| Replies, urgent posts | ✅ | `PERCENT_REPLIES`, `PERCENT_URGENT` |
| Initial sync (config, preferences, sidebar, threads, statuses) | ✅ | `lib/sync.js` |
| Per-VU rate distribution | ✅ | `lib/rates.js` |
| File uploads, attachments | ✅ (separate stressor) | `load-attachments.js`, not in the default mix |
| LogoutLogin, ReconnectWebSocket | ⚠️ partial | A new VU iteration is effectively a re-login + reconnect; the explicit actions aren't separately scheduled |
| OpenDirectOrGroupChannel, CreateDirectChannel, CreateGroupChannel | ❌ | Skipped — would need admin or pre-seeded DM pools |
| Drafts (UpsertDraft, GetDrafts, DeleteDraft) | ❌ | Low value vs implementation cost |
| Scheduled posts, post reminders, bookmarks, custom attributes, persistent notifications, ack posts | ❌ | Version-gated, very low frequencies |
| CreatePublicChannel, CreatePrivateChannel | ❌ | Mutates server topology; skip for locked-down env |
| FullReload | ❌ | Effectively the same as a new iteration |
| Plugin actions (e.g. playbooks) | ❌ | Out of scope |

## Rates distribution

By default each VU is assigned a rate multiplier:

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

## Output interpretation

After the run, k6 prints a summary. Key metrics:

- `http_req_duration` overall p95/p99
- Per-`kind` breakdown: `{kind:read}`, `{kind:write}`, `{kind:auth}`
- Per-`endpoint` breakdown
- `http_req_failed` rate
- `mm_ws_events_received` — confirms realtime events flow
- `mm_ws_connect_duration` — initial WS handshake latency
- `mm_action_errors{action:<name>}` — silently-caught exceptions inside the per-VU action loop, tagged by action name. Non-zero means a specific action is throwing. Zero is expected.
- Any threshold marked `✗`

### Cleanup output

```
cleanup(admin) done: deleted=42 delete_errors=0 search_errors=0 zombies=0 run_id=<id>
```

- `deleted` — posts removed (success metric)
- `delete_errors` — 5xx, network failures, anything not 200/403/404
- `search_errors` — searchPosts failures
- `zombies` — posts returned by search that were already gone at delete time (404). Non-zero is normal under search-index lag; informational, not an error.

### Teardown output

```
teardown(hard): snapshot {"EnableAPIUserDeletion":false,...}
teardown(hard): deletion flags enabled (verified)
teardown(hard): permanently deleted 5/5 channels
teardown(hard): permanently deleted 50/50 users
teardown(hard): permanently deleted team lt-<RUN_ID>
teardown(hard): restored flags to {"EnableAPIUserDeletion":false,...} (verified)
```

The `(verified)` suffix means the post-patch verify check passed. If you see "restore PATCH returned 200 but flags didn't match snapshot" — the flags may still be enabled cluster-wide. Run `make recover-flags` IMMEDIATELY.

## File layout

```
config/
  users.example.json
  users.example.csv
  users.json             # your real creds (Mode A only), gitignored
scripts/
  preflight.js           # verify creds + teams + channels (Mode A)
  smoke.js               # 1-VU sanity check
  load.js                # main weighted-action scenario
  breakpoint.js          # ramp-to-failure capacity test
  load-search.js         # search-heavy stressor (ES)
  load-attachments.js    # file-upload stressor (S3/disk)
  load-realtime.js       # WS-fanout stressor (Go app)
  bootstrap.js           # Mode B: admin creates team + channels + users
  teardown.js            # Mode B: admin soft/hard-deletes them
  cleanup.js             # delete posts marked [lt-<RUN_ID>]
  recover-flags.js       # restore EnableAPI*Deletion flags after a stuck teardown
  lib/
    api.js               # REST wrappers (incl. admin endpoints), kind+endpoint tags
    ws.js                # WS session + sendTyping helper + metrics
    users.js             # SharedArray loader (file OR deterministic from RUN_ID)
    content.js           # message + emoji + search-term gen, all tagged with [lt-<RUN_ID>]
    sync.js              # post-login initial sync chain
    rates.js             # per-VU RatesDistribution + PickIdleTimeMs
    actions.js           # default weighted action list + picker
    vu.js                # shared per-VU loop + verifyBootstrap + verifyUsersAvailable
    thresholds.js        # baseThresholds + breakpointThresholds + SLO env vars
chart/                   # Helm chart for running on Kubernetes
  README.md              # chart-specific docs
  Chart.yaml             # version 1.0.0, appVersion "2.0.0"
  values.yaml
  templates/             # job, configmap, secrets, pre-delete hook
  files/scripts/         # vendored copy of scripts/ (refresh via `make chart-sync`)
docs/
  modes.md               # Mode A vs B, Mattermost requirements, setup
  capacity-testing.md    # breakpoint + stressors + SLOs + attribution
  metrics-grafana.md     # Prometheus / Alloy integration
  cleanup-teardown.md    # 3 modes, hard-mode lifecycle, recovery, complete teardown
  troubleshooting.md     # failure modes + exit codes
  air-gap.md             # offline deployment
  configuration.md       # this file
Makefile                 # preflight / smoke / load / load-* / breakpoint
                         # bootstrap / cleanup / teardown-soft / teardown-hard / recover-flags
                         # chart-sync / chart-lint / chart-package
                         # airgap-bundle / airgap-clean
```
