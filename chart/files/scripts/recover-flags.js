import exec from 'k6/execution';
import { login, getConfig, patchConfig, verifyServiceSettingsFlags } from './lib/api.js';

// k6's `fail()` (the module-level helper from "k6") does NOT cause non-zero
// exit — it logs but the process still exits 0. exec.test.abort() does
// (exit code 108) — required so CI / operator wrapper scripts detect a
// failed recovery attempt instead of silently moving on.
function abort(msg) {
  exec.test.abort(msg);
}

/**
 * Recover ServiceSettings deletion flags after a failed teardown/cleanup.
 *
 * Scenario: a previous `make teardown-hard` or `helm uninstall` run died
 * (pod OOM, node eviction, activeDeadlineSeconds, network blip) AFTER
 * enabling the EnableAPI*Deletion flags but BEFORE the `finally` block
 * restored them. The server is now in a state where any admin with token
 * access can permanently delete users/channels/teams/posts via API.
 * This script puts the flags back where they belong.
 *
 * Modes:
 *   Default — set all four deletion flags to false (the safest defaults
 *             for any environment that doesn't run frequent test cleanups).
 *   Snapshot — pass RECOVER_SNAPSHOT_JSON to restore to a specific known-
 *             good state. Useful if the operator knows the flags WERE
 *             legitimately true before our test and wants them back true.
 *
 * Required env:
 *   MM_URL, ADMIN_EMAIL, ADMIN_PASSWORD
 *
 * Optional:
 *   RECOVER_SNAPSHOT_JSON — JSON string with the desired flag values, e.g.
 *     '{"EnableAPIUserDeletion":false,"EnableAPIChannelDeletion":false,
 *       "EnableAPITeamDeletion":false,"EnableAPIPostDeletion":false}'
 *   RECOVER_DRY_RUN=true — print what would change, don't actually patch
 *
 * Example invocations:
 *   make recover-flags
 *     → sets all four flags to false
 *
 *   RECOVER_SNAPSHOT_JSON='{"EnableAPIUserDeletion":true}' make recover-flags
 *     → restores only that one flag to true, leaves others untouched
 *
 *   RECOVER_DRY_RUN=true make recover-flags
 *     → shows current vs desired values without writing
 */
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate>=0.0'] },
};

const ADMIN_EMAIL    = __ENV.ADMIN_EMAIL    || '';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || '';
const DRY_RUN        = (__ENV.RECOVER_DRY_RUN || 'false').toLowerCase() === 'true';

const ALL_FLAGS = [
  'EnableAPIUserDeletion',
  'EnableAPIChannelDeletion',
  'EnableAPITeamDeletion',
  'EnableAPIPostDeletion',
];

// Parse optional snapshot. If not provided, default to all-false.
function parseDesiredState() {
  const raw = __ENV.RECOVER_SNAPSHOT_JSON;
  if (!raw) {
    const allFalse = {};
    for (const f of ALL_FLAGS) allFalse[f] = false;
    return allFalse;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    abort(`recover-flags: RECOVER_SNAPSHOT_JSON failed to parse: ${e.message}`);
  }
  // Only the four flags we care about; ignore unknown keys.
  const desired = {};
  for (const f of ALL_FLAGS) {
    if (f in parsed) desired[f] = parsed[f] === true;
  }
  if (Object.keys(desired).length === 0) {
    abort('recover-flags: RECOVER_SNAPSHOT_JSON had no recognized EnableAPI*Deletion keys');
  }
  return desired;
}

export default function () {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    abort('recover-flags: ADMIN_EMAIL and ADMIN_PASSWORD must be exported in your shell');
  }

  const admin = login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) abort('recover-flags: admin login failed');

  const desired = parseDesiredState();
  console.log(`recover-flags: target state ${JSON.stringify(desired)}`);

  // Read current state to log the delta and skip the PATCH if already correct.
  const r = getConfig(admin.token);
  if (!r || r.status !== 200) {
    abort(`recover-flags: GET /config failed (status=${r && r.status})`);
  }
  const current = r.json('ServiceSettings') || {};
  const delta = {};
  const changes = [];
  for (const [flag, want] of Object.entries(desired)) {
    const have = current[flag] === true;
    if (have !== want) {
      delta[flag] = want;
      changes.push(`${flag}: ${have} -> ${want}`);
    }
  }

  if (changes.length === 0) {
    console.log('recover-flags: all target flags already match desired state; nothing to do');
    return;
  }

  console.log(`recover-flags: changes to apply:\n  ${changes.join('\n  ')}`);

  if (DRY_RUN) {
    console.log('recover-flags: DRY_RUN=true, not writing config');
    return;
  }

  const w = patchConfig(admin.token, { ServiceSettings: delta });
  if (!w || w.status !== 200) {
    abort(`recover-flags: PUT /config/patch failed (status=${w && w.status}); flags may still be in incorrect state`);
  }

  // CRITICAL: this is the last line of defense. If the recovery PATCH
  // returns 200 but the flags didn't change (MM's writeFilter silently
  // dropping fields for non-system_admin callers), the operator would
  // see "applied N change(s)" and walk away while production stays in a
  // vulnerable state. Verify-after-patch closes the loop.
  const mismatches = verifyServiceSettingsFlags(admin.token, desired);
  if (mismatches) {
    abort(
      `recover-flags: PATCH returned 200 but flags didn't update — ${JSON.stringify(mismatches)}. ` +
      'Admin needs PermissionManageSystem (system_admin role), not just sysconsole_write_*. ' +
      'PROD IS STILL IN A VULNERABLE STATE — escalate to someone with system_admin.'
    );
  }
  console.log(`recover-flags: applied ${changes.length} change(s) (verified)`);
}
