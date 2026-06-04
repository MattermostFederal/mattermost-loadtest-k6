import ws from 'k6/ws';
import { Counter, Trend } from 'k6/metrics';
import { WS_BASE } from './api.js';

export const wsEventsReceived = new Counter('mm_ws_events_received');
export const wsConnectDuration = new Trend('mm_ws_connect_duration', true);

/**
 * Open a Mattermost websocket, authenticate, and run `onTick` periodically.
 *
 * onTick receives a `wsCtx` with:
 *   - send(action, data): send a WS action (e.g. user_typing)
 *
 * @returns true if the connection completed normally.
 */
export function runWithWebSocket(token, userId, sessionMs, onTick, tickIntervalMs) {
  const url = `${WS_BASE}/api/v4/websocket`;
  let seq = 1;

  const t0 = Date.now();

  const res = ws.connect(url, { tags: { endpoint: 'websocket' } }, (socket) => {
    const wsCtx = {
      send(action, data) {
        socket.send(JSON.stringify({ seq: seq++, action, data: data || {} }));
      },
      sendTyping(channelId, parentId = '') {
        this.send('user_typing', { channel_id: channelId, parent_id: parentId });
      },
    };

    socket.on('open', () => {
      wsConnectDuration.add(Date.now() - t0);

      socket.send(JSON.stringify({
        seq: seq++,
        action: 'authentication_challenge',
        data: { token },
      }));

      socket.setInterval(() => {
        try { onTick(wsCtx); } catch (e) { /* swallow per-tick errors to keep session alive */ }
      }, tickIntervalMs);

      socket.setTimeout(() => socket.close(), sessionMs);
    });

    socket.on('message', () => {
      wsEventsReceived.add(1);
    });

    socket.on('error', () => { /* errors surface via ws_* metrics */ });
  });

  return res && res.status === 101;
}
