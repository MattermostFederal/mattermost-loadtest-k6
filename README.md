# mattermost-loadtest-k6

k6-based load test for Mattermost. Simulates realistic user activity (initial sync → websocket → weighted random actions including reads, posts, reactions, searches, threads) with per-user idle-time variance.

The tool supports two modes:

| Mode | When to use | Admin needed? |
|---|---|---|
| **A — bring your own users** (default) | Locked-down environments; you pre-create the test users via `mmctl` or admin UI. | No |
| **B — bootstrap** (`bootstrap.js`) | Ephemeral / on-demand testing where you want the tool to create and remove its own state. | Yes (admin email/password) |

In Mode B, the tool creates a team, channels, and users on install, then **soft-deletes them on teardown** (`teardown.js`). In both modes, posts created during the run are tagged with a `[lt-<runId>]` marker so `cleanup.js` can find and delete them.

The whole thing also ships as a **Helm chart** so you can `helm install` and `helm uninstall` to run + clean up automatically. See [chart/README.md](chart/README.md).

## Prerequisites

- [k6](https://k6.io/docs/get-started/installation/) installed locally
  - macOS: `brew install k6`
  - Debian/Ubuntu: `sudo gpg -k && sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69 && echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list && sudo apt-get update && sudo apt-get install k6`
  - RHEL/CentOS: see [official docs](https://k6.io/docs/get-started/installation/)
- A Mattermost instance you can reach over HTTP(S)
- A pool of pre-created Mattermost user accounts (see [Mattermost requirements](#mattermost-requirements) below)

## Mattermost requirements

Compared with `mattermost-load-test-ng`, the list of MM-side things you must allow is much smaller. The exact requirements depend on which mode you use.

### Mode A (no admin) — what you do NOT need

- ❌ `Enable Account Creation` — we don't create users at runtime
- ❌ `Enable Open Server` — we don't auto-join teams
- ❌ `Enable Custom Emoji` — we don't upload emoji
- ❌ An admin account in the load-test config

### Mode B (bootstrap) — what you DO need

- ✅ A **sysadmin account** with email/password auth. Used only by `bootstrap.js` (creating users/team/channels) and `teardown.js` (deleting them).
- The other "Mode A — not needed" items still aren't needed — bootstrap uses admin endpoints which work regardless of `Enable Account Creation` etc.

### Things each load-test user account needs

(In Mode B these accounts are created by `bootstrap.js` automatically and satisfy all the conditions below. In Mode A you create them yourself.)

For every account listed in `users.json`/`users.csv`:

- ✅ **Email/password auth must work for that account.** MM's `/users/login` is called with `login_id` (email or username) + `password`. SSO-only / LDAP-only accounts will fail.
- ✅ **MFA must not be required** for that account. If MFA is enforced globally, you'll need to either disable it just for the load-test users or use a config that opts them out.
- ✅ **Active account** — not deactivated, not soft-deleted.
- ✅ **Member of at least one team and one channel.** The `preflight` script checks this for you.

That's it. No special role, no system admin privileges, no extra permissions.

### Optional but recommended

- **`Max Users Per Team`** ≥ `TARGET_VUS`. Default is 50 — bump it in **System Console → Site Configuration → Users and Teams** if you'll exceed.
- **Performance Monitoring enabled** if you want to watch MM-side CPU, DB, request latency in Grafana during the run. Not required by k6.

## Setup

> Skip steps 1-2 if you'll use **Mode B (bootstrap)** locally — see [Mode B (local)](#mode-b-bootstrap-locally) below. For Kubernetes either way, use the Helm chart in [chart/](chart/).

### 1. Create the users file

Copy whichever format you prefer (the script accepts both):

```sh
cp config/users.example.json config/users.json
# or
cp config/users.example.csv  config/users.json   # name doesn't matter if you set USERS_FILE
```

Both are git-ignored. Each VU maps round-robin to one entry.

JSON:
```json
[
  { "login_id": "ltuser-01@example.com", "password": "..." }
]
```

CSV (header row required):
```
login_id,password
ltuser-01@example.com,...
```

`login_id` accepts either email or username.

### 2. Set the server URL

```sh
export MM_URL=https://mattermost.example.com
```

### 3. TLS / self-signed certificates

k6 verifies TLS by default. If your MM uses a self-signed certificate or an internal CA k6 doesn't trust, append `--insecure-skip-tls-verify` to the `k6 run` call:

```sh
k6 run --insecure-skip-tls-verify scripts/load.js
```

Or edit the Makefile to add it permanently. The websocket connection inherits the same TLS settings.

### 4. (Optional) Raise file descriptor limit

Each VU opens an HTTP keep-alive connection + a websocket. For runs above ~500 VUs on macOS/Linux, raise `ulimit -n`:

```sh
ulimit -n 65536
```

Put it in the same shell that runs `k6` — it doesn't persist.

## Run

### Pre-flight (recommended first thing)

Verifies the server is reachable, prints its version, then logs in **every** user and confirms each one has teams + channels:

```sh
make preflight
```

Fails fast if any user is misconfigured. Run this whenever you change `users.json`.

### Smoke test

One VU, 30s, exercises login + basic reads:

```sh
make smoke
```

### Realistic load (writes enabled)

Ramps to `TARGET_VUS`, holds, ramps down. Each VU runs the full weighted-action loop:

```sh
make load
TARGET_VUS=200 STEADY_SEC=600 make load
```

### Read-only load (safe for prod-clone data)

Same scenario, but every write action becomes a no-op (no posts, reactions, edits, deletes, channel-view writes). Useful when your test data must not mutate:

```sh
make load-readonly
```

### With JSON summary export

```sh
make load-summary   # produces summary.json
```

### Mode B (bootstrap) locally

If you'd rather have the tool create + tear down the test state instead of pre-creating users:

```sh
export MM_URL=https://mattermost.example.com
export RUN_ID=local-$(whoami)              # any short tag; used in resource names
export ADMIN_EMAIL=sysadmin@example.com
export ADMIN_PASSWORD='YourAdminPassword!'
export BOOTSTRAP_NUM_USERS=50
export BOOTSTRAP_NUM_CHANNELS=5

# 1. Create team + channels + users (idempotent)
k6 run scripts/bootstrap.js

# 2. Run the load test — users are derived from RUN_ID, no users file needed
k6 run scripts/load.js

# 3. Clean up posts marked with [lt-$RUN_ID]
k6 run scripts/cleanup.js

# 4. Soft-delete bootstrap users / channels / team
k6 run scripts/teardown.js
```

`bootstrap.js`, `cleanup.js`, and `teardown.js` are all **idempotent** — safe to re-run.

### Running on a Linux server (no Kubernetes, no Helm)

The whole thing is just k6 + a directory of JavaScript. Nothing about Kubernetes is required — you can run it on any Linux box that has outbound network access to your Mattermost URL.

```sh
# 1. Install k6 (one-time)
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | \
  sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install -y k6
# (Red Hat / Amazon Linux: see https://k6.io/docs/get-started/installation/)

# 2. Get the scripts onto the box
git clone <this-repo> mattermost-loadtest-k6
cd mattermost-loadtest-k6

# 3. Raise the file-descriptor limit if you'll run many VUs
ulimit -n 65536

# 4. Run — Mode A (bring your own users)
export MM_URL=https://mattermost.example.com
cp config/users.example.json config/users.json   # fill in real creds
make preflight
make load

# OR — Mode B (bootstrap everything)
export MM_URL=https://mattermost.example.com
export RUN_ID=$(hostname)-$(date +%s)
export ADMIN_EMAIL=sysadmin@example.com
export ADMIN_PASSWORD='YourAdminPassword!'
export BOOTSTRAP_NUM_USERS=100
k6 run scripts/bootstrap.js
k6 run scripts/load.js
k6 run scripts/cleanup.js
k6 run scripts/teardown.js
```

#### Running it long / in the background

For tests longer than a shell session, use `tmux`, `screen`, or `nohup`:

```sh
nohup k6 run --summary-export=summary.json scripts/load.js > k6.log 2>&1 &
tail -f k6.log
```

Or run via systemd as a one-shot unit if you want managed cleanup. There's no daemon — k6 is a single process that exits when the test ends.

#### What the box needs

- Outbound HTTPS (and WSS if `MM_URL` is HTTPS) to your Mattermost host
- ~500 MB RAM + 1 CPU per ~500 VUs as a rough rule of thumb (k6's docs have a more precise sizing guide)
- File descriptors: `ulimit -n` at least `4 × TARGET_VUS` to leave headroom

No Kubernetes, no Helm, no Docker required.

### Running on Kubernetes (Helm)

The same scripts also ship as a Helm chart in [chart/](chart/). One `helm install` runs the whole lifecycle (optionally including bootstrap as an initContainer), and `helm uninstall` triggers a pre-delete hook that deletes posts and (if bootstrap was on) the team/channels/users. See [chart/README.md](chart/README.md).

## Configuration knobs

All set via env vars (see `Makefile`).

| Var | Default | Effect |
|---|---|---|
| `MM_URL` | `http://localhost:8065` | Mattermost base URL |
| `USERS_FILE` | `./config/users.json` | Credentials file (.json or .csv). Ignored if `BOOTSTRAP_NUM_USERS > 0`. |
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

**Mode B / bootstrap + teardown only:**

| Var | Default | Effect |
|---|---|---|
| `ADMIN_EMAIL` | — | Sysadmin email (required by bootstrap.js, teardown.js) |
| `ADMIN_PASSWORD` | — | Sysadmin password |
| `BOOTSTRAP_NUM_USERS` | 0 (off) | When > 0: bootstrap creates this many users; load.js generates their creds from RUN_ID instead of reading USERS_FILE |
| `BOOTSTRAP_NUM_CHANNELS` | 5 | Public channels to create |
| `BOOTSTRAP_TEAM_DISPLAY_NAME` | `Load test <RUN_ID>` | Human-readable team display name |
| `TEARDOWN_DELETE_TEAM` | true | If false, teardown leaves the team intact and only removes channels + users |

### Tuning the thresholds

The pass/fail thresholds are set in `scripts/load.js` at the top:

```js
thresholds: {
  http_req_failed: ['rate<0.02'],
  'http_req_duration{kind:auth}':  ['p(95)<2000'],
  'http_req_duration{kind:read}':  ['p(95)<500'],
  'http_req_duration{kind:write}': ['p(95)<1000'],
  ws_connecting: ['p(95)<2000'],
},
```

These are starting values. If you're on a slow network or testing against a small instance, expect to relax them. k6 exits non-zero if any threshold fails; relax or remove individual entries to allow the run to "pass."

The same `kind` tags are applied in `scripts/lib/api.js` (`auth` / `read` / `write`), so you can also add per-endpoint thresholds like `'http_req_duration{endpoint:create_post}': ['p(95)<800']`.

### Rates distribution

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

## What the script simulates per VU

1. Pick a user from `users.json` (round-robin by VU number)
2. POST `/users/login`
3. **Initial sync** (mirrors a real web client startup):
   - GET `/config/client?format=old`
   - GET `/users/me/preferences`
   - GET `/users/me/teams/unread`
   - For each team: GET channels, GET user threads, GET sidebar categories
   - POST `/users/status/ids` for self
4. Open websocket, send `authentication_challenge`
5. **Tick loop** (sampled idle between actions):
   - Weighted-random pick from the action list below
   - Before posting, send `user_typing` over the websocket
6. Close websocket after `SESSION_SEC`, iterate

### Action list and weights

Weights are taken directly from mattermost-load-test-ng's simulcontroller and reflect real-world MM client activity:

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

### Coverage vs mattermost-load-test-ng

| Original action | Covered here | Notes |
|---|---|---|
| SwitchChannel, ScrollChannel, UnreadCheck, CreatePost, AddReaction, EditPost, DeletePost, ViewGlobalThreads, ViewThread, UpdateThreadRead, Search* | ✅ | Same weights |
| Typing notifications | ✅ | Sent over WS before posting |
| Replies, urgent posts | ✅ | `PERCENT_REPLIES`, `PERCENT_URGENT` |
| Initial sync (config, preferences, sidebar, threads, statuses) | ✅ | `lib/sync.js` |
| Per-VU rate distribution | ✅ | `lib/rates.js` |
| LogoutLogin, ReconnectWebSocket | ⚠️ partial | A new VU iteration is effectively a re-login + reconnect; the explicit actions aren't separately scheduled |
| OpenDirectOrGroupChannel, CreateDirectChannel, CreateGroupChannel | ❌ | Skipped — would need admin or pre-seeded DM pools |
| File uploads, attachments | ❌ | Skipped — would need a fixture file and stresses different infra |
| Drafts (UpsertDraft, GetDrafts, DeleteDraft) | ❌ | Low value vs implementation cost |
| Scheduled posts, post reminders, bookmarks, custom attributes, persistent notifications, ack posts | ❌ | Version-gated, very low frequencies |
| CreatePublicChannel, CreatePrivateChannel | ❌ | Mutates server topology; skip for locked-down env |
| FullReload | ❌ | Effectively the same as a new iteration |
| Plugin actions (e.g. playbooks) | ❌ | Out of scope |

## Output

After the run, k6 prints a summary. Pay attention to:

- `http_req_duration` overall p95/p99
- Per-`kind` breakdown: `{kind:read}`, `{kind:write}`, `{kind:auth}`
- Per-`endpoint` breakdown if you want per-API view
- `http_req_failed` rate
- `mm_ws_events_received` (custom counter) — confirms realtime events flow
- `mm_ws_connect_duration` (custom trend) — initial WS handshake latency
- Any threshold marked `✗`

## Pre-creating users

The script does not create users. Do this once via `mmctl`:

```sh
for i in $(seq -w 1 50); do
  mmctl user create \
    --email "ltuser-${i}@example.com" \
    --username "ltuser-${i}" \
    --password "Lt@Pass-${i}!" \
    --email-verified
  mmctl team users add <team-name> "ltuser-${i}@example.com"
done
```

Then list them in `config/users.json` (or `.csv`). Users persist across runs.

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
  bootstrap.js           # Mode B: admin creates team + channels + users
  teardown.js            # Mode B: admin soft-deletes them
  cleanup.js             # delete posts marked [lt-<RUN_ID>]
  lib/
    api.js               # REST wrappers (incl. admin endpoints), kind+endpoint tags
    ws.js                # WS session + sendTyping helper + metrics
    users.js             # SharedArray loader (file OR deterministic from RUN_ID)
    content.js           # message + emoji + search-term gen, all tagged with [lt-<RUN_ID>]
    sync.js              # post-login initial sync chain
    rates.js             # per-VU RatesDistribution + PickIdleTimeMs
    actions.js           # weighted action list + picker
chart/                   # Helm chart for running on Kubernetes
  README.md              # chart-specific docs
  Chart.yaml
  values.yaml
  templates/             # job, configmap, secrets, pre-delete hook
  files/scripts/         # vendored copy of scripts/ (refresh via `make chart-sync`)
Makefile                 # preflight / smoke / load / load-readonly / load-summary
                         # chart-sync / chart-lint / chart-package
```
