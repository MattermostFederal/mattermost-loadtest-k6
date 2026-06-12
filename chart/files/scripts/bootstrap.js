import { sleep } from 'k6';
import exec from 'k6/execution';
import {
  login, getTeamByName, createTeam, addUserToTeam,
  getChannelByName, createChannel, addUserToChannel,
  getUserByUsername, createUser,
} from './lib/api.js';
import { bootstrapUserDescriptor } from './lib/users.js';
import { RUN_ID } from './lib/content.js';

// k6's `fail()` does NOT cause non-zero exit — it logs and marks the
// iteration failed, but the process still exits 0. exec.test.abort() exits
// 108. The Helm initContainer relies on a non-zero exit here to stop the
// main load job from starting against missing bootstrap state.
function abort(msg) {
  exec.test.abort(msg);
}

/**
 * Bootstrap MM state for a load-test run.
 *
 * Inputs (env):
 *   ADMIN_EMAIL, ADMIN_PASSWORD  - sysadmin credentials
 *   RUN_ID                       - unique tag for this run (Helm release name)
 *   BOOTSTRAP_NUM_USERS          - users to create
 *   BOOTSTRAP_NUM_CHANNELS       - channels to create
 *   BOOTSTRAP_TEAM_DISPLAY_NAME  - human-readable team name (optional)
 *
 * Creates (all named with RUN_ID prefix so teardown can find them):
 *   - 1 public team:    lt-{RUN_ID}
 *   - N public channels: lt-{RUN_ID}-ch{i}
 *   - N users:           lt-{RUN_ID}-u{i} / lt-{RUN_ID}-u{i}@loadtest.invalid
 *
 * Each user is added to the team and all channels.
 *
 * Idempotent: existing resources are reused (404s ignored).
 */
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate>=0.0'] },
};

const ADMIN_EMAIL    = __ENV.ADMIN_EMAIL    || '';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || '';
const NUM_USERS    = Number(__ENV.BOOTSTRAP_NUM_USERS    || 0);
const NUM_CHANNELS = Number(__ENV.BOOTSTRAP_NUM_CHANNELS || 5);
const TEAM_DISPLAY = __ENV.BOOTSTRAP_TEAM_DISPLAY_NAME   || `Load test ${RUN_ID}`;

const TEAM_NAME = `lt-${RUN_ID}`;

export default function () {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    abort('bootstrap: ADMIN_EMAIL and ADMIN_PASSWORD must be set');
  }
  if (NUM_USERS <= 0) {
    abort('bootstrap: BOOTSTRAP_NUM_USERS must be > 0');
  }

  const admin = login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) abort('bootstrap: admin login failed');
  console.log(`bootstrap: logged in as admin (run_id=${RUN_ID})`);

  // -- team --
  const teamId = ensureTeam(admin.token, TEAM_NAME, TEAM_DISPLAY);
  console.log(`bootstrap: team ${TEAM_NAME} -> ${teamId}`);

  // -- channels --
  const channelIds = [];
  for (let i = 1; i <= NUM_CHANNELS; i++) {
    const name = `lt-${RUN_ID}-ch${i}`;
    const id = ensureChannel(admin.token, teamId, name, `${TEAM_DISPLAY} #${i}`);
    channelIds.push(id);
  }
  console.log(`bootstrap: ${channelIds.length} channels ready`);

  // -- users --
  let created = 0, reused = 0, membershipFailures = 0;
  for (let i = 1; i <= NUM_USERS; i++) {
    const desc = bootstrapUserDescriptor(i);
    const r = ensureUser(admin.token, desc);
    if (r.created) created++; else reused++;

    const tm = addUserToTeam(admin.token, teamId, r.id);
    if (memberAddFailed(tm)) {
      console.error(`bootstrap: add ${desc.username} to team failed (status=${tm && tm.status})`);
      membershipFailures++;
    }
    for (const ch of channelIds) {
      const cm = addUserToChannel(admin.token, ch, r.id);
      if (memberAddFailed(cm)) {
        console.error(`bootstrap: add ${desc.username} to channel ${ch} failed (status=${cm && cm.status})`);
        membershipFailures++;
      }
    }

    if (i % 25 === 0) sleep(0.1);
  }
  console.log(`bootstrap: users created=${created} reused=${reused}`);
  // Membership failures would otherwise only surface later as VUs that log
  // in fine but see zero teams/channels — fail here with attribution instead.
  if (membershipFailures > 0) {
    abort(
      `bootstrap: ${membershipFailures} team/channel membership call(s) failed — ` +
      'affected users would log in with no teams or channels. Bootstrap is ' +
      'idempotent; re-run it after investigating the errors above.'
    );
  }
  console.log(`bootstrap: done. Main load job can now connect.`);
}

// Current MM treats add-member as idempotent (re-adding returns the existing
// member with 2xx), but some releases respond 400 with an already-a-member
// app error. Treat that as success so re-running bootstrap stays idempotent.
function memberAddFailed(r) {
  if (!r) return true;
  if (r.status < 300) return false;
  if (r.status === 400 && typeof r.body === 'string' && r.body.includes('already')) return false;
  return true;
}

function ensureTeam(token, name, displayName) {
  const r = getTeamByName(token, name);
  if (r && r.status === 200) return r.json('id');
  const c = createTeam(token, name, displayName, 'O');
  if (!c || c.status >= 300) abort(`create team failed: ${c && c.status} ${c && c.body}`);
  return c.json('id');
}

function ensureChannel(token, teamId, name, displayName) {
  const r = getChannelByName(token, teamId, name);
  if (r && r.status === 200) return r.json('id');
  const c = createChannel(token, teamId, name, displayName, 'O');
  if (!c || c.status >= 300) abort(`create channel ${name} failed: ${c && c.status} ${c && c.body}`);
  return c.json('id');
}

function ensureUser(token, desc) {
  const r = getUserByUsername(token, desc.username);
  if (r && r.status === 200) return { id: r.json('id'), created: false };
  const c = createUser(token, {
    email:    desc.email,
    username: desc.username,
    password: desc.password,
  });
  if (!c || c.status >= 300) {
    abort(`create user ${desc.username} failed: ${c && c.status} ${c && c.body}`);
  }
  return { id: c.json('id'), created: true };
}
