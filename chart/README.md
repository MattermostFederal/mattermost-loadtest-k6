# mattermost-loadtest-k6 (Helm chart)

Runs the [mattermost-loadtest-k6](..) scripts as a Kubernetes Job. The chart can also bootstrap the test team / channels / users on install and tear them down on uninstall.

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

1. **Pre-run (initContainer)**: `bootstrap.js` logs in as admin and creates:
   - 1 public team: `lt-<release-name>`
   - N public channels: `lt-<release-name>-ch{1..N}`
   - N users: `lt-<release-name>-u{1..N}` (deterministic creds derived from release name)
   - Adds users to team + all channels
2. **Main container**: `k6 run /scripts/load.js` with `RUN_ID=<release-name>`, generating users in-memory from the same algorithm as bootstrap — no users file needed.
3. **On `helm uninstall`**: pre-delete hook runs:
   - `cleanup.js` — deletes posts marked `[lt-<release-name>]`
   - `teardown.js` — soft-deletes the bootstrap users, channels, and team
   - Then Helm tears down the rest of the release.

After uninstall, the only residue on MM is soft-deleted records (standard for MM's API).

## Picking the script

Set `script` to one of:

| Value | What it runs |
|---|---|
| `load` (default) | Full weighted-action scenario |
| `load-readonly` | Same scenario, all writes are no-ops |
| `smoke` | 1 VU for 30s — sanity check |
| `preflight` | Confirms each user has teams + channels |
| `cleanup` | Just runs the post cleanup (without uninstalling) |

```sh
helm install lt ./chart --set script=smoke ...
```

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
  # OR pre-create a secret with keys ADMIN_EMAIL/ADMIN_PASSWORD and reference:
  existingSecret: ""

users:                                 # only used if bootstrap.enabled = false
  file: ""                             # set via --set-file
  format: json                         # or csv
  existingSecret: ""
  existingSecretKey: users.json

load:
  targetVUs: 50
  rampUpSec: 60
  steadySec: 300
  rampDownSec: 30
  sessionSec: 180
  minIdleMs: 1000
  avgIdleMs: 20000
  percentReplies: 0.18
  percentUrgent: 0.001
  ratesDistribution: ""                # JSON-string override

cleanup:
  posts: true                          # delete [lt-<release>] posts on uninstall
  teardown: true                       # delete bootstrap users/channels/team on uninstall
                                       # (only effective if bootstrap.enabled was true)
```

Full list: see `values.yaml`.

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
- `ServiceAccount/<release>-mattermost-loadtest-k6` — if `serviceAccount.create`
- `Job/<release>-mattermost-loadtest-k6-cleanup` — appears briefly during `helm uninstall`

All of these are cleaned by `helm uninstall`. The main Job auto-deletes itself `ttlSecondsAfterFinished` seconds (default 300) after completion.

## What gets created on Mattermost

| Mode A (pre-created users) | Mode B (bootstrap enabled) |
|---|---|
| ✗ Nothing new (just posts) | ✓ 1 team |
| ✓ Posts with marker `[lt-<release>]` | ✓ N channels |
| ✓ Reactions (cascade-deleted with posts) | ✓ N users |
| | ✓ Posts with marker `[lt-<release>]` |
| | ✓ Reactions (cascade) |

`helm uninstall` removes the posts in either mode (and the team/channels/users in Mode B).

## Reusing a secret instead of inline credentials

For real environments, you typically don't want admin passwords in your Helm values history.

```sh
kubectl create secret generic mm-admin \
  --from-literal=ADMIN_EMAIL=sysadmin@example.com \
  --from-literal=ADMIN_PASSWORD='YourAdminPassword!'

helm install lt ./chart \
  --set bootstrap.enabled=true \
  --set admin.existingSecret=mm-admin
```

Same idea for the users secret in Mode A:

```sh
kubectl create secret generic mm-users \
  --from-file=users.json=./users.json

helm install lt ./chart \
  --set users.existingSecret=mm-users \
  --set users.existingSecretKey=users.json
```

## Troubleshooting

### "bootstrap: ADMIN_EMAIL and ADMIN_PASSWORD must be set"

The chart didn't find the admin secret. Either set `admin.email` and `admin.password` in values, or set `admin.existingSecret` to a secret with both `ADMIN_EMAIL` and `ADMIN_PASSWORD` keys.

### "Either users.file or users.existingSecret must be set..."

You enabled neither bootstrap nor a users source. Either turn bootstrap on, or supply `users.file`/`users.existingSecret`.

### Bootstrap fails with `Invalid or expired session`

Admin login failed. The same checks as the [main README's Mattermost requirements](../README.md#mattermost-requirements) apply: email+password works for the admin account, MFA off on that account.

### Posts left over after uninstall

`cleanup.posts` was false, or the cleanup Job failed. Either:

```sh
# Re-run cleanup as a fresh install with script=cleanup:
helm install lt-cleanup ./chart \
  --set script=cleanup --set mattermost.url=... \
  --set-file users.file=./users.json    # or bootstrap.enabled=true + admin creds
helm uninstall lt-cleanup
```

## Updating the bundled scripts

The chart vendors `../scripts/` into `chart/files/scripts/`. After editing scripts:

```sh
make chart-sync     # copy scripts/ -> chart/files/scripts/
make chart-lint     # helm lint
make chart-package  # builds dist/mattermost-loadtest-k6-x.y.z.tgz
```
