import { SharedArray } from 'k6/data';
import { RUN_ID } from './content.js';

/**
 * If BOOTSTRAP_NUM_USERS > 0, generate users deterministically from RUN_ID
 * instead of reading a credentials file. The bootstrap.js script creates the
 * matching MM accounts using the same algorithm, so no creds file is needed.
 *
 * Username : lt-{RUN_ID}-u{i}        (i: 1..N, padded)
 * Email    : lt-{RUN_ID}-u{i}@loadtest.invalid
 * Password : Lt-{RUN_ID}-{i}!Pass
 */
export function bootstrapUserDescriptor(i) {
  const tag = `${RUN_ID}-u${i}`;
  return {
    username: `lt-${tag}`,
    email: `lt-${tag}@loadtest.invalid`,
    password: `Lt-${RUN_ID}-${i}!Pass`,
  };
}

function generateBootstrapUsers(n) {
  const arr = [];
  for (let i = 1; i <= n; i++) {
    const u = bootstrapUserDescriptor(i);
    arr.push({ login_id: u.email, password: u.password });
  }
  return arr;
}

function parseCSV(raw) {
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(',').map(s => s.trim().toLowerCase());
  const idxLogin = header.indexOf('login_id');
  const idxPass = header.indexOf('password');
  if (idxLogin < 0 || idxPass < 0) {
    throw new Error('CSV must have a header row with columns: login_id,password');
  }
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    return { login_id: cols[idxLogin].trim(), password: cols[idxPass].trim() };
  });
}

// No default for USERS_FILE — k6's SharedArray callback runs at module
// init context (per k6/data source), so opening a non-existent default
// path here would crash any script that imports this module, even ones
// that never touch the users array (e.g. admin-path cleanup, teardown).
//
// Resolution order:
//   1. BOOTSTRAP_NUM_USERS > 0 → derive users deterministically from RUN_ID
//   2. USERS_FILE set         → open and parse that file
//   3. Neither set            → return [] (callers reading .length get 0
//                               and should produce a clear error)
// Trim — USERS_FILE=' ' would be truthy under a simple !usersFile check
// and reach open(' '), wasting the round-10 fix.
const usersFile = (__ENV.USERS_FILE || '').trim();
const bootstrapN = Number(__ENV.BOOTSTRAP_NUM_USERS || 0);

export const users = new SharedArray('mm-users', () => {
  if (bootstrapN > 0) return generateBootstrapUsers(bootstrapN);
  if (!usersFile) return [];

  const raw = open(usersFile);
  const parsed = usersFile.toLowerCase().endsWith('.csv')
    ? parseCSV(raw)
    : JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${usersFile} must be a non-empty list of {login_id,password}`);
  }
  for (const u of parsed) {
    if (!u.login_id || !u.password) {
      throw new Error(`${usersFile} contains an entry missing login_id or password`);
    }
  }
  return parsed;
});

export function pickUser(vu) {
  return users[(vu - 1) % users.length];
}
