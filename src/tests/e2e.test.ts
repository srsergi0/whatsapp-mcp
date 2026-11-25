import '../boot.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Db } from '../db/database.js';
import { Repo } from '../db/repo.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '..', 'index.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mcp-e2e-'));
let client: Client;

const text = (r: any) => (r.content?.[0] as any)?.text as string;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { ...r, json: r.structuredContent ?? (() => { try { return JSON.parse(text(r)); } catch { return undefined; } })() };
};

before(async () => {
  // seed the database the server will open (WAL mode allows it)
  const db = new Db(path.join(dataDir, 'whatsapp.db'));
  const repo = new Repo(db);
  repo.ensureSession('demo');
  repo.updateSession('demo', { registered: 1, auto_connect: 0, jid: '111@s.whatsapp.net', phone: '111', push_name: 'Yo' });
  repo.upsertContact('demo', '5491100@s.whatsapp.net', { name: 'Ana Pérez', phone: '5491100' });
  repo.upsertContact('demo', '5491200@s.whatsapp.net', { notify: 'Beto' });
  const base: any = { from_me: false, sender_name: null, type: 'text', caption: null, quoted_id: null, quoted_sender: null, quoted_text: null, quoted_type: null, mentions: [], forwarded: false, status: null, ephemeral_expiration: null, media_mime: null, media_name: null, media_size: null, media_seconds: null, extra: null, raw: null, has_media: false };
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 5; i++) {
    repo.upsertMessage('demo', { ...base, chat_jid: '5491100@s.whatsapp.net', id: `m${i}`, sender_jid: '5491100@s.whatsapp.net', ts: now - 600 + i * 60, text: i === 3 ? 'el presupuesto está listo' : `mensaje ${i}`, from_me: i % 2 === 1 });
  }
  repo.touchChat('demo', '5491100@s.whatsapp.net', { ts: now - 360, id: 'm4', preview: 'mensaje 4', fromMe: false }, 2);
  repo.upsertGroup('demo', { jid: '1203@g.us', subject: 'Equipo', size: 2, participants: [{ id: '5491100@s.whatsapp.net', admin: 'admin' }], meIsAdmin: false });
  repo.upsertChat('demo', '1203@g.us', { name: 'Equipo', kind: 'group' });
  db.close();

  client = new Client({ name: 'e2e', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [entry],
    env: { ...process.env as Record<string, string>, WA_MCP_DATA_DIR: dataDir, WA_MCP_AUTOCONNECT: '0', WA_MCP_LOG_LEVEL: 'error' },
    stderr: 'pipe',
  }));
});

after(async () => {
  await client?.close().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 800));
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp dir cleanup is best effort on Windows */ }
});

test('lists tools, resources, prompts', async () => {
  const tools = (await client.listTools()).tools;
  const names = tools.map((t) => t.name);
  for (const n of ['session_pair', 'send_text', 'send_media', 'get_messages', 'search_messages', 'get_events', 'group_participants', 'chat_memory', 'unread_summary', 'inbox', 'inbox_dismiss', 'log_interaction', 'list_interactions', 'update_interaction']) assert.ok(names.includes(n), `missing tool ${n}`);
  assert.ok(tools.length >= 55, `expected >=55 tools, got ${tools.length}`);
  const send = tools.find((t) => t.name === 'send_text')!;
  assert.equal(send.annotations?.readOnlyHint, false);
  assert.equal(tools.find((t) => t.name === 'get_messages')!.annotations?.readOnlyHint, true);
  assert.ok(tools.find((t) => t.name === 'list_chats')!.outputSchema, 'structured output declared');
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
  assert.ok(prompts.includes('link_whatsapp') && prompts.includes('triage_inbox'));
  const res = (await client.listResources()).resources.map((r) => r.uri);
  assert.ok(res.includes('whatsapp://sessions'));
  const tpl = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
  assert.ok(tpl.some((t) => t.includes('/chat/{jid}/messages')));
});

test('read tools over seeded data', async () => {
  const chats = await call('list_chats', {});
  assert.equal(chats.isError, undefined, text(chats));
  assert.ok(chats.json.chats.some((c: any) => c.name === 'Ana Pérez' && c.unread === 2));

  const msgs = await call('get_messages', { format: 'json', chat: 'Ana', limit: 3 });
  assert.equal(msgs.isError, undefined, text(msgs));
  assert.equal(msgs.json.count, 3);
  assert.equal(msgs.json.messages.at(-1).id, 'm4', 'chronological, newest last');
  assert.ok(msgs.json.next_cursor);
  const older = await call('get_messages', { format: 'json', chat: '5491100', cursor: msgs.json.next_cursor, limit: 10 });
  assert.deepEqual(older.json.messages.map((m: any) => m.id), ['m0', 'm1']);

  const s = await call('search_messages', { format: 'json', query: 'presupuesto' });
  assert.equal(s.json.count, 1);
  assert.ok(s.json.results[0].match.includes('[presupuesto]'));

  const u = await call('unread_summary', { format: 'json' });
  assert.equal(u.json.summary.unread_messages, 2);

  const g = await call('group_info', { group: 'Equipo' });
  assert.equal(g.json.subject, 'Equipo');

  const f = await call('find_contacts', { query: 'bet' });
  assert.equal(f.json.contacts.length, 1);
});

test('memory, tags, ignore, export persist in SQLite', async () => {
  assert.equal((await call('chat_memory', { action: 'set', chat: 'Ana', key: 'idioma', value: 'español' })).json.saved, true);
  const got = await call('chat_memory', { action: 'get', chat: 'Ana', key: 'idioma' });
  assert.equal(got.json.notes[0].value, 'español');
  await call('chat_tags', { action: 'add', chat: 'Ana', tags: ['Cliente', 'VIP'] });
  const byTag = await call('list_chats', { tag: 'vip' });
  assert.equal(byTag.json.total, 1);
  const ex = await call('export_chat', { chat: 'Ana', format: 'markdown' });
  assert.ok(fs.existsSync(ex.json.file));
  assert.ok(fs.readFileSync(ex.json.file, 'utf8').includes('presupuesto'));
  const chat = await call('get_chat', { chat: 'Ana' });
  assert.equal(chat.json.notes.idioma, 'español');
});

test('write tools fail cleanly while offline, dangerous ones need confirm', async () => {
  const r = await call('send_text', { to: '5491100', text: 'hola' });
  assert.equal(r.isError, true);
  assert.match(text(r), /not connected/i);
  const d = await call('session_delete', { session: 'demo' });
  assert.equal(d.isError, true);
  assert.match(text(d), /confirm/i);
  const bad = await call('session_pair', { session: 'x y', phone: '12' });
  assert.equal(bad.isError, true);
});

test('resources and prompts', async () => {
  const sessions: any = await client.readResource({ uri: 'whatsapp://sessions' });
  assert.ok(JSON.parse(sessions.contents[0].text).sessions.find((s: any) => s.name === 'demo'));
  const t: any = await client.readResource({ uri: 'whatsapp://demo/chat/5491100%40s.whatsapp.net/messages' });
  assert.match(t.contents[0].text, /presupuesto/);
  const p: any = await client.getPrompt({ name: 'link_whatsapp', arguments: { phone: '5491112345678' } });
  assert.match(p.messages[0].content.text, /session_pair/);
});

test('get_events returns journal entries', async () => {
  const e = await call('get_events', { since_id: 0, types: ['message.in', 'connection'] });
  assert.equal(e.isError, undefined, text(e));
  assert.ok(typeof e.json.last_event_id === 'number');
});

test('server_info', async () => {
  const i = await call('server_info');
  assert.equal(i.json.mode, 'read-write');
  assert.ok(i.json.db.bytes > 0);
});

test('streamable HTTP transport with bearer auth', async () => {
  const { spawn } = await import('node:child_process');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const port = 39000 + Math.floor(Math.random() * 500);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mcp-http-'));
  const child = spawn(process.execPath, [entry, '--http'], {
    env: { ...process.env, WA_MCP_DATA_DIR: dir2, WA_MCP_HTTP_PORT: String(port), WA_MCP_HTTP_TOKEN: 'secret-token', WA_MCP_LOG_LEVEL: 'error', WA_MCP_AUTOCONNECT: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    const noAuth = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noAuth.status, 401);
    const c = new Client({ name: 'http-e2e', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: 'Bearer secret-token' } } }));
    const info: any = await c.callTool({ name: 'server_info', arguments: {} });
    assert.equal(info.structuredContent.name, 'whatsapp-mcp');
    assert.ok((await c.listTools()).tools.length > 50);
    await c.close();
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('log_interaction -> inbox / get_messages / transcript reflect it', async () => {
  const before = await call('inbox', { format: 'json', filter: 'unanswered' });
  assert.equal(before.isError, undefined, text(before));
  const waiting = before.json.items.find((i: any) => i.name === 'Ana Pérez');
  assert.ok(waiting, 'Ana waits for a reply (last message is hers)');
  const logged = await call('log_interaction', { chat: 'Ana', kind: 'call', note: 'La llamé, quedamos mañana', when: '1m' });
  assert.equal(logged.isError, undefined, text(logged));
  const task = await call('log_interaction', { chat: 'Ana', kind: 'task', note: 'Mandar presupuesto', due: '+2d' });
  const after = await call('inbox', { format: 'json', filter: 'unanswered' });
  assert.ok(!after.json.items.some((i: any) => i.name === 'Ana Pérez'), 'resolved by the call');
  const any = await call('inbox', { format: 'json', filter: 'any' });
  assert.equal(any.json.items.find((i: any) => i.name === 'Ana Pérez').my_notes.length, 2);
  const msgs = await call('get_messages', { format: 'json', chat: 'Ana', limit: 5 });
  assert.ok(msgs.json.my_notes.some((n: any) => n.kind === 'call'));
  const open = await call('list_interactions', { status: 'open' });
  assert.equal(open.json.count, 1);
  await call('update_interaction', { id: task.json.id, action: 'complete' });
  assert.equal((await call('list_interactions', { status: 'open' })).json.count, 0);
  const tr: any = await client.readResource({ uri: 'whatsapp://demo/chat/5491100%40s.whatsapp.net/messages' });
  assert.match(tr.contents[0].text, /★ CALL/);
});

test('several MCP clients share ONE owner process (second client proxies)', async () => {
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mcp-multi-'));
  const env = { ...process.env as Record<string, string>, WA_MCP_DATA_DIR: dir3, WA_MCP_AUTOCONNECT: '0', WA_MCP_LOG_LEVEL: 'error' };
  const mk = async (name: string) => {
    const c = new Client({ name, version: '0' });
    const t = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: 'pipe' });
    await c.connect(t);
    return c;
  };
  const a = await mk('A');
  const b = await mk('B');
  const c3 = await mk('C');
  try {
    const ia: any = (await a.callTool({ name: 'server_info', arguments: {} })).structuredContent;
    const ib: any = (await b.callTool({ name: 'server_info', arguments: {} })).structuredContent;
    const ic: any = (await c3.callTool({ name: 'server_info', arguments: {} })).structuredContent;
    assert.equal(ia.mode, 'read-write');
    assert.equal(ib.pid, ia.pid, 'B is served by A\'s process');
    assert.equal(ic.pid, ia.pid, 'C too');
    assert.equal(ib.mode, 'read-write');
    assert.equal((await b.listTools()).tools.length, (await a.listTools()).tools.length);
    // state written through one client is visible through the others
    const s: any = await a.callTool({ name: 'chat_memory', arguments: { session: 'x', action: 'list' } });
    assert.equal(s.isError, true, 'no sessions yet');
    assert.ok((await b.listPrompts()).prompts.length >= 5);
    const res: any = await c3.readResource({ uri: 'whatsapp://sessions' });
    assert.ok(JSON.parse(res.contents[0].text).sessions);
  } finally {
    await c3.close().catch(() => undefined);
    await b.close().catch(() => undefined);
    await a.close().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1500));
    try { fs.rmSync(dir3, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
  }
});

test('compact format + incremental reads + short ids', async () => {
  // fresh chat so earlier tests do not interfere
  const db = new Db(path.join(dataDir, 'whatsapp.db'));
  const repo = new Repo(db);
  const base: any = { sender_name: null, type: 'text', caption: null, quoted_id: null, quoted_sender: null, quoted_text: null, quoted_type: null, mentions: [], forwarded: false, status: null, ephemeral_expiration: null, media_mime: null, media_name: null, media_size: null, media_seconds: null, extra: null, raw: null, has_media: false };
  const now = Math.floor(Date.now() / 1000);
  const J = '5491300@s.whatsapp.net';
  repo.upsertContact('demo', J, { name: 'Carla' });
  repo.upsertMessage('demo', { ...base, chat_jid: J, id: 'ABCDEF0123456789LONGID01', from_me: false, sender_jid: J, ts: now - 300, text: 'Hola, ¿tienes el informe?' });
  repo.upsertMessage('demo', { ...base, chat_jid: J, id: 'ZZZZ1111222233334444AAAA', from_me: true, sender_jid: '111@s.whatsapp.net', ts: now - 200, text: 'Sí, ahora te lo mando', quoted_id: 'ABCDEF0123456789LONGID01', quoted_sender: J, quoted_text: 'Hola, ¿tienes el informe?' });
  repo.touchChat('demo', J, { ts: now - 200, id: 'ZZZZ1111222233334444AAAA', preview: 'x', fromMe: true }, 0);
  db.close();

  const compact = await client.callTool({ name: 'get_messages', arguments: { chat: 'Carla' } }) as any;
  const txt: string = compact.content[0].text;
  assert.match(txt, /^# Carla <5491300@s\.whatsapp\.net>/);
  assert.match(txt, /\] Carla: Hola, ¿tienes el informe\? #LONGID01/);
  assert.match(txt, /\] me: Sí, ahora te lo mando #4444AAAA/);
  assert.match(txt, /↪ Carla .*: Hola, ¿tienes el informe\?/);
  assert.ok(!txt.includes('"jid"') && !txt.includes('"ts"'), 'plain text, not JSON');
  assert.equal(compact.structuredContent, undefined, 'plain text answer, no structuredContent that clients might show instead of the text');
  const asJson = JSON.stringify((await client.callTool({ name: 'get_messages', arguments: { chat: 'Carla', format: 'json' } }) as any).structuredContent);
  assert.ok(txt.length < asJson.length / 2, `compact (${txt.length}) should be less than half of json (${asJson.length})`);

  // incremental: nothing new right after reading
  const again = await client.callTool({ name: 'get_messages', arguments: { chat: 'Carla', unseen_only: true } }) as any;
  assert.match(again.content[0].text, /Nothing new since you last read/);
  // a new message arrives -> only that one is returned
  const db2 = new Db(path.join(dataDir, 'whatsapp.db'));
  new Repo(db2).upsertMessage('demo', { ...base, chat_jid: J, id: 'NEWMSG0000000000000001', from_me: false, sender_jid: J, ts: now - 10, text: 'gracias, ya lo vi' });
  db2.close();
  const inc = await client.callTool({ name: 'get_messages', arguments: { chat: 'Carla', unseen_only: true } }) as any;
  assert.match(inc.content[0].text, /1 new since last read/);
  assert.match(inc.content[0].text, /gracias, ya lo vi/);
  assert.ok(!inc.content[0].text.includes('Sí, ahora te lo mando'), 'old messages are not repeated');
  // after_message_id with the short id printed in the transcript
  const afterShort = await client.callTool({ name: 'get_messages', arguments: { chat: 'Carla', after_message_id: '#LONGID01' } }) as any;
  assert.match(afterShort.content[0].text, /Sí, ahora te lo mando/);
  assert.match(afterShort.content[0].text, /· 2 after #LONGID01/);

  // short ids work in other tools (react would need a connection; get_message resolves them)
  const one: any = await client.callTool({ name: 'get_message', arguments: { chat: 'Carla', message_id: '#4444AAAA' } });
  assert.equal(one.structuredContent.message.id, 'ZZZZ1111222233334444AAAA');

  // inbox compact: text, with skip_seen hiding what was shown
  const inbox = await client.callTool({ name: 'inbox', arguments: { filter: 'any' } }) as any;
  assert.match(inbox.content[0].text, /^INBOX demo/);
  assert.match(inbox.content[0].text, /Carla <5491300@s\.whatsapp\.net>/);
  const inbox2 = await client.callTool({ name: 'inbox', arguments: { filter: 'any', skip_seen: true } }) as any;
  assert.ok(!inbox2.content[0].text.includes('gracias, ya lo vi'), 'already read by this client, hidden');
  assert.match(inbox2.content[0].text, /already shown earlier|Carla/);
});

test('waiting for their reply: log, list, inbox section, send tools accept wait_for_reply', async () => {
  const tools = (await client.listTools()).tools;
  for (const n of ['send_text', 'send_media', 'send_poll']) {
    assert.ok((tools.find((t) => t.name === n)!.inputSchema as any).properties.wait_for_reply, `${n} has wait_for_reply`);
  }
  const w = await call('log_interaction', { chat: 'Ana', kind: 'waiting', note: 'Esperando que confirme el presupuesto', due: '+2d' });
  assert.equal(w.isError, undefined, text(w));
  assert.equal(w.json.saved.status, 'waiting for their reply');
  assert.ok(w.json.saved.due);
  const open = await call('list_interactions', { status: 'open', kind: 'waiting' });
  assert.equal(open.json.count, 1);
  const inbox = await client.callTool({ name: 'inbox', arguments: { filter: 'any' } }) as any;
  assert.match(inbox.content[0].text, /I WAIT FOR THEIR REPLY\n- Ana Pérez: Esperando que confirme el presupuesto/);
  assert.match(inbox.content[0].text, /I wait on 1 \(0 overdue\)/);
  await call('update_interaction', { id: w.json.id, action: 'complete' });
  assert.equal((await call('list_interactions', { status: 'open', kind: 'waiting' })).json.count, 0);
});
