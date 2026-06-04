import {
  getChannel, getChannelMember, getChannelStats, viewChannel,
  getPostsAroundLastUnread, getPosts, getPostsBefore,
  createPost, editPost, deletePost, addReaction,
  getTeamsUnread, getUserThreads, getThread, markThreadRead,
  searchUsers, searchChannels, searchPosts,
  getUsersStatusesByIds,
} from './api.js';
import { randomMessage, randomEmoji, randomSearchTerm } from './content.js';

/**
 * Action list with frequencies cribbed from simulcontroller's getActionList.
 * Only the top-frequency actions are implemented — long-tail / version-gated
 * ones (scheduled posts, bookmarks, custom attributes, etc.) are omitted.
 *
 * Each action receives a `ctx` with:
 *   - token, userId
 *   - teams, channelsByTeam, allOpenChannelIds (from initialSync)
 *   - state: { currentChannelId, lastPostIdByChannel }
 *   - wsCtx: optional WS context for sending user_typing
 *   - readOnly: if true, write actions are no-ops
 */
export const ACTIONS = [
  {
    name: 'SwitchChannel',
    frequency: 6.5219,
    run(ctx) {
      const next = pickRandom(ctx.allOpenChannelIds);
      if (!next) return;
      const prev = ctx.state.currentChannelId;
      getChannel(ctx.token, next);
      getChannelMember(ctx.token, next, ctx.userId);
      getChannelStats(ctx.token, next);
      const r = getPostsAroundLastUnread(ctx.token, ctx.userId, next);
      if (r && r.status === 200) {
        const order = r.json('order') || [];
        if (order.length > 0) ctx.state.lastPostIdByChannel[next] = order[0];
      }
      if (!ctx.readOnly) viewChannel(ctx.token, ctx.userId, next, prev);
      ctx.state.currentChannelId = next;
    },
  },
  {
    name: 'ScrollChannel',
    frequency: 1.9873,
    run(ctx) {
      const ch = ctx.state.currentChannelId;
      if (!ch) return;
      const before = ctx.state.lastPostIdByChannel[ch];
      if (before) getPostsBefore(ctx.token, ch, before);
      else getPosts(ctx.token, ch);
    },
  },
  {
    name: 'UnreadCheck',
    frequency: 1.0,
    run(ctx) {
      getTeamsUnread(ctx.token, true);
    },
  },
  {
    name: 'CreatePost',
    frequency: 1.0,
    run(ctx) {
      const ch = ctx.state.currentChannelId;
      if (!ch) return;
      if (ctx.wsCtx) ctx.wsCtx.sendTyping(ch);
      if (ctx.readOnly) return;
      const isReply = Math.random() < ctx.percentReplies;
      const rootId = isReply ? ctx.state.lastPostIdByChannel[ch] : '';
      const priority = (!isReply && Math.random() < ctx.percentUrgent)
        ? { priority: 'urgent', requested_ack: false, persistent_notifications: false }
        : null;
      const r = createPost(ctx.token, ch, randomMessage(), rootId || '', priority);
      if (r && r.status === 201) ctx.state.lastPostIdByChannel[ch] = r.json('id');
    },
  },
  {
    name: 'ViewGlobalThreads',
    frequency: 0.6023,
    run(ctx) {
      const team = pickRandom(ctx.teams);
      if (!team) return;
      getUserThreads(ctx.token, ctx.userId, team.id, false);
    },
  },
  {
    name: 'ViewThread',
    frequency: 0.2841,
    run(ctx) {
      const team = pickRandom(ctx.teams);
      const threadId = ctx.state.lastPostIdByChannel[ctx.state.currentChannelId];
      if (!team || !threadId) return;
      getThread(ctx.token, ctx.userId, team.id, threadId);
    },
  },
  {
    name: 'UpdateThreadRead',
    frequency: 0.3236,
    run(ctx) {
      const team = pickRandom(ctx.teams);
      const threadId = ctx.state.lastPostIdByChannel[ctx.state.currentChannelId];
      if (!team || !threadId || ctx.readOnly) return;
      markThreadRead(ctx.token, ctx.userId, team.id, threadId, Date.now());
    },
  },
  {
    name: 'AddReaction',
    frequency: 0.1306,
    run(ctx) {
      const ch = ctx.state.currentChannelId;
      const postId = ctx.state.lastPostIdByChannel[ch];
      if (!postId || ctx.readOnly) return;
      addReaction(ctx.token, ctx.userId, postId, randomEmoji());
    },
  },
  {
    name: 'SearchUsers',
    frequency: 0.0320,
    run(ctx) {
      const team = pickRandom(ctx.teams);
      searchUsers(ctx.token, randomSearchTerm(), team ? team.id : '');
    },
  },
  {
    name: 'SearchPosts',
    frequency: 0.0218,
    run(ctx) {
      const team = pickRandom(ctx.teams);
      if (!team) return;
      searchPosts(ctx.token, team.id, randomSearchTerm());
    },
  },
  {
    name: 'SearchChannels',
    frequency: 0.0150,
    run(ctx) {
      const team = pickRandom(ctx.teams);
      if (!team) return;
      searchChannels(ctx.token, team.id, randomSearchTerm());
    },
  },
  {
    name: 'EditPost',
    frequency: 0.0400,
    run(ctx) {
      const postId = ctx.state.lastPostIdByChannel[ctx.state.currentChannelId];
      if (!postId || ctx.readOnly) return;
      editPost(ctx.token, postId, randomMessage(3, 10));
    },
  },
  {
    name: 'DeletePost',
    frequency: 0.0049,
    run(ctx) {
      const ch = ctx.state.currentChannelId;
      const postId = ctx.state.lastPostIdByChannel[ch];
      if (!postId || ctx.readOnly) return;
      deletePost(ctx.token, postId);
      delete ctx.state.lastPostIdByChannel[ch];
    },
  },
  {
    name: 'GetStatuses',
    frequency: 0.05,
    run(ctx) {
      getUsersStatusesByIds(ctx.token, [ctx.userId]);
    },
  },
];

function pickRandom(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Weighted random action picker. Mirrors gencontroller.pickAction:
 *   - sum all frequencies
 *   - pick uniform in [0, sum), subtract until non-positive
 */
export function pickAction(actions) {
  let sum = 0;
  for (const a of actions) sum += a.frequency;
  if (sum <= 0) throw new Error('action frequency sum is zero');
  let r = Math.random() * sum;
  for (const a of actions) {
    r -= a.frequency;
    if (r <= 0) return a;
  }
  return actions[actions.length - 1];
}
