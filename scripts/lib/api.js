import http from 'k6/http';
import { check } from 'k6';

export const BASE = (__ENV.MM_URL || 'http://localhost:8065').replace(/\/$/, '');
export const WS_BASE = BASE.replace(/^http/, 'ws');

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function authJSON(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

function authOnly(token) {
  return { Authorization: `Bearer ${token}` };
}

// --- auth ---

export function login(loginId, password) {
  const res = http.post(
    `${BASE}/api/v4/users/login`,
    JSON.stringify({ login_id: loginId, password }),
    { headers: JSON_HEADERS, tags: { kind: 'auth', endpoint: 'login' } }
  );
  const ok = check(res, { 'login 200': r => r.status === 200 });
  if (!ok) return null;
  return { token: res.headers['Token'], userId: res.json('id') };
}

export function logout(token) {
  return http.post(`${BASE}/api/v4/users/logout`, null, {
    headers: authOnly(token), tags: { kind: 'auth', endpoint: 'logout' },
  });
}

export function ping() {
  return http.get(`${BASE}/api/v4/system/ping`, { tags: { kind: 'read', endpoint: 'ping' } });
}

export function getClientConfig() {
  return http.get(`${BASE}/api/v4/config/client?format=old`, {
    tags: { kind: 'read', endpoint: 'client_config' },
  });
}

// --- teams / channels ---

// Returns array of teams on success; `null` on transport / non-200. Callers
// MUST distinguish "user has no teams" (returns []) from "API error"
// (returns null) — masking the latter as empty leads to silent zero-work
// in preflight and cleanup.
export function getMyTeams(token) {
  const res = http.get(`${BASE}/api/v4/users/me/teams`, {
    headers: authOnly(token), tags: { kind: 'read', endpoint: 'teams' },
  });
  return res.status === 200 ? res.json() : null;
}

export function getTeamsUnread(token, includeCollapsed = true) {
  return http.get(
    `${BASE}/api/v4/users/me/teams/unread?include_collapsed_threads=${includeCollapsed}`,
    { headers: authOnly(token), tags: { kind: 'read', endpoint: 'teams_unread' } }
  );
}

// Returns array on success; null on non-200. Same distinguishing-error-
// from-empty contract as getMyTeams.
export function getMyChannelsForTeam(token, teamId) {
  const res = http.get(`${BASE}/api/v4/users/me/teams/${teamId}/channels`, {
    headers: authOnly(token), tags: { kind: 'read', endpoint: 'channels' },
  });
  return res.status === 200 ? res.json() : null;
}

export function getChannel(token, channelId) {
  return http.get(`${BASE}/api/v4/channels/${channelId}`, {
    headers: authOnly(token), tags: { kind: 'read', endpoint: 'channel' },
  });
}

export function getChannelMember(token, channelId, userId) {
  return http.get(`${BASE}/api/v4/channels/${channelId}/members/${userId}`, {
    headers: authOnly(token), tags: { kind: 'read', endpoint: 'channel_member' },
  });
}

export function getChannelStats(token, channelId) {
  return http.get(
    `${BASE}/api/v4/channels/${channelId}/stats?exclude_files_count=true`,
    { headers: authOnly(token), tags: { kind: 'read', endpoint: 'channel_stats' } }
  );
}

export function viewChannel(token, userId, channelId, prevChannelId = '') {
  return http.post(
    `${BASE}/api/v4/channels/members/${userId}/view`,
    JSON.stringify({ channel_id: channelId, prev_channel_id: prevChannelId }),
    { headers: authJSON(token), tags: { kind: 'write', endpoint: 'view_channel' } }
  );
}

// --- posts ---

export function getPosts(token, channelId, perPage = 30) {
  return http.get(
    `${BASE}/api/v4/channels/${channelId}/posts?per_page=${perPage}`,
    { headers: authOnly(token), tags: { kind: 'read', endpoint: 'posts' } }
  );
}

export function getPostsAroundLastUnread(token, userId, channelId, before = 30, after = 30, collapsed = true) {
  return http.get(
    `${BASE}/api/v4/users/${userId}/channels/${channelId}/posts/unread`
      + `?limit_before=${before}&limit_after=${after}&collapsedThreads=${collapsed}`,
    { headers: authOnly(token), tags: { kind: 'read', endpoint: 'posts_around_unread' } }
  );
}

export function getPostsBefore(token, channelId, postId, perPage = 30) {
  return http.get(
    `${BASE}/api/v4/channels/${channelId}/posts?before=${postId}&per_page=${perPage}`,
    { headers: authOnly(token), tags: { kind: 'read', endpoint: 'posts_before' } }
  );
}

export function createPost(token, channelId, message, rootId = '', priority = null, fileIds = null) {
  const body = { channel_id: channelId, message };
  if (rootId) body.root_id = rootId;
  if (priority) body.metadata = { priority };
  if (fileIds && fileIds.length > 0) body.file_ids = fileIds;
  return http.post(`${BASE}/api/v4/posts`, JSON.stringify(body), {
    headers: authJSON(token), tags: { kind: 'write', endpoint: 'create_post' },
  });
}

// Single-file upload via raw body (MM also accepts multipart, but raw is
// simpler and lower-overhead from k6). Returns the standard FileUpload
// response: { file_infos: [{ id, name, size, ... }] }
export function uploadFile(token, channelId, fileBytes, filename, contentType = 'application/octet-stream') {
  return http.post(
    `${BASE}/api/v4/files?channel_id=${channelId}&filename=${encodeURIComponent(filename)}`,
    fileBytes,
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      tags: { kind: 'write', endpoint: 'upload_file' },
    }
  );
}

export function editPost(token, postId, message) {
  return http.put(
    `${BASE}/api/v4/posts/${postId}`,
    JSON.stringify({ id: postId, message }),
    { headers: authJSON(token), tags: { kind: 'write', endpoint: 'edit_post' } }
  );
}

export function deletePost(token, postId) {
  return http.del(`${BASE}/api/v4/posts/${postId}`, null, {
    headers: authOnly(token), tags: { kind: 'write', endpoint: 'delete_post' },
  });
}

// Permanent post delete — removes the Post row, FileInfo rows for attached
// files, AND the blobs on the file backend. Gated by sysadmin permission
// and ServiceSettings.EnableAPIPostDeletion. This is the only API surface
// that fully cleans uploaded files (channel-permanent-delete skips them).
export function deletePostPermanent(token, postId) {
  return http.del(`${BASE}/api/v4/posts/${postId}?permanent=true`, null, {
    headers: authOnly(token), tags: { kind: 'admin', endpoint: 'delete_post_permanent' },
  });
}

export function addReaction(token, userId, postId, emojiName) {
  return http.post(
    `${BASE}/api/v4/reactions`,
    JSON.stringify({ user_id: userId, post_id: postId, emoji_name: emojiName }),
    { headers: authJSON(token), tags: { kind: 'write', endpoint: 'reaction' } }
  );
}

// --- threads ---

export function getUserThreads(token, userId, teamId, totalsOnly = true) {
  return http.get(
    `${BASE}/api/v4/users/${userId}/teams/${teamId}/threads`
      + `?totalsOnly=${totalsOnly}&threadsOnly=false`,
    { headers: authOnly(token), tags: { kind: 'read', endpoint: 'user_threads' } }
  );
}

export function getThread(token, userId, teamId, threadId) {
  return http.get(
    `${BASE}/api/v4/users/${userId}/teams/${teamId}/threads/${threadId}`,
    { headers: authOnly(token), tags: { kind: 'read', endpoint: 'thread' } }
  );
}

export function markThreadRead(token, userId, teamId, threadId, timestamp) {
  return http.put(
    `${BASE}/api/v4/users/${userId}/teams/${teamId}/threads/${threadId}/read/${timestamp}`,
    null,
    { headers: authOnly(token), tags: { kind: 'write', endpoint: 'thread_read' } }
  );
}

// --- preferences / sidebar / statuses ---

export function getMyPreferences(token) {
  return http.get(`${BASE}/api/v4/users/me/preferences`, {
    headers: authOnly(token), tags: { kind: 'read', endpoint: 'preferences' },
  });
}

export function getSidebarCategories(token, userId, teamId) {
  return http.get(`${BASE}/api/v4/users/${userId}/teams/${teamId}/channels/categories`, {
    headers: authOnly(token), tags: { kind: 'read', endpoint: 'sidebar_categories' },
  });
}

export function getUsersStatusesByIds(token, ids) {
  return http.post(
    `${BASE}/api/v4/users/status/ids`,
    JSON.stringify(ids),
    { headers: authJSON(token), tags: { kind: 'read', endpoint: 'user_statuses' } }
  );
}

// --- search ---

export function searchUsers(token, term, teamId = '') {
  return http.post(
    `${BASE}/api/v4/users/search`,
    JSON.stringify({ term, team_id: teamId }),
    { headers: authJSON(token), tags: { kind: 'read', endpoint: 'search_users' } }
  );
}

export function searchChannels(token, teamId, term) {
  return http.post(
    `${BASE}/api/v4/teams/${teamId}/channels/search`,
    JSON.stringify({ term }),
    { headers: authJSON(token), tags: { kind: 'read', endpoint: 'search_channels' } }
  );
}

export function searchPosts(token, teamId, terms) {
  return http.post(
    `${BASE}/api/v4/teams/${teamId}/posts/search`,
    JSON.stringify({ terms, is_or_search: false }),
    { headers: authJSON(token), tags: { kind: 'read', endpoint: 'search_posts' } }
  );
}

// --- admin: team/channel/user management --------------------------------------
// These require admin privileges. Used by bootstrap.js and teardown.js.

export function getTeamByName(token, name) {
  return http.get(`${BASE}/api/v4/teams/name/${name}`, {
    headers: authOnly(token), tags: { kind: 'admin', endpoint: 'team_by_name' },
  });
}

export function createTeam(token, name, displayName, type = 'O') {
  return http.post(
    `${BASE}/api/v4/teams`,
    JSON.stringify({ name, display_name: displayName, type }),
    { headers: authJSON(token), tags: { kind: 'admin', endpoint: 'create_team' } }
  );
}

export function deleteTeam(token, teamId) {
  return http.del(`${BASE}/api/v4/teams/${teamId}`, null, {
    headers: authOnly(token), tags: { kind: 'admin', endpoint: 'delete_team' },
  });
}

export function addUserToTeam(token, teamId, userId) {
  return http.post(
    `${BASE}/api/v4/teams/${teamId}/members`,
    JSON.stringify({ team_id: teamId, user_id: userId }),
    { headers: authJSON(token), tags: { kind: 'admin', endpoint: 'add_team_member' } }
  );
}

export function getChannelByName(token, teamId, name) {
  return http.get(`${BASE}/api/v4/teams/${teamId}/channels/name/${name}`, {
    headers: authOnly(token), tags: { kind: 'admin', endpoint: 'channel_by_name' },
  });
}

export function createChannel(token, teamId, name, displayName, type = 'O') {
  return http.post(
    `${BASE}/api/v4/channels`,
    JSON.stringify({ team_id: teamId, name, display_name: displayName, type }),
    { headers: authJSON(token), tags: { kind: 'admin', endpoint: 'create_channel' } }
  );
}

export function deleteChannel(token, channelId) {
  return http.del(`${BASE}/api/v4/channels/${channelId}`, null, {
    headers: authOnly(token), tags: { kind: 'admin', endpoint: 'delete_channel' },
  });
}

export function addUserToChannel(token, channelId, userId) {
  return http.post(
    `${BASE}/api/v4/channels/${channelId}/members`,
    JSON.stringify({ user_id: userId }),
    { headers: authJSON(token), tags: { kind: 'admin', endpoint: 'add_channel_member' } }
  );
}

export function getUserByUsername(token, username) {
  return http.get(`${BASE}/api/v4/users/username/${username}`, {
    headers: authOnly(token), tags: { kind: 'admin', endpoint: 'user_by_username' },
  });
}

export function createUser(token, user) {
  // user = { email, username, password, first_name, last_name }
  return http.post(`${BASE}/api/v4/users`, JSON.stringify(user), {
    headers: authJSON(token), tags: { kind: 'admin', endpoint: 'create_user' },
  });
}

export function deleteUser(token, userId) {
  return http.del(`${BASE}/api/v4/users/${userId}`, null, {
    headers: authOnly(token), tags: { kind: 'admin', endpoint: 'delete_user' },
  });
}

// --- admin: permanent (hard) delete -------------------------------------------
// These require the matching ServiceSettings.EnableAPI*Deletion flag to be true
// on the server. Hard delete removes the row from the DB and cannot be undone
// outside of a backup restore.

export function deleteUserPermanent(token, userId) {
  return http.del(`${BASE}/api/v4/users/${userId}?permanent=true`, null, {
    headers: authOnly(token), tags: { kind: 'admin', endpoint: 'delete_user_permanent' },
  });
}

export function deleteTeamPermanent(token, teamId) {
  return http.del(`${BASE}/api/v4/teams/${teamId}?permanent=true`, null, {
    headers: authOnly(token), tags: { kind: 'admin', endpoint: 'delete_team_permanent' },
  });
}

export function deleteChannelPermanent(token, channelId) {
  return http.del(`${BASE}/api/v4/channels/${channelId}?permanent=true`, null, {
    headers: authOnly(token), tags: { kind: 'admin', endpoint: 'delete_channel_permanent' },
  });
}

// --- admin: server config (used to toggle EnableAPI*Deletion at hard teardown) -
// Three endpoints used here:
//   GET /api/v4/config        — read full config (we use this for snapshot)
//   PUT /api/v4/config        — full replacement (kept for legacy callers;
//                               teardown/cleanup no longer use it)
//   PUT /api/v4/config/patch  — surgical merge of only the keys we send
//                               (added in MM 5.20+; what teardown.js and
//                               cleanup.js use to flip the EnableAPI*Deletion
//                               flags without touching unrelated config)
//
// Why patch matters: full PUT carries the entire config blob, which creates
// (a) a clobber risk if another admin is making concurrent changes and
// (b) noisy audit log entries showing the whole config as the "diff."
// Patch is single-key surgery; both issues go away.

export function getMe(token) {
  return http.get(`${BASE}/api/v4/users/me`, {
    headers: authOnly(token), tags: { kind: 'admin', endpoint: 'get_me' },
  });
}

export function getConfig(token) {
  return http.get(`${BASE}/api/v4/config`, {
    headers: authOnly(token), tags: { kind: 'admin', endpoint: 'get_config' },
  });
}

export function updateConfig(token, config) {
  return http.put(`${BASE}/api/v4/config`, JSON.stringify(config), {
    headers: authJSON(token), tags: { kind: 'admin', endpoint: 'update_config' },
  });
}

// Surgical config update — sends ONLY the keys in `patch` (rest of the
// config untouched). Drastically reduces clobber risk vs the full PUT, and
// shrinks the audit-log diff to just the fields we care about.
//
// Example: patchConfig(token, { ServiceSettings: { EnableAPIPostDeletion: true } })
export function patchConfig(token, patch) {
  return http.put(`${BASE}/api/v4/config/patch`, JSON.stringify(patch), {
    headers: authJSON(token), tags: { kind: 'admin', endpoint: 'patch_config' },
  });
}

// CRITICAL silent-failure guard: MM's writeFilter at api4/config.go:403-459
// drops fields whose `access:` struct tag is absent unless the caller has
// PermissionManageSystem (system_admin). The four EnableAPI*Deletion fields
// have no access tag (model/config.go:448-472), so a granular RBAC admin
// passes the outer SysconsoleWritePermissions guard but the merge silently
// drops the fields — patchConfig returns 200 OK with the values unchanged.
//
// verifyServiceSettingsFlags re-reads /api/v4/config and compares each key
// in `expected` against the live value. Returns null when all match, or an
// array of {flag, want, got} mismatches.
//
// Callers MUST invoke this after every patch that touches deletion flags
// and abort the run when mismatches surface — the alternative is a sweep
// run on stale-true assumption that silently 501s every delete.
export function verifyServiceSettingsFlags(token, expected) {
  const r = getConfig(token);
  if (!r || r.status !== 200) {
    return [{ flag: '<get-config>', want: 'reachable', got: `status=${r && r.status}` }];
  }
  const live = r.json('ServiceSettings') || {};
  const mismatches = [];
  for (const [flag, want] of Object.entries(expected)) {
    const got = live[flag] === true;
    if (got !== want) mismatches.push({ flag, want, got });
  }
  return mismatches.length === 0 ? null : mismatches;
}

// --- admin: discovery (replaces count-based iteration in teardown) ------------
// Lists users in a team page-by-page. Used to find the bootstrap users by
// username prefix even if BOOTSTRAP_NUM_USERS at teardown doesn't match what
// bootstrap actually created.

export function getUsersInTeam(token, teamId, page = 0, perPage = 200) {
  return http.get(
    `${BASE}/api/v4/users?in_team=${teamId}&page=${page}&per_page=${perPage}`,
    { headers: authOnly(token), tags: { kind: 'admin', endpoint: 'users_in_team' } }
  );
}

export function getChannelsForTeam(token, teamId, page = 0, perPage = 200) {
  return http.get(
    `${BASE}/api/v4/teams/${teamId}/channels?page=${page}&per_page=${perPage}`,
    { headers: authOnly(token), tags: { kind: 'admin', endpoint: 'channels_for_team' } }
  );
}
