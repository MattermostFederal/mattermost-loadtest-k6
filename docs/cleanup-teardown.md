# Cleanup, teardown, and recovery

This document covers the three teardown modes, the file-cleanup lifecycle, the operational recovery procedure, and the complete-teardown runbook for fully removing test state.

## Three teardown modes (Mode B)

`TEARDOWN_MODE` controls what `teardown.js` does to the bootstrap-created resources. Set it on the env or use the matching `make` target.

| Mode | `make` target | Channels & team | Users | Server config touched? |
|---|---|---|---|---|
| `none` (default) | *(no target — just skip)* | Untouched | Untouched | No |
| `soft` | `make teardown-soft` | Archived (`delete_at` set; UI: "Archived") | Deactivated (`delete_at` set; UI: "Inactive") | No |
| `hard` | `make teardown-hard` | Permanently deleted (row removed) | Permanently deleted | Yes — see lifecycle below |

## Hard-mode lifecycle

`hard` mode requires three Mattermost config flags to be `true` during the sweep: `ServiceSettings.EnableAPIUserDeletion`, `EnableAPIChannelDeletion`, `EnableAPITeamDeletion`. `teardown.js` handles the full lifecycle:

1. **Preflight (read-only)**: `GET /api/v4/users/me` checks for `system_admin` role. If absent, the script warns — granular RBAC is NOT sufficient for these untagged fields (verified against MM source). The verify-after-patch in step 3 catches the no-op cleanly.
2. `GET /api/v4/config` once, snapshot the current values of all three flags. **Aborts if any flag is already `true`** (concurrent teardown in flight, or prior run died — set `TEARDOWN_ALLOW_PRE_ENABLED_FLAGS=true` to opt in for environments that legitimately run with these flags always-on).
3. **Surgical patch** via `PUT /api/v4/config/patch` setting only the three keys to `true`. Verify-after-patch re-reads the config and aborts if MM's writeFilter silently dropped the fields (catches the granular-RBAC silent-failure case).
4. Run the `?permanent=true` sweep — channels, users, team — discovering resources by `lt-<RUN_ID>-` prefix. Discovery paginates up to 100K resources; aborts on any pagination error rather than proceeding with a truncated list.
5. In a `finally` block: `PUT /api/v4/config/patch` to restore each flag to its snapshotted value, then verify-after-patch confirms it took.
6. If any sweep failure occurred OR restore failed, `exec.test.abort()` (exit code 108) so CI / Helm reports failure. **Restore failure is treated as strictly worse than sweep failure** — flags-still-enabled means the cluster is exposed.

If the restore step (5) itself fails — pod OOM, eviction, transient API error — see [Recovery](#recovery) below.

### Cleanup-posts permanent path

When `cleanup.teardownMode=hard` in Helm (or `CLEANUP_PERMANENT=true` directly), the cleanup-posts step ALSO uses `?permanent=true` on individual posts. This is the only API path that cascades cleanly to FileInfo rows AND file blobs (channel-permanent-delete skips both). It requires `EnableAPIPostDeletion=true` which cleanup.js manages with its own snapshot/enable/restore + verify-after-patch + concurrent-cleanup guard (mirror of the three-flag teardown lifecycle).

The Helm chart's pre-delete hook enforces ordering via Kubernetes `initContainers`:

1. `cleanup-posts` runs as an **`initContainer`** — must complete successfully before the main container starts. With `restartPolicy: Never`, an init failure fails the whole Pod (teardown never runs on a broken cleanup — intentional, better to leave channels than orphan more state).
2. `cleanup-teardown` runs as the **main `container`** only after init succeeds. No `sleep`, no race.

## Hard-mode safety checklist

Before running `make teardown-hard` against any real environment:

- ✅ **Validated on a non-prod Mattermost instance first.** Run a full bootstrap → load → cleanup → teardown-hard cycle there and confirm the DB rows are gone (`SELECT count(*) FROM Users WHERE Username LIKE 'lt-<run_id>-u%'` returns 0). Don't trust this is wired correctly until you've seen it work end-to-end.
- ✅ **Admin account has the full `system_admin` role.** The four `EnableAPI*Deletion` config fields require `PermissionManageSystem`. Granular `sysconsole_write_*` roles pass the outer permission check but MM silently drops the deletion-flag writes — the verify-after-patch catches this with a clear error, but using a system_admin account avoids the round-trip.
- ✅ **Not running against Mattermost Cloud.** Cloud-managed instances generally disable `PUT /api/v4/config` (returns 501); use `make teardown-soft` there and coordinate any cleanup with the platform team.
- ✅ **No one else is editing server config concurrently.** Patch is surgical (touches only the four flags) but there's still a small race window between snapshot and patch.
- ⚠️ **Cascade behavior is the server's responsibility.** Hard-deleting users / channels / teams doesn't guarantee every related row (audit entries, plugin state) is also removed. The tool drives MM's permanent-delete endpoints; the cleanup-posts permanent path is the only one that cleans file blobs.

## Discovery (not counts)

Teardown discovers resources by **prefix lookup** (`GET /users?in_team=<team_id>`, `GET /teams/<id>/channels`, filtered by `lt-<RUN_ID>-`) rather than by `BOOTSTRAP_NUM_*` env vars. So if you bootstrapped 100 users but lost track and re-run teardown with the default 50, the full 100 still get cleaned up.

Discovery cap is 100K resources (500 pages × 200/page). Larger bootstrap teams should split into multiple RUN_IDs.

## File cleanup — soft vs full

File uploads in Mattermost have a different lifecycle from the data they're attached to. Cleaning posts doesn't automatically reclaim the file blobs on storage:

| Method | DB rows (Posts) | DB rows (FileInfo) | File blob on storage | When it triggers |
|---|---|---|---|---|
| **Soft post delete** — `DELETE /posts/{id}` | `DeleteAt` set | `DeleteAt` set (via `FileInfo.DeleteForPost`) | Blob remains on storage; eligible for cleanup by MM's data retention / S3 lifecycle | Default cleanup (`cleanup.js` without `CLEANUP_PERMANENT`) |
| **Full post delete** — `DELETE /posts/{id}?permanent=true` | Row removed | Row removed (via `PermanentDeleteFilesByPost`) | **Blob removed** from file backend (`FileBackend.RemoveFile`) | `CLEANUP_PERMANENT=true` in cleanup.js, or auto-on when `teardownMode=hard` in Helm |
| **Channel hard delete** — `DELETE /channels/{id}?permanent=true` | Removed in bulk (batch SQL) | **Not touched** (orphaned) | **Not touched** (orphaned) | `teardown.js` hard mode — fast bulk path |
| **MM data retention job** | Per retention policy | Per retention policy | Per retention policy | Operator-configured (`mmctl ... retention ...`); enterprise feature |

Net intent: hard teardown is **designed to** clean everything inside Mattermost (posts, FileInfo, blobs, channels, users, team). Verify end-to-end on your target MM version before trusting it in production — MM's cascade semantics differ subtly across versions.

## Cleanup paths

`cleanup.js` picks a path automatically:

- **Admin path** (Mode B): when `ADMIN_EMAIL`/`ADMIN_PASSWORD` set AND `lt-<RUN_ID>` team exists → one admin login, scoped sweep of the bootstrap team.
- **User path** (Mode A): no admin creds → iterate users from `USERS_FILE`, each one searches their teams and deletes posts they authored.

When admin creds are set but the team doesn't exist:
- `CLEANUP_ALLOW_MISSING_TEAM=true` (chart's default in `mmlt.cleanupEnv`): exit 0 idempotently. What Helm uninstall wants.
- `CLEANUP_ALLOW_MISSING_TEAM=false` (script's default for direct `k6 run`): abort with explicit "ambiguous config" error. Catches mixed Mode A + admin creds misconfiguration.

### Cleanup output and the `zombies` counter

```
cleanup(admin) done: deleted=42 delete_errors=0 search_errors=0 zombies=0 run_id=<id>
```

- `deleted` — posts removed (success metric)
- `delete_errors` — 5xx, network failures, anything not 200/403/404
- `search_errors` — searchPosts failures
- `zombies` — posts returned by search but already gone at delete time (404). Non-zero is normal under search-index lag; **informational, not an error**.

If `zombies > 0 AND deleted === 0`, increase `CLEANUP_PASSES` / `CLEANUP_PASS_DELAY_SEC` — the script logs an explicit hint for this case. Default `PASS_DELAY_SEC` of 30s suits Elasticsearch with `refresh_interval=1s`; raise to match your ES tuning.

## Recovery

If a hard teardown dies between flag-enable and flag-restore — pod OOM, K8s evicts the node, `activeDeadlineSeconds` hits, network drops — the server is left with one or more `ServiceSettings.EnableAPI*Deletion` flags enabled. The on-call response:

```sh
export MM_URL=https://mattermost.example.com
export ADMIN_EMAIL=sysadmin@example.com
export ADMIN_PASSWORD='YourAdminPassword!'

# Dry run first — see what's currently true vs the safe defaults:
RECOVER_DRY_RUN=true make recover-flags

# Actually reset (default = all four flags to false):
make recover-flags

# Or restore to a specific known-good state:
RECOVER_SNAPSHOT_JSON='{"EnableAPIUserDeletion":true,"EnableAPIChannelDeletion":false,"EnableAPITeamDeletion":false,"EnableAPIPostDeletion":false}' \
  make recover-flags
```

Uses `PUT /api/v4/config/patch` so only the four flags are touched — never modifies other config. Verifies after each patch and aborts non-zero if MM's writeFilter silently no-op'd the change (granular RBAC perms case).

## Complete teardown — when "leave nothing behind" matters

`make teardown-hard` cleans everything **inside Mattermost** that this tool created. It does NOT touch:

- The Mattermost server itself (the container, the deployment, the systemd service)
- The Mattermost Postgres database (the DB process, the volume, rows of unrelated tenants)
- The file-storage backend itself (the S3 bucket, the local filesystem mount)

Those are the deployment manager's concern. The complete-teardown runbook depends on your deployment topology:

| Topology | Tear down MM completely |
|---|---|
| **Helm-managed MM** | `make teardown-hard` (this tool), then `helm uninstall mattermost`, then `kubectl delete pvc -l app=mattermost` |
| **Docker Compose** | `make teardown-hard`, then `docker compose down -v` (removes volumes too) |
| **Terraform-managed** | `make teardown-hard`, then `terraform destroy` against the MM stack |
| **VM with systemd** | `make teardown-hard`, then `systemctl stop mattermost`, `rm -rf /opt/mattermost/data /var/lib/postgresql/mattermost` (or wherever your data lives) |
| **Mattermost Cloud / managed** | `make teardown-soft` only — you don't control the deployment; ask the platform team for a tenant wipe |

The tool's job ends at "no test data left in MM"; the operator's job is everything beyond that.
