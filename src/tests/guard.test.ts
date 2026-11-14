import '../boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { Db } from '../db/database.js';
import { Repo } from '../db/repo.js';
import { loadConfig } from '../config.js';
import { Core } from '../core.js';
import { assertFresh, markSeen, StaleChatError } from '../mcp/freshness.js';
import { sendText } from '../wa/send.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const base: any = { sender_name: null, type: 'text', caption: null, quoted_id: null, quoted_sender: null, quoted_text: null, quoted_type: null, mentions: [], forwarded: false, status: null, ephemeral_expiration: null, media_mime: null, media_name: null, media_size: null, media_seconds: null, extra: null, raw: null, has_media: false };
const CHAT = '5@s.whatsapp.net';

function setup(guard = true) {
  const repo = new Repo(new Db(':memory:'));
  repo.ensureSession('s');
  repo.updateSession('s', { jid: '1@s.whatsapp.net' });
  const core: any = { repo, cfg: { ...loadConfig(), freshnessGuard: guard } };
  let n = 0;
  const msg = (chat: string, ts: number, from_me: boolean, text: string) =>
    repo.upsertMessage('s', { ...base, chat_jid: chat, id: `m${++n}`, from_me, sender_jid: from_me ? '1@s.whatsapp.net' : chat, ts, text });
  return { repo, core, msg, owner: {} };
}

test('no pending incoming: send allowed; a new message while thinking blocks it, retry passes', () => {
  const { core, msg, owner } = setup();
  msg(CHAT, 100, false, 'hola');
  msg(CHAT, 110, true, 'te respondo');
  assert.doesNotThrow(() => assertFresh(core, owner, 's', CHAT));
  msg(CHAT, 120, false, 'ah, y otra cosa: cambié de idea');
  assert.throws(
    () => assertFresh(core, owner, 's', CHAT),
    (e: Error) => e instanceof StaleChatError && /NOT SENT/.test(e.message) && /\[\d\d:\d\d\] [^\n]*: ah, y otra cosa: cambié de idea #/.test(e.message) && !e.message.includes('"new_messages"'),
  );
  assert.doesNotThrow(() => assertFresh(core, owner, 's', CHAT), 'new messages were shown, so the retry goes through');
});

test('unread pending messages the agent never read block a blind reply', () => {
  const { core, msg, owner } = setup();
  msg(CHAT, 100, true, 'hola, ¿cómo vas?');
  msg(CHAT, 120, false, 'mal, necesito ayuda');
  assert.throws(() => assertFresh(core, owner, 's', CHAT), /necesito ayuda/);
  assert.doesNotThrow(() => assertFresh(core, owner, 's', CHAT));
});

test('reading the chat sets the mark; only later messages count; marks are per client', () => {
  const { repo, core, msg, owner } = setup();
  msg(CHAT, 100, true, 'hola');
  msg(CHAT, 120, false, 'respuesta 1');
  markSeen(owner, 's', CHAT, repo.listMessages('s', { chat: CHAT, limit: 10 }));
  assert.doesNotThrow(() => assertFresh(core, owner, 's', CHAT), 'read it, nothing newer');
  msg(CHAT, 130, false, 'respuesta 2');
  assert.throws(() => assertFresh(core, owner, 's', CHAT), (e: Error) => /respuesta 2/.test(e.message) && !/respuesta 1/.test(e.message));
  const other = {};
  assert.throws(() => assertFresh(core, other, 's', CHAT), /respuesta 2/, 'another client never read the chat');
});

test('groups are only enforced after being read; handled-by-call counts as dealt with', () => {
  const { repo, core, msg, owner } = setup();
  const G = 'g@g.us';
  msg(G, 100, false, 'ruido');
  assert.doesNotThrow(() => assertFresh(core, owner, 's', G));
  markSeen(owner, 's', G, repo.listMessages('s', { chat: G, limit: 5 }));
  msg(G, 110, false, 'algo nuevo');
  assert.throws(() => assertFresh(core, owner, 's', G), /algo nuevo/);
  msg(CHAT, 100, false, 'llámame');
  repo.addInteraction('s', { jid: CHAT, ts: 105, kind: 'call', note: 'llamé', handled: true, status: 'done' });
  assert.doesNotThrow(() => assertFresh(core, {}, 's', CHAT), 'their message predates my call');
});

test('guard can be disabled and ignores newsletters', () => {
  const { core, msg, owner } = setup(false);
  msg(CHAT, 100, false, 'nuevo');
  assert.doesNotThrow(() => assertFresh(core, owner, 's', CHAT));
});

test('last-moment check: a message arriving during the anti-ban delay aborts the send', async () => {
  const { core, msg, owner } = setup();
  msg(CHAT, 100, true, 'hola');
  const sent: any[] = [];
  const session: any = {
    name: 's',
    typing: async () => undefined,
    // simulates Session.send: throttle delay, then the beforeSend hook, then the wire
    send: async (jid: string, content: any, _o: any, beforeSend?: () => void) => {
      msg(CHAT, 200, false, 'espera, no lo mandes');   // client writes during the delay
      await beforeSend?.();
      sent.push({ jid, content });
      return { key: { id: 'OUT', remoteJid: jid, fromMe: true }, messageTimestamp: 300 };
    },
  };
  const guard = () => assertFresh(core, owner, 's', CHAT);
  await assert.rejects(sendText(core, session, CHAT, { text: 'mensaje viejo', beforeSend: guard }), /NOT SENT.*espera, no lo mandes/s);
  assert.equal(sent.length, 0, 'nothing went out');
  await sendText(core, session, CHAT, { text: 'mensaje actualizado', beforeSend: () => undefined });
  assert.equal(sent.length, 1);
});

test('scheduled messages are held when the chat moved after scheduling', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sched-'));
  const cfg = { ...loadConfig(), dataDir: dir, dbPath: path.join(dir, 'x.db'), mediaDir: path.join(dir, 'media'), logDir: path.join(dir, 'logs') };
  const core = new Core(cfg, pino({ level: 'silent' }));
  try {
    core.repo.ensureSession('s');
    const sent: string[] = [];
    (core.sessions as any).set('s', { name: 's', isOpen: true, stop: async () => undefined, typing: async () => undefined, send: async (jid: string, c: any) => { sent.push(c.text); return { key: { id: 'X' + sent.length, remoteJid: jid }, messageTimestamp: 1 }; } });
    const past = Math.floor(Date.now() / 1000) - 600;
    const quiet = core.repo.schedule('s', '7@s.whatsapp.net', 'text', { text: 'recordatorio A' }, past + 500);
    const moved = core.repo.schedule('s', CHAT, 'text', { text: 'recordatorio B' }, past + 500);
    core.db.run('UPDATE scheduled_messages SET created_at = ?', past);
    core.repo.upsertMessage('s', { ...base, chat_jid: CHAT, id: 'in1', from_me: false, sender_jid: CHAT, ts: past + 100, text: 'cambio de planes' });
    await core.runScheduler();
    assert.equal(core.repo.getScheduled(quiet)!.status, 'sent');
    const held = core.repo.getScheduled(moved)!;
    assert.equal(held.status, 'held');
    assert.deepEqual(sent, ['recordatorio A']);
    // release sends it anyway
    core.repo.updateScheduled(moved, { status: 'pending', send_at: past, payload: JSON.stringify({ text: 'recordatorio B', ignore_new_messages: true }) });
    await core.runScheduler();
    assert.equal(core.repo.getScheduled(moved)!.status, 'sent');
  } finally {
    await core.shutdown();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
