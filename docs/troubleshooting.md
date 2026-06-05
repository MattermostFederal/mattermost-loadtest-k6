# Troubleshooting

Failure modes and their fixes. Indexed by what you see in the output.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `99` | A k6 threshold failed (e.g., `http_req_duration{kind:write}` p95 over SLO) |
| `108` | `exec.test.abort()` fired — investigate before retrying |

## "PATCH returned 200 but flags weren't applied" (exit 108)

Your admin account doesn't have `system_admin` — only granular `sysconsole_write_*` roles. The four `EnableAPI*Deletion` config fields have no `access:` tag in MM's source, so the writeFilter falls through to require `PermissionManageSystem` even though the outer permission check (`SysconsoleWritePermissions`) passes.

Use an account with the full system_admin role, or skip hard mode (`cleanup.teardownMode=soft`, or `TEARDOWN_MODE=soft`).

## Cleanup leaves posts behind, `zombies > 0` in summary

Search-index lag. The script's deletes succeeded but Elasticsearch hasn't refreshed yet, so subsequent searches return already-deleted IDs (the `zombies`). Fix:

```sh
CLEANUP_PASSES=2 CLEANUP_PASS_DELAY_SEC=60 make cleanup
```

For ES backends with `refresh_interval > 30s`, raise `CLEANUP_PASS_DELAY_SEC` to match.

## "Refusing to start — flags already true at snapshot" (exit 108)

Either:
- Another teardown is currently running against the same MM (wait for it).
- A previous teardown died mid-run leaving flags enabled (`make recover-flags`).
- Your environment legitimately runs with these flags always-on (`TEARDOWN_ALLOW_PRE_ENABLED_FLAGS=true` opts in — snapshot still captures the true baseline, so restore correctly puts it back to true).

## "team `lt-<RUN_ID>` not found" (exit 108)

In Mode B + admin creds, this means the team is missing. Causes:
- Bootstrap was never run for this RUN_ID — run `make bootstrap` first.
- Already torn down — set `CLEANUP_ALLOW_MISSING_TEAM=true` for idempotent no-op (this is the Helm chart's behavior).
- RUN_ID typo — verify it matches what bootstrap used.

## `make recover-flags` reports "PATCH returned 200 but flags didn't update" (exit 108)

Same root cause as the first issue — your admin lacks `system_admin`. **Production is still in a vulnerable state.** Escalate to someone with system_admin and run recovery again.

## Helm pre-delete hook fails on `helm uninstall`

```sh
kubectl logs job/<release>-mattermost-loadtest-k6-cleanup -c cleanup-posts    # initContainer
kubectl logs job/<release>-mattermost-loadtest-k6-cleanup -c cleanup-teardown # main container
```

The initContainer (cleanup-posts) runs before cleanup-teardown. If init fails, teardown never runs — by design (better to halt than orphan more state). Read the init logs for the actual error.

## Disk-full after multiple `load-attachments` runs

Hard-deleting channels via API does NOT cascade to file blobs (verified against MM source). Use `make teardown-hard` (which uses `?permanent=true` on posts and DOES cascade through files), OR configure MM's data-retention policy for periodic blob purge.

## "No user source configured" (exit 108)

The script aborted at `setup()` because no users are available. Either:
- Set `USERS_FILE` to a JSON/CSV with `{login_id, password}` entries (Mode A)
- Set `BOOTSTRAP_NUM_USERS>0` and matching `RUN_ID` (Mode B)

## "verifyBootstrap: user lt-<RUN_ID>-u1 not found"

Mode B was selected (`BOOTSTRAP_NUM_USERS>0` + admin creds) but the bootstrap users don't exist. Run `make bootstrap` with the same `RUN_ID` first, or set `VERIFY_BOOTSTRAP=false` to skip the check (if you're confident bootstrap ran).

## "Projected upload (X MB) exceeds ATTACHMENT_SOFT_LIMIT_MB" (exit 108)

`load-attachments` pre-flight detected the projected total upload volume would exceed the soft limit (default 500 MB). Either lower `TARGET_VUS` / `STEADY_SEC` / `ATTACHMENT_SIZE_BYTES`, or set `ATTACHMENT_CONFIRM_LARGE=true` to bypass. Verify target free disk before bypassing.

## All VUs failing to log in / 401 errors

Common causes:
- `MM_URL` wrong or unreachable from the load-gen box
- Users in `users.json` have wrong passwords / are SSO-only / MFA-required (see [modes.md](modes.md) for per-user requirements)
- TLS issue — add `--insecure-skip-tls-verify` for self-signed certs

Run `make preflight` first — it logs in every user and confirms each one has teams + channels, failing fast with a specific error.

## File descriptor exhaustion / `too many open files`

Each VU opens an HTTP keep-alive connection + a websocket. For runs above ~500 VUs:

```sh
ulimit -n 65536
```

Put it in the same shell that runs `k6` — doesn't persist across sessions.

## Stuck Helm pre-delete hook on uninstall

If the cleanup Job is stuck (initContainer image pull failure, hung k6 process), `helm uninstall` waits for the hook to complete. Force unstick:

```sh
kubectl delete job <release>-mattermost-loadtest-k6-cleanup --force --grace-period=0
helm uninstall <release> --no-hooks   # skip the hook entirely if needed
```

Then run `make recover-flags` to make sure no `EnableAPI*Deletion` flags were left enabled.

## Audit log volume concerns

Hard teardown emits 4 config-change audit events per run (cleanup-posts enable/restore + cleanup-teardown enable/restore). Federal customers with tight audit budgets should know this. Soft mode emits zero config-change events; use it if audit volume is a constraint.
