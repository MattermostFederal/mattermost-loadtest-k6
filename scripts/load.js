import { sleep } from 'k6';
import { pickUser } from './lib/users.js';
import { login } from './lib/api.js';
import { initialSync } from './lib/sync.js';
import { runWithWebSocket } from './lib/ws.js';
import { ACTIONS, pickAction } from './lib/actions.js';
import { rateForVU, pickIdleMs } from './lib/rates.js';

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
  thresholds: {
    http_req_failed: ['rate<0.02'],
    'http_req_duration{kind:auth}':  ['p(95)<2000'],
    'http_req_duration{kind:read}':  ['p(95)<500'],
    'http_req_duration{kind:write}': ['p(95)<1000'],
    ws_connecting: ['p(95)<2000'],
  },
};

export default function () {
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
    readOnly: READ_ONLY,
    percentReplies: PERCENT_REPLIES,
    percentUrgent: PERCENT_URGENT,
  };

  // Tick fires roughly every MIN_IDLE_MS scaled by rate; inside, we sleep the
  // remainder of the sampled idle. This keeps WS open continuously across many
  // actions while respecting per-VU rate.
  let pendingSleepMs = 0;
  function tick(wsCtx) {
    ctx.wsCtx = wsCtx;

    // If we owe sleep from the previous action, skip this tick.
    if (pendingSleepMs > MIN_IDLE_MS) {
      pendingSleepMs -= MIN_IDLE_MS;
      return;
    }

    const action = pickAction(ACTIONS);
    try { action.run(ctx); } catch (e) { /* keep session alive */ }

    pendingSleepMs = pickIdleMs(MIN_IDLE_MS, AVG_IDLE_MS, rate);
  }

  runWithWebSocket(
    session.token,
    session.userId,
    SESSION_SEC * 1000,
    tick,
    MIN_IDLE_MS, // tick granularity; actual action cadence is throttled by `pendingSleepMs`
  );

  // brief gap before VU iterates again
  sleep(1);
}
