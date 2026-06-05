import { ACTIONS } from './lib/actions.js';
import { runVU, verifyBootstrap, verifyUsersAvailable } from './lib/vu.js';
import { baseThresholds } from './lib/thresholds.js';

/**
 * Search-heavy load — multiplies the weights of SearchPosts / SearchUsers /
 * SearchChannels by SEARCH_WEIGHT_MULTIPLIER (default 50x), and halves
 * everything else. Background reads/writes stay non-zero so the WS connection
 * stays warm and the session looks plausible.
 *
 * Use this when you want to characterize Elasticsearch (or DB full-text if
 * ES is disabled) under load — the realistic mix has search at <1% of
 * actions, which won't surface ES bottlenecks until VU count is enormous.
 *
 * If `search_posts` / `search_users` / `search_channels` p95 dominates the
 * summary here, ES (or your search backend) is the next thing to scale.
 */
const TARGET_VUS    = Number(__ENV.TARGET_VUS    || 100);
const RAMP_UP_SEC   = Number(__ENV.RAMP_UP_SEC   || 60);
const STEADY_SEC    = Number(__ENV.STEADY_SEC    || 600);
const RAMP_DOWN_SEC = Number(__ENV.RAMP_DOWN_SEC || 30);
const SESSION_SEC   = Number(__ENV.SESSION_SEC   || 180);
const MIN_IDLE_MS   = Number(__ENV.MIN_IDLE_MS   || 1000);
const AVG_IDLE_MS   = Number(__ENV.AVG_IDLE_MS   || 20000);
const SEARCH_MULT   = Number(__ENV.SEARCH_WEIGHT_MULTIPLIER || 50);

// Per-script SLO knobs — search-heavy load stresses reads, so the global
// SLO_READ_P95_MS is intentionally overridable here without affecting
// load.js. Each endpoint-specific knob defaults to a value reasonable
// for a healthy ES backend.
const SEARCH_READ_P95_MS     = Number(__ENV.SEARCH_READ_P95_MS     || 1500);
const SEARCH_POSTS_P95_MS    = Number(__ENV.SEARCH_POSTS_P95_MS    || 2000);
const SEARCH_USERS_P95_MS    = Number(__ENV.SEARCH_USERS_P95_MS    || 1000);
const SEARCH_CHANNELS_P95_MS = Number(__ENV.SEARCH_CHANNELS_P95_MS || 1000);

const SEARCH_ACTIONS = ACTIONS.map(a => {
  if (a.name === 'SearchPosts' || a.name === 'SearchUsers' || a.name === 'SearchChannels') {
    return { ...a, frequency: a.frequency * SEARCH_MULT };
  }
  // Keep background activity going (~0.5x normal) so the session looks real
  // and per-endpoint tags for non-search APIs still get samples.
  return { ...a, frequency: a.frequency * 0.5 };
});

export const options = {
  scenarios: {
    search_heavy: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: `${RAMP_UP_SEC}s`,   target: TARGET_VUS },
        { duration: `${STEADY_SEC}s`,    target: TARGET_VUS },
        { duration: `${RAMP_DOWN_SEC}s`, target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    ...baseThresholds(),
    // Relax the global read p95 for this script — searches are heavier
    // than the average GET and shouldn't be held to the same ceiling.
    'http_req_duration{kind:read}': [`p(95)<${SEARCH_READ_P95_MS}`],
    'http_req_duration{endpoint:search_posts}':    [`p(95)<${SEARCH_POSTS_P95_MS}`],
    'http_req_duration{endpoint:search_users}':    [`p(95)<${SEARCH_USERS_P95_MS}`],
    'http_req_duration{endpoint:search_channels}': [`p(95)<${SEARCH_CHANNELS_P95_MS}`],
  },
};

export function setup() {
  verifyUsersAvailable();
  verifyBootstrap();
}

export default function () {
  runVU({
    actions: SEARCH_ACTIONS,
    sessionSec: SESSION_SEC,
    minIdleMs: MIN_IDLE_MS,
    avgIdleMs: AVG_IDLE_MS,
  });
}
