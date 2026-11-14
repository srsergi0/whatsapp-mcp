import fsp from 'node:fs/promises';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { iso } from '../util.js';
import type { Core } from '../core.js';
import { downloadStoredMedia } from '../wa/ingest.js';
import { markSeen } from './freshness.js';
import { computeInbox } from './inbox.js';
import { Presenter, compact } from './present.js';
import { uris } from './uris.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const dec = (v: string | string[] | undefined) => decodeURIComponent(Array.isArray(v) ? v[0]! : (v ?? ''));
const json = (uri: string, data: unknown) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 1) }] });

export function transcript(core: Core, session: string, jid: string, limit = 50, owner?: object): string {
  const p = new Presenter(core, session);
  const rows = core.repo.listMessages(session, { chat: jid, limit }).reverse();
  if (!rows.length) return '(no stored messages)';
  if (owner) markSeen(owner, session, jid, rows);
  let day = '';
  const lines: string[] = [`# ${p.name(jid) ?? jid}  (${jid})`];
  // logged interactions (calls, meetings, to-dos) are interleaved chronologically with the messages
  const notes = core.repo.listInteractions(session, { jid, since: rows[0]!.ts, limit: 50 }).reverse();
  const entries: { ts: number; time: string; render: () => string }[] = [];
  for (const m of p.messages(rows) as any[]) {
    entries.push({
      ts: m.ts, time: m.time,
      render: () => {
        const who = m.from_me ? 'me' : (m.sender_name ?? m.sender ?? '?');
        const body = m.text ?? m.caption ?? '';
        const media = m.media ? ` [${m.type}${m.media.name ? ' ' + m.media.name : ''}]` : m.type !== 'text' && !body ? ` [${m.type}]` : '';
        const qt = m.quoted ? (m.quoted.text ?? (m.quoted.unavailable ? '(original unavailable)' : '')) : '';
        const qwhen = m.quoted?.time ? ` [${String(m.quoted.time).slice(5, 16).replace('T', ' ')}]` : '';
        const quote = m.quoted ? `\n      ↪ in reply to ${m.quoted.from ?? 'someone'}${qwhen}: "${String(qt).slice(0, 160)}"` : '';
        return `[${m.time.slice(11, 16)}] ${who}: ${body}${media}${m.deleted ? ' (deleted)' : ''}  <id:${m.id}>${quote}`;
      },
    });
  }
  for (const n of notes) {
    const time = iso(n.ts)!;
    entries.push({ ts: n.ts, time, render: () => `[${time.slice(11, 16)}] ★ ${n.kind.toUpperCase()} (logged by me${n.handled ? ', resolved pending' : ''}${n.status === 'open' ? ', OPEN' : ''}): ${n.note}` });
  }
  entries.sort((a, b) => a.ts - b.ts);
  for (const e of entries) {
    const d = e.time.slice(0, 10);
    if (d !== day) { day = d; lines.push(`\n## ${d}`); }
    lines.push(e.render());
  }
  return lines.join('\n');
}

export function registerResources(server: McpServer, core: Core) {
  const sessionNames = () => [...core.sessions.keys()];
  const sessionComplete = { session: async (v: string) => sessionNames().filter((n) => n.startsWith(v)) };

  server.registerResource(
    'sessions', uris.sessions(),
    { title: 'WhatsApp sessions', description: 'All linked accounts and their connection state.', mimeType: 'application/json' },
    async (uri) => json(uri.href, { sessions: [...core.sessions.values()].map((s) => s.info()) }),
  );

  server.registerResource(
    'session-status',
    new ResourceTemplate('whatsapp://{session}/status', {
      list: async () => ({ resources: sessionNames().map((s) => ({ uri: uris.status(s), name: `status:${s}`, mimeType: 'application/json' })) }),
      complete: sessionComplete,
    }),
    { title: 'Session status', description: 'Connection, pairing and sync state of one session.', mimeType: 'application/json' },
    async (uri, v) => { const s = core.resolve(dec(v.session)); return json(uri.href, { ...s.info(), stats: core.repo.stats(s.name) }); },
  );

  server.registerResource(
    'unread',
    new ResourceTemplate('whatsapp://{session}/unread', {
      list: async () => ({ resources: sessionNames().map((s) => ({ uri: uris.unread(s), name: `unread:${s}`, mimeType: 'application/json' })) }),
      complete: sessionComplete,
    }),
    { title: 'Unread overview', description: 'Chats with unread messages (subscribe to be notified of changes).', mimeType: 'application/json' },
    async (uri, v) => {
      const s = core.resolve(dec(v.session));
      const p = new Presenter(core, s.name);
      const { rows } = core.repo.listChats(s.name, { unreadOnly: true, archived: false, limit: 30 });
      return json(uri.href, { chats: rows.map((c) => p.chat(c)) });
    },
  );

  server.registerResource(
    'inbox',
    new ResourceTemplate('whatsapp://{session}/inbox', {
      list: async () => ({ resources: sessionNames().map((s) => ({ uri: uris.inbox(s), name: `inbox:${s}`, mimeType: 'application/json' })) }),
      complete: sessionComplete,
    }),
    { title: 'Inbox (unread + awaiting my reply)', description: 'Chats that need attention, oldest-waiting first. Subscribe to be notified when it changes.', mimeType: 'application/json' },
    async (uri, v) => {
      const s = core.resolve(dec(v.session));
      return json(uri.href, computeInbox(core, s.name, {
        filter: 'any', minWaitMinutes: 0, maxAgeDays: 14, includeGroups: true, includeArchived: false, includeMuted: false, includeDismissed: false, perChat: 3, limit: 25, sort: 'oldest',
      }));
    },
  );

  server.registerResource(
    'chats',
    new ResourceTemplate('whatsapp://{session}/chats', {
      list: async () => ({ resources: sessionNames().map((s) => ({ uri: uris.chats(s), name: `chats:${s}`, mimeType: 'application/json' })) }),
      complete: sessionComplete,
    }),
    { title: 'Recent chats', description: '50 most recently active chats.', mimeType: 'application/json' },
    async (uri, v) => {
      const s = core.resolve(dec(v.session));
      const p = new Presenter(core, s.name);
      return json(uri.href, { chats: core.repo.listChats(s.name, { limit: 50 }).rows.map((c) => p.chat(c)) });
    },
  );

  server.registerResource(
    'chat-messages',
    new ResourceTemplate('whatsapp://{session}/chat/{jid}/messages', {
      list: async () => ({
        resources: sessionNames().flatMap((s) => {
          const p = new Presenter(core, s);
          return core.repo.listChats(s, { limit: 15 }).rows.map((c) => ({
            uri: uris.messages(s, c.jid), name: `${p.name(c.jid) ?? c.jid}`, description: c.last_message_preview ?? undefined, mimeType: 'text/markdown',
          }));
        }),
      }),
      complete: {
        ...sessionComplete,
        jid: async (v: string, ctx?: any) => {
          const s = ctx?.arguments?.session ? dec(ctx.arguments.session) : sessionNames()[0];
          if (!s) return [];
          return core.repo.listChats(s, { query: v || undefined, limit: 20 }).rows.map((c) => c.jid);
        },
      },
    }),
    { title: 'Chat transcript', description: 'Last 50 messages of a chat as a readable transcript. Subscribe to get notified on new messages.', mimeType: 'text/markdown' },
    async (uri, v) => {
      const s = core.resolve(dec(v.session));
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: transcript(core, s.name, dec(v.jid), 50, server) }] };
    },
  );

  server.registerResource(
    'chat',
    new ResourceTemplate('whatsapp://{session}/chat/{jid}', { list: undefined, complete: sessionComplete }),
    { title: 'Chat info', description: 'Chat metadata with tags, labels and unread count.', mimeType: 'application/json' },
    async (uri, v) => {
      const s = core.resolve(dec(v.session));
      const jid = dec(v.jid);
      const row = core.repo.getChat(s.name, jid);
      if (!row) throw new Error(`Unknown chat ${jid}`);
      return json(uri.href, new Presenter(core, s.name).chat(row));
    },
  );

  server.registerResource(
    'contact',
    new ResourceTemplate('whatsapp://{session}/contact/{jid}', { list: undefined, complete: sessionComplete }),
    { title: 'Contact', description: 'Stored contact record.', mimeType: 'application/json' },
    async (uri, v) => {
      const s = core.resolve(dec(v.session));
      const c = core.repo.getContact(s.name, dec(v.jid));
      if (!c) throw new Error('Unknown contact');
      return json(uri.href, compact({ ...c, updated_at: iso(c.updated_at) }));
    },
  );

  server.registerResource(
    'group',
    new ResourceTemplate('whatsapp://{session}/group/{jid}', { list: undefined, complete: sessionComplete }),
    { title: 'Group', description: 'Stored group metadata with members.', mimeType: 'application/json' },
    async (uri, v) => {
      const s = core.resolve(dec(v.session));
      const g = core.repo.getGroup(s.name, dec(v.jid));
      if (!g) throw new Error('Unknown group');
      return json(uri.href, { ...g, participants: g.participants ? JSON.parse(g.participants) : [] });
    },
  );

  server.registerResource(
    'memory',
    new ResourceTemplate('whatsapp://{session}/memory/{jid}', { list: undefined, complete: sessionComplete }),
    { title: 'Notes about a chat', description: 'Persistent notes saved with chat_memory.', mimeType: 'application/json' },
    async (uri, v) => {
      const s = core.resolve(dec(v.session));
      const jid = dec(v.jid);
      return json(uri.href, { chat: jid, notes: Object.fromEntries(core.repo.getMemory(s.name, jid).map((m) => [m.key, m.value])), tags: core.repo.tagsOf(s.name, jid) });
    },
  );

  server.registerResource(
    'media',
    new ResourceTemplate('whatsapp://{session}/media/{jid}/{id}', { list: undefined, complete: sessionComplete }),
    { title: 'Message media', description: 'The file attached to a message (downloaded on demand).', mimeType: 'application/octet-stream' },
    async (uri, v) => {
      const s = core.resolve(dec(v.session));
      const r = await downloadStoredMedia(s, core, dec(v.jid), dec(v.id));
      const buf = await fsp.readFile(r.path);
      return { contents: [{ uri: uri.href, mimeType: r.mime?.split(';')[0] ?? 'application/octet-stream', blob: buf.toString('base64') }] };
    },
  );
}
