import fsp from 'node:fs/promises';
import { z } from 'zod';
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { decodeCursor, encodeCursor } from '../../db/repo.js';
import { iso, sleep } from '../../util.js';
import { downloadStoredMedia } from '../../wa/ingest.js';
import { markSeen, readCursor } from '../freshness.js';
import { chatHeader, renderFollowUps, renderInbox, renderMessage, renderTranscript, localShort, TZ } from '../compact.js';
import { DISMISS_KEY, NO_FOLLOWUP_TAGS, computeFollowUps, computeInbox } from '../inbox.js';
import { compact } from '../present.js';
import { uris } from '../uris.js';
import { chatField, defineTool, limitField, Rich, sessionField, TextResult, type Env } from '../helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** "2026-10-01T10:00:00Z" | "2026-10-01" | "-2h" | "7d" (relative: that long ago). */
export function parseTime(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const rel = /^-?(\d+)\s*([smhdw])$/i.exec(v.trim());
  if (rel) {
    const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[rel[2]!.toLowerCase() as 's'];
    return Math.floor(Date.now() / 1000) - Number(rel[1]) * unit;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Invalid time "${v}": use ISO-8601 (2026-10-01T10:00:00Z) or relative (2h, 7d).`);
  return Math.floor(t / 1000);
}

const timeDesc = 'ISO-8601 date/time, or relative like "2h", "7d", "1w" (that long ago).';

export function registerReadTools(env: Env) {
  const { core } = env;

  const fmt = {
    format: z.enum(['compact', 'json']).default('compact').describe('compact = readable transcript text (about 5x fewer tokens, default); json = full structured data.'),
    max_chars: z.number().int().min(0).max(20000).default(600).describe('Cut each message text after this many characters (0 = no limit). Full text via get_message.'),
    ids: z.boolean().default(true).describe('Print a short "#id" after each message so other tools can reference it (react, quote, edit, download...).'),
  };

  defineTool(env, 'list_chats', {
    title: 'List chats',
    description: 'List chats ordered by recent activity (pinned first) from the local store. Filter by name, kind, unread, archived or tag.',
    toolset: 'read',
    input: {
      session: sessionField,
      query: z.string().optional().describe('Name or number substring.'),
      kind: z.enum(['user', 'group', 'community', 'newsletter']).optional(),
      unread_only: z.boolean().optional(),
      archived: z.boolean().optional().describe('true = only archived, false = hide archived. Default: both.'),
      pinned_only: z.boolean().optional(),
      tag: z.string().optional().describe('Only chats with this local tag.'),
      limit: limitField(30, 200),
      offset: z.number().int().min(0).default(0),
    },
    output: { session: z.string(), total: z.number(), chats: z.array(z.looseObject({ jid: z.string() })), next_offset: z.number().optional() },
    network: false,
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    const { rows, total } = core.repo.listChats(s.name, { query: a.query, kind: a.kind, unreadOnly: a.unread_only, archived: a.archived, pinnedOnly: a.pinned_only, tag: a.tag, limit: a.limit, offset: a.offset });
    const p = ctx.presenter(s.name);
    return { session: s.name, total, chats: rows.map((r) => p.chat(r)), next_offset: a.offset + rows.length < total ? a.offset + rows.length : undefined };
  });

  defineTool(env, 'get_chat', {
    title: 'Chat details',
    description: 'Everything known about one chat: profile (contact or group with members), unread count, tags, labels, saved notes and presence.',
    toolset: 'read',
    input: { session: sessionField, chat: chatField },
    network: false,
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    const jid = ctx.chat(s.name, a.chat);
    const p = ctx.presenter(s.name);
    const row = core.repo.getChat(s.name, jid);
    const out: Record<string, any> = { jid, chat: row ? p.chat(row) : { jid, name: p.name(jid) ?? undefined }, messages_stored: core.repo.countMessages(s.name, jid) };
    if (jid.endsWith('@g.us')) {
      const g = core.repo.getGroup(s.name, jid);
      if (g) {
        const parts = g.participants ? (JSON.parse(g.participants) as any[]) : [];
        out.group = compact({
          subject: g.subject, description: g.description, owner: p.who(g.owner), created: iso(g.creation), size: g.size, announce_only_admins_can_send: !!g.announce,
          only_admins_edit_info: !!g.restrict_info, join_approval: !!g.join_approval, i_am_admin: !!g.me_is_admin,
          members: parts.map((m) => compact({ jid: m.phone ?? m.id, name: p.name(m.phone ?? m.id) ?? undefined, admin: m.admin ?? undefined })),
        });
      }
    } else {
      const c = core.repo.getContact(s.name, jid);
      out.contact = c ? compact({ name: c.name, push_name: c.notify, verified_name: c.verified_name, phone: c.phone, about: c.about, business: !!c.is_business, blocked: !!c.blocked }) : undefined;
      const pr = s.presence.get(jid);
      if (pr) out.presence = { state: pr.state, seen_s_ago: Math.round((Date.now() - pr.at) / 1000) };
    }
    const mem = core.repo.getMemory(s.name, jid);
    if (mem.length) out.notes = Object.fromEntries(mem.map((m) => [m.key, m.value]));
    const log = core.repo.listInteractions(s.name, { jid, limit: 10 });
    if (log.length) out.recent_interactions = log.map((i) => p.interaction(i));
    const open = core.repo.listInteractions(s.name, { jid, status: 'open', limit: 20 });
    if (open.length) out.open_tasks = open.map((i) => p.interaction(i));
    return out;
  });

  defineTool(env, 'get_messages', {
    title: 'Read messages of a chat',
    description:
      'Read stored messages of a chat in chronological order, newest page first. Page backwards with next_cursor. Filter by time, direction, type, sender. ' +
      'Only messages this server has seen are available (history sync + live); use load_older_history to pull older ones from the phone.',
    toolset: 'read',
    input: {
      session: sessionField,
      chat: chatField,
      limit: limitField(30, 200),
      cursor: z.string().optional().describe('next_cursor from the previous page (loads older messages).'),
      since: z.string().optional().describe(`Only messages after this. ${timeDesc}`),
      until: z.string().optional().describe(`Only messages before this. ${timeDesc}`),
      from_me: z.boolean().optional(),
      sender: z.string().optional().describe('Only from this participant (group chats). Phone or jid.'),
      type: z.enum(['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'contacts', 'poll', 'event', 'system']).optional(),
      has_media: z.boolean().optional(),
      starred: z.boolean().optional(),
      unseen_only: z.boolean().default(false).describe('Incremental read: only messages (both directions) after what THIS client already read of the chat. Use it to re-check a chat you read earlier in this conversation; the first time it reads normally.'),
      after_message_id: z.string().optional().describe('Only messages after this one (full id or the #short id).'),
      ...fmt,
    },
    network: false,
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    const jid = ctx.chat(s.name, a.chat);
    const cur = decodeCursor(a.cursor);
    const filters = { chat: jid, since: parseTime(a.since), until: parseTime(a.until), fromMe: a.from_me, type: a.type, hasMedia: a.has_media, starred: a.starred, sender: a.sender ? ctx.jid(s.name, a.sender) : undefined };

    // incremental: everything after an explicit message, or after what this client has already read
    let after: [number, number] | undefined;
    let incremental = false;
    let firstRead = false;
    if (a.after_message_id) {
      const anchor = core.repo.getMessage(s.name, jid, a.after_message_id);
      if (!anchor) throw new Error(`Message ${a.after_message_id} not found in this chat.`);
      after = [anchor.ts, anchor._rid];
      incremental = true;
    } else if (a.unseen_only) {
      after = readCursor(ctx.server, s.name, jid);
      incremental = !!after;
      firstRead = !after;
    }

    const rows = incremental
      ? core.repo.listMessages(s.name, { ...filters, after, limit: a.limit }) // ascending
      : core.repo.listMessages(s.name, { ...filters, limit: a.limit, before: cur ? [Number(cur[0]), Number(cur[1])] : undefined }).reverse();
    const hasMoreNew = incremental && rows.length === a.limit;
    markSeen(ctx.server, s.name, jid, rows);

    const p = ctx.presenter(s.name);
    const name = p.name(jid) ?? undefined;
    const oldest = rows[0];
    const notes = rows.length || incremental
      ? core.repo.listInteractions(s.name, { jid, since: incremental ? after![0] : oldest?.ts, until: incremental ? undefined : cur ? Number(cur[0]) : undefined, limit: 20 }).reverse().map((i) => p.interaction(i))
      : [];
    const nextCursor = !incremental && rows.length === a.limit && oldest ? encodeCursor([oldest.ts, oldest._rid]) : undefined;
    const msgs = p.messages(rows);
    const emptyNote = !rows.length
      ? (incremental ? 'Nothing new since you last read this chat.' : a.cursor ? undefined : core.repo.countMessages(s.name, jid) ? 'No messages match the filters.' : 'No stored messages for this chat yet. Try load_older_history, or wait for history sync (session_status).')
      : undefined;

    if (a.format === 'json') {
      return {
        session: s.name, chat: jid, chat_name: name, count: rows.length, new_since_last_read: incremental ? rows.length : undefined,
        messages: msgs, my_notes: notes, next_cursor: nextCursor, note: emptyNote ?? (firstRead ? 'First read of this chat by this client: returned the latest messages.' : hasMoreNew ? 'More new messages exist; call again with unseen_only.' : undefined),
      };
    }
    const o = { ids: a.ids, maxChars: a.max_chars };
    const anchorLabel = a.after_message_id ? (a.after_message_id.startsWith('#') ? a.after_message_id : `#${a.after_message_id.slice(-8)}`) : '';
    const head = chatHeader(name, jid, a.after_message_id ? `${rows.length} after ${anchorLabel}` : incremental ? `${rows.length} new since last read` : `${rows.length} msgs`);
    const lines = [head, ...(rows.length ? renderTranscript(msgs as any[], notes as any[], o) : [])];
    if (emptyNote) lines.push(emptyNote);
    if (firstRead) lines.push('(first read of this chat by this client: latest messages)');
    if (hasMoreNew) lines.push('… more new messages: call again with unseen_only=true');
    if (nextCursor) lines.push(`… older messages: cursor=${nextCursor}`);
    return new TextResult(lines.join('\n'), { session: s.name, chat: jid, chat_name: name, count: rows.length, new_since_last_read: incremental ? rows.length : undefined, next_cursor: nextCursor });
  });

  defineTool(env, 'get_message', {
    title: 'Get one message with context',
    description: 'Fetch a single message by id with its reactions, the message it quotes, and optionally N surrounding messages.',
    toolset: 'read',
    input: { session: sessionField, chat: chatField.optional(), message_id: z.string(), context: z.number().int().min(0).max(10).default(0).describe('Messages to include before and after.') },
    network: false,
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    const row = a.chat ? core.repo.getMessage(s.name, ctx.chat(s.name, a.chat), a.message_id) : core.repo.findMessageById(s.name, a.message_id);
    if (!row) throw new Error(`Message ${a.message_id} not found in the local store.`);
    const p = ctx.presenter(s.name);
    markSeen(ctx.server, s.name, row.chat_jid, [row]);
    const out: Record<string, any> = { message: p.messages([row])[0] };
    if (row.quoted_id) {
      const q = core.repo.getMessage(s.name, row.chat_jid, row.quoted_id);
      if (q) out.quoted_message = p.messages([q])[0];
    }
    if (a.context) {
      const before = core.repo.listMessages(s.name, { chat: row.chat_jid, limit: a.context, before: [row.ts, row._rid] });
      const after = core.repo.listMessages(s.name, { chat: row.chat_jid, limit: a.context, after: [row.ts, row._rid] });
      out.before = p.messages([...before].reverse());
      out.after = p.messages(after);
      markSeen(ctx.server, s.name, row.chat_jid, after);
    }
    return out;
  });

  defineTool(env, 'search_messages', {
    title: 'Search messages (full text)',
    description: 'Full-text search (FTS5, accent-insensitive, prefix matching, all words must match) over text, captions and sender names across all chats or one chat.',
    toolset: 'read',
    input: {
      session: sessionField,
      query: z.string().min(1),
      chat: z.string().optional(),
      from_me: z.boolean().optional(),
      sender: z.string().optional(),
      type: z.string().optional(),
      since: z.string().optional().describe(timeDesc),
      until: z.string().optional().describe(timeDesc),
      limit: limitField(20, 100),
      offset: z.number().int().min(0).default(0),
      ...fmt,
    },
    network: false,
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    const rows = core.repo.searchMessages(s.name, a.query, {
      chat: a.chat ? ctx.chat(s.name, a.chat) : undefined, fromMe: a.from_me, sender: a.sender ? ctx.jid(s.name, a.sender) : undefined, type: a.type,
      since: parseTime(a.since), until: parseTime(a.until), limit: a.limit, offset: a.offset,
    });
    const p = ctx.presenter(s.name);
    const nextOffset = rows.length === a.limit ? a.offset + rows.length : undefined;
    if (a.format === 'json') {
      return {
        session: s.name, count: rows.length,
        results: rows.map((r) => ({ ...p.message(r), chat_name: p.name(r.chat_jid) ?? undefined, match: r.snippet })),
        next_offset: nextOffset,
      };
    }
    const o = { ids: a.ids, maxChars: a.max_chars };
    const lines = [`SEARCH "${a.query}" · ${rows.length} result(s) · times ${TZ}`];
    for (const r of rows) {
      const m = p.message(r) as any;
      lines.push(renderMessage(m, o, localShort, `${p.name(r.chat_jid) ?? r.chat_jid} <${r.chat_jid}>`));
    }
    if (nextOffset) lines.push(`… more: offset=${nextOffset}`);
    return new TextResult(lines.join('\n'), { session: s.name, count: rows.length, next_offset: nextOffset });
  });

  defineTool(env, 'inbox', {
    title: 'Inbox: new, unread and unanswered chats',
    description:
      'THE tool for "what needs my attention?". Lists chats that have unread messages and/or are WAITING FOR MY REPLY (their message is the newest and I have not answered), ' +
      'with how long they have been waiting and the pending messages. filter: unread | unanswered | any (default any). In groups only messages that @mention you or reply to you count as awaiting. ' +
      'Skips muted/archived chats and blocked contacts by default. Use inbox_dismiss for chats that need no reply.',
    toolset: 'read',
    input: {
      session: sessionField,
      filter: z.enum(['unread', 'unanswered', 'any']).default('any'),
      min_wait_minutes: z.number().int().min(0).max(100000).default(0).describe('Only list unanswered chats waiting at least this long.'),
      max_age_days: z.number().int().min(1).max(3650).default(14).describe('Ignore unanswered chats whose last message is older than this.'),
      include_groups: z.boolean().default(true),
      include_archived: z.boolean().default(false),
      include_muted: z.boolean().default(false),
      include_dismissed: z.boolean().default(false),
      messages_per_chat: z.number().int().min(1).max(20).default(3),
      limit: limitField(25, 100),
      sort: z.enum(['oldest', 'newest']).optional().describe('Default: oldest-waiting first for unanswered/any, newest first for unread.'),
      skip_seen: z.boolean().default(false).describe('Do not repeat messages this client already read (saves tokens when polling). Only use if you still have the earlier output in mind.'),
      ...fmt,
    },
    network: false,
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    const data = computeInbox(core, s.name, {
      filter: a.filter, minWaitMinutes: a.min_wait_minutes, maxAgeDays: a.max_age_days, includeGroups: a.include_groups, includeArchived: a.include_archived,
      includeMuted: a.include_muted, includeDismissed: a.include_dismissed, perChat: a.messages_per_chat, limit: a.limit,
      sort: a.sort ?? (a.filter === 'unread' ? 'newest' : 'oldest'), skipSeen: a.skip_seen,
    }, ctx.server);
    if (a.format === 'json') return data;
    return new TextResult(renderInbox(data, { ids: a.ids, maxChars: a.max_chars }), {
      session: data.session, summary: data.summary, sort: data.sort,
      items: data.items.map((i: any) => ({ jid: i.jid, name: i.name, awaiting_reply: i.awaiting_reply, unread: i.unread, waiting_minutes: i.waiting_minutes })),
    });
  });

  defineTool(env, 'follow_ups', {
    title: 'Follow-ups: chats waiting on THEM',
    description:
      'THE tool for "recover leads / who did not answer me?". The opposite of inbox: chats where MY message is the newest and they have not answered, ' +
      'silent for at least min_silence_hours. Each chat shows its stage (proposal_sent = I sent a document, engaged = real back-and-forth, cold = only their first message), ' +
      'how many follow-up attempts I already made since their last message (messages less than 6h apart count as one), whether they saw it, my notes/open tasks and the last messages. ' +
      'Default sort is priority: warm leads first, fewest attempts first. Chats at max_attempts are hidden so nobody gets spammed; tag a chat "no-followup" with chat_tags to never list it.',
    toolset: 'read',
    input: {
      session: sessionField,
      min_silence_hours: z.number().min(0).max(24 * 365).default(20).describe('Only chats where my last message is at least this old.'),
      max_age_days: z.number().int().min(1).max(3650).default(30).describe('Ignore chats where my last message is older than this.'),
      max_attempts: z.number().int().min(0).max(20).default(3).describe('Hide chats where I already made this many unanswered attempts (0 = show all).'),
      include_never_replied: z.boolean().default(false).describe('Also list chats where they never wrote at all (outreach I started).'),
      include_groups: z.boolean().default(false),
      include_archived: z.boolean().default(false),
      exclude_tags: z.array(z.string()).default(NO_FOLLOWUP_TAGS).describe('Chats with any of these tags are skipped.'),
      messages_per_chat: z.number().int().min(1).max(20).default(4),
      limit: limitField(30, 100),
      sort: z.enum(['priority', 'oldest', 'newest']).default('priority'),
      ...fmt,
    },
    network: false,
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    const data = computeFollowUps(core, s.name, {
      minSilenceHours: a.min_silence_hours, maxAgeDays: a.max_age_days, maxAttempts: a.max_attempts, includeNeverReplied: a.include_never_replied,
      includeGroups: a.include_groups, includeArchived: a.include_archived, excludeTags: a.exclude_tags, perChat: a.messages_per_chat, limit: a.limit, sort: a.sort,
    }, ctx.server);
    if (a.format === 'json') return data;
    return new TextResult(renderFollowUps(data, { ids: a.ids, maxChars: a.max_chars }), {
      session: data.session, summary: data.summary, sort: data.sort,
      items: data.items.map((i: any) => ({ jid: i.jid, name: i.name, stage: i.stage, attempts: i.attempts, silent_hours: i.silent_hours })),
    });
  });

  defineTool(env, 'inbox_dismiss', {
    title: 'Mark a chat as "no reply needed"',
    description: 'Hide a chat from the unanswered list until the other person writes again (stored locally; nothing is sent). undo=true brings it back.',
    toolset: 'read',
    effect: 'local',
    idempotent: true,
    network: false,
    input: { session: sessionField, chat: chatField, undo: z.boolean().default(false) },
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    const jid = ctx.chat(s.name, a.chat);
    if (a.undo) {
      core.repo.deleteMemory(s.name, jid, DISMISS_KEY);
      return { chat: jid, dismissed: false };
    }
    const last = core.repo.listMessages(s.name, { chat: jid, fromMe: false, limit: 1 })[0];
    core.repo.setMemory(s.name, jid, DISMISS_KEY, String(last?.ts ?? Math.floor(Date.now() / 1000)));
    return { chat: jid, dismissed: true, reappears_when: 'they send a new message' };
  });

  defineTool(env, 'unread_summary', {
    title: 'Unread messages overview',
    description: 'Chats with unread messages and their latest unread messages (for unread + unanswered together use `inbox`).',
    toolset: 'read',
    input: { session: sessionField, max_chats: z.number().int().min(1).max(50).default(15), per_chat: z.number().int().min(1).max(10).default(3), include_muted: z.boolean().default(false), include_groups: z.boolean().default(true), ...fmt },
    network: false,
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    const data = computeInbox(core, s.name, {
      filter: 'unread', minWaitMinutes: 0, maxAgeDays: 3650, includeGroups: a.include_groups, includeArchived: false, includeMuted: a.include_muted,
      includeDismissed: true, perChat: a.per_chat, limit: a.max_chats, sort: 'newest', skipSeen: false,
    }, ctx.server);
    if (a.format === 'json') return data;
    return new TextResult(renderInbox(data, { ids: a.ids, maxChars: a.max_chars }), { session: data.session, summary: data.summary });
  });

  defineTool(env, 'load_older_history', {
    title: 'Fetch older messages from the phone',
    description: 'Ask the phone for messages older than the oldest one stored for this chat (on-demand history sync, up to 50 per request). Results arrive asynchronously; this waits briefly and reports how many were added. The phone must be online.',
    toolset: 'read',
    effect: 'local',
    network: true,
    input: { session: sessionField, chat: chatField, count: z.number().int().min(1).max(50).default(50), wait_seconds: z.number().int().min(1).max(60).default(15) },
  }, async (a, ctx) => {
    const s = await ctx.open(a.session);
    const jid = ctx.chat(s.name, a.chat);
    const oldest = core.repo.oldestMessage(s.name, jid);
    if (!oldest) throw new Error('No stored message to anchor the request. Wait for the initial history sync or receive a message first.');
    const before = core.repo.countMessages(s.name, jid);
    await s.socket().fetchMessageHistory(a.count, { remoteJid: jid, id: oldest.id, fromMe: !!oldest.from_me }, oldest.ts as any);
    const deadline = Date.now() + a.wait_seconds * 1000;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (core.repo.countMessages(s.name, jid) > before) { await sleep(1500); break; }
    }
    const after = core.repo.countMessages(s.name, jid);
    return { chat: jid, added: after - before, total_stored: after, note: after === before ? 'Nothing arrived yet; it may still come in. Call get_messages again in a few seconds.' : undefined };
  });

  defineTool(env, 'download_media', {
    title: 'Download media of a message',
    description: 'Download (and cache on disk) the image/video/audio/document/sticker of a message. Images are returned inline so you can look at them; everything else comes back as a resource link plus the local file path.',
    toolset: 'read',
    effect: 'local',
    idempotent: true,
    network: true,
    input: { session: sessionField, chat: chatField, message_id: z.string(), inline: z.boolean().default(true).describe('Embed images/audio (≤ 2 MB) in the response.') },
  }, async (a, ctx) => {
    const s = await ctx.open(a.session);
    const chat = ctx.chat(s.name, a.chat);
    const r = await downloadStoredMedia(s, core, chat, a.message_id);
    const row = core.repo.getMessage(s.name, chat, a.message_id)!;
    const data = { chat, message_id: a.message_id, path: r.path, mime: r.mime, size: r.size, name: row.media_name ?? undefined, uri: uris.media(s.name, chat, a.message_id) };
    const content: ContentBlock[] = [];
    if (a.inline && r.size <= 2 * 1024 * 1024 && r.mime) {
      const b64 = (await fsp.readFile(r.path)).toString('base64');
      if (r.mime.startsWith('image/') && r.mime !== 'image/webp') content.push({ type: 'image', data: b64, mimeType: r.mime.split(';')[0]! });
      else if (r.mime.startsWith('image/')) content.push({ type: 'image', data: b64, mimeType: 'image/webp' });
      else if (r.mime.startsWith('audio/')) content.push({ type: 'audio', data: b64, mimeType: r.mime.split(';')[0]! });
    }
    content.push({ type: 'resource_link', uri: data.uri, name: row.media_name ?? `${row.type}-${a.message_id}`, mimeType: r.mime ?? undefined, description: `${row.type} from ${ctx.presenter(s.name).name(chat) ?? chat}` });
    return new Rich(data, content);
  });

  defineTool(env, 'get_events', {
    title: 'Get / wait for new events',
    description:
      'Durable event feed (survives restarts). Types: message.in, message.out, message.update, reaction, poll.vote, group, call, connection, pairing, history. ' +
      'Pass since_id from the previous call (last_event_id) to continue; omit it to start from "now". With wait_seconds it long-polls until something arrives — use it to react to incoming messages.',
    toolset: 'read',
    input: {
      session: sessionField,
      since_id: z.number().int().min(0).optional().describe('Return events with id greater than this. Omit = only new events from now on.'),
      types: z.array(z.string()).default(['message.in']),
      chat: z.string().optional(),
      wait_seconds: z.number().int().min(0).max(120).default(0),
      limit: limitField(50, 200),
    },
    network: false,
  }, async (a, ctx) => {
    const session = a.session ? ctx.session(a.session).name : undefined;
    const since = a.since_id ?? core.repo.lastEventId();
    const chat = a.chat && session ? ctx.chat(session, a.chat) : undefined;
    const events = await core.waitForEvents({ sinceId: since, session, types: a.types, chat, timeoutMs: a.wait_seconds * 1000, limit: a.limit, signal: ctx.extra?.signal });
    const p = session ? ctx.presenter(session) : undefined;
    for (const e of events) {
      if (e.type === 'message.in' && e.chat) {
        const row = core.repo.getMessage(e.session, e.chat, String(e.ref ?? e.payload?.id));
        if (row) markSeen(ctx.server, e.session, e.chat, [row]);
      }
    }
    return {
      last_event_id: events.length ? events[events.length - 1]!.id : since,
      count: events.length,
      events: events.map((e) => ({
        id: e.id, session: e.session, type: e.type, time: iso(e.ts), chat: e.chat ?? undefined,
        chat_name: p && e.chat ? (p.name(e.chat) ?? undefined) : undefined, ...e.payload,
      })),
    };
  });

  defineTool(env, 'get_poll_results', {
    title: 'Poll results',
    description: 'Current tally of a poll: votes per option and who voted for what.',
    toolset: 'read',
    input: { session: sessionField, chat: chatField, poll_id: z.string(), show_voters: z.boolean().default(true) },
    network: false,
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    const chat = ctx.chat(s.name, a.chat);
    const poll = core.repo.getMessage(s.name, chat, a.poll_id);
    if (!poll || poll.type !== 'poll') throw new Error('Poll message not found.');
    const extra = JSON.parse(poll.extra ?? '{}') as { options?: string[]; selectable?: number };
    const votes = core.repo.pollVotes(s.name, chat, a.poll_id);
    const p = ctx.presenter(s.name);
    const tally = (extra.options ?? []).map((option) => {
      const voters = votes.filter((v) => v.options.includes(option));
      return { option, votes: voters.length, voters: a.show_voters ? voters.map((v) => p.name(v.voter) ?? v.voter) : undefined };
    });
    return { question: poll.text, selectable: extra.selectable, total_voters: votes.filter((v) => v.options.length).length, results: tally };
  });
}
