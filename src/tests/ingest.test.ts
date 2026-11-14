import '../boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import pino from 'pino';
import { Db } from '../db/database.js';
import { Repo } from '../db/repo.js';
import { loadConfig } from '../config.js';
import { bindIngest } from '../wa/ingest.js';
import { TtlCache } from '../util.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function setup() {
  const repo = new Repo(new Db(':memory:'));
  repo.ensureSession('s');
  const events: any[] = [];
  const hub: any = { cfg: { ...loadConfig(), autoDownload: 'off' }, log: pino({ level: 'silent' }), repo, publish: (...a: any[]) => events.push(a) };
  const ev = new EventEmitter();
  (ev as any).removeAllListeners = ev.removeAllListeners.bind(ev);
  const sock: any = { ev, authState: { creds: { me: { id: '111:7@s.whatsapp.net', lid: '999@lid' } } }, groupMetadata: async () => ({ id: '1@g.us', subject: 'G', participants: [] }), rejectCall: async () => undefined };
  const session: any = { name: 's', history: { syncType: null, progress: null, isLatest: false, messages: 0, updatedAt: 0 }, presence: new Map(), groupCache: new TtlCache(1000) };
  const ingest = bindIngest(session, sock, hub);
  return { repo, ev, events, ingest, session };
}

const msg = (over: any) => ({ key: { remoteJid: '5@s.whatsapp.net', id: 'X', fromMe: false }, messageTimestamp: 1700000000, pushName: 'Ana', message: { conversation: 'hola' }, ...over });

test('live message: stored, unread++, event, push name -> contact', () => {
  const { repo, ev, events } = setup();
  ev.emit('messages.upsert', { type: 'notify', messages: [msg({})] });
  assert.equal(repo.getMessage('s', '5@s.whatsapp.net', 'X')?.text, 'hola');
  assert.equal(repo.getChat('s', '5@s.whatsapp.net')?.unread_count, 1);
  assert.equal(repo.getContact('s', '5@s.whatsapp.net')?.notify, 'Ana');
  assert.equal(events.filter((e) => e[1] === 'message.in').length, 1);
  // duplicate delivery must not double count
  ev.emit('messages.upsert', { type: 'notify', messages: [msg({})] });
  assert.equal(repo.getChat('s', '5@s.whatsapp.net')?.unread_count, 1);
  assert.equal(events.filter((e) => e[1] === 'message.in').length, 1);
});

test('history sync stores without unread / events and maps lid', () => {
  const { repo, ev, events, session } = setup();
  ev.emit('messaging-history.set', {
    chats: [{ id: '5@s.whatsapp.net', name: 'Ana', unreadCount: 3, archived: false, pinned: 1700000000, conversationTimestamp: 1700000000 }],
    contacts: [{ id: '77@lid', lid: '77@lid', phoneNumber: '6@s.whatsapp.net', name: 'Beto' }],
    messages: [msg({ key: { remoteJid: '77@lid', id: 'H1', fromMe: false }, message: { conversation: 'viejo' } })],
    lidPnMappings: [], isLatest: true, progress: 100, syncType: 2,
  });
  assert.equal(repo.getChat('s', '5@s.whatsapp.net')?.unread_count, 3);
  assert.equal(repo.getChat('s', '5@s.whatsapp.net')?.pinned, 1);
  assert.equal(repo.canon('s', '77@lid'), '6@s.whatsapp.net');
  assert.ok(repo.getMessage('s', '6@s.whatsapp.net', 'H1'), 'message folded under phone jid');
  assert.equal(events.filter((e) => e[1] === 'message.in').length, 0);
  assert.equal(session.history.messages, 1);
  assert.equal(session.history.isLatest, true);
});

test('edit, revoke, status, receipts, reaction', () => {
  const { repo, ev } = setup();
  const mine = msg({ key: { remoteJid: '5@s.whatsapp.net', id: 'M1', fromMe: true }, message: { conversation: 'v1' }, status: 2 });
  ev.emit('messages.upsert', { type: 'append', messages: [mine] });
  ev.emit('messages.update', [{ key: mine.key, update: { message: { editedMessage: { message: { conversation: 'v2' } } } } }]);
  assert.equal(repo.getMessage('s', '5@s.whatsapp.net', 'M1')?.text, 'v2');
  assert.equal(repo.getMessage('s', '5@s.whatsapp.net', 'M1')?.edited, 1);
  ev.emit('message-receipt.update', [{ key: mine.key, receipt: { userJid: '5@s.whatsapp.net', readTimestamp: 1 } }]);
  assert.equal(repo.getMessage('s', '5@s.whatsapp.net', 'M1')?.status, 4);
  ev.emit('messages.reaction', [{ key: mine.key, reaction: { key: { remoteJid: '5@s.whatsapp.net', fromMe: false }, text: '🔥', senderTimestampMs: 1700000000000 } }]);
  assert.equal(repo.reactionsFor('s', '5@s.whatsapp.net', ['M1']).get('M1')?.[0]?.emoji, '🔥');
  ev.emit('messages.reaction', [{ key: mine.key, reaction: { key: { remoteJid: '5@s.whatsapp.net', fromMe: false }, text: '' } }]);
  assert.equal(repo.reactionsFor('s', '5@s.whatsapp.net', ['M1']).size, 0);
  ev.emit('messages.update', [{ key: mine.key, update: { message: null, messageStubType: 1 } }]);
  assert.equal(repo.getMessage('s', '5@s.whatsapp.net', 'M1')?.deleted, 1);
});

test('poll votes are tallied per voter (latest vote wins)', () => {
  const { repo, ev } = setup();
  const poll = msg({ key: { remoteJid: '1@g.us', id: 'P1', fromMe: true }, message: { pollCreationMessage: { name: 'Cena?', options: [{ optionName: 'A' }, { optionName: 'B' }], selectableOptionsCount: 1 }, messageContextInfo: { messageSecret: Buffer.alloc(32) } } });
  ev.emit('messages.upsert', { type: 'append', messages: [poll] });
  const h = (n: string) => createHash('sha256').update(Buffer.from(n)).digest();
  const upd = (opt: string) => [{ key: poll.key, update: { pollUpdates: [{ pollUpdateMessageKey: { remoteJid: '1@g.us', fromMe: false, participant: '8@s.whatsapp.net' }, vote: { selectedOptions: [h(opt)] }, senderTimestampMs: 1700000000000 }] } }];
  ev.emit('messages.update', upd('A'));
  ev.emit('messages.update', upd('B'));
  const votes = repo.pollVotes('s', '1@g.us', 'P1');
  assert.equal(votes.length, 1);
  assert.deepEqual(votes[0]!.options, ['B']);
});

test('groups and calls', () => {
  const { repo, ev, events } = setup();
  ev.emit('groups.upsert', [{ id: '1@g.us', subject: 'Equipo', desc: 'd', announce: true, participants: [{ id: '111@s.whatsapp.net', admin: 'admin' }, { id: '8@s.whatsapp.net' }] }]);
  const g = repo.getGroup('s', '1@g.us')!;
  assert.equal(g.subject, 'Equipo');
  assert.equal(g.announce, 1);
  assert.equal(g.me_is_admin, 1);
  assert.equal(repo.getChat('s', '1@g.us')?.kind, 'group');
  ev.emit('groups.update', [{ id: '1@g.us', subject: 'Nuevo' }]);
  assert.equal(repo.getGroup('s', '1@g.us')!.subject, 'Nuevo');
  ev.emit('call', [{ chatId: '5@s.whatsapp.net', from: '5@s.whatsapp.net', id: 'C1', date: new Date(), isVideo: false, status: 'offer' }]);
  assert.equal(repo.listCalls('s', 5).length, 1);
  assert.ok(events.some((e) => e[1] === 'call'));
});

test('ignored senders are dropped', () => {
  const { repo, ev } = setup();
  repo.ignore('s', '5@s.whatsapp.net', 'spam');
  ev.emit('messages.upsert', { type: 'notify', messages: [msg({})] });
  assert.equal(repo.getMessage('s', '5@s.whatsapp.net', 'X'), undefined);
});
