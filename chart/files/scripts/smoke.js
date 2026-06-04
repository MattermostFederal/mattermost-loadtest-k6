import { sleep } from 'k6';
import { pickUser } from './lib/users.js';
import { login, getMyTeams, getMyChannelsForTeam, getPosts } from './lib/api.js';

export const options = {
  vus: 1,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{kind:auth}':  ['p(95)<2000'],
    'http_req_duration{kind:read}':  ['p(95)<1000'],
  },
};

export default function () {
  const creds = pickUser(__VU);
  const session = login(creds.login_id, creds.password);
  if (!session) return;

  const teams = getMyTeams(session.token);
  if (teams.length === 0) {
    console.warn(`user ${creds.login_id} has no teams`);
    return;
  }

  const channels = getMyChannelsForTeam(session.token, teams[0].id);
  const channel = channels.find(c => c.type === 'O') || channels[0];
  if (!channel) {
    console.warn(`user ${creds.login_id} has no channels in team ${teams[0].name}`);
    return;
  }

  getPosts(session.token, channel.id);
  sleep(1);
}
