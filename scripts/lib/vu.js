import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';
import { users, pickUser } from './users.js';
import { login, getUserByUsername } from './api.js';
import { initialSync } from './sync.js';
import { runWithWebSocket } from './ws.js';
import { pickAction } from './actions.js';
import { rateForVU, pickIdleMs } from './rates.js';

// Surface silently-swallowed action exceptions. Without this, the
// try/catch in the tick loop (kept to prevent one bad iteration from
// killing the VU) makes debugging "why did all my X return zero
// results" impossible — no log, no metric, no counter. The metric
// shows up in the k6 summary tagged by action name.
const actionErrors = new Counter('mm_action_errors');

/**
 * verifyUsersAvailable — call from setup() in any load/breakpoint script.
 * Aborts the test at start if no user source is configured, so we don't
 * end up with "ran 10 VUs, all silently failed to log in, exited 0."
 *
 * Round-10 made users.js return [] when no source is set (USERS_FILE
 * empty AND BOOTSTRAP_NUM_USERS=0). That's safe for admin-only scripts
 * like teardown but a misconfiguration for load scripts that genuinely
 * need user creds. This guard turns "silently passes" into "loud fail."
 */
export function verifyUsersAvailable() {
  if (users.length === 0) {
    exec.test.abort(
      'No user source configured. Mode A: set USERS_FILE to a JSON/CSV. ' +
      'Mode B: set BOOTSTRAP_NUM_USERS>0 (and matching RUN_ID).'
    );
  }
}

/**
 * Shared per-VU loop used by load.js, breakpoint.js, and the targeted
 * stressors (load-search, load-attachments, load-realtime).
 *
 * Each caller passes the action list it wants (default mix, search-heavy,
 * attachment-heavy, etc.) along with the timing knobs. The shape of the
 * tick loop is identical across scenarios — what differs is the weighted
 * action mix and per-script idle distributions.
 *
 * opts:
 *   actions         — array from lib/actions.js (or a reweighted variant)
 *   sessionSec      — websocket lifetime per VU iteration
 *   minIdleMs       — minimum idle between actions; also the tick granularity
 *   avgIdleMs       — average idle between actions (sampled per-VU)
 *   percentReplies  — fraction of CreatePost actions that are replies
 *   percentUrgent   — fraction of root posts marked priority=urgent
 *   readOnly        — if true, write actions are no-ops
 */
export function runVU(opts) {
  const {
    actions,
    sessionSec,
    minIdleMs,
    avgIdleMs,
    percentReplies = 0.18,
    percentUrgent = 0.001,
    readOnly = false,
  } = opts;

  const creds = pickUser(__VU);
  const session = login(creds.login_id, creds.password);
  if (!session) return;

  const synced = initialSync(session.token, session.userId);
  if (synced.allOpenChannelIds.length === 0) return;

  const rate = rateForVU(__VU);
  const ctx = {
    token:        session.token,
    userId:       session.userId,
    teams:        synced.teams,
    channelsByTeam: synced.channelsByTeam,
    allOpenChannelIds: synced.allOpenChannelIds,
    state: { currentChannelId: '', lastPostIdByChannel: {} },
    wsCtx: null,
    readOnly,
    percentReplies,
    percentUrgent,
  };

  // Tick fires roughly every minIdleMs scaled by rate; inside, we sleep the
  // remainder of the sampled idle. This keeps WS open continuously across
  // many actions while respecting per-VU rate.
  let pendingSleepMs = 0;
  function tick(wsCtx) {
    ctx.wsCtx = wsCtx;

    if (pendingSleepMs > minIdleMs) {
      pendingSleepMs -= minIdleMs;
      return;
    }

    const action = pickAction(actions);
    try {
      action.run(ctx);
    } catch (e) {
      // Swallow to keep the VU loop alive — one bad iteration shouldn't
      // tear down a 30-minute test. But emit a tagged counter so the
      // failure is at least visible in the summary.
      actionErrors.add(1, { action: action.name });
    }

    pendingSleepMs = pickIdleMs(minIdleMs, avgIdleMs, rate);
  }

  runWithWebSocket(
    session.token,
    session.userId,
    sessionSec * 1000,
    tick,
    minIdleMs,
  );

  sleep(1);
}

/**
 * verifyBootstrap — optional pre-test sanity check that the Mode B
 * bootstrap actually ran for the current RUN_ID. Call from a script's
 * setup() function; if the bootstrap users don't exist, throws with a
 * clear actionable message and k6 aborts before any VU starts.
 *
 * Quiet (returns immediately) when:
 *   - BOOTSTRAP_NUM_USERS is not set or <= 0 (Mode A — no bootstrap to verify)
 *   - ADMIN_EMAIL or ADMIN_PASSWORD is missing (can't verify without admin)
 *
 * Otherwise: one admin login + one GET /users/username/lt-{RUN_ID}-u1.
 * The cost is a single HTTP round-trip at test start. If you want to skip
 * this check (e.g. you know bootstrap ran and want to save the round-trip
 * on every test invocation), set VERIFY_BOOTSTRAP=false.
 */
export function verifyBootstrap() {
  if ((__ENV.VERIFY_BOOTSTRAP || 'true').toLowerCase() === 'false') return;

  const numUsers = Number(__ENV.BOOTSTRAP_NUM_USERS || 0);
  const adminEmail = __ENV.ADMIN_EMAIL;
  const adminPassword = __ENV.ADMIN_PASSWORD;
  if (numUsers <= 0 || !adminEmail || !adminPassword) return;

  const runId = (__ENV.RUN_ID || 'default').replace(/[^A-Za-z0-9_-]/g, '');

  const admin = login(adminEmail, adminPassword);
  if (!admin) {
    throw new Error(
      `verifyBootstrap: admin login failed (ADMIN_EMAIL=${adminEmail}). ` +
      'Check credentials, or set VERIFY_BOOTSTRAP=false to skip this check.'
    );
  }
  const expected = `lt-${runId}-u1`;
  const r = getUserByUsername(admin.token, expected);
  if (!r || r.status === 404) {
    throw new Error(
      `verifyBootstrap: user ${expected} not found on the server. ` +
      `RUN_ID=${runId} with BOOTSTRAP_NUM_USERS=${numUsers}, but bootstrap-derived ` +
      'users don\'t exist. Run `make bootstrap` with the same RUN_ID first, ' +
      'or set VERIFY_BOOTSTRAP=false to skip this check.'
    );
  }
  if (r.status !== 200) {
    throw new Error(
      `verifyBootstrap: GET ${expected} returned ${r.status}; ` +
      'expected 200 (user exists) or 404 (does not). Investigate before continuing.'
    );
  }
  console.log(`verifyBootstrap: ${expected} present, proceeding`);
}
