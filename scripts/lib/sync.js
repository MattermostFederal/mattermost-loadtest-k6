import {
  getClientConfig, getMyPreferences, getMyTeams,
  getMyChannelsForTeam, getSidebarCategories, getTeamsUnread,
  getUserThreads, getUsersStatusesByIds,
} from './api.js';

/**
 * Emulate the work a real Mattermost web client does on a fresh login.
 * Mirrors the simulcontroller's loadTeam + initial fetches.
 *
 * Returns { teams, channelsByTeam, allOpenChannelIds }.
 */
export function initialSync(token, userId) {
  getClientConfig();
  getMyPreferences(token);
  getTeamsUnread(token, true);

  // getMyTeams returns null on API error (distinguished from empty 200).
  // For initial sync, treat null as "no teams" — the VU iteration will
  // see allOpenChannelIds.length === 0 and exit cleanly. Logging the
  // distinction here helps debug "every VU got 0 channels" cases.
  const teams = getMyTeams(token);
  if (teams === null) {
    console.warn('initialSync: getMyTeams returned non-200; treating as empty');
    return { teams: [], channelsByTeam: {}, allOpenChannelIds: [] };
  }
  const channelsByTeam = {};
  const allOpenChannelIds = [];

  for (const team of teams) {
    const channels = getMyChannelsForTeam(token, team.id);
    if (channels === null) {
      console.warn(`initialSync: getMyChannelsForTeam(${team.name}) returned non-200; skipping`);
      channelsByTeam[team.id] = [];
      continue;
    }
    channelsByTeam[team.id] = channels;
    for (const c of channels) {
      if (c.type === 'O' || c.type === 'P') allOpenChannelIds.push(c.id);
    }

    getUserThreads(token, userId, team.id, true);
    getSidebarCategories(token, userId, team.id);
  }

  getUsersStatusesByIds(token, [userId]);

  return { teams, channelsByTeam, allOpenChannelIds };
}
