import '../boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db/database.js';
import { Repo, ftsQuery } from '../db/repo.js';
import { toJid, normalizePhone, kindOf } from '../wa/jid.js';
import { normalizeMessage, parseRaw } from '../wa/message-utils.js';
import { assertReadablePath, sniffMime, extFromMime } from '../wa/media.js';
import { loadConfig } from '../config.js';
import { parseTime } from '../mcp/tools/read.js';

test('jid helpers', () => {
  assert.equal(toJid('+54 9 11 1234-5678'), '5491112345678@s.whatsapp.net');
  assert.equal(toJid('123456@g.us'), '123456@g.us');
  assert.equal(toJid('5491112345678:12@s.whatsapp.net'), '5491112345678@s.whatsapp.net');
  assert.throws(() => toJid('Juan'));
  assert.equal(normalizePhone('+1 (555) 010-9999'), '15550109999');
  assert.throws(() => normalizePhone('12'));
  assert.equal(kindOf('1@g.us'), 'group');
  assert.equal(kindOf('1@newsletter'), 'newsletter');
});

test('fts query is escaped', () => {
  assert.equal(ftsQuery('hola "mundo" *'), '"hola"* "mundo"*');
  assert.throws(() => ftsQuery('   '));
});

test('parseTime', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(parseTime('2h')! - (now - 7200)) <= 2);
  assert.equal(parseTime('2026-01-01T00:00:00Z'), 1767225600);
  assert.throws(() => parseTime('banana'));
});

test('mime helpers', () => {
  assert.equal(extFromMime('image/jpeg'), 'jpg');
  assert.equal(extFromMime('audio/ogg; codecs=opus'), 'ogg');
  assert.equal(sniffMime(Buffer.from('%PDF-1.7 xxxxxxxxx')), 'application/pdf');
});

test('normalizeMessage: text, quote, media, reaction skip', () => {
  const ctx = { canon: (j: string) => j, meJid: '1@s.whatsapp.net' };
  const text = normalizeMessage({
    key: { remoteJid: '5@s.whatsapp.net', id: 'A1', fromMe: false },
    messageTimestamp: 1700000000, pushName: 'Ana',
    message: { extendedTextMessage: { text: 'hola', contextInfo: { stanzaId: 'Q1', participant: '1@s.whatsapp.net', quotedMessage: { conversation: 'original' }, mentionedJid: ['9@s.whatsapp.net'] } } },
  } as any, ctx)!;
  assert.equal(text.type, 'text');
  assert.equal(text.text, 'hola');
  assert.equal(text.quoted_id, 'Q1');
  assert.equal(text.quoted_text, 'original');
  assert.deepEqual(text.mentions, ['9@s.whatsapp.net']);
  assert.equal(text.sender_jid, '5@s.whatsapp.net');

  const img = normalizeMessage({
    key: { remoteJid: '12@g.us', id: 'I1', fromMe: false, participant: '5@s.whatsapp.net' }, messageTimestamp: 1700000001,
    message: { imageMessage: { mimetype: 'image/jpeg', caption: 'foto', fileLength: 1234, jpegThumbnail: Buffer.from('x') } },
  } as any, ctx)!;
  assert.equal(img.type, 'image');
  assert.equal(img.caption, 'foto');
  assert.equal(img.sender_jid, '5@s.whatsapp.net');
  assert.ok(img.has_media && img.media_size === 1234);
  assert.ok(!img.raw!.includes('jpegThumbnail'));
  assert.ok(parseRaw(img.raw!)?.imageMessage);

  assert.equal(normalizeMessage({ key: { remoteJid: '5@s.whatsapp.net', id: 'R1' }, message: { reactionMessage: { text: '👍' } } } as any, ctx), null);
});

test('repo: lid -> pn merge, upsert, fts search, cursor ordering', () => {
  const repo = new Repo(new Db(':memory:'));
  repo.ensureSession('s');
  const base = { from_me: false, sender_name: null, type: 'text', caption: null, quoted_id: null, quoted_sender: null, quoted_text: null, quoted_type: null, mentions: [], forwarded: false, status: null, ephemeral_expiration: null, media_mime: null, media_name: null, media_size: null, media_seconds: null, extra: null, raw: null, has_media: false } as any;
  repo.upsertMessage('s', { ...base, chat_jid: '99@lid', id: 'm1', sender_jid: '99@lid', ts: 100, text: 'Reunión mañana' });
  repo.touchChat('s', '99@lid', { ts: 100, id: 'm1', preview: 'x', fromMe: false }, 1);
  repo.mapJid('s', '99@lid', '5491100@s.whatsapp.net');
  assert.equal(repo.canon('s', '99@lid'), '5491100@s.whatsapp.net');
  assert.ok(repo.getMessage('s', '5491100@s.whatsapp.net', 'm1'));
  assert.equal(repo.getChat('s', '5491100@s.whatsapp.net')?.unread_count, 1);
  assert.equal(repo.getChat('s', '99@lid'), undefined);
  repo.upsertMessage('s', { ...base, chat_jid: '5491100@s.whatsapp.net', id: 'm2', sender_jid: '5491100@s.whatsapp.net', ts: 101, text: 'ok nos vemos' });
  const hit = repo.searchMessages('s', 'reunion', { limit: 5 });
  assert.equal(hit.length, 1, 'accent-insensitive prefix search');
  const page = repo.listMessages('s', { chat: '5491100@s.whatsapp.net', limit: 1 });
  assert.equal(page[0]!.id, 'm2');
  const older = repo.listMessages('s', { chat: '5491100@s.whatsapp.net', limit: 5, before: [page[0]!.ts, page[0]!._rid] });
  assert.deepEqual(older.map((m) => m.id), ['m1']);
  repo.patchMessage('s', '5491100@s.whatsapp.net', 'm1', { text: 'cambiado', edited: true });
  assert.equal(repo.searchMessages('s', 'reunion', { limit: 5 }).length, 0, 'fts updated by trigger');
  assert.equal(repo.searchMessages('s', 'cambiado', { limit: 5 }).length, 1);
});

test('assertReadablePath blocks secrets and the data dir', async () => {
  const cfg = loadConfig();
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-t-'));
  const ok = path.join(dir, 'a.txt');
  const env = path.join(dir, '.env');
  fs.writeFileSync(ok, 'x');
  fs.writeFileSync(env, 'SECRET=1');
  assert.ok(assertReadablePath(ok, cfg));
  assert.throws(() => assertReadablePath(env, cfg), /credential-like/);
  assert.throws(() => assertReadablePath(path.join(cfg.dataDir, 'whatsapp.db'), cfg));
});

test('quotes are resolved: author (me / name), time, full text from the local store', async () => {
  const { Presenter } = await import('../mcp/present.js');
  const repo = new Repo(new Db(':memory:'));
  repo.ensureSession('s');
  repo.updateSession('s', { jid: '1@s.whatsapp.net', lid: '1@lid' });
  repo.upsertContact('s', '5@s.whatsapp.net', { name: 'Ana' });
  const base: any = { sender_name: null, type: 'text', caption: null, quoted_id: null, quoted_sender: null, quoted_text: null, quoted_type: null, mentions: [], forwarded: false, status: null, ephemeral_expiration: null, media_mime: null, media_name: null, media_size: null, media_seconds: null, extra: null, raw: null, has_media: false };
  const long = 'x'.repeat(520);
  repo.upsertMessage('s', { ...base, chat_jid: '5@s.whatsapp.net', id: 'O1', from_me: false, sender_jid: '5@s.whatsapp.net', ts: 1000, text: long });
  repo.upsertMessage('s', { ...base, chat_jid: '5@s.whatsapp.net', id: 'O2', from_me: true, sender_jid: '1@s.whatsapp.net', ts: 1001, text: 'mi mensaje' });
  repo.upsertMessage('s', { ...base, chat_jid: '5@s.whatsapp.net', id: 'R1', from_me: true, sender_jid: '1@s.whatsapp.net', ts: 1010, text: 'respuesta', quoted_id: 'O1', quoted_sender: '5@s.whatsapp.net', quoted_text: 'x'.repeat(10) });
  repo.upsertMessage('s', { ...base, chat_jid: '5@s.whatsapp.net', id: 'R2', from_me: false, sender_jid: '5@s.whatsapp.net', ts: 1011, text: 'ok', quoted_id: 'O2', quoted_sender: '1@lid', quoted_text: 'mi mensaje' });
  repo.upsertMessage('s', { ...base, chat_jid: '5@s.whatsapp.net', id: 'R3', from_me: false, sender_jid: '5@s.whatsapp.net', ts: 1012, text: 'y eso?', quoted_id: 'GONE', quoted_sender: null, quoted_text: null });
  const p = new Presenter({ repo } as any, 's');
  const [r1, r2, r3] = ['R1', 'R2', 'R3'].map((id) => p.message(repo.getMessage('s', '5@s.whatsapp.net', id)!) as any);
  assert.equal(r1.quoted.from, 'Ana');
  assert.equal(r1.quoted.text.length, 520, 'full original text, not the 10-char preview');
  assert.ok(r1.quoted.time);
  assert.equal(r2.quoted.from, 'me', 'quote of my own message (lid form) is labelled me');
  assert.equal(r3.quoted.unavailable, true);
  assert.equal(r3.quoted.not_in_local_store, true);
});
