import { fail } from 'k6';
import {
  login, getTeamByName, deleteTeam,
  getChannelByName, deleteChannel,
  getUserByUsername, deleteUser,
} from './lib/api.js';
import { RUN_ID, bootstrapUserDescriptor } from './lib/users.js';

/**
 * Teardown: reverses bootstrap.js. Soft-deletes the users, channels, and team
 * that bootstrap created (everything named lt-{RUN_ID}-...).
 *
 * Idempotent: missing resources are silently skipped.
 *
 * NOTE on hard vs soft delete:
 *   - DELETE /users/{id}, /channels/{id}, /teams/{id} all do SOFT delete.
 *   - Permanent deletion requires `ServiceSettings.EnableAPIUserDeletion=true`
 *     (or similar) AND a special endpoint or flag. For most installs, soft
 *     delete is what you want and what this does.
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
const DELETE_TEAM = (__ENV.TEARDOWN_DELETE_TEAM || 'true').toLowerCase() === 'true';

const TEAM_NAME = `lt-${RUN_ID}`;

export default function () {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    fail('teardown: ADMIN_EMAIL and ADMIN_PASSWORD must be set');
  }

  const admin = login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (!admin) fail('teardown: admin login failed');
  console.log(`teardown: logged in as admin (run_id=${RUN_ID})`);

  // Resolve team (may not exist if bootstrap was skipped or already torn down).
  let teamId = null;
  const t = getTeamByName(admin.token, TEAM_NAME);
  if (t && t.status === 200) teamId = t.json('id');
  else console.log(`teardown: team ${TEAM_NAME} not found, skipping channel/team delete`);

  let chDeleted = 0;
  if (teamId) {
    for (let i = 1; i <= NUM_CHANNELS; i++) {
      const name = `lt-${RUN_ID}-ch${i}`;
      const r = getChannelByName(admin.token, teamId, name);
      if (r && r.status === 200) {
        deleteChannel(admin.token, r.json('id'));
        chDeleted++;
      }
    }
  }
  console.log(`teardown: deleted ${chDeleted} channels`);

  let uDeleted = 0;
  for (let i = 1; i <= NUM_USERS; i++) {
    const desc = bootstrapUserDescriptor(i);
    const r = getUserByUsername(admin.token, desc.username);
    if (r && r.status === 200) {
      deleteUser(admin.token, r.json('id'));
      uDeleted++;
    }
  }
  console.log(`teardown: deleted ${uDeleted} users`);

  if (teamId && DELETE_TEAM) {
    deleteTeam(admin.token, teamId);
    console.log(`teardown: deleted team ${TEAM_NAME}`);
  }

  console.log('teardown: done');
}
