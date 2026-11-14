import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  downloadMediaMessage, getAggregateVotesInPollMessage, isJidBroadcast, proto,
  type GroupMetadata, type WAMessage, type WASocket,
} from 'baileys';
import { errMsg } from '../util.js';
import { bare, isGroupJid, isLidJid, isPnJid, phoneOf } from './jid.js';
import { extFromMime, safeName } from './media.js';
import { editedText, normalizeMessage, parseRaw, summarize, toNum, type NormalizedMessage } from './message-utils.js';
import type { SessionHub, WaSession } from './session.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Ingest {
  dispose(): void;
  saveGroup(meta: GroupMetadata): void;
  persistOutgoing(msg: WAMessage): void;
}

const STATUS = { ERROR: 0, PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5 };

/** Wire every Baileys event of one socket into SQLite + the event journal. */
export function bindIngest(session: WaSession, sock: WASocket, hub: SessionHub): Ingest {
  const { repo, cfg } = hub;
  const name = session.name;
  const log = hub.log.child({ session: name, mod: 'ingest' });
  const meJid = () => (sock.authState.creds.me?.id ? bare(sock.authState.creds.me.id) : undefined);
  const canon = (j: string) => repo.canon(name, j);
  const norm = (j: string) => canon(bare(j) || j);
  const pushNames = new Map<string, string>();
  const groupRefresh = new Map<string, NodeJS.Timeout>();
  const dlQueue: (() => Promise<void>)[] = [];
  let dlActive = 0;
  let disposed = false;

  const learn = (key: any) => {
    const r = key?.remoteJid as string | undefined;
    const ra = key?.remoteJidAlt as string | undefined;
    if (r && ra) pairUp(r, ra);
    const p = key?.participant as string | undefined;
    const pa = key?.participantAlt as string | undefined;
    if (p && pa) pairUp(p, pa);
  };
  const pairUp = (a: string, b: string) => {
    const x = bare(a), y = bare(b);
    if (isLidJid(x) && isPnJid(y)) repo.mapJid(name, x, y);
    else if (isPnJid(x) && isLidJid(y)) repo.mapJid(name, y, x);
  };

  /* -------------------------------- messages -------------------------------- */

  function storeMessage(msg: WAMessage, kind: 'notify' | 'append' | 'history' | 'own'): NormalizedMessage | null {
    const key: any = msg.key;
    if (!key?.remoteJid || (isJidBroadcast(key.remoteJid))) return null;
    learn(key);
    const n = normalizeMessage(msg, { canon, meJid: meJid() });
    if (!n) return null;
    if (!n.from_me && (repo.isIgnored(name, n.chat_jid) || (n.sender_jid && repo.isIgnored(name, n.sender_jid)))) return null;

    const existed = repo.hasMessage(name, n.chat_jid, n.id, n.from_me);
    repo.upsertMessage(name, n);
    const countsAsUnread = !n.from_me && kind === 'notify' && !existed && n.type !== 'system';
    repo.touchChat(name, n.chat_jid, { ts: n.ts, id: n.id, preview: summarize(n.type, n.text, n.caption), fromMe: n.from_me }, countsAsUnread ? 1 : 0);

    if (!n.from_me && msg.pushName && n.sender_jid && isPnJid(n.sender_jid) && pushNames.get(n.sender_jid) !== msg.pushName) {
      pushNames.set(n.sender_jid, msg.pushName);
      repo.upsertContact(name, n.sender_jid, { notify: msg.pushName, phone: phoneOf(n.sender_jid) ?? null });
    }

    if (!existed && (kind === 'notify' || kind === 'own')) {
      hub.publish(name, n.from_me ? 'message.out' : 'message.in', n.chat_jid, n.id, {
        id: n.id, chat: n.chat_jid, from_me: n.from_me, sender: n.sender_jid, sender_name: n.sender_name, ts: n.ts, type: n.type,
        text: n.text ?? n.caption, quoted_id: n.quoted_id, group: isGroupJid(n.chat_jid), has_media: n.has_media,
      });
      if (n.has_media && !n.from_me && cfg.autoDownload === 'all' && (n.media_size ?? 0) <= cfg.mediaMaxBytes) {
        enqueueDownload(n.chat_jid, n.id);
      }
    }

    // they answered: every "waiting for their reply" entry logged before this message closes itself
    if (!existed && !n.from_me && n.type !== 'system') {
      const closed = repo.resolveWaiting(name, n.chat_jid, n.ts, n.id);
      if (closed.length) {
        hub.publish(name, 'waiting.replied', n.chat_jid, n.id, {
          chat: n.chat_jid, message_id: n.id, sender_name: n.sender_name, replied_at: n.ts,
          preview: (n.text ?? n.caption ?? `[${n.type}]`).slice(0, 160),
          waiting: closed.map((w) => ({ id: w.id, note: w.note, waited_s: n.ts - w.ts })),
        });
      }
    }
    return n;
  }

  function enqueueDownload(chat: string, id: string) {
    dlQueue.push(async () => {
      try { await downloadStoredMedia(session, hub, chat, id); } catch (e) { log.debug({ err: errMsg(e), id }, 'auto-download failed'); }
    });
    pumpDownloads();
  }
  function pumpDownloads() {
    while (dlActive < 2 && dlQueue.length && !disposed) {
      const job = dlQueue.shift()!;
      dlActive++;
      void job().finally(() => { dlActive--; pumpDownloads(); });
    }
  }

  /* --------------------------------- contacts --------------------------------- */

  function saveContact(c: any) {
    if (!c?.id) return;
    if (c.lid && c.phoneNumber) pairUp(c.lid, c.phoneNumber);
    if (isLidJid(c.id) && c.phoneNumber) pairUp(c.id, c.phoneNumber);
    if (isPnJid(c.id) && c.lid) pairUp(c.id, c.lid);
    const jid = norm(c.id);
    repo.upsertContact(name, jid, {
      name: c.name, notify: c.notify, verified_name: c.verifiedName, lid: c.lid ?? (isLidJid(c.id) ? c.id : undefined),
      phone: phoneOf(jid) ?? (c.phoneNumber ? phoneOf(c.phoneNumber) : undefined) ?? undefined, about: c.status,
    });
  }

  /* ----------------------------------- chats ----------------------------------- */

  function saveChat(c: any, absoluteUnread: boolean) {
    if (!c?.id || isJidBroadcast(c.id)) return;
    if (c.pnJid && c.lidJid) pairUp(c.pnJid, c.lidJid);
    const jid = norm(c.id);
    const patch: Record<string, any> = {};
    const nm = c.name ?? c.displayName;
    if (nm) patch.name = nm;
    if (absoluteUnread && typeof c.unreadCount === 'number') patch.unread_count = Math.max(0, c.unreadCount);
    else if (c.unreadCount === 0) patch.unread_count = 0;
    else if (c.unreadCount === -1) patch.unread_count = 1; // marked as unread on the phone
    if (c.archived !== undefined && c.archived !== null) patch.archived = c.archived ? 1 : 0;
    if (c.pinned !== undefined && c.pinned !== null) patch.pinned = Number(toNum(c.pinned) ?? 0) > 0 || c.pinned === true ? 1 : 0;
    if (c.muteEndTime !== undefined) {
      const m = toNum(c.muteEndTime);
      patch.muted_until = m && m > 0 ? (m > 1e11 ? Math.floor(m / 1000) : m) : null;
    }
    if (c.ephemeralExpiration !== undefined) patch.ephemeral_duration = c.ephemeralExpiration ?? null;
    if (absoluteUnread && c.conversationTimestamp) patch.last_message_ts = toNum(c.conversationTimestamp);
    repo.upsertChat(name, jid, patch);
  }

  /* ----------------------------------- groups ----------------------------------- */

  function saveGroup(g: GroupMetadata) {
    if (!g?.id) return;
    const me = meJid();
    const myLid = (sock.authState.creds.me as any)?.lid ? bare((sock.authState.creds.me as any).lid) : undefined;
    const parts = (g.participants ?? []).map((p: any) => ({
      id: p.id, phone: p.phoneNumber ?? (isPnJid(p.id) ? p.id : undefined), admin: p.admin ?? null,
    }));
    const meIsAdmin = (g.participants ?? []).some((p: any) => !!p.admin && [me, myLid].filter(Boolean).includes(bare(p.id)) );
    repo.upsertGroup(name, {
      jid: g.id, subject: g.subject, description: g.desc ?? null, owner: g.ownerPn ?? g.owner ?? null, creation: g.creation ?? null,
      announce: !!g.announce, restrict: !!g.restrict, joinApproval: !!g.joinApprovalMode,
      memberAddMode: g.memberAddMode === undefined ? null : g.memberAddMode ? 'all_member_add' : 'admin_add',
      ephemeral: g.ephemeralDuration ?? null, isCommunity: !!g.isCommunity, size: g.size ?? parts.length, participants: parts, meIsAdmin,
    });
    repo.upsertChat(name, g.id, { kind: g.isCommunity ? 'community' : 'group', name: g.subject });
    session.groupCache.set(g.id, g);
  }

  function scheduleGroupRefresh(jid: string) {
    if (groupRefresh.has(jid) || disposed) return;
    groupRefresh.set(jid, setTimeout(async () => {
      groupRefresh.delete(jid);
      try { saveGroup(await sock.groupMetadata(jid)); } catch (e) { log.debug({ err: errMsg(e), jid }, 'group refresh failed'); }
    }, 2500));
  }

  /* --------------------------------- listeners --------------------------------- */

  const on = sock.ev.on.bind(sock.ev) as (ev: string, fn: (...a: any[]) => void) => void;
  const guard = <A extends any[]>(label: string, fn: (...a: A) => void) => (...a: A) => {
    if (disposed) return;
    try { fn(...a); } catch (e) { log.error({ err: errMsg(e), stack: (e as Error).stack?.split('\n').slice(0, 3).join(' | '), label }, 'ingest handler failed'); }
  };

  on('messaging-history.set', guard('history', (d: any) => {
    repo.db.tx(() => {
      for (const m of d.lidPnMappings ?? []) repo.mapJid(name, m.lid, m.pn);
      for (const c of d.contacts ?? []) saveContact(c);
      for (const c of d.chats ?? []) saveChat(c, true);
      let stored = 0;
      for (const m of d.messages ?? []) if (storeMessage(m, 'history')) stored++;
      session.history = {
        syncType: d.syncType !== undefined && d.syncType !== null ? String(proto.HistorySync.HistorySyncType[d.syncType] ?? d.syncType) : session.history.syncType,
        progress: d.progress ?? session.history.progress, isLatest: !!d.isLatest || session.history.isLatest,
        messages: session.history.messages + stored, updatedAt: Math.floor(Date.now() / 1000),
      };
    });
    hub.publish(name, 'history', null, null, session.history);
  }));

  on('messages.upsert', guard('upsert', ({ messages, type }: { messages: WAMessage[]; type: string }) => {
    repo.db.tx(() => {
      for (const m of messages) {
        const own = !!m.key?.fromMe;
        storeMessage(m, type === 'notify' ? 'notify' : own ? 'own' : 'append');
      }
    });
  }));

  on('messages.update', guard('update', (updates: any[]) => {
    for (const { key, update } of updates) {
      if (!key?.remoteJid || !key.id) continue;
      learn(key);
      const chat = norm(key.remoteJid);
      const id: string = key.id;
      if (key.fromMe && typeof update.status === 'number') repo.bumpStatus(name, chat, id, update.status);
      if (update.message === null && update.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
        repo.markDeleted(name, chat, id);
        hub.publish(name, 'message.update', chat, id, { id, chat, change: 'deleted' });
      }
      const edited = update.message?.editedMessage?.message ?? update.message?.protocolMessage?.editedMessage;
      if (edited) {
        const text = editedText(edited);
        repo.patchMessage(name, chat, id, { ...(text !== null ? { text } : {}), edited: true });
        hub.publish(name, 'message.update', chat, id, { id, chat, change: 'edited', text });
      }
      if (typeof update.starred === 'boolean') repo.patchMessage(name, chat, id, { starred: update.starred });
      if (update.pollUpdates?.length) handlePollUpdates(chat, id, update.pollUpdates);
    }
  }));

  function handlePollUpdates(chat: string, pollId: string, pollUpdates: any[]) {
    const poll = repo.getMessage(name, chat, pollId, true);
    const pollMsg = parseRaw(poll?.raw ?? undefined);
    if (!pollMsg) return;
    for (const pu of pollUpdates) {
      const k = pu.pollUpdateMessageKey ?? {};
      const voter = k.fromMe ? meJid() : norm(k.participant || k.participantAlt || k.remoteJid || '');
      if (!voter) continue;
      const agg = getAggregateVotesInPollMessage({ message: pollMsg, pollUpdates: [pu] }, meJid());
      const options = agg.filter((a: any) => a.voters.length && a.name !== 'Unknown').map((a: any) => a.name as string);
      const ts = Math.floor(Number(toNum(pu.senderTimestampMs) ?? Date.now()) / 1000);
      repo.setPollVote(name, chat, pollId, voter, options, ts > 1e10 ? Math.floor(ts / 1000) : ts);
      hub.publish(name, 'poll.vote', chat, pollId, { poll_id: pollId, chat, voter, options });
    }
  }

  on('messages.delete', guard('delete', (d: any) => {
    if (d.all && d.jid) { repo.clearChat(name, norm(d.jid)); return; }
    for (const k of d.keys ?? []) if (k.remoteJid && k.id) repo.markDeleted(name, norm(k.remoteJid), k.id);
  }));

  on('messages.reaction', guard('reaction', (list: any[]) => {
    for (const { key, reaction } of list) {
      if (!key?.remoteJid || !key.id) continue;
      const chat = norm(key.remoteJid);
      const rk = reaction.key ?? {};
      const reactor = rk.fromMe ? meJid() : norm(rk.participant || rk.participantAlt || rk.remoteJid || chat);
      if (!reactor) continue;
      const ts = Math.floor((toNum(reaction.senderTimestampMs) ?? Date.now()) / 1000);
      repo.setReaction(name, chat, key.id, reactor, reaction.text ?? '', ts);
      hub.publish(name, 'reaction', chat, key.id, { message_id: key.id, chat, reactor, emoji: reaction.text || null });
    }
  }));

  on('message-receipt.update', guard('receipt', (list: any[]) => {
    for (const { key, receipt } of list) {
      if (!key?.fromMe || !key.remoteJid || !key.id) continue;
      const st = receipt.playedTimestamp ? STATUS.PLAYED : receipt.readTimestamp ? STATUS.READ : receipt.receiptTimestamp ? STATUS.DELIVERY_ACK : undefined;
      if (st !== undefined) repo.bumpStatus(name, norm(key.remoteJid), key.id, st);
    }
  }));

  on('chats.upsert', guard('chats.upsert', (l: any[]) => { for (const c of l) saveChat(c, true); }));
  on('chats.update', guard('chats.update', (l: any[]) => { for (const c of l) saveChat(c, false); }));
  on('chats.delete', guard('chats.delete', (ids: string[]) => { for (const id of ids) repo.deleteChat(name, norm(id), true); }));

  on('contacts.upsert', guard('contacts.upsert', (l: any[]) => { repo.db.tx(() => { for (const c of l) saveContact(c); }); }));
  on('contacts.update', guard('contacts.update', (l: any[]) => { for (const c of l) saveContact(c); }));
  on('lid-mapping.update', guard('lid', (m: { lid: string; pn: string }) => repo.mapJid(name, bare(m.lid), bare(m.pn))));

  on('groups.upsert', guard('groups.upsert', (l: GroupMetadata[]) => { for (const g of l) saveGroup(g); }));
  on('groups.update', guard('groups.update', (l: Partial<GroupMetadata>[]) => {
    for (const g of l) {
      if (!g.id) continue;
      const patch: Record<string, any> = {};
      if (g.subject !== undefined) patch.subject = g.subject;
      if (g.desc !== undefined) patch.description = g.desc;
      if (g.announce !== undefined) patch.announce = g.announce ? 1 : 0;
      if (g.restrict !== undefined) patch.restrict_info = g.restrict ? 1 : 0;
      if (g.joinApprovalMode !== undefined) patch.join_approval = g.joinApprovalMode ? 1 : 0;
      if (g.ephemeralDuration !== undefined) patch.ephemeral_duration = g.ephemeralDuration;
      if (Object.keys(patch).length) repo.patchGroup(name, g.id, patch);
      if (g.subject) repo.upsertChat(name, g.id, { name: g.subject });
      session.groupCache.del(g.id);
      hub.publish(name, 'group', g.id, null, { jid: g.id, change: 'settings', ...patch });
    }
  }));
  on('group-participants.update', guard('group-participants', (d: any) => {
    session.groupCache.del(d.id);
    scheduleGroupRefresh(d.id);
    hub.publish(name, 'group', d.id, null, { jid: d.id, change: 'participants', action: d.action, participants: (d.participants ?? []).map((p: any) => p.id ?? p), author: d.author });
  }));
  on('group.join-request', guard('group-join', (d: any) => {
    hub.publish(name, 'group', d.id, null, { jid: d.id, change: 'join_request', action: d.action, participant: d.participantPn ?? d.participant, method: d.method });
  }));

  on('labels.edit', guard('labels.edit', (l: any) => repo.upsertLabel(name, l.id, l.name ?? null, l.color ?? null, !!l.deleted)));
  on('labels.association', guard('labels.assoc', ({ association: a, type }: any) => {
    repo.setLabelAssoc(name, a.labelId, norm(a.chatId), a.messageId ?? null, type === 'add');
  }));
  on('blocklist.set', guard('blocklist.set', ({ blocklist }: any) => repo.replaceBlocklist(name, (blocklist ?? []).map(norm))));
  on('blocklist.update', guard('blocklist.update', ({ blocklist, type }: any) => repo.setBlocked(name, (blocklist ?? []).map(norm), type === 'add')));

  on('presence.update', guard('presence', ({ id, presences }: any) => {
    for (const [jid, p] of Object.entries<any>(presences ?? {})) session.presence.set(norm(jid), { state: p.lastKnownPresence, at: Date.now() });
    if (!isGroupJid(id)) session.presence.set(norm(id), session.presence.get(norm(id)) ?? { state: 'unknown', at: Date.now() });
  }));

  on('call', guard('call', (calls: any[]) => {
    for (const c of calls) {
      const chat = norm(c.chatId ?? c.from);
      repo.upsertCall(name, { id: c.id, chat, from: norm(c.callerPn ?? c.from), video: !!c.isVideo, group: !!c.isGroup, status: c.status, ts: Math.floor(new Date(c.date).getTime() / 1000) });
      hub.publish(name, 'call', chat, c.id, { call_id: c.id, from: norm(c.callerPn ?? c.from), status: c.status, video: !!c.isVideo, group: !!c.isGroup });
      if (cfg.rejectCalls && c.status === 'offer') void sock.rejectCall(c.id, c.from).catch(() => undefined);
    }
  }));

  on('connection.update', guard('conn', (u: any) => {
    if (u.receivedPendingNotifications) log.info('pending notifications received');
    if (u.isNewLogin) hub.publish(name, 'connection', null, null, { new_login: true });
  }));

  return {
    dispose() {
      disposed = true;
      for (const t of groupRefresh.values()) clearTimeout(t);
      groupRefresh.clear();
      dlQueue.length = 0;
      for (const ev of ['messaging-history.set', 'messages.upsert', 'messages.update', 'messages.delete', 'messages.reaction', 'message-receipt.update',
        'chats.upsert', 'chats.update', 'chats.delete', 'contacts.upsert', 'contacts.update', 'lid-mapping.update', 'groups.upsert', 'groups.update',
        'group-participants.update', 'group.join-request', 'labels.edit', 'labels.association', 'blocklist.set', 'blocklist.update',
        'presence.update', 'call', 'connection.update']) {
        try { (sock.ev as any).removeAllListeners(ev); } catch { /* ignore */ }
      }
    },
    saveGroup,
    persistOutgoing(msg: WAMessage) {
      repo.db.tx(() => { storeMessage(msg, 'own'); });
    },
  };
}

/* ---------------------------------- media ---------------------------------- */

/** Download (and cache on disk) the media of a stored message. Returns the file path. */
export async function downloadStoredMedia(session: WaSession, hub: SessionHub, chat: string, id: string): Promise<{ path: string; mime: string | null; size: number }> {
  const { repo, cfg } = hub;
  const row = repo.getMessage(session.name, chat, id, true);
  if (!row) throw new Error(`Message ${id} not found in ${chat}`);
  if (!row.media_mime) throw new Error('This message has no downloadable media');
  if (row.media_path) {
    try {
      const st = await fsp.stat(row.media_path);
      return { path: row.media_path, mime: row.media_mime, size: st.size };
    } catch { /* file vanished: download again */ }
  }
  const content = parseRaw(row.raw ?? undefined);
  if (!content) throw new Error('Original message payload not stored; cannot download this media (history-only entry).');
  const sock = session.socket();
  const waMsg = { key: { remoteJid: chat, id, fromMe: !!row.from_me, participant: row.sender_jid ?? undefined }, message: content } as WAMessage;
  const buffer = (await downloadMediaMessage(waMsg, 'buffer', {}, { logger: hub.log as any, reuploadRequest: sock.updateMediaMessage })) as Buffer;
  if (buffer.length > cfg.mediaMaxBytes * 4) throw new Error('Media larger than the configured limit');
  const dir = path.join(cfg.mediaDir, safeName(session.name), safeName(chat));
  await fsp.mkdir(dir, { recursive: true });
  const base = row.media_name ? safeName(row.media_name) : `${row.ts}_${safeName(id)}.${extFromMime(row.media_mime)}`;
  const file = path.join(dir, row.media_name ? `${row.ts}_${base}` : base);
  await fsp.writeFile(file, buffer);
  repo.patchMessage(session.name, chat, id, { media_path: file, media_size: buffer.length });
  return { path: file, mime: row.media_mime, size: buffer.length };
}
