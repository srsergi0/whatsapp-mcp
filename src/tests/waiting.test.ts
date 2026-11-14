import '../boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import { Db } from '../db/database.js';
import { Repo } from '../db/repo.js';
import { loadConfig } from '../config.js';
import { Core } from '../core.js';
import { bindIngest } from '../wa/ingest.js';
import { TtlCache } from '../util.js';
import { computeInbox, type InboxOpts } from '../mcp/inbox.js';
import { renderInbox } from '../mcp/compact.js';
import { Presenter } from '../mcp/present.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const now = Math.floor(Date.now() / 1000);
const H = 3600;
const opts: InboxOpts = { filter: 'any', minWaitMinutes: 0, maxAgeDays: 14, includeGroups: true, includeArchived: false, includeMuted: false, includeDismissed: false, perChat: 3, limit: 50, sort: 'oldest' };
const base: any = { sender_name: null, type: 'text', caption: null, quoted_id: null, quoted_sender: null, quoted_text: null, quoted_type: null, mentions: [], forwarded: false, status: null, ephemeral_expiration: null, media_mime: null, media_name: null, media_size: null, media_seconds: null, extra: null, raw: null, has_media: false };

function setup() {
  const repo = new Repo(new Db(':memory:'));
  repo.ensureSession('s');
  repo.updateSession('s', { jid: '1@s.whatsapp.net' });
  const events: any[] = [];
  const hub: any = { cfg: { ...loadConfig(), autoDownload: 'off' }, log: pino({ level: 'silent' }), repo, publish: (...a: any[]) => events.push(a) };
  const ev = new EventEmitter();
  const sock: any = { ev, authState: { creds: { me: { id: '1:7@s.whatsapp.net' } } }, groupMetadata: async () => ({}), rejectCall: async () => undefined };
  const session: any = { name: 's', history: {}, presence: new Map(), groupCache: new TtlCache(1000) };
  bindIngest(session, sock, hub);
  return { repo, ev, events, core: { repo } as any };
}

const incoming = (chat: string, ts: number, text: string, id = `in${ts}`) => ({
  key: { remoteJid: chat, id, fromMe: false }, messageTimestamp: ts, pushName: 'Ana', message: { conversation: text },
});

test('waiting entry closes itself when they answer, publishes an event, and only then', () => {
  const { repo, ev, events } = setup();
  const CHAT = '5@s.whatsapp.net';
  const id = repo.addInteraction('s', { jid: CHAT, ts: now - 2 * H, kind: 'waiting', note: 'Waiting for their reply to: propuesta', handled: false, dueAt: now + 24 * H, status: 'open' });
  // an OLD message (before the entry) must not close it, e.g. delivered late through history sync
  ev.emit('messages.upsert', { type: 'append', messages: [incoming(CHAT, now - 3 * H, 'mensaje anterior')] });
  assert.equal(repo.getInteraction(id)!.status, 'open');
  // my own message does not close it either
  ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: CHAT, id: 'out1', fromMe: true }, messageTimestamp: now - H, message: { conversation: 'ping' } }] });
  assert.equal(repo.getInteraction(id)!.status, 'open');
  // their reply closes it
  ev.emit('messages.upsert', { type: 'notify', messages: [incoming(CHAT, now - 60, 'Acepto la propuesta', 'ans1')] });
  const row = repo.getInteraction(id)!;
  assert.equal(row.status, 'done');
  assert.equal(row.resolved_by, 'ans1');
  assert.equal(row.resolved_at, now - 60);
  const e = events.find((x) => x[1] === 'waiting.replied');
  assert.ok(e, 'event published');
  assert.equal(e[2], CHAT);
  assert.equal(e[4].preview, 'Acepto la propuesta');
  assert.equal(e[4].waiting[0].id, id);
  // a second incoming message does not re-fire
  ev.emit('messages.upsert', { type: 'notify', messages: [incoming(CHAT, now - 30, 'gracias', 'ans2')] });
  assert.equal(events.filter((x) => x[1] === 'waiting.replied').length, 1);
});

test('inbox: "I wait for their reply" section, overdue flag, separate from my to-dos', () => {
  const { repo, core } = setup();
  const A = 'a@s.whatsapp.net', B = 'b@s.whatsapp.net', C = 'c@s.whatsapp.net';
  repo.addInteraction('s', { jid: A, ts: now - 50 * H, kind: 'waiting', note: 'Waiting for their reply to: cotización', handled: false, dueAt: now - 2 * H, status: 'open' });
  repo.addInteraction('s', { jid: B, ts: now - 1 * H, kind: 'waiting', note: 'Waiting for their reply to: horario', handled: false, dueAt: now + 40 * H, status: 'open' });
  repo.addInteraction('s', { jid: C, ts: now - 1 * H, kind: 'task', note: 'Enviar factura', handled: false, dueAt: now + 3 * H, status: 'open' });
  const r: any = computeInbox(core, 's', opts);
  assert.equal(r.summary.waiting_on_them, 2);
  assert.equal(r.summary.waiting_overdue, 1);
  assert.equal(r.summary.open_tasks, 1, 'waiting entries are not my to-dos');
  assert.deepEqual(r.waiting_on_them.map((w: any) => w.chat), [A, B], 'overdue first');
  assert.equal(r.waiting_on_them[0].overdue, true);
  assert.equal(r.waiting_on_them[0].status, 'waiting for their reply');
  assert.deepEqual(r.tasks_due_soon.map((t: any) => t.chat), [C], 'tasks list has no waiting entries');
  const text = renderInbox(r, { ids: true, maxChars: 600 });
  assert.match(text, /I wait on 2 \(1 overdue\)/);
  assert.match(text, /I WAIT FOR THEIR REPLY\n- a@s\.whatsapp\.net: Waiting for their reply to: cotización · waiting 2d 2h .*OVERDUE/);
  assert.ok(!/Waiting for their reply to: horario.*OVERDUE/.test(text));
});

test('presenter: replied vs manual completion; reopen clears the resolution', () => {
  const { repo, core } = setup();
  const CHAT = 'a@s.whatsapp.net';
  const id = repo.addInteraction('s', { jid: CHAT, ts: now - H, kind: 'waiting', note: 'x', handled: false, dueAt: now + H, status: 'open' });
  const p = new Presenter(core, 's');
  assert.equal((p.interaction(repo.getInteraction(id)!) as any).status, 'waiting for their reply');
  repo.resolveWaiting('s', CHAT, now, 'MSG1');
  const done = p.interaction(repo.getInteraction(id)!) as any;
  assert.equal(done.status, 'replied');
  assert.equal(done.reply_id, 'MSG1');
  assert.ok(done.replied);
  repo.updateInteraction(id, { status: 'open', resolved_at: null, resolved_by: null });
  assert.equal(repo.getInteraction(id)!.resolved_at, null);
  assert.equal(repo.openWaiting('s', { limit: 5 }).length, 1);
});

test('core: overdue notification fires once per entry (and survives a restart via kv)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-wait-'));
  const cfg = { ...loadConfig(), dataDir: dir, dbPath: path.join(dir, 'x.db'), mediaDir: path.join(dir, 'media'), logDir: path.join(dir, 'logs') };
  const core = new Core(cfg, pino({ level: 'silent' }));
  try {
    core.repo.ensureSession('s');
    (core.sessions as any).set('s', { name: 's', stop: async () => undefined });
    const seen: any[] = [];
    core.on('event', (e) => seen.push(e));
    const late = core.repo.addInteraction('s', { jid: 'a@s.whatsapp.net', ts: now - 60 * H, kind: 'waiting', note: 'late one', handled: false, dueAt: now - H, status: 'open' });
    core.repo.addInteraction('s', { jid: 'b@s.whatsapp.net', ts: now - H, kind: 'waiting', note: 'not yet', handled: false, dueAt: now + 5 * H, status: 'open' });
    core.checkWaiting();
    core.checkWaiting();
    const overdue = seen.filter((e) => e.type === 'waiting.overdue');
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0].payload.waiting_id, late);
    assert.equal(overdue[0].chat, 'a@s.whatsapp.net');
    assert.ok(core.repo.kvGet(`waiting_overdue:${late}`));
  } finally {
    void core.shutdown();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
