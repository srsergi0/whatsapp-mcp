import '../boot.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db/database.js';
import { Repo } from '../db/repo.js';
import { DISMISS_KEY, NO_FOLLOWUP_TAGS, computeFollowUps, computeInbox, humanDuration, type FollowUpOpts, type InboxOpts } from '../mcp/inbox.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const now = Math.floor(Date.now() / 1000);
const H = 3600;
const base: any = { from_me: false, sender_name: null, type: 'text', caption: null, quoted_id: null, quoted_sender: null, quoted_text: null, quoted_type: null, mentions: [], forwarded: false, status: null, ephemeral_expiration: null, media_mime: null, media_name: null, media_size: null, media_seconds: null, extra: null, raw: null, has_media: false };
const opts = (o: Partial<InboxOpts> = {}): InboxOpts => ({ filter: 'any', minWaitMinutes: 0, maxAgeDays: 14, includeGroups: true, includeArchived: false, includeMuted: false, includeDismissed: false, perChat: 3, limit: 50, sort: 'oldest', ...o });

function seed() {
  const repo = new Repo(new Db(':memory:'));
  repo.ensureSession('s');
  repo.updateSession('s', { jid: '1@s.whatsapp.net', lid: '1@lid', registered: 1 });
  const core: any = { repo };
  let n = 0;
  const msg = (chat: string, ago: number, from_me: boolean, extra: any = {}) => {
    const ts = now - ago;
    const m = { ...base, chat_jid: chat, id: `m${++n}`, sender_jid: from_me ? '1@s.whatsapp.net' : chat, ts, text: `msg ${n}`, from_me, ...extra };
    repo.upsertMessage('s', m);
    repo.touchChat('s', chat, { ts, id: m.id, preview: m.text, fromMe: from_me }, from_me ? 0 : 1);
  };
  // A: three incoming 3h ago, never answered
  msg('a@s.whatsapp.net', 3 * H + 120, false); msg('a@s.whatsapp.net', 3 * H + 60, false); msg('a@s.whatsapp.net', 3 * H, false, { text: '¿vienes?' });
  // B: they wrote, I answered afterwards
  msg('b@s.whatsapp.net', 2 * H, false); msg('b@s.whatsapp.net', H, true);
  // C: I wrote, they answered 1h ago
  msg('c@s.whatsapp.net', 5 * H, true); msg('c@s.whatsapp.net', H, false);
  // D group chatter (no mention); E group where I'm mentioned; F group where someone quotes me
  repo.upsertChat('s', 'd@g.us', { kind: 'group', name: 'D' }); msg('d@g.us', 2 * H, false);
  repo.upsertChat('s', 'e@g.us', { kind: 'group', name: 'E' }); msg('e@g.us', H, false, { mentions: ['1@s.whatsapp.net'], sender_jid: '9@s.whatsapp.net' });
  repo.upsertChat('s', 'f@g.us', { kind: 'group', name: 'F' }); msg('f@g.us', 30 * 60, false, { quoted_sender: '1@lid', sender_jid: '8@s.whatsapp.net' });
  // G muted, H very old
  msg('g@s.whatsapp.net', H, false); repo.upsertChat('s', 'g@s.whatsapp.net', { muted_until: -1 });
  msg('h@s.whatsapp.net', 40 * 86400, false); repo.upsertChat('s', 'h@s.whatsapp.net', { unread_count: 0 });
  return { repo, core };
}

test('unanswered: waiting chats, groups only when directed at me, muted/old excluded', () => {
  const { core } = seed();
  const r = computeInbox(core, 's', opts({ filter: 'unanswered' }));
  const by = Object.fromEntries(r.items.map((i: any) => [i.jid, i]));
  assert.deepEqual(Object.keys(by).sort(), ['a@s.whatsapp.net', 'c@s.whatsapp.net', 'e@g.us', 'f@g.us']);
  assert.equal(by['a@s.whatsapp.net'].pending_count, 3);
  assert.ok(by['a@s.whatsapp.net'].waiting_minutes >= 179 && by['a@s.whatsapp.net'].waiting_minutes <= 183);
  assert.equal(by['a@s.whatsapp.net'].looks_like_question, true);
  assert.equal(by['e@g.us'].directed_at_me, true);
  assert.equal(r.items[0].jid, 'a@s.whatsapp.net', 'oldest waiting first');
  assert.equal(r.summary.chats_awaiting_my_reply, 4);
});

test('unread filter, newest first, min wait, per-chat limit', () => {
  const { core } = seed();
  const u = computeInbox(core, 's', opts({ filter: 'unread', sort: 'newest', includeMuted: false }));
  assert.ok(u.items.every((i: any) => i.unread > 0));
  assert.ok(!u.items.some((i: any) => i.jid === 'g@s.whatsapp.net'), 'muted hidden');
  assert.equal(u.items[0].jid, 'f@g.us', 'most recent first');
  const w = computeInbox(core, 's', opts({ filter: 'unanswered', minWaitMinutes: 150 }));
  assert.deepEqual(w.items.map((i: any) => i.jid), ['a@s.whatsapp.net']);
  const one = computeInbox(core, 's', opts({ filter: 'unanswered', perChat: 1 }));
  assert.equal(one.items.find((i: any) => i.jid === 'a@s.whatsapp.net').messages.length, 1);
  const nog = computeInbox(core, 's', opts({ filter: 'unanswered', includeGroups: false }));
  assert.ok(!nog.items.some((i: any) => i.jid.endsWith('@g.us')));
});

test('dismiss hides until a newer message arrives; muted can be included', () => {
  const { repo, core } = seed();
  const last = repo.listMessages('s', { chat: 'a@s.whatsapp.net', fromMe: false, limit: 1 })[0]!;
  repo.setMemory('s', 'a@s.whatsapp.net', DISMISS_KEY, String(last.ts));
  assert.ok(!computeInbox(core, 's', opts({ filter: 'unanswered' })).items.some((i: any) => i.jid === 'a@s.whatsapp.net'));
  assert.ok(computeInbox(core, 's', opts({ filter: 'unanswered', includeDismissed: true })).items.some((i: any) => i.jid === 'a@s.whatsapp.net'));
  repo.upsertMessage('s', { ...base, chat_jid: 'a@s.whatsapp.net', id: 'new', sender_jid: 'a@s.whatsapp.net', ts: now - 60, text: 'hola?' });
  assert.ok(computeInbox(core, 's', opts({ filter: 'unanswered' })).items.some((i: any) => i.jid === 'a@s.whatsapp.net'), 'reappears on new message');
  assert.equal(repo.getMemory('s', 'a@s.whatsapp.net').length, 0, 'internal key hidden from notes');
  assert.ok(computeInbox(core, 's', opts({ filter: 'unanswered', includeMuted: true })).items.some((i: any) => i.jid === 'g@s.whatsapp.net'));
});

test('humanDuration', () => {
  assert.equal(humanDuration(0.2), '<1m');
  assert.equal(humanDuration(45), '45m');
  assert.equal(humanDuration(192), '3h 12m');
  assert.equal(humanDuration(60 * 52), '2d 4h');
});

test('logging a call resolves the pending "llámame" until they write again', () => {
  const { repo, core } = seed();
  const ids = () => computeInbox(core, 's', opts({ filter: 'unanswered' })).items.map((i: any) => i.jid);
  assert.ok(ids().includes('a@s.whatsapp.net'));
  // user called them 10 minutes ago and logged it
  repo.addInteraction('s', { jid: 'a@s.whatsapp.net', ts: now - 600, kind: 'call', note: 'Lo llamé, le envío la cotización mañana', handled: true, status: 'done' });
  repo.addInteraction('s', { jid: 'a@s.whatsapp.net', ts: now - 590, kind: 'task', note: 'Enviar cotización', handled: false, dueAt: now + 3600, status: 'open' });
  assert.ok(!ids().includes('a@s.whatsapp.net'), 'handled by phone call');
  const r = computeInbox(core, 's', opts({ filter: 'unread' }));
  const a = r.items.find((i: any) => i.jid === 'a@s.whatsapp.net') as any;
  assert.ok(a, 'still unread');
  assert.equal(a.awaiting_reply, undefined);
  assert.equal(a.my_notes[0].kind, 'task');
  assert.equal(r.summary.open_tasks, 1);
  assert.equal((r as any).tasks_due_soon[0].note, 'Enviar cotización');
  // they write again after the call -> shows up again, with the notes attached
  repo.upsertMessage('s', { ...base, chat_jid: 'a@s.whatsapp.net', id: 'again', sender_jid: 'a@s.whatsapp.net', ts: now - 30, text: 'no me llegó nada' });
  const back = computeInbox(core, 's', opts({ filter: 'unanswered' })).items.find((i: any) => i.jid === 'a@s.whatsapp.net') as any;
  assert.ok(back);
  assert.equal(back.pending_count, 1);
  assert.deepEqual(back.my_notes.map((n: any) => n.kind).sort(), ['call', 'task']);
  repo.updateInteraction(1, { status: 'done' });
  assert.equal(repo.listInteractions('s', { status: 'open', limit: 5 }).length, 1);
});

const fopts = (o: Partial<FollowUpOpts> = {}): FollowUpOpts => ({ minSilenceHours: 20, maxAgeDays: 30, maxAttempts: 3, includeNeverReplied: false, includeGroups: false, includeArchived: false, excludeTags: NO_FOLLOWUP_TAGS, perChat: 4, limit: 50, sort: 'priority', ...o });

test('follow_ups: chats waiting on them, staged, attempts grouped, warm first', () => {
  const { repo, core } = seed();
  let n = 100;
  const msg = (chat: string, ago: number, from_me: boolean, extra: any = {}) => {
    const ts = now - ago;
    const m = { ...base, chat_jid: chat, id: `f${++n}`, sender_jid: from_me ? '1@s.whatsapp.net' : chat, ts, text: `msg ${n}`, from_me, ...extra };
    repo.upsertMessage('s', m);
    repo.touchChat('s', chat, { ts, id: m.id, preview: m.text ?? '[doc]', fromMe: from_me }, 0);
  };
  const D = 86400;
  // cold: "Quiero más información" -> my burst of 3 messages (one attempt) 2 days ago
  msg('cold@s.whatsapp.net', 3 * D, false); msg('cold@s.whatsapp.net', 2 * D, true); msg('cold@s.whatsapp.net', 2 * D - 60, true); msg('cold@s.whatsapp.net', 2 * D - 120, true, { status: 4 });
  // proposal: a real conversation, then I sent a PDF 5 days ago and a follow-up yesterday (two attempts)
  msg('prop@s.whatsapp.net', 6 * D, false); msg('prop@s.whatsapp.net', 6 * D - 600, false); msg('prop@s.whatsapp.net', 5 * D, true, { type: 'document', text: null });
  msg('prop@s.whatsapp.net', D + 3600, true);
  // chased: four attempts on different days -> hidden by maxAttempts 3
  msg('chased@s.whatsapp.net', 10 * D, false); for (const d of [9, 7, 5, 3]) msg('chased@s.whatsapp.net', d * D, true);
  // fresh: my message 2h ago -> too recent; never: I wrote, they never did; tagged: opted out
  msg('fresh@s.whatsapp.net', 3 * D, false); msg('fresh@s.whatsapp.net', 2 * H, true);
  msg('never@s.whatsapp.net', 2 * D, true);
  msg('tagged@s.whatsapp.net', 3 * D, false); msg('tagged@s.whatsapp.net', 2 * D, true); repo.addTags('s', 'tagged@s.whatsapp.net', ['no-followup']);
  // called after my last message -> conversation moved off WhatsApp
  msg('called@s.whatsapp.net', 3 * D, false); msg('called@s.whatsapp.net', 2 * D, true);
  repo.addInteraction('s', { jid: 'called@s.whatsapp.net', ts: now - D, kind: 'call', note: 'Hablamos por teléfono', handled: true, status: 'done' });

  const r = computeFollowUps(core, 's', fopts());
  const by = Object.fromEntries(r.items.map((i: any) => [i.jid, i]));
  assert.deepEqual(r.items.map((i: any) => i.jid), ['prop@s.whatsapp.net', 'cold@s.whatsapp.net'], 'warm lead first; B (answered 1h ago) is too fresh');
  assert.equal(by['prop@s.whatsapp.net'].stage, 'proposal_sent');
  assert.equal(by['prop@s.whatsapp.net'].attempts, 2);
  assert.equal(by['cold@s.whatsapp.net'].stage, 'cold');
  assert.equal(by['cold@s.whatsapp.net'].attempts, 1, 'a burst is one attempt');
  assert.equal(by['cold@s.whatsapp.net'].my_last_seen_by_them, true);
  assert.equal(r.summary.hidden_max_attempts, 1);

  const all = computeFollowUps(core, 's', fopts({ maxAttempts: 0, includeNeverReplied: true, minSilenceHours: 1 })).items.map((i: any) => i.jid);
  for (const j of ['chased@s.whatsapp.net', 'never@s.whatsapp.net', 'fresh@s.whatsapp.net']) assert.ok(all.includes(j), j);
  assert.ok(!all.includes('tagged@s.whatsapp.net') && !all.includes('called@s.whatsapp.net'));
  assert.ok(!all.includes('a@s.whatsapp.net'), 'they spoke last: inbox, not follow-up');

  // they answer -> leaves the list
  msg('cold@s.whatsapp.net', 60, false);
  assert.ok(!computeFollowUps(core, 's', fopts()).items.some((i: any) => i.jid === 'cold@s.whatsapp.net'));
});
