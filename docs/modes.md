# Modes and setup

This document covers the two operating modes (A and B), per-mode Mattermost requirements, and the one-time setup steps.

## The two modes

| Mode | When to use | Admin needed? |
|---|---|---|
| **A — bring your own users** (default) | Locked-down environments; you pre-create the test users via `mmctl` or admin UI. | No |
| **B — bootstrap** (`bootstrap.js`) | Ephemeral / on-demand testing where you want the tool to create and remove its own state. | Yes (admin email/password) |

In Mode B, the tool creates a team, channels, and users on install, then soft- or hard-deletes them on teardown (see [cleanup-teardown.md](cleanup-teardown.md)). In both modes, posts created during the run are tagged with a `[lt-<RUN_ID>]` marker so `cleanup.js` can find and delete them.

## Mattermost requirements

The exact requirements depend on which mode you use.

### Mode A (no admin) — what you do NOT need

- ❌ `Enable Account Creation` — we don't create users at runtime
- ❌ `Enable Open Server` — we don't auto-join teams
- ❌ `Enable Custom Emoji` — we don't upload emoji
- ❌ An admin account in the load-test config

### Mode B (bootstrap) — what you DO need

- ✅ A **sysadmin account** with email/password auth. Used only by `bootstrap.js` (creating users/team/channels) and `teardown.js` (deleting them).
- The other "Mode A — not needed" items still aren't needed — bootstrap uses admin endpoints which work regardless of `Enable Account Creation` etc.

### Per-user requirements (both modes)

In Mode B these accounts are created automatically by `bootstrap.js` and satisfy all the conditions below. In Mode A you create them yourself. For every account listed in `users.json`/`users.csv`:

- ✅ **Email/password auth must work for that account.** MM's `/users/login` is called with `login_id` (email or username) + `password`. SSO-only / LDAP-only accounts will fail.
- ✅ **MFA must not be required.** If MFA is enforced globally, either disable it for the load-test users or use a config that opts them out.
- ✅ **Active account** — not deactivated, not soft-deleted.
- ✅ **Member of at least one team and one channel.** The `preflight` script checks this for you.

No special role, no system admin privileges, no extra permissions.

### Optional but recommended

- **`Max Users Per Team`** ≥ `TARGET_VUS`. Default is 50 — bump it in **System Console → Site Configuration → Users and Teams** if you'll exceed.
- **Performance Monitoring enabled** if you want to watch MM-side CPU, DB, request latency in Grafana during the run. Not required by k6.

## Setup

### 1. Create the users file (Mode A only)

Copy whichever format you prefer:

```sh
cp config/users.example.json config/users.json
# or
cp config/users.example.csv config/users.json   # name doesn't matter if you set USERS_FILE
```

Both files are git-ignored. Each VU maps round-robin to one entry.

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

k6 verifies TLS by default. If your MM uses a self-signed certificate or an internal CA k6 doesn't trust, append `--insecure-skip-tls-verify`:

```sh
k6 run --insecure-skip-tls-verify scripts/load.js
```

Or edit the Makefile to add it permanently. The websocket connection inherits the same TLS settings.

### 4. (Optional) Raise file descriptor limit

Each VU opens an HTTP keep-alive connection + a websocket. For runs above ~500 VUs on macOS/Linux:

```sh
ulimit -n 65536
```

Put it in the same shell that runs `k6` — it doesn't persist across sessions.

## Mode B (bootstrap) workflow

If you'd rather have the tool create + tear down test state instead of pre-creating users, use the `make` targets:

```sh
export MM_URL=https://mattermost.example.com
export RUN_ID=local-$(whoami)              # any short tag; used in resource names
export ADMIN_EMAIL=sysadmin@example.com
export ADMIN_PASSWORD='YourAdminPassword!'
export BOOTSTRAP_NUM_USERS=50
export BOOTSTRAP_NUM_CHANNELS=5

# 1. Create team + channels + users (idempotent)
make bootstrap

# 2. Run the load test — users are derived from RUN_ID, no users file needed
make load

# 3. Clean up posts marked with [lt-$RUN_ID]
make cleanup

# 4. Tear down bootstrap users / channels / team — pick one:
make teardown-soft     # archive (reversible from System Console)
make teardown-hard     # permanent delete (see cleanup-teardown.md for details)
```

The raw `k6 run` equivalents work the same way:

```sh
k6 run scripts/bootstrap.js
k6 run scripts/load.js
k6 run scripts/cleanup.js
TEARDOWN_MODE=soft k6 run scripts/teardown.js   # or hard
```

## Pre-creating users (Mode A)

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
   - Weighted-random pick from the action list
   - Before posting, send `user_typing` over the websocket
6. Close websocket after `SESSION_SEC`, iterate

See [configuration.md](configuration.md) for the per-action weights and rate distribution.
