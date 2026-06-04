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

  const teams = getMyTeams(token);
  const channelsByTeam = {};
  const allOpenChannelIds = [];

  for (const team of teams) {
    const channels = getMyChannelsForTeam(token, team.id);
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
