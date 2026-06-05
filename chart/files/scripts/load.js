import { ACTIONS } from './lib/actions.js';
import { runVU, verifyBootstrap, verifyUsersAvailable } from './lib/vu.js';
import { baseThresholds } from './lib/thresholds.js';

const TARGET_VUS         = Number(__ENV.TARGET_VUS         || 50);
const RAMP_UP_SEC        = Number(__ENV.RAMP_UP_SEC        || 60);
const STEADY_SEC         = Number(__ENV.STEADY_SEC         || 300);
const RAMP_DOWN_SEC      = Number(__ENV.RAMP_DOWN_SEC      || 30);
const SESSION_SEC        = Number(__ENV.SESSION_SEC        || 180);
const MIN_IDLE_MS        = Number(__ENV.MIN_IDLE_MS        || 1000);
const AVG_IDLE_MS        = Number(__ENV.AVG_IDLE_MS        || 20000);
const PERCENT_REPLIES    = Number(__ENV.PERCENT_REPLIES    || 0.18);
const PERCENT_URGENT     = Number(__ENV.PERCENT_URGENT     || 0.001);
const READ_ONLY          = (__ENV.READ_ONLY || 'false').toLowerCase() === 'true';

export const options = {
  scenarios: {
    realistic_users: {
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
  thresholds: baseThresholds(),
};

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
    readOnly: READ_ONLY,
  });
}
