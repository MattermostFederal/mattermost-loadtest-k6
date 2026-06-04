import { sleep, fail } from 'k6';
import {
  login, getTeamByName, createTeam, addUserToTeam,
  getChannelByName, createChannel, addUserToChannel,
  getUserByUsername, createUser,
} from './lib/api.js';
import { RUN_ID, bootstrapUserDescriptor } from './lib/users.js';

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
    fail('bootstrap: ADMIN_EMAIL and ADMIN_PASSWORD must be set');
  }
  if (NUM_USERS <= 0) {
    fail('bootstrap: BOOTSTRAP_NUM_USERS must be > 0');
  }

  const admin = login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) fail('bootstrap: admin login failed');
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
  let created = 0, reused = 0;
  for (let i = 1; i <= NUM_USERS; i++) {
    const desc = bootstrapUserDescriptor(i);
    const r = ensureUser(admin.token, desc);
    if (r.created) created++; else reused++;

    addUserToTeam(admin.token, teamId, r.id);
    for (const ch of channelIds) addUserToChannel(admin.token, ch, r.id);

    if (i % 25 === 0) sleep(0.1);
  }
  console.log(`bootstrap: users created=${created} reused=${reused}`);
  console.log(`bootstrap: done. Main load job can now connect.`);
}

function ensureTeam(token, name, displayName) {
  const r = getTeamByName(token, name);
  if (r && r.status === 200) return r.json('id');
  const c = createTeam(token, name, displayName, 'O');
  if (!c || c.status >= 300) fail(`create team failed: ${c && c.status} ${c && c.body}`);
  return c.json('id');
}

function ensureChannel(token, teamId, name, displayName) {
  const r = getChannelByName(token, teamId, name);
  if (r && r.status === 200) return r.json('id');
  const c = createChannel(token, teamId, name, displayName, 'O');
  if (!c || c.status >= 300) fail(`create channel ${name} failed: ${c && c.status} ${c && c.body}`);
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
    fail(`create user ${desc.username} failed: ${c && c.status} ${c && c.body}`);
  }
  return { id: c.json('id'), created: true };
}
