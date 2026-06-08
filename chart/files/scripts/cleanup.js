import { sleep } from 'k6';
import exec from 'k6/execution';
import { users } from './lib/users.js';
import {
  login, getMyTeams, searchPosts, deletePost, deletePostPermanent, getTeamByName,
  getConfig, patchConfig, verifyServiceSettingsFlags,
} from './lib/api.js';
import { MARKER, RUN_ID } from './lib/content.js';

// Wrapper for exec.test.abort(). k6's `fail()` (the module-level helper
// from "k6") does NOT cause non-zero exit — it logs at error level and
// marks the iteration as failed, but the k6 process still exits 0.
// exec.test.abort() is the documented mechanism for "stop the test AND
// exit non-zero" (returns exit code 108) — CI and the Helm pre-delete
// hook rely on the non-zero exit to detect a failed cleanup pass.
function abort(msg) {
  exec.test.abort(msg);
}

/**
 * Cleanup script — deletes posts tagged with `[lt-<RUN_ID>]`. Idempotent.
 *
 * Two execution paths, picked automatically:
 *
 *   Admin path  (ADMIN_EMAIL + ADMIN_PASSWORD set, and `lt-<RUN_ID>` team exists)
 *     One admin login, search the bootstrap team for marker posts, delete.
 *     Used by Mode B — no users file or BOOTSTRAP_NUM_USERS needed.
 *
 *   User path   (no admin creds, or no bootstrap team found)
 *     Logs in as each user from USERS_FILE / bootstrap-derived list and
 *     deletes marker posts in their visible teams. Used by Mode A.
 *
 * Search-index lag: MM's search index (Postgres or Elasticsearch) is async.
 * Posts created in the final seconds of the run may not appear in the first
 * search pass. CLEANUP_PASSES > 1 schedules additional passes with
 * CLEANUP_PASS_DELAY_SEC between them. A pass short-circuits remaining passes
 * only when it found zero posts AND hit zero errors — otherwise we keep
 * retrying (an index that's down returns empty, which looks identical to a
 * genuinely-empty team without the error check).
 *
 * In the Helm chart this is wired to the pre-delete hook so `helm uninstall`
 * automatically removes posts created during the run.
 */
export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate>=0.0'] }, // no failing thresholds; just report
};

const PASSES = Math.max(1, Number(__ENV.CLEANUP_PASSES || 1));
const PASS_DELAY_SEC = Math.max(0, Number(__ENV.CLEANUP_PASS_DELAY_SEC || 30));
const ADMIN_EMAIL    = __ENV.ADMIN_EMAIL    || '';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || '';

// CLEANUP_PERMANENT — when true (and admin path is taken), uses
// DELETE /posts/{id}?permanent=true instead of the default soft delete.
// Permanent post delete removes Post + FileInfo + file blob in one call,
// which is the only API-driven way to reclaim file-storage bytes from
// load-test uploads. Gated by ServiceSettings.EnableAPIPostDeletion;
// cleanup.js snapshots that flag, enables it, runs, restores it on exit.
//
// Helm chart sets this to true automatically when teardownMode=hard so
// the file lifecycle is consistent: hard mode ⇒ everything goes,
// including blobs. Mode A (no admin) always uses soft delete.
const CLEANUP_PERMANENT = (__ENV.CLEANUP_PERMANENT || 'false').toLowerCase() === 'true';

export default function () {
  // Admin path: when credentials are set, this script ONLY runs the admin
  // path. If the bootstrap team is missing (already cleaned, partial
  // bootstrap, idempotent re-run after success), exit cleanly — nothing
  // to do.
  //
  // Note: we deliberately do NOT fall back to user-iteration when admin
  // creds are set. The admin-vs-user choice is a config decision; mixing
  // them at runtime breaks idempotency (no USERS_FILE in Helm Mode B → the
  // user path would then hit users.length === 0 and abort, failing
  // `helm uninstall` for what should be a clean state).
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const admin = login(ADMIN_EMAIL, ADMIN_PASSWORD);
    if (!admin) abort('cleanup: admin login failed');
    const teamName = `lt-${RUN_ID}`;
    const t = getTeamByName(admin.token, teamName);
    if (t && t.status === 200) {
      // Permanent mode wraps the loop in a flag snapshot/restore so files
      // are actually removed from the file backend, not just marked.
      if (CLEANUP_PERMANENT) {
        const snap = snapshotPostDeletionFlag(admin.token);
        enablePostDeletionFlag(admin.token, snap);
        let restoreResult = { restored: true };
        try {
          runAdminLoop(admin.token, t.json('id'), teamName);
        } finally {
          restoreResult = restorePostDeletionFlag(admin.token, snap);
        }
        // Same CRITICAL pattern as teardown.js — flags stranded is
        // strictly worse than cleanup-incomplete. Abort non-zero so
        // Helm pre-delete hook reports failure and an operator can
        // run `make recover-flags`.
        if (!restoreResult.restored) {
          abort(
            `cleanup(permanent): CRITICAL — ${restoreResult.message}. ` +
            'EnableAPIPostDeletion may still be enabled cluster-wide. ' +
            'Run `make recover-flags` IMMEDIATELY to remediate.'
          );
        }
      } else {
        runAdminLoop(admin.token, t.json('id'), teamName);
      }
      return;
    }
    // Admin creds set but bootstrap team missing. Two cases:
    //   (a) Idempotent re-run of cleanup — bootstrap team was already
    //       torn down, nothing to do.
    //   (b) Mode A with admin creds also set (mixed config) — user posts
    //       in user-owned teams are NOT cleaned. Silent success masks the
    //       misconfiguration.
    //
    // CLEANUP_ALLOW_MISSING_TEAM defaults to FALSE (loud abort) because
    // case (b) is the more dangerous of the two. The Helm chart explicitly
    // sets it to true in mmlt.cleanupEnv (case (a) is the expected path
    // for Helm idempotent uninstall). Local `make cleanup` callers who
    // genuinely want idempotent no-op must opt in.
    if ((__ENV.CLEANUP_ALLOW_MISSING_TEAM || 'false').toLowerCase() === 'true') {
      console.log(
        `cleanup(admin): team ${teamName} not found — nothing to clean. ` +
        'Treating as idempotent no-op (post-uninstall, partial bootstrap, or already-cleaned state). ' +
        'CLEANUP_ALLOW_MISSING_TEAM=true selected this path.'
      );
      return;
    }
    abort(
      `cleanup(admin): team ${teamName} not found. ` +
      'Ambiguous config: either remove admin creds for Mode A (user-iteration) cleanup, ' +
      'run bootstrap.js first to create the team for Mode B, ' +
      'or set CLEANUP_ALLOW_MISSING_TEAM=true if you genuinely want this to be an idempotent no-op.'
    );
  }

  // Mode A: no admin creds → iterate users from USERS_FILE.
  runUserLoop();
}

// --- admin path --------------------------------------------------------------

function runAdminLoop(token, teamId, teamName) {
  console.log(`cleanup(admin): searching team ${teamName} for marker "${MARKER}" (passes=${PASSES})`);
  let totalDeleted = 0;
  let totalDeleteErrors = 0;
  let totalSearchErrors = 0;
  let totalZombies = 0;

  for (let pass = 1; pass <= PASSES; pass++) {
    if (pass > 1) {
      console.log(`cleanup(admin): pass ${pass}/${PASSES} starting after ${PASS_DELAY_SEC}s delay`);
      sleep(PASS_DELAY_SEC);
    }
    const r = adminPass(token, teamId, teamName);
    totalDeleted += r.deleted;
    totalDeleteErrors += r.errors;
    totalSearchErrors += r.searchErrors;
    totalZombies += (r.zombies || 0);
    if (pass > 1 && shouldShortCircuit(r)) {
      console.log(`cleanup(admin): pass ${pass} found nothing and hit no errors; skipping remaining passes`);
      break;
    }
  }

  console.log(
    `cleanup(admin) done: deleted=${totalDeleted} ` +
    `delete_errors=${totalDeleteErrors} search_errors=${totalSearchErrors} ` +
    `zombies=${totalZombies} run_id=${RUN_ID}`
  );
  if (totalZombies > 0 && totalDeleted === 0) {
    console.warn(
      `cleanup(admin): all pass results were zombies (404s). Likely cause: ` +
      'search-index lag (Elasticsearch refresh_interval > PASS_DELAY_SEC). ' +
      `Bump CLEANUP_PASSES (currently ${PASSES}) and/or CLEANUP_PASS_DELAY_SEC ` +
      `(currently ${PASS_DELAY_SEC}s) for environments with slow index refresh.`
    );
  }
}

function adminPass(token, teamId, teamName) {
  const deleteFn = CLEANUP_PERMANENT ? deletePostPermanent : deletePost;
  const r = sweepTeamPosts(token, teamId, deleteFn);
  if (r.deleted > 0) {
    const mode = CLEANUP_PERMANENT ? 'permanent' : 'soft';
    console.log(`cleanup(admin/${mode}) ${teamName}: deleted ${r.deleted}`);
  }
  return r;
}

// sweepTeamPosts: inline delete during search loop. MM's posts/search API
// has no offset/from param, so a collect-then-delete pattern caps at the
// first 60 results per pass (the second searchPosts call returns the same
// 60 IDs, the loop's `added===0` short-circuit fires). The fix: delete
// each batch immediately so the search index reflects deletions on the
// next call, returning fresh results.
//
// Termination:
//   - search returns 0 results → done
//   - search errors → break, surface searchErrors
//   - batch deletes nothing (all 403 in Mode A, or systemic delete failure)
//     → break to avoid infinite loop on undeletable results
//
// Safety cap: 1000 iterations × ~60 results/iteration = up to ~60,000
// posts per call. Larger than any realistic load run.
function sweepTeamPosts(token, teamId, deleteFn) {
  let deleted = 0;
  let errors = 0;
  let searchErrors = 0;
  let zombies = 0;       // 404 — search returned a post that's already gone
  let forbidden = 0;     // 403 — Mode A user trying to delete another user's post

  for (let i = 0; i < 1000; i++) {
    const r = searchPosts(token, teamId, MARKER);
    if (!r || r.status !== 200) {
      searchErrors++;
      break;
    }
    const order = r.json('order') || [];
    if (order.length === 0) break;

    let batchDeleted = 0;
    let batchZombies = 0;
    let batchForbidden = 0;
    for (const id of order) {
      const d = deleteFn(token, id);
      if (d && d.status === 200) {
        deleted++;
        batchDeleted++;
      } else if (d && d.status === 404) {
        // 404 = post already gone. Search index hasn't caught up yet
        // (Elasticsearch with refresh_interval > 1s is common in federal
        // tuned configs), OR a concurrent cleanup beat us to it. Either
        // way, the post being gone is success-equivalent for cleanup —
        // it's NOT an error.
        zombies++;
        batchZombies++;
      } else if (d && d.status === 403) {
        // Mode A: post belongs to another user. Expected; another user
        // will delete it on their own scan. Not an error.
        forbidden++;
        batchForbidden++;
      } else {
        errors++;
      }
    }
    // Break the inner loop when no real deletes happened this batch.
    // Outer pass loop + PASS_DELAY_SEC handle the retry — that's the
    // right mechanism for search-index-lag scenarios. If a pass returns
    // zombies > 0 and deleted === 0, shouldShortCircuit (below) keeps
    // outer passes alive so a later pass picks up the now-indexed list.
    if (batchDeleted === 0) break;
  }

  return { deleted, errors, searchErrors, zombies, forbidden };
}

// --- EnableAPIPostDeletion flag lifecycle ------------------------------------
// Mirrors teardown.js's flag handling but scoped to a single flag — cleanup
// runs in its own container (cleanup-posts) before teardown, so it can't
// share teardown's snapshot. Same try/finally guarantee on restore.

// Uses PUT /api/v4/config/patch for surgical updates — only touches
// ServiceSettings.EnableAPIPostDeletion, never reads/writes other config.

function snapshotPostDeletionFlag(token) {
  const r = getConfig(token);
  if (!r || r.status !== 200) {
    abort(`cleanup(permanent): GET /config failed (status=${r && r.status}); cannot manage EnableAPIPostDeletion`);
  }
  const cfg = r.json();
  if (!cfg.ServiceSettings) {
    abort('cleanup(permanent): config has no ServiceSettings');
  }
  const original = cfg.ServiceSettings.EnableAPIPostDeletion === true;

  // Concurrent-cleanup guard. Same pattern teardown.js uses for the other
  // three flags. If EnableAPIPostDeletion is already true at snapshot,
  // another cleanup is in flight (or a prior run died mid-restore) —
  // proceeding would capture the wrong "original" and re-set it to true
  // at the end, stranding the flag permanently after restore.
  if (original) {
    abort(
      'cleanup(permanent): refusing to start — EnableAPIPostDeletion already true at snapshot. ' +
      'Either another permanent cleanup is in flight, or a previous run died with the flag enabled. ' +
      'Wait for the other run, or run `make recover-flags` to remediate.'
    );
  }
  console.log(`cleanup(permanent): snapshot EnableAPIPostDeletion=${original}`);
  return { original };
}

function enablePostDeletionFlag(token /* snap unused with patch */) {
  const r = patchConfig(token, { ServiceSettings: { EnableAPIPostDeletion: true } });
  if (!r || r.status !== 200) {
    const status = r && r.status;
    let hint = '';
    if (status === 403) hint = ' — admin lacks PUT /api/v4/config/patch permission';
    else if (status === 501 || status === 404) hint = ' — config patch disabled or not present (older MM, Cloud, or managed). Use CLEANUP_PERMANENT=false; files will tombstone via soft delete only';
    abort(`cleanup(permanent): enabling EnableAPIPostDeletion failed (status=${status})${hint}`);
  }

  // Verify-after-patch — MM's writeFilter silently drops untagged
  // ServiceSettings fields for non-system_admin callers. Without this
  // check we'd run permanent post delete against a server that still
  // has the flag false, and every delete returns 501.
  const mismatches = verifyServiceSettingsFlags(token, { EnableAPIPostDeletion: true });
  if (mismatches) {
    abort(
      `cleanup(permanent): PATCH returned 200 but EnableAPIPostDeletion wasn't applied — ${JSON.stringify(mismatches)}. ` +
      'Admin needs PermissionManageSystem (system_admin role), not just sysconsole_write_*. ' +
      'No posts were touched.'
    );
  }
  console.log('cleanup(permanent): EnableAPIPostDeletion enabled (verified)');
}

// Returns { restored: true } or { restored: false, message }. Caller MUST
// propagate restore failures to a non-zero exit — silent log+return would
// have the Helm pre-delete hook reporting success while
// EnableAPIPostDeletion stays enabled.
function restorePostDeletionFlag(token, snap) {
  const r = patchConfig(token, { ServiceSettings: { EnableAPIPostDeletion: snap.original } });
  if (!r || r.status !== 200) {
    return {
      restored: false,
      message: `restore PUT /config/patch failed (${r && r.status})`,
    };
  }

  const mismatches = verifyServiceSettingsFlags(token, { EnableAPIPostDeletion: snap.original });
  if (mismatches) {
    return {
      restored: false,
      message: `restore PATCH returned 200 but flag didn't match snapshot — ${JSON.stringify(mismatches)}`,
    };
  }
  console.log(`cleanup(permanent): restored EnableAPIPostDeletion=${snap.original} (verified)`);
  return { restored: true };
}

// --- user path (Mode A) ------------------------------------------------------

function runUserLoop() {
  // users.js's SharedArray returns [] when neither BOOTSTRAP_NUM_USERS nor
  // USERS_FILE is set. We reach this branch when admin creds are absent —
  // so there's no source of users at all. Abort with a clear, actionable
  // message rather than silently running zero iterations.
  if (users.length === 0) {
    abort(
      'cleanup: no user source available — set USERS_FILE (Mode A) or ' +
      'export ADMIN_EMAIL/ADMIN_PASSWORD with BOOTSTRAP_NUM_USERS (Mode B).'
    );
  }
  console.log(`cleanup: searching for marker "${MARKER}" across ${users.length} users (passes=${PASSES})`);
  let totalDeleted = 0;
  let totalDeleteErrors = 0;
  let totalSearchErrors = 0;
  let totalZombies = 0;

  for (let pass = 1; pass <= PASSES; pass++) {
    if (pass > 1) {
      console.log(`cleanup: pass ${pass}/${PASSES} starting after ${PASS_DELAY_SEC}s delay`);
      sleep(PASS_DELAY_SEC);
    }
    const r = userPass();
    totalDeleted += r.deleted;
    totalDeleteErrors += r.errors;
    totalSearchErrors += r.searchErrors;
    totalZombies += (r.zombies || 0);
    if (pass > 1 && shouldShortCircuit(r)) {
      console.log(`cleanup: pass ${pass} found nothing and hit no errors; skipping remaining passes`);
      break;
    }
    if (pass > 1 && r.deleted === 0 && (r.errors > 0 || r.searchErrors > 0)) {
      console.log(`cleanup: pass ${pass} found nothing but had errors (search=${r.searchErrors}, delete/login=${r.errors}); continuing to next pass`);
    }
  }

  console.log(
    `cleanup done: deleted=${totalDeleted} ` +
    `delete_errors=${totalDeleteErrors} search_errors=${totalSearchErrors} ` +
    `zombies=${totalZombies} run_id=${RUN_ID}`
  );
}

function userPass() {
  let deleted = 0;
  let errors = 0;
  let searchErrors = 0;
  let zombies = 0;

  for (const u of users) {
    const session = login(u.login_id, u.password);
    if (!session) {
      console.error(`[${u.login_id}] login failed; skipping`);
      errors++;
      continue;
    }

    const teams = getMyTeams(session.token);
    if (teams === null) {
      console.error(`[${u.login_id}] getMyTeams returned error; skipping`);
      errors++;
      continue;
    }
    for (const team of teams) {
      const r = sweepTeamPosts(session.token, team.id, deletePost);
      deleted += r.deleted;
      errors += r.errors;
      searchErrors += r.searchErrors;
      zombies += (r.zombies || 0);
      if (r.deleted > 0) {
        console.log(`[${u.login_id}] team ${team.name}: deleted ${r.deleted}`);
      }
    }

    sleep(0.1); // gentle pacing across users
  }
  return { deleted, errors, searchErrors, zombies };
}

// --- shared helpers ----------------------------------------------------------

// Outer-pass short-circuit. Only exit the pass loop early when a pass found
// NOTHING actionable — no deletions, no zombies (which signal more work
// pending behind search-index lag), no errors of any kind.
//
// Including zombies > 0 here is critical: a pass that hit only zombies
// (search returned posts that were already gone) means the search index
// hasn't caught up to a prior cleanup yet. The next pass after
// PASS_DELAY_SEC will see the refreshed index and pick up real work.
function shouldShortCircuit(r) {
  return r.deleted === 0
      && r.errors === 0
      && r.searchErrors === 0
      && (r.zombies || 0) === 0;
}

// collectPostIds was removed in favor of sweepTeamPosts (above): the
// old collect-then-delete pattern capped at ~60 posts per pass because
// MM's posts/search has no offset param, so subsequent search calls
// returned the same IDs the first call did. sweepTeamPosts deletes
// inline during the search loop so each subsequent search reflects
// the deletions.
