import { ACTIONS } from './lib/actions.js';
import { runVU, verifyBootstrap, verifyUsersAvailable } from './lib/vu.js';
import { breakpointThresholds } from './lib/thresholds.js';

/**
 * Breakpoint test — ramp VU count steadily upward and let k6 abort the
 * moment the configured threshold trips. The summary then shows the VU
 * count and elapsed time when the abort fired, which IS the capacity
 * number under those thresholds.
 *
 * Default abort signal is write p95 — latency degradation typically
 * happens before outright errors and gives the cleanest "users started
 * waiting too long" data point. Tune via env vars:
 *
 *   BREAKPOINT_MAX_VUS         (default 1000)   peak VU count
 *   BREAKPOINT_DURATION        (default 30m)    time to ramp 0 -> max
 *   BREAKPOINT_WRITE_P95_MS    (default 1000)   abort when write p95 crosses
 *   BREAKPOINT_DELAY_ABORT     (default 2m)     give warmup time before evaluating
 *   SESSION_SEC, MIN_IDLE_MS, AVG_IDLE_MS, PERCENT_REPLIES, PERCENT_URGENT
 *     — same as load.js, control per-VU activity
 *
 * To capture client-side metrics in Grafana during the run, set
 * K6_PROMETHEUS_RW_SERVER_URL and use the `make breakpoint` target —
 * the Makefile wires up the `-o experimental-prometheus-rw` flag and
 * tags series with run_id for cross-run comparison.
 */
const MAX_VUS         = Number(__ENV.BREAKPOINT_MAX_VUS      || 1000);
const DURATION        = __ENV.BREAKPOINT_DURATION            || '30m';
const WRITE_P95_MS    = Number(__ENV.BREAKPOINT_WRITE_P95_MS || 1000);
const DELAY_ABORT     = __ENV.BREAKPOINT_DELAY_ABORT         || '2m';

const SESSION_SEC     = Number(__ENV.SESSION_SEC     || 180);
const MIN_IDLE_MS     = Number(__ENV.MIN_IDLE_MS     || 1000);
const AVG_IDLE_MS     = Number(__ENV.AVG_IDLE_MS     || 20000);
const PERCENT_REPLIES = Number(__ENV.PERCENT_REPLIES || 0.18);
const PERCENT_URGENT  = Number(__ENV.PERCENT_URGENT  || 0.001);

export const options = {
  scenarios: {
    breakpoint: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: DURATION, target: MAX_VUS },
      ],
      // Generous gracefulStop so in-flight iterations can finish their
      // current action and close their WS cleanly when abort fires.
      gracefulRampDown: '30s',
      gracefulStop: '60s',
    },
  },
  // breakpointThresholds() relaxes the non-abort SLOs since latency is
  // expected to climb during the ramp; only the write-p95 threshold has
  // abortOnFail set, which is the signal that defines "max capacity here."
  thresholds: breakpointThresholds(WRITE_P95_MS, DELAY_ABORT),
};

// setup runs once before VUs start. Fail fast if Mode B was selected but
// bootstrap hasn't been run for this RUN_ID — better than 1000 VUs each
// failing to log in.
export function setup() {
  verifyUsersAvailable();
  verifyBootstrap();
}

export default function () {
  runVU({
    actions: ACTIONS,
    sessionSec: SESSION_SEC,
    minIdleMs: MIN_IDLE_MS,
    avgIdleMs: AVG_IDLE_MS,
    percentReplies: PERCENT_REPLIES,
    percentUrgent: PERCENT_URGENT,
    readOnly: false,
  });
}
