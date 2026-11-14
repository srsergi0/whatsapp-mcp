import '../boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pino from 'pino';
import { loadConfig } from '../config.js';
import { Core } from '../core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A receiver whose answer can be switched between "up" (200), "down" (503) and "reject" (400). */
async function receiver() {
  const got: any[] = [];
  let mode: 'up' | 'down' | 'reject' = 'up';
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (mode === 'up') got.push({ auth: req.headers.authorization, ...JSON.parse(b) });
      res.statusCode = mode === 'up' ? 200 : mode === 'down' ? 503 : 400;
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { got, url: `http://127.0.0.1:${(srv.address() as any).port}/events`, set: (m: typeof mode) => (mode = m), close: () => srv.close() };
}

function core(url: string, over: Partial<ReturnType<typeof loadConfig>['webhook']> = {}, dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-hook-'))) {
  const base = loadConfig();
  const cfg = { ...base, dataDir, dbPath: path.join(dataDir, 'whatsapp.db'), autoConnect: false, webhook: { url, token: 't', events: ['message.in'], groups: false, allow: [], groupAllow: [], ...over } };
  return new Core(cfg, pino({ level: 'silent' }));
}

const dm = (c: Core, phone: string, id: string, text = 'hola') =>
  c.publish('s', 'message.in', `${phone}@s.whatsapp.net`, id, { id, sender: `${phone}@s.whatsapp.net`, sender_name: 'Ana', type: 'text', text });
const settle = () => new Promise((r) => setTimeout(r, 300));

/** Run a test body and always release cores and receivers, even when an assertion fails. */
async function scoped(body: (own: <T extends { shutdown?: () => Promise<void>; close?: () => void }>(x: T) => T) => Promise<void>) {
  const owned: any[] = [];
  try {
    await body((x) => (owned.push(x), x));
  } finally {
    for (const x of owned.reverse()) await (x.shutdown?.() ?? x.close?.());
  }
}

test('webhook: envelope, bearer, groups and outgoing messages filtered', () => scoped(async (own) => {
  const rx = own(await receiver());
  const c = own(core(rx.url));
  await c.start();
  dm(c, '51911111111', 'A');
  c.publish('s', 'message.in', '1@g.us', 'G', { id: 'G', sender: '51922@s.whatsapp.net', type: 'text', text: 'grupo' });
  c.publish('s', 'message.out', '51911111111@s.whatsapp.net', 'O', { id: 'O', type: 'text', text: 'yo' });
  await settle();
  assert.equal(rx.got.length, 1);
  assert.equal(rx.got[0].auth, 'Bearer t');
  assert.equal(rx.got[0].from, '51911111111');
  assert.equal(rx.got[0].dedupe_key, 'wa:s:message.in:A');
  assert.deepEqual(rx.got[0].reply, { channel: 'whatsapp', session: 's', to: '51911111111@s.whatsapp.net' });
}));

test('webhook: allowlist filters at the source', () => scoped(async (own) => {
  const rx = own(await receiver());
  const c = own(core(rx.url, { allow: ['51900000001'] }));
  await c.start();
  dm(c, '51955555555', 'X', 'privado');
  dm(c, '51900000001', 'Y', 'prueba');
  await settle();
  assert.deepEqual(rx.got.map((g) => g.text), ['prueba']);
}));

test('webhook: only listed groups pass, and the envelope says it is a group', () => scoped(async (own) => {
  const rx = own(await receiver());
  const c = own(core(rx.url, { allow: ['51900000001'], groupAllow: ['120363000000000001'] }));
  await c.start();
  c.publish('s', 'message.in', '120363000000000001@g.us', 'G1', { id: 'G1', sender: '51977000001@s.whatsapp.net', type: 'text', text: 'grupo master' });
  c.publish('s', 'message.in', '120363999999999999@g.us', 'G2', { id: 'G2', sender: '51900000001@s.whatsapp.net', type: 'text', text: 'otro grupo' });
  await settle();
  assert.deepEqual(rx.got.map((g) => [g.text, g.group, g.reply.to]), [['grupo master', true, '120363000000000001@g.us']]);
}));

test('webhook: receiver down → nothing lost, delivered in order when it comes back', () => scoped(async (own) => {
  const rx = own(await receiver());
  rx.set('down');
  const c = own(core(rx.url));
  await c.start();
  dm(c, '51911111111', '1', 'uno');
  dm(c, '51911111111', '2', 'dos');
  await settle();
  assert.equal(rx.got.length, 0);
  rx.set('up');
  dm(c, '51911111111', '3', 'tres'); // any new event (or the 30 s timer) retries from the cursor
  await settle();
  assert.deepEqual(rx.got.map((g) => g.text), ['uno', 'dos', 'tres']);
}));

test('webhook: cursor survives restarts; history before the first start is not replayed', () => scoped(async (own) => {
  const rx = own(await receiver());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-hook-'));
  const pre = own(core('', {}, dir)); // webhook not configured yet
  await pre.start();
  dm(pre, '51911111111', 'old', 'antiguo');
  await pre.shutdown();

  rx.set('down');
  const a = own(core(rx.url, {}, dir));
  await a.start();
  dm(a, '51911111111', 'n1', 'nuevo mientras el receptor estaba caído');
  await settle();
  await a.shutdown(); // process restarts before the receiver comes back

  rx.set('up');
  const b = own(core(rx.url, {}, dir));
  await b.start();
  await settle();
  assert.deepEqual(rx.got.map((g) => g.text), ['nuevo mientras el receptor estaba caído']);
}));

test('webhook: a permanently rejected event (4xx) does not block the queue', () => scoped(async (own) => {
  const rx = own(await receiver());
  const c = own(core(rx.url));
  rx.set('reject');
  await c.start();
  dm(c, '51911111111', 'bad', 'rechazado');
  await settle();
  rx.set('up');
  dm(c, '51911111111', 'ok', 'siguiente');
  await settle();
  assert.deepEqual(rx.got.map((g) => g.text), ['siguiente']);
}));
