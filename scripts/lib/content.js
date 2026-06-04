const WORDS = [
  'team', 'channel', 'meeting', 'release', 'deploy', 'incident', 'bug',
  'feature', 'PR', 'review', 'staging', 'production', 'rollback', 'metric',
  'alert', 'dashboard', 'latency', 'throughput', 'cache', 'queue', 'consumer',
  'producer', 'partition', 'replica', 'index', 'shard', 'snapshot', 'migration',
  'schema', 'query', 'plan', 'budget', 'roadmap', 'standup', 'retro', 'demo',
  'ticket', 'oncall', 'pager', 'runbook', 'log', 'trace', 'span', 'workflow',
  'pipeline', 'artifact', 'binary', 'config', 'flag', 'experiment', 'cohort',
  'support', 'customer', 'feedback', 'rollout', 'canary', 'soak', 'load',
];

const EMOJIS = [
  'thumbsup', 'tada', 'eyes', 'heart', 'fire', 'rocket', 'thinking_face',
  '+1', '-1', 'wave', 'pray', 'clap', 'sweat_smile', 'joy', 'partying_face',
];

function randInt(lo, hiExclusive) {
  return lo + Math.floor(Math.random() * (hiExclusive - lo));
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/**
 * Tag prepended to every generated message. cleanup.js searches by this
 * marker, so every write action must carry it.
 *
 * RUN_ID defaults to "default" if unset; Helm chart sets it to the release name.
 */
export const RUN_ID = (__ENV.RUN_ID || 'default').replace(/[^A-Za-z0-9_-]/g, '');
export const MARKER = `[lt-${RUN_ID}]`;

/**
 * Random message between minWords and maxWords words. Default 5-20 — matches
 * the rough word-count distribution from simulcontroller's createMessage.
 *
 * Always prefixed with MARKER so cleanup can find it.
 */
export function randomMessage(minWords = 5, maxWords = 20) {
  const n = randInt(minWords, maxWords + 1);
  const parts = [MARKER];
  for (let i = 0; i < n; i++) parts.push(pick(WORDS));
  return parts.join(' ');
}

export function randomEmoji() {
  return pick(EMOJIS);
}

/** Short single-word search term for searchUsers/Channels/Posts. */
export function randomSearchTerm() {
  return pick(WORDS);
}
