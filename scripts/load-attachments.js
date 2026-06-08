import crypto from 'k6/crypto';
import { ACTIONS } from './lib/actions.js';
import { runVU, verifyBootstrap, verifyUsersAvailable } from './lib/vu.js';
import { baseThresholds } from './lib/thresholds.js';
import { uploadFile, createPost } from './lib/api.js';
import { randomMessage } from './lib/content.js';

/**
 * Attachment-heavy load — replaces plain CreatePost in the mix with a
 * CreatePostWithFile action that uploads a binary payload before posting.
 * Every other action runs at half its normal weight so reads/searches/threads
 * still surface in the per-endpoint summary.
 *
 * Use this to characterize the file store (S3 / MinIO / local disk) under
 * load. If `upload_file` p95 dominates the summary, the file backend is
 * the bottleneck. Pair with MM-side metrics:
 *   - S3: cloud-side metrics on PutObject latency / 5xx rate
 *   - MinIO: `minio_s3_requests_*` series
 *   - Local: filesystem write latency, disk I/O saturation
 *
 * Byte generation: the payload is generated once at module init and reused
 * for every upload. Memory cost per VU ≈ ATTACHMENT_SIZE_BYTES. At 100KB
 * default × 100 VUs = ~10 MB total — fine. If you bump to 1MB+ payloads,
 * watch the load-generator memory.
 */
// Defaults are intentionally conservative for lift-and-shift safety — a
// single-VM local-disk target should be able to run with defaults without
// risking disk pressure. Operators with capable file backends (S3, MinIO
// scaled, large local volumes) override these per-install.
const TARGET_VUS       = Number(__ENV.TARGET_VUS    || 10);
const RAMP_UP_SEC      = Number(__ENV.RAMP_UP_SEC   || 30);
const STEADY_SEC       = Number(__ENV.STEADY_SEC    || 120);
const RAMP_DOWN_SEC    = Number(__ENV.RAMP_DOWN_SEC || 30);
const SESSION_SEC      = Number(__ENV.SESSION_SEC   || 180);
const MIN_IDLE_MS      = Number(__ENV.MIN_IDLE_MS   || 1000);
const AVG_IDLE_MS      = Number(__ENV.AVG_IDLE_MS   || 15000);
const FILE_SIZE        = Number(__ENV.ATTACHMENT_SIZE_BYTES        || 10240);    // 10 KB (was 100 KB)
const ATTACH_WEIGHT    = Number(__ENV.ATTACHMENT_WEIGHT            || 2);        // was 5
const RANDOM_BYTES     = (__ENV.ATTACHMENT_RANDOM_BYTES || 'false').toLowerCase() === 'true';
const POOL_SIZE        = Math.max(1, Number(__ENV.ATTACHMENT_RANDOM_POOL_SIZE || 8));

// Pre-flight safety knobs — projected upload total is compared against
// ATTACHMENT_SOFT_LIMIT_MB; if exceeded, setup() throws unless the operator
// explicitly acknowledges via ATTACHMENT_CONFIRM_LARGE=true.
const SOFT_LIMIT_MB     = Number(__ENV.ATTACHMENT_SOFT_LIMIT_MB     || 500);
const CONFIRM_LARGE     = (__ENV.ATTACHMENT_CONFIRM_LARGE || 'false').toLowerCase() === 'true';

// Per-script SLO knobs — uploads get more headroom than normal writes
// because even a healthy S3 backend takes 100-500ms per small object PUT.
const UPLOAD_FILE_P95_MS = Number(__ENV.UPLOAD_FILE_P95_MS || 3000);

// Deterministic buffer for the default (non-random) path — generated once
// per VU at init, reused for every upload. Memory cost ≈ FILE_SIZE per VU.
//
// File stores with content-addressable storage (some S3 setups, MinIO with
// dedup on) hash the body and skip storage on duplicates. The deterministic
// buffer triggers that dedup, so subsequent uploads only stress the
// metadata path — not the storage path. Set ATTACHMENT_RANDOM_BYTES=true
// to defeat dedup. The random path uses a small pool of pre-generated
// random buffers rotated per upload, so per-iteration CPU is near zero
// even at 1 MB+ payloads. Pool memory ≈ POOL_SIZE × FILE_SIZE per VU.
const FILE_BYTES_FIXED = (() => {
  const buf = new Uint8Array(FILE_SIZE);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 7) & 0xff;
  return buf.buffer;
})();

const FILE_BYTES_POOL = (() => {
  if (!RANDOM_BYTES) return null;
  const pool = new Array(POOL_SIZE);
  for (let i = 0; i < POOL_SIZE; i++) pool[i] = crypto.randomBytes(FILE_SIZE);
  return pool;
})();

function nextFileBytes() {
  if (!RANDOM_BYTES) return FILE_BYTES_FIXED;
  // Rotate through the pool. POOL_SIZE distinct random blobs defeats
  // naive content-addressable dedup (no cache holds 8+ blobs cheaply)
  // while keeping per-upload cost to a single array index.
  return FILE_BYTES_POOL[Math.floor(Math.random() * POOL_SIZE)];
}

const CreatePostWithFile = {
  name: 'CreatePostWithFile',
  frequency: ATTACH_WEIGHT,
  run(ctx) {
    const ch = ctx.state.currentChannelId;
    if (!ch || ctx.readOnly) return;
    if (ctx.wsCtx) ctx.wsCtx.sendTyping(ch);

    const up = uploadFile(ctx.token, ch, nextFileBytes(), 'attach.bin');
    if (!up || up.status !== 201) return;
    const fileId = up.json('file_infos.0.id');
    if (!fileId) return;

    const r = createPost(ctx.token, ch, randomMessage(), '', null, [fileId]);
    if (r && r.status === 201) ctx.state.lastPostIdByChannel[ch] = r.json('id');
  },
};

// Drop CreatePost from the default mix (replaced by CreatePostWithFile) and
// halve the rest so the file action dominates without starving every other
// signal.
const ATTACHMENT_ACTIONS = [
  ...ACTIONS
    .filter(a => a.name !== 'CreatePost')
    .map(a => ({ ...a, frequency: a.frequency * 0.5 })),
  CreatePostWithFile,
];

const ACTIONS_WEIGHT_SUM = ATTACHMENT_ACTIONS.reduce((s, a) => s + a.frequency, 0);

// Upper-bound projection — assumes every VU acts every AVG_IDLE_MS without
// the per-VU rate distribution multiplier (which is ~12x slower on average).
// Real uploads will be lower; this is intentionally conservative so the
// soft-limit gate errs on the side of "warn even if borderline."
function projectedUploadMB() {
  const projIters = TARGET_VUS * (STEADY_SEC / Math.max(0.001, AVG_IDLE_MS / 1000));
  const projUploads = projIters * (ATTACH_WEIGHT / ACTIONS_WEIGHT_SUM);
  return {
    uploads: projUploads,
    mb: (projUploads * FILE_SIZE) / 1024 / 1024,
  };
}

export const options = {
  scenarios: {
    attachments_heavy: {
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
    'http_req_duration{endpoint:upload_file}': [`p(95)<${UPLOAD_FILE_P95_MS}`],
  },
};

export function setup() {
  verifyUsersAvailable();
  verifyBootstrap();

  // Pre-flight: compute projected upload total. Fail loud if it exceeds the
  // soft limit unless the operator explicitly acknowledged the size.
  const proj = projectedUploadMB();
  console.log(
    `load-attachments: projected up to ${proj.uploads.toFixed(0)} uploads × ` +
    `${FILE_SIZE} bytes = ~${proj.mb.toFixed(1)} MB total ` +
    `(soft limit ${SOFT_LIMIT_MB} MB; upper-bound estimate, real volume will be lower due to per-VU rate distribution)`
  );

  if (proj.mb > SOFT_LIMIT_MB) {
    if (!CONFIRM_LARGE) {
      throw new Error(
        `Projected upload (${proj.mb.toFixed(1)} MB) exceeds ATTACHMENT_SOFT_LIMIT_MB (${SOFT_LIMIT_MB}). ` +
        `Either lower TARGET_VUS / STEADY_SEC / ATTACHMENT_SIZE_BYTES, ` +
        `or set ATTACHMENT_CONFIRM_LARGE=true to proceed. ` +
        `Verify target free disk before doing the latter.`
      );
    }
    console.warn(
      `load-attachments: projected ${proj.mb.toFixed(1)} MB exceeds soft limit but ATTACHMENT_CONFIRM_LARGE=true; proceeding`
    );
  }
}

export default function () {
  runVU({
    actions: ATTACHMENT_ACTIONS,
    sessionSec: SESSION_SEC,
    minIdleMs: MIN_IDLE_MS,
    avgIdleMs: AVG_IDLE_MS,
  });
}
