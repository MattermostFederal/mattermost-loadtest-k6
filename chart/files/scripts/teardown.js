import exec from 'k6/execution';
import {
  login, getMe,
  getTeamByName, deleteTeam, deleteTeamPermanent,
  deleteChannel, deleteChannelPermanent, getChannelsForTeam,
  deleteUser, deleteUserPermanent, getUsersInTeam,
  getConfig, patchConfig, verifyServiceSettingsFlags,
} from './lib/api.js';
// Import RUN_ID from content.js (not users.js) — teardown doesn't use the
// users array at all, and importing users.js would force its SharedArray
// to construct at module init, opening USERS_FILE even when teardown only
// needs admin tokens. content.js has no init-time side effects.

// k6's `fail()` does NOT cause non-zero exit (documented behavior — logs
// error, marks iteration failed, but process still exits 0). exec.test.abort()
// is the idiomatic mechanism for "stop the test AND propagate failure to CI"
// — added in k6 0.39, stable through v2.x. Required so CI / Helm pre-delete
// hooks actually report a failed teardown instead of silently succeeding.
function abort(msg) {
  exec.test.abort(msg);
}
import { RUN_ID } from './lib/content.js';

/**
 * Teardown — reverses bootstrap.js. Discovers and removes the users, channels,
 * and team that bootstrap created (everything named `lt-{RUN_ID}-...`).
 *
 * Modes (TEARDOWN_MODE env var):
 *   none  — default; log and exit. Leaves bootstrap state in place.
 *   soft  — DELETE endpoints set delete_at. Equivalent to the UI's "archive"
 *           for channels/teams and "deactivate" for users. Data remains in DB.
 *   hard  — Permanent removal. Snapshots ServiceSettings.EnableAPI*Deletion,
 *           flips all three to true, runs ?permanent=true sweep, then restores
 *           the originals in a finally block — even on partial failure.
 *
 * Discovery (replaces count-based iteration):
 *   Users   — paginated list of users in the bootstrap team, filtered by the
 *             `lt-{RUN_ID}-u` username prefix.
 *   Channels— paginated list of channels in the bootstrap team, filtered by
 *             the `lt-{RUN_ID}-ch` name prefix.
 *   Idempotent: missing resources are silently skipped; safe to re-run.
 */
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate>=0.0'] },
};

const ADMIN_EMAIL    = __ENV.ADMIN_EMAIL    || '';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || '';
const MODE = (__ENV.TEARDOWN_MODE || 'none').toLowerCase();
const DELETE_TEAM = (__ENV.TEARDOWN_DELETE_TEAM || 'true').toLowerCase() === 'true';

const TEAM_NAME = `lt-${RUN_ID}`;
const USER_PREFIX = `lt-${RUN_ID}-u`;
const CHANNEL_PREFIX = `lt-${RUN_ID}-ch`;

// Three ServiceSettings flags that gate permanent-delete endpoints for the
// resources teardown.js handles. All must be true during the hard sweep.
// Snapshotted before, restored after, in a `finally` block.
//
// Note: EnableAPIPostDeletion is NOT in this list — cleanup.js owns it
// since cleanup-posts runs first in the Helm pre-delete hook ordering and
// needs the flag enabled before teardown.js even logs in. Each script
// manages the flags it directly needs.
const DELETION_FLAGS = [
  'EnableAPIUserDeletion',
  'EnableAPIChannelDeletion',
  'EnableAPITeamDeletion',
];

export default function () {
  if (MODE === 'none') {
    console.log(`teardown: TEARDOWN_MODE=none, skipping (run_id=${RUN_ID})`);
    return;
  }
  if (MODE !== 'soft' && MODE !== 'hard') {
    abort(`teardown: TEARDOWN_MODE must be one of: none, soft, hard (got "${MODE}")`);
  }
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    abort('teardown: ADMIN_EMAIL and ADMIN_PASSWORD must be set');
  }

  const admin = login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) abort('teardown: admin login failed');
  console.log(`teardown: mode=${MODE} run_id=${RUN_ID}`);

  // Resolve team (may be absent if bootstrap was skipped or already torn down).
  let teamId = null;
  const t = getTeamByName(admin.token, TEAM_NAME);
  if (t && t.status === 200) teamId = t.json('id');
  else console.log(`teardown: team ${TEAM_NAME} not found`);

  // Discover BEFORE any deletion happens — once the team is gone, in_team
  // lookups stop working.
  let channelIds = [];
  let userIds = [];
  if (teamId) {
    const chR = discoverChannels(admin.token, teamId);
    const uR = discoverUsers(admin.token, teamId);
    // Abort on discovery errors rather than proceeding with a truncated
    // list. A non-200 mid-pagination means we don't know what we missed;
    // running the sweep on a partial set would leave residuals AND
    // misdiagnose later (team-delete would fail blaming the wrong cause).
    if (chR.errors > 0 || uR.errors > 0) {
      abort(
        `teardown: discovery hit errors (channel_errors=${chR.errors} user_errors=${uR.errors}). ` +
        'Refusing to proceed with truncated lists. Re-run after investigating MM server-side errors.'
      );
    }
    channelIds = chR.ids;
    userIds = uR.ids;
  }
  console.log(`teardown: discovered users=${userIds.length} channels=${channelIds.length}`);

  if (MODE === 'soft') {
    softSweep(admin.token, userIds, channelIds, teamId);
    return;
  }

  // mode === 'hard'
  preflightAdminRole(admin.token);
  const originals = snapshotFlags(admin.token);
  enableFlags(admin.token);
  let sweepResult = { failures: 0, summary: '' };
  let restoreResult = { restored: true };
  try {
    sweepResult = hardSweep(admin.token, userIds, channelIds, teamId);
  } finally {
    restoreResult = restoreFlags(admin.token, originals);
  }

  // CRITICAL: flags-still-enabled is strictly more dangerous than a partial
  // sweep failure. If restoreFlags couldn't put the flags back, the cluster
  // is exposed (any admin token can permanently delete data via API).
  // Always abort on restore failure first.
  if (!restoreResult.restored) {
    abort(
      `teardown(hard): CRITICAL — ${restoreResult.message}. ` +
      'Deletion flags may still be enabled cluster-wide. ' +
      'Run `make recover-flags` IMMEDIATELY to remediate.'
    );
  }

  // After confirming flags are back, surface partial sweep failures so
  // CI/Helm sees a non-zero exit when residual resources remain.
  if (sweepResult.failures > 0) {
    abort(`teardown(hard): ${sweepResult.summary}`);
  }
}

// --- discovery ---------------------------------------------------------------

// Discovery functions return { ids, errors }. A non-200 mid-pagination is
// treated as failure (NOT a silent break) — proceeding with a truncated
// list would skip resources and then misdiagnose the failure later.
//
// Page cap raised to 500 (×200/page = 100K resources). Bigger than any
// realistic bootstrap.

function discoverUsers(token, teamId) {
  const ids = [];
  let errors = 0;
  let hitCap = false;
  for (let page = 0; page < 500; page++) {
    const r = getUsersInTeam(token, teamId, page, 200);
    if (!r || r.status !== 200) {
      errors++;
      break;
    }
    const batch = r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const u of batch) {
      if (u.username && u.username.startsWith(USER_PREFIX)) ids.push(u.id);
    }
    if (batch.length < 200) break;
    if (page === 499) hitCap = true;
  }
  if (hitCap) {
    console.warn(`teardown: discoverUsers hit 500-page cap (>100K users in team) — list may be truncated`);
  }
  return { ids, errors };
}

function discoverChannels(token, teamId) {
  const ids = [];
  let errors = 0;
  let hitCap = false;
  for (let page = 0; page < 500; page++) {
    const r = getChannelsForTeam(token, teamId, page, 200);
    if (!r || r.status !== 200) {
      errors++;
      break;
    }
    const batch = r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const c of batch) {
      if (c.name && c.name.startsWith(CHANNEL_PREFIX)) ids.push(c.id);
    }
    if (batch.length < 200) break;
    if (page === 499) hitCap = true;
  }
  if (hitCap) {
    console.warn(`teardown: discoverChannels hit 500-page cap (>100K channels) — list may be truncated`);
  }
  return { ids, errors };
}

// --- soft sweep --------------------------------------------------------------

function softSweep(token, userIds, channelIds, teamId) {
  let chDeleted = 0;
  for (const id of channelIds) {
    const r = deleteChannel(token, id);
    if (r && r.status === 200) chDeleted++;
  }
  console.log(`teardown(soft): archived ${chDeleted}/${channelIds.length} channels`);

  let uDeleted = 0;
  for (const id of userIds) {
    const r = deleteUser(token, id);
    if (r && r.status === 200) uDeleted++;
  }
  console.log(`teardown(soft): deactivated ${uDeleted}/${userIds.length} users`);

  if (teamId && DELETE_TEAM) {
    const r = deleteTeam(token, teamId);
    if (r && r.status === 200) console.log(`teardown(soft): archived team ${TEAM_NAME}`);
  }
}

// --- hard sweep --------------------------------------------------------------

// Returns { failures: <int>, summary: <string> } so the caller can abort()
// non-zero when residual resources remain. Restoration of flags still
// happens in the caller's finally block regardless of failures here.
function hardSweep(token, userIds, channelIds, teamId) {
  // Channels first — they reference team, but team-permanent-delete should
  // cascade if any survive. Users next so they're gone before team-delete
  // tries to validate "no remaining members."
  const chFails = [];
  let chDeleted = 0;
  for (const id of channelIds) {
    const r = deleteChannelPermanent(token, id);
    if (r && r.status === 200) chDeleted++;
    else chFails.push({ id, status: r && r.status });
  }
  console.log(`teardown(hard): permanently deleted ${chDeleted}/${channelIds.length} channels`);
  if (chFails.length > 0) {
    console.error(`teardown(hard): channel failures: ${JSON.stringify(chFails)}`);
  }

  const uFails = [];
  let uDeleted = 0;
  for (const id of userIds) {
    const r = deleteUserPermanent(token, id);
    if (r && r.status === 200) uDeleted++;
    else uFails.push({ id, status: r && r.status });
  }
  console.log(`teardown(hard): permanently deleted ${uDeleted}/${userIds.length} users`);
  if (uFails.length > 0) {
    console.error(`teardown(hard): user failures: ${JSON.stringify(uFails)}`);
  }

  let teamFailed = false;
  if (teamId && DELETE_TEAM) {
    const r = deleteTeamPermanent(token, teamId);
    if (r && r.status === 200) {
      console.log(`teardown(hard): permanently deleted team ${TEAM_NAME}`);
    } else {
      // Team-delete commonly fails when residual members or channels remain.
      // Correlate explicitly so the operator doesn't have to guess.
      const status = r && r.status;
      teamFailed = true;
      console.error(`teardown(hard): team delete failed (status=${status})`);
      if (uFails.length > 0 || chFails.length > 0) {
        console.error(
          `teardown(hard): likely cause — ${uFails.length} user(s) and ` +
          `${chFails.length} channel(s) failed to delete and may still be ` +
          `holding references to team ${TEAM_NAME} (id=${teamId})`
        );
      }
      console.error(
        'teardown(hard): re-run `make teardown-hard` to retry. Teardown is ' +
        'idempotent and discovery-based; a second pass will pick up exactly ' +
        'what the first one missed.'
      );
    }
  }

  const total = chFails.length + uFails.length + (teamFailed ? 1 : 0);
  const summary = `partial failure — ${chFails.length} channels, ${uFails.length} users` +
    (teamFailed ? ', team' : '') + ' failed to delete';
  return { failures: total, summary };
}

// --- config flag snapshot / restore ------------------------------------------
//
// We use PUT /api/v4/config/patch — surgical updates of only the
// ServiceSettings.EnableAPI*Deletion keys. Two wins over the full PUT:
//   1. No risk of clobbering an unrelated admin's concurrent config change
//   2. Audit log shows only the three bool toggles, not a diff of the
//      whole config blob

function snapshotFlags(token) {
  const r = getConfig(token);
  if (!r || r.status !== 200) {
    abort(`teardown(hard): GET /config failed: ${r && r.status}`);
  }
  const cfg = r.json();
  if (!cfg.ServiceSettings) {
    abort('teardown(hard): config has no ServiceSettings');
  }
  const originals = {};
  for (const f of DELETION_FLAGS) {
    originals[f] = cfg.ServiceSettings[f] === true;
  }

  // Concurrent-teardown guard. If any deletion flag is ALREADY true at
  // snapshot time, the most likely causes are (a) another hard teardown
  // in flight, (b) a previous run died before restore, OR (c) the env
  // legitimately runs with a deletion flag enabled by policy.
  //
  // Default behavior: abort with actionable advice. Operators in case (c)
  // can opt in via TEARDOWN_ALLOW_PRE_ENABLED_FLAGS=true. The snapshot
  // still captures the true baseline, so restore correctly puts it back
  // to true — but concurrent-teardown protection no longer applies.
  const preEnabled = Object.entries(originals).filter(([, v]) => v).map(([f]) => f);
  if (preEnabled.length > 0) {
    const allowPreEnabled = (__ENV.TEARDOWN_ALLOW_PRE_ENABLED_FLAGS || 'false').toLowerCase() === 'true';
    if (!allowPreEnabled) {
      abort(
        `teardown(hard): refusing to start — flags already true at snapshot: ${preEnabled.join(', ')}. ` +
        'Either another teardown is in flight, or a previous run died with flags enabled. ' +
        'Wait for the other run to complete, run `make recover-flags` if no other run is active, ' +
        'OR set TEARDOWN_ALLOW_PRE_ENABLED_FLAGS=true if your environment legitimately runs ' +
        'with these flags always-on by policy (e.g. DBA pipelines using ?permanent=true).'
      );
    }
    console.warn(
      `teardown(hard): TEARDOWN_ALLOW_PRE_ENABLED_FLAGS=true; pre-enabled flags will be ` +
      `restored to true: ${preEnabled.join(', ')}. Concurrent-teardown safety disabled.`
    );
  }
  console.log(`teardown(hard): snapshot ${JSON.stringify(originals)}`);
  return { originals };
}

// preflightAdminRole is a READ-ONLY check that the admin account is
// plausibly able to write config. GET /users/me is cheap and silent
// (no audit-log side effects).
//
// Important nuance verified against MM source (server/channels/api4/config.go:458
// + server/public/model/config.go:448-472): the four EnableAPI*Deletion
// fields have NO `access:` struct tag, so MM's writeFilter falls through
// to PermissionManageSystem. That means granular RBAC roles
// (sysconsole_write_environment_*) pass the outer SysconsoleWritePermissions
// guard at config.go:290 but the PATCH merge silently drops the fields,
// returning 200 OK with values UNCHANGED.
//
// This preflight is therefore a soft signal — even without system_admin,
// the patch will appear to succeed. The authoritative check happens via
// verifyServiceSettingsFlags after each patch (enableFlags / restoreFlags),
// which re-reads the live config and aborts on mismatch.
function preflightAdminRole(token) {
  const r = getMe(token);
  if (!r || r.status !== 200) {
    abort(`teardown(hard): preflight GET /users/me failed (status=${r && r.status}); cannot verify admin identity`);
  }
  const rolesStr = r.json('roles') || '';
  const roles = rolesStr.split(/\s+/).filter(Boolean);
  if (roles.includes('system_admin')) {
    console.log('teardown(hard): admin has system_admin role; proceeding');
    return;
  }
  // The verify-after-patch in enableFlags will catch this case loudly,
  // but warn here for an early diagnostic signal.
  console.warn(
    `teardown(hard): admin account has no system_admin role (roles="${rolesStr}"). ` +
    'The four EnableAPI*Deletion fields require PermissionManageSystem (system_admin) — ' +
    'granular sysconsole_write_* roles will silently fail. enableFlags will abort with a ' +
    'clear message when the verify-after-patch catches the no-op.'
  );
}

function enableFlags(token /* snap unused with patch */) {
  // Surgical patch — only the three EnableAPI*Deletion keys, leaves the
  // rest of the config alone. If this fails, no resources have been
  // touched yet.
  const patch = { ServiceSettings: {} };
  for (const f of DELETION_FLAGS) patch.ServiceSettings[f] = true;
  const r = patchConfig(token, patch);
  if (!r || r.status !== 200) {
    const status = r && r.status;
    let hint = '';
    if (status === 403) {
      hint = ' — admin lacks PUT /api/v4/config/patch permission';
    } else if (status === 401) {
      hint = ' — admin session unauthorized; re-check ADMIN_EMAIL / ADMIN_PASSWORD';
    } else if (status === 501 || status === 404) {
      hint = ' — config patch endpoint disabled or not present (older MM, or Cloud/managed); use soft mode';
    }
    abort(`teardown(hard): enabling deletion flags failed (status=${status})${hint}; teardown aborted before any data was touched`);
  }

  // Verify-after-patch: MM's writeFilter silently drops untagged
  // ServiceSettings fields for non-system_admin callers. PATCH returns
  // 200 OK with the values UNCHANGED. Without this check the sweep would
  // proceed and every delete would 501 — silent failure with a misleading
  // diagnostic chain.
  const expected = {};
  for (const f of DELETION_FLAGS) expected[f] = true;
  const mismatches = verifyServiceSettingsFlags(token, expected);
  if (mismatches) {
    abort(
      `teardown(hard): PATCH returned 200 but flags weren't applied — ${JSON.stringify(mismatches)}. ` +
      'Admin needs PermissionManageSystem (system_admin role), not just sysconsole_write_*. ' +
      'No resources were touched.'
    );
  }
  console.log('teardown(hard): deletion flags enabled (verified)');
}

// Returns { restored: true } on success, { restored: false, message } on
// failure. Caller MUST check and propagate to a non-zero exit — a silent
// log + return would have CI/Helm reporting teardown success while
// deletion flags stay enabled across the cluster.
function restoreFlags(token, snap) {
  const patch = { ServiceSettings: {} };
  for (const f of DELETION_FLAGS) patch.ServiceSettings[f] = snap.originals[f];
  const r = patchConfig(token, patch);
  if (!r || r.status !== 200) {
    return {
      restored: false,
      message: `restore PUT /config/patch failed (${r && r.status}) — flags may still be enabled`,
    };
  }

  // Verify-after-patch on restore too — same writeFilter risk.
  const mismatches = verifyServiceSettingsFlags(token, snap.originals);
  if (mismatches) {
    return {
      restored: false,
      message: `restore PATCH returned 200 but flags didn't match snapshot — ${JSON.stringify(mismatches)}`,
    };
  }
  console.log(`teardown(hard): restored flags to ${JSON.stringify(snap.originals)} (verified)`);
  return { restored: true };
}
