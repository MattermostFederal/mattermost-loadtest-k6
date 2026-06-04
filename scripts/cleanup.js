import { sleep } from 'k6';
import { users } from './lib/users.js';
import { login, getMyTeams, searchPosts, deletePost } from './lib/api.js';
import { MARKER, RUN_ID } from './lib/content.js';

/**
 * Cleanup script: searches each user's teams for posts tagged with
 * `[lt-<RUN_ID>]` and deletes them. Idempotent — re-running is safe.
 *
 * Run via:
 *   USERS_FILE=./config/users.json MM_URL=... RUN_ID=<id> \
 *     k6 run scripts/cleanup.js
 *
 * In the Helm chart this is wired to the pre-delete hook so `helm uninstall`
 * automatically removes posts created during the run.
 */
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate>=0.0'] }, // no failing thresholds; just report
};

export default function () {
  console.log(`cleanup: searching for marker "${MARKER}" across ${users.length} users`);
  let totalDeleted = 0;
  let totalErrors = 0;

  for (const u of users) {
    const session = login(u.login_id, u.password);
    if (!session) {
      console.error(`[${u.login_id}] login failed; skipping`);
      totalErrors++;
      continue;
    }

    const teams = getMyTeams(session.token);
    for (const team of teams) {
      const ids = collectPostIds(session.token, team.id);
      for (const id of ids) {
        const r = deletePost(session.token, id);
        if (r && r.status === 200) totalDeleted++;
        else totalErrors++;
      }
      if (ids.length > 0) {
        console.log(`[${u.login_id}] team ${team.name}: deleted ${ids.length}`);
      }
    }

    sleep(0.1); // gentle pacing across users
  }

  console.log(`cleanup done: deleted=${totalDeleted} errors=${totalErrors} run_id=${RUN_ID}`);
}

function collectPostIds(token, teamId) {
  const ids = [];
  // Search returns up to 60 per call. Loop until empty or capped.
  for (let i = 0; i < 100; i++) {
    const r = searchPosts(token, teamId, MARKER);
    if (!r || r.status !== 200) break;

    const order = r.json('order') || [];
    if (order.length === 0) break;

    let added = 0;
    for (const id of order) {
      if (!ids.includes(id)) {
        ids.push(id);
        added++;
      }
    }
    if (added === 0) break; // no new results = paged out
  }
  return ids;
}
