/**
 * Per-VU rate distribution + per-action idle sampler.
 *
 * Mirrors mattermost-load-test-ng's `RatesDistribution` and `PickIdleTimeMs`:
 *   - Each VU is assigned a rate multiplier when it starts.
 *   - On every tick, the next idle time is sampled uniformly from
 *     [MIN_IDLE_MS, 2*AVG_IDLE_MS - MIN_IDLE_MS] and scaled by the multiplier.
 *
 * Default distribution matches config.sample.json:
 *   1.0x  : 5%   (very active)
 *   2.0x  : 10%
 *   3.0x  : 15%
 *   6.0x  : 40%
 *   30.0x : 30%  (mostly idle)
 */

const DEFAULT_DISTRIBUTION = [
  { rate: 1.0,  percentage: 0.05 },
  { rate: 2.0,  percentage: 0.10 },
  { rate: 3.0,  percentage: 0.15 },
  { rate: 6.0,  percentage: 0.40 },
  { rate: 30.0, percentage: 0.30 },
];

function parseDistribution() {
  const env = __ENV.RATES_DISTRIBUTION;
  if (!env) return DEFAULT_DISTRIBUTION;
  try {
    const parsed = JSON.parse(env);
    const total = parsed.reduce((s, r) => s + r.percentage, 0);
    if (Math.abs(total - 1) > 0.01) {
      throw new Error(`RATES_DISTRIBUTION percentages must sum to 1, got ${total}`);
    }
    return parsed;
  } catch (e) {
    throw new Error(`Invalid RATES_DISTRIBUTION: ${e.message}`);
  }
}

const DISTRIBUTION = parseDistribution();

/**
 * Deterministic rate assignment: VU N always gets the same rate.
 * Uses a hash of vu so VUs spread across buckets evenly.
 */
export function rateForVU(vu) {
  // Map [0,1) deterministically per VU.
  const x = ((vu * 2654435761) >>> 0) / 0x100000000;
  let acc = 0;
  for (const bucket of DISTRIBUTION) {
    acc += bucket.percentage;
    if (x < acc) return bucket.rate;
  }
  return DISTRIBUTION[DISTRIBUTION.length - 1].rate;
}

/**
 * Sample idle time for the next action, in ms.
 * Equivalent to control.PickIdleTimeMs(min, avg, rate).
 */
export function pickIdleMs(minIdleMs, avgIdleMs, rate) {
  // Guard misconfiguration: AVG_IDLE_MS below MIN_IDLE_MS would make the
  // span negative and idle times negative — actions would fire every tick.
  const span = Math.max(0, avgIdleMs * 2 - minIdleMs * 2);
  const base = minIdleMs + Math.floor(Math.random() * span);
  return Math.round(base * rate);
}
