import { check, fail } from 'k6';
import { users } from './lib/users.js';
import { ping, getClientConfig, login, getMyTeams, getMyChannelsForTeam } from './lib/api.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1.0'] },
};

export default function () {
  const p = ping();
  if (!check(p, { 'ping 200': r => r.status === 200 })) {
    fail(`ping failed: ${p.status} ${p.body}`);
  }

  const cfg = getClientConfig();
  if (!check(cfg, { 'client_config 200': r => r.status === 200 })) {
    fail(`client_config failed: ${cfg.status} ${cfg.body}`);
  }
  const version = cfg.json('Version') || '';
  console.log(`server version: ${version}`);

  console.log(`checking ${users.length} users`);
  let issues = 0;

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const session = login(u.login_id, u.password);
    if (!session) {
      console.error(`[${u.login_id}] login failed`);
      issues++;
      continue;
    }

    const teams = getMyTeams(session.token);
    if (teams.length === 0) {
      console.error(`[${u.login_id}] has no teams`);
      issues++;
      continue;
    }

    let totalChannels = 0;
    for (const t of teams) totalChannels += getMyChannelsForTeam(session.token, t.id).length;
    if (totalChannels === 0) {
      console.error(`[${u.login_id}] has no channels`);
      issues++;
      continue;
    }

    console.log(`[${u.login_id}] OK (${teams.length} teams, ${totalChannels} channels)`);
  }

  if (issues > 0) fail(`${issues} of ${users.length} users have issues`);
}
