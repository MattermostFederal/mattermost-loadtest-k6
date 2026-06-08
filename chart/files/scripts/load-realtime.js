import { ACTIONS } from './lib/actions.js';
import { runVU, verifyBootstrap, verifyUsersAvailable } from './lib/vu.js';
import { baseThresholds } from './lib/thresholds.js';

/**
 * Realtime / WebSocket-fanout load — short idle times and increased post
 * weight so every post fans out via WS to all the other VUs in the same
 * channels. Stresses the Go app server's WS push pipeline:
 *   - goroutine count per connection
 *   - hub channel fanout
 *   - per-VU outbound message queue
 *
 * Every CreatePost in the existing action mix already sends `user_typing`
 * over WS before the POST (see actions.js → CreatePost), so bumping
 * CreatePost weight also bumps typing notification volume.
 *
 * If `ws_connecting` p95 spikes here, or you see WS event loss client-side
 * (mm_ws_events_received drops relative to mm_ws_events_expected if you
 * add such a counter), the Go server is the bottleneck. Pair with MM-side:
 *   - `go_goroutines` should climb roughly linearly with VU count; a sharp
 *     non-linear inflection means the WS hub is contending for locks
 *   - `process_cpu_seconds_total` rate
 *   - `mattermost_websocket_event_total` if available
 */
const TARGET_VUS    = Number(__ENV.TARGET_VUS    || 100);
const RAMP_UP_SEC   = Number(__ENV.RAMP_UP_SEC   || 60);
const STEADY_SEC    = Number(__ENV.STEADY_SEC    || 600);
const RAMP_DOWN_SEC = Number(__ENV.RAMP_DOWN_SEC || 30);
const SESSION_SEC   = Number(__ENV.SESSION_SEC   || 240);
// Aggressive defaults — every VU acts every 1-4s instead of 1-20s.
const MIN_IDLE_MS   = Number(__ENV.MIN_IDLE_MS   || 500);
const AVG_IDLE_MS   = Number(__ENV.AVG_IDLE_MS   || 2000);
const POST_MULT     = Number(__ENV.POST_WEIGHT_MULTIPLIER || 10);

// Per-script SLO knobs — WS-fanout-heavy load stresses the WS handshake
// and the create_post hot path. Override these without touching the
// global SLO_* env vars used by load.js.
const REALTIME_WS_CONNECT_P95_MS = Number(__ENV.REALTIME_WS_CONNECT_P95_MS || 3000);
const REALTIME_CREATE_POST_P95_MS = Number(__ENV.REALTIME_CREATE_POST_P95_MS || 1500);

// Post-heavy: each post triggers WS fanout. Reads stay at normal weight to
// keep the session realistic; channel switching at half because each switch
// is expensive (5 API calls) and we want to keep the action loop tight.
const REALTIME_ACTIONS = ACTIONS.map(a => {
  if (a.name === 'CreatePost') return { ...a, frequency: a.frequency * POST_MULT };
  if (a.name === 'SwitchChannel') return { ...a, frequency: a.frequency * 0.5 };
  return a;
});

export const options = {
  scenarios: {
    realtime_heavy: {
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
    // Realtime-specific: WS handshake should still be fast even under
    // heavy fanout; create_post is the hot path and gets its own SLO.
    ws_connecting: [`p(95)<${REALTIME_WS_CONNECT_P95_MS}`],
    'http_req_duration{endpoint:create_post}': [`p(95)<${REALTIME_CREATE_POST_P95_MS}`],
  },
};

export function setup() {
  verifyUsersAvailable();
  verifyBootstrap();
}

export default function () {
  runVU({
    actions: REALTIME_ACTIONS,
    sessionSec: SESSION_SEC,
    minIdleMs: MIN_IDLE_MS,
    avgIdleMs: AVG_IDLE_MS,
    percentReplies: 0.18,
    percentUrgent: 0.001,
  });
}
