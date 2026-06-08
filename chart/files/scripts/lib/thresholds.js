/**
 * Shared SLO thresholds — single source of truth.
 *
 * All k6 scripts in this repo import from here so an SLO change in one
 * place propagates to load.js, breakpoint.js, and the targeted stressors.
 * Each value is overridable per environment via SLO_* env vars — no script
 * edits needed for CI / per-cluster SLO variation:
 *
 *   # Tighter prod SLO:
 *   SLO_WRITE_P95_MS=600 SLO_READ_P95_MS=300 make load
 *
 *   # Relaxed dev SLO (single small node):
 *   SLO_WRITE_P95_MS=2000 SLO_HTTP_REQ_FAILED=0.05 make load
 *
 * Pattern: shared lib + env-var overrides. This is the k6-idiomatic
 * approach for multi-script repos. If you ever migrate to an SLO-as-code
 * framework (Sloth, OpenSLO), the SLO_* env vars are the integration seam.
 */

// SLO defaults. These MUST stay in sync with chart/values.yaml metrics.slo —
// the chart mirrors them so `helm template` shows the effective SLO without
// having to cross-reference this file. If you change a default here, also
// update chart/values.yaml; CI / lint will not catch drift.
export const SLO = {
  httpReqFailed:        Number(__ENV.SLO_HTTP_REQ_FAILED        || 0.02),
  authP95Ms:            Number(__ENV.SLO_AUTH_P95_MS            || 2000),
  readP95Ms:            Number(__ENV.SLO_READ_P95_MS            || 500),
  writeP95Ms:           Number(__ENV.SLO_WRITE_P95_MS           || 1000),
  wsConnectingP95Ms:    Number(__ENV.SLO_WS_CONNECTING_P95_MS   || 2000),
};

/**
 * baseThresholds — the default SLO bundle used by load.js and reused by
 * the targeted stressors (which extend with endpoint-specific entries).
 *
 * Per-script override pattern: spread baseThresholds() then add or
 * replace specific entries. JS object-spread semantics let any later
 * key win, so a script can locally tighten or relax any SLO without
 * coupling to other scripts.
 *
 *   thresholds: {
 *     ...baseThresholds(),
 *     // search is read-heavy; relax the global read SLO just for this script
 *     'http_req_duration{kind:read}': [`p(95)<${SEARCH_READ_P95_MS}`],
 *     // add an endpoint-specific SLO that doesn't exist in baseThresholds
 *     'http_req_duration{endpoint:search_posts}': [`p(95)<${SEARCH_POSTS_P95_MS}`],
 *   }
 *
 * Each script defines its own well-known env vars (e.g. SEARCH_*_P95_MS)
 * for the values it overrides. This keeps overrides explicit and grep-able.
 */
export function baseThresholds() {
  return {
    http_req_failed: [`rate<${SLO.httpReqFailed}`],
    'http_req_duration{kind:auth}':  [`p(95)<${SLO.authP95Ms}`],
    'http_req_duration{kind:read}':  [`p(95)<${SLO.readP95Ms}`],
    'http_req_duration{kind:write}': [`p(95)<${SLO.writeP95Ms}`],
    ws_connecting: [`p(95)<${SLO.wsConnectingP95Ms}`],
  };
}

/**
 * breakpointThresholds — relaxed during ramp-to-failure (lots of noise as
 * VUs scale up) and aborts on the write-p95 signal only. The non-abort
 * thresholds are informational: they appear in the summary alongside the
 * abort cause so post-run analysis sees the full picture.
 *
 * Pass writeP95Ms and delayAbort from the calling script (those are
 * scenario-specific knobs, not org-wide SLO).
 */
export function breakpointThresholds(writeP95Ms, delayAbort) {
  return {
    'http_req_duration{kind:write}': [
      { threshold: `p(95)<${writeP95Ms}`, abortOnFail: true, delayAbortEval: delayAbort },
    ],
    // Informational. Don't abort; just surface in summary.
    http_req_failed: ['rate<0.10'],
    'http_req_duration{kind:read}': ['p(95)<2000'],
    'http_req_duration{kind:auth}': ['p(95)<5000'],
    ws_connecting: ['p(95)<5000'],
  };
}
