import '../boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { Db } from '../db/database.js';
import { Repo } from '../db/repo.js';
import { loadConfig } from '../config.js';
import { normalizeMessage } from '../wa/message-utils.js';
import { editText, reactTo, revokeMessage, sendContacts, sendEvent, sendLocation, sendMedia, sendPoll, sendText, vcard } from '../wa/send.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function setup() {
  const repo = new Repo(new Db(':memory:'));
  repo.ensureSession('s');
  const sent: { jid: string; content: any; options: any }[] = [];
  const session: any = {
    name: 's',
    send: async (jid: string, content: any, options: any) => { sent.push({ jid, content, options }); return { key: { id: `OUT${sent.length}`, remoteJid: jid, fromMe: true }, messageTimestamp: 1700000000 }; },
    typing: async () => undefined,
  };
  const core: any = { repo, cfg: loadConfig() };
  const raw = { key: { remoteJid: '5@s.whatsapp.net', id: 'Q1', fromMe: false }, messageTimestamp: 1700000000, message: { conversation: 'pregunta' } };
  const n = normalizeMessage(raw as any, { canon: (j) => j })!;
  repo.upsertMessage('s', n);
  return { core, session, sent, repo };
}

test('sendText: quoting + mentions', async () => {
  const { core, session, sent } = setup();
  const r = await sendText(core, session, '5@s.whatsapp.net', { text: 'hola @9', quoted_id: 'Q1', mentions: ['+9 1234567'] });
  assert.equal(r.id, 'OUT1');
  assert.equal(sent[0]!.options.quoted.key.id, 'Q1');
  assert.equal(sent[0]!.options.quoted.message.conversation, 'pregunta');
  assert.deepEqual(sent[0]!.content.mentions, ['91234567@s.whatsapp.net']);
  await assert.rejects(sendText(core, session, '5@s.whatsapp.net', { text: 'x', quoted_id: 'NOPE' }), /not found/);
});

test('sendMedia: document from base64, sticker, size/type checks', async () => {
  const { core, session, sent } = setup();
  await sendMedia(core, session, '5@s.whatsapp.net', { kind: 'document', base64: Buffer.from('%PDF-1.4 hello world').toString('base64'), file_name: 'a.pdf', caption: 'ver' });
  assert.equal(sent[0]!.content.mimetype, 'application/pdf');
  assert.equal(sent[0]!.content.fileName, 'a.pdf');
  assert.equal(sent[0]!.content.caption, 'ver');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await sendMedia(core, session, '5@s.whatsapp.net', { kind: 'sticker', base64: png.toString('base64') });
  assert.ok(Buffer.isBuffer(sent[1]!.content.sticker));
  assert.equal(sent[1]!.content.sticker.subarray(8, 12).toString(), 'WEBP');
  await assert.rejects(sendMedia(core, session, '5@s.whatsapp.net', { kind: 'image' } as any), /exactly one/);
  await assert.rejects(sendMedia(core, session, '5@s.whatsapp.net', { kind: 'image', path: 'C:/definitely/missing.png' }), /not found/i);
});

test('poll / event / location / contacts payloads', async () => {
  const { core, session, sent } = setup();
  await sendPoll(core, session, '1@g.us', { question: 'Q', options: ['a', 'a'], selectable_count: 1 }).catch((e) => e);
  assert.equal(sent.length, 0, 'duplicate options collapse below 2 => rejected');
  await sendPoll(core, session, '1@g.us', { question: 'Q', options: ['a', 'b'], selectable_count: 2 });
  assert.deepEqual(sent[0]!.content.poll, { name: 'Q', values: ['a', 'b'], selectableCount: 2 });
  await sendEvent(core, session, '1@g.us', { name: 'Cena', start: '2030-01-01T20:00:00Z', location_name: 'Casa' });
  assert.ok(sent[1]!.content.event.startDate instanceof Date);
  await assert.rejects(sendEvent(core, session, '1@g.us', { name: 'x', start: 'mañana' }), /Invalid/);
  await sendLocation(core, session, '5@s.whatsapp.net', { latitude: -12.04, longitude: -77.03, name: 'Lima' });
  assert.equal(sent[2]!.content.location.degreesLatitude, -12.04);
  await sendContacts(core, session, '5@s.whatsapp.net', { contacts: [{ name: 'Juan; Pérez', phone: '+51 999 888 777' }] });
  assert.match(sent[3]!.content.contacts.contacts[0].vcard, /waid=51999888777/);
  assert.match(vcard({ name: 'A,B', phone: '123456789' }), /FN:A\\,B/);
});

test('react / edit / revoke use stored keys and guards', async () => {
  const { core, session, sent, repo } = setup();
  await reactTo(core, session, '5@s.whatsapp.net', 'Q1', '👍');
  assert.equal(sent[0]!.content.react.key.id, 'Q1');
  await assert.rejects(editText(core, session, '5@s.whatsapp.net', 'Q1', 'nuevo'), /Only your own/);
  const mine = normalizeMessage({ key: { remoteJid: '5@s.whatsapp.net', id: 'M1', fromMe: true }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'a' } } as any, { canon: (j) => j })!;
  repo.upsertMessage('s', mine);
  await editText(core, session, '5@s.whatsapp.net', 'M1', 'b');
  assert.equal(sent[1]!.content.edit.id, 'M1');
  assert.equal(repo.getMessage('s', '5@s.whatsapp.net', 'M1')?.text, 'b');
  await revokeMessage(core, session, '5@s.whatsapp.net', 'M1');
  assert.equal(sent[2]!.content.delete.fromMe, true);
  assert.equal(repo.getMessage('s', '5@s.whatsapp.net', 'M1')?.deleted, 1);
});
