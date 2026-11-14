import type { Db, Param } from './database.js';
import type { NormalizedMessage } from '../wa/message-utils.js';
import { kindOf } from '../wa/jid.js';

const now = () => Math.floor(Date.now() / 1000);

export interface SessionRow {
  name: string; phone: string | null; jid: string | null; lid: string | null; push_name: string | null;
  registered: number; auto_connect: number; status: string; last_disconnect_code: number | null;
  last_disconnect_reason: string | null; connected_at: number | null; created_at: number; updated_at: number;
}
export interface ChatRow {
  session: string; jid: string; kind: string; name: string | null; display_name: string | null; unread_count: number;
  archived: number; pinned: number; muted_until: number | null; ephemeral_duration: number | null;
  last_message_ts: number | null; last_message_id: string | null; last_message_preview: string | null;
  last_message_from_me: number | null; updated_at: number;
}
export interface MessageRow {
  _rid: number; session: string; chat_jid: string; id: string; from_me: number; sender_jid: string | null; sender_name: string | null;
  ts: number; type: string; text: string | null; caption: string | null; quoted_id: string | null; quoted_sender: string | null;
  quoted_text: string | null; quoted_type: string | null; mentions: string | null; forwarded: number; status: number | null;
  starred: number; edited: number; deleted: number; pinned: number; ephemeral_expiration: number | null;
  media_mime: string | null; media_name: string | null; media_size: number | null; media_path: string | null;
  media_seconds: number | null; extra: string | null; raw?: string | null;
}
export interface ContactRow {
  session: string; jid: string; name: string | null; notify: string | null; verified_name: string | null; lid: string | null;
  phone: string | null; about: string | null; about_ts: number | null; is_business: number; blocked: number; updated_at: number;
}
export interface InteractionRow {
  id: number; session: string; jid: string; ts: number; kind: string; note: string; ref_id: string | null;
  handled: number; due_at: number | null; status: string; created_at: number;
  resolved_at?: number | null; resolved_by?: string | null;
}
export interface EventRow { id: number; session: string; type: string; chat_jid: string | null; ref_id: string | null; ts: number; payload: string }
export interface ScheduledRow {
  id: number; session: string; to_jid: string; kind: string; payload: string; send_at: number; status: string;
  attempts: number; last_error: string | null; sent_message_id: string | null; created_at: number; updated_at: number;
}

const MSG_COLS = `m.rowid AS _rid, m.session, m.chat_jid, m.id, m.from_me, m.sender_jid, m.sender_name, m.ts, m.type, m.text, m.caption,
  m.quoted_id, m.quoted_sender, m.quoted_text, m.quoted_type, m.mentions, m.forwarded, m.status, m.starred, m.edited, m.deleted, m.pinned,
  m.ephemeral_expiration, m.media_mime, m.media_name, m.media_size, m.media_path, m.media_seconds, m.extra`;

const CHAT_SELECT = `
  SELECT c.*, COALESCE(c.name, g.subject, ct.name, ct.notify, ct.verified_name,
                       CASE WHEN c.jid LIKE '%@s.whatsapp.net' THEN substr(c.jid, 1, instr(c.jid, '@') - 1) END) AS display_name
  FROM chats c
  LEFT JOIN groups g ON g.session = c.session AND g.jid = c.jid
  LEFT JOIN contacts ct ON ct.session = c.session AND ct.jid = c.jid`;

export function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(parts.join(':')).toString('base64url');
}
export function decodeCursor(c?: string): string[] | undefined {
  if (!c) return undefined;
  try {
    return Buffer.from(c, 'base64url').toString().split(':');
  } catch {
    throw new Error('Invalid cursor');
  }
}

/** Escape user input into a safe FTS5 query: every word becomes a quoted prefix term (AND). */
export function ftsQuery(q: string): string {
  const terms = q.split(/\s+/).map((t) => t.replace(/["*^():]/g, '')).filter(Boolean);
  if (!terms.length) throw new Error('Empty search query');
  return terms.map((t) => `"${t}"*`).join(' ');
}

export class Repo {
  private lidMaps = new Map<string, Map<string, string>>();

  constructor(readonly db: Db) {}

  /* ------------------------------ sessions ------------------------------ */

  getSession(name: string): SessionRow | undefined {
    return this.db.get<SessionRow>('SELECT * FROM sessions WHERE name = ?', name);
  }
  listSessions(): SessionRow[] {
    return this.db.all<SessionRow>('SELECT * FROM sessions ORDER BY created_at');
  }
  ensureSession(name: string): SessionRow {
    const t = now();
    this.db.run('INSERT OR IGNORE INTO sessions(name, created_at, updated_at) VALUES (?,?,?)', name, t, t);
    return this.getSession(name)!;
  }
  updateSession(name: string, patch: Partial<Omit<SessionRow, 'name' | 'created_at' | 'updated_at'>>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.db.run(`UPDATE sessions SET ${sets}, updated_at = ? WHERE name = ?`, ...keys.map((k) => patch[k] as Param), now(), name);
  }
  deleteSession(name: string) {
    this.db.tx(() => {
      for (const t of ['memory', 'tags', 'ignore_list', 'scheduled_messages', 'events']) this.db.run(`DELETE FROM ${t} WHERE session = ?`, name);
      this.db.run('DELETE FROM audit_log WHERE session = ?', name);
      this.db.run('DELETE FROM sessions WHERE name = ?', name); // cascades the rest
    });
    this.lidMaps.delete(name);
  }
  /** Wipe credentials only (keeps chats/messages): used after a remote logout. */
  clearAuth(name: string) {
    this.db.run('DELETE FROM auth_creds WHERE session = ?', name);
    this.db.run('DELETE FROM auth_keys WHERE session = ?', name);
  }

  /* ------------------------------- lid <-> pn ------------------------------ */

  private lidMap(session: string): Map<string, string> {
    let m = this.lidMaps.get(session);
    if (!m) {
      m = new Map();
      for (const r of this.db.all<{ lid: string; pn: string }>('SELECT lid, pn FROM jid_map WHERE session = ?', session)) m.set(r.lid, r.pn);
      this.lidMaps.set(session, m);
    }
    return m;
  }
  /** Canonical jid: LIDs are replaced by their phone-number jid once known. */
  canon(session: string, jid: string): string {
    if (!jid.endsWith('@lid')) return jid;
    return this.lidMap(session).get(jid) ?? jid;
  }
  pnForLid(session: string, lid: string): string | undefined {
    return this.lidMap(session).get(lid);
  }
  lidForPn(session: string, pn: string): string | undefined {
    return this.db.get<{ lid: string }>('SELECT lid FROM jid_map WHERE session = ? AND pn = ?', session, pn)?.lid;
  }
  /** Learn a mapping and fold any chat already stored under the LID into the PN chat. */
  mapJid(session: string, lid: string, pn: string) {
    if (!lid.endsWith('@lid') || !pn.endsWith('@s.whatsapp.net')) return;
    if (this.lidMap(session).get(lid) === pn) return;
    this.db.tx(() => {
      this.db.run('INSERT INTO jid_map(session, lid, pn) VALUES (?,?,?) ON CONFLICT(session, lid) DO UPDATE SET pn = excluded.pn', session, lid, pn);
      this.lidMap(session).set(lid, pn);
      this.mergeChat(session, lid, pn);
    });
  }
  private mergeChat(session: string, from: string, to: string) {
    const d = this.db;
    d.run('UPDATE OR IGNORE messages SET chat_jid = ? WHERE session = ? AND chat_jid = ?', to, session, from);
    d.run('DELETE FROM messages WHERE session = ? AND chat_jid = ?', session, from);
    d.run('UPDATE OR IGNORE messages SET sender_jid = ? WHERE session = ? AND sender_jid = ?', to, session, from);
    d.run('UPDATE OR IGNORE reactions SET chat_jid = ? WHERE session = ? AND chat_jid = ?', to, session, from);
    d.run('UPDATE OR IGNORE memory SET jid = ? WHERE session = ? AND jid = ?', to, session, from);
    d.run('UPDATE OR IGNORE tags SET jid = ? WHERE session = ? AND jid = ?', to, session, from);
    d.run('UPDATE OR IGNORE label_assoc SET chat_jid = ? WHERE session = ? AND chat_jid = ?', to, session, from);
    d.run('UPDATE interactions SET jid = ? WHERE session = ? AND jid = ?', to, session, from);
    const a = d.get<ChatRow>('SELECT * FROM chats WHERE session = ? AND jid = ?', session, from);
    if (a) {
      const b = d.get<ChatRow>('SELECT * FROM chats WHERE session = ? AND jid = ?', session, to);
      if (!b) d.run('UPDATE chats SET jid = ? WHERE session = ? AND jid = ?', to, session, from);
      else {
        d.run('UPDATE chats SET unread_count = unread_count + ?, name = COALESCE(name, ?) WHERE session = ? AND jid = ?', a.unread_count, a.name, session, to);
        d.run('DELETE FROM chats WHERE session = ? AND jid = ?', session, from);
      }
    }
  }

  /* -------------------------------- chats -------------------------------- */

  upsertChat(session: string, jid: string, patch: Partial<Omit<ChatRow, 'session' | 'jid' | 'display_name' | 'updated_at'>> = {}) {
    const cols = ['kind', 'name', 'unread_count', 'archived', 'pinned', 'muted_until', 'ephemeral_duration',
      'last_message_ts', 'last_message_id', 'last_message_preview', 'last_message_from_me'] as const;
    const vals: Record<string, Param> = { kind: kindOf(jid), ...(patch as Record<string, Param>) };
    const present = cols.filter((c) => vals[c] !== undefined);
    const insertCols = ['session', 'jid', ...present, 'updated_at'];
    const sets = present.map((c) => `${c} = excluded.${c}`).concat('updated_at = excluded.updated_at').join(', ');
    this.db.run(
      `INSERT INTO chats(${insertCols.join(',')}) VALUES (${insertCols.map(() => '?').join(',')})
       ON CONFLICT(session, jid) DO UPDATE SET ${sets}`,
      session, jid, ...present.map((c) => vals[c]), now(),
    );
  }

  touchChat(session: string, jid: string, m: { ts: number; id: string; preview: string; fromMe: boolean }, unreadDelta = 0) {
    this.upsertChat(session, jid, {});
    this.db.run(
      `UPDATE chats SET
         last_message_ts = CASE WHEN last_message_ts IS NULL OR ? >= last_message_ts THEN ? ELSE last_message_ts END,
         last_message_id = CASE WHEN last_message_ts IS NULL OR ? >= last_message_ts THEN ? ELSE last_message_id END,
         last_message_preview = CASE WHEN last_message_ts IS NULL OR ? >= last_message_ts THEN ? ELSE last_message_preview END,
         last_message_from_me = CASE WHEN last_message_ts IS NULL OR ? >= last_message_ts THEN ? ELSE last_message_from_me END,
         unread_count = MAX(0, unread_count + ?), updated_at = ?
       WHERE session = ? AND jid = ?`,
      m.ts, m.ts, m.ts, m.id, m.ts, m.preview.slice(0, 200), m.ts, m.fromMe, unreadDelta, now(), session, jid,
    );
  }

  getChat(session: string, jid: string): ChatRow | undefined {
    return this.db.get<ChatRow>(`${CHAT_SELECT} WHERE c.session = ? AND c.jid = ?`, session, jid);
  }

  deleteChat(session: string, jid: string, keepMessages = false) {
    this.db.tx(() => {
      if (!keepMessages) this.db.run('DELETE FROM messages WHERE session = ? AND chat_jid = ?', session, jid);
      this.db.run('DELETE FROM chats WHERE session = ? AND jid = ?', session, jid);
    });
  }
  clearChat(session: string, jid: string) {
    this.db.tx(() => {
      this.db.run('DELETE FROM messages WHERE session = ? AND chat_jid = ?', session, jid);
      this.db.run('UPDATE chats SET last_message_preview = NULL, last_message_id = NULL, unread_count = 0 WHERE session = ? AND jid = ?', session, jid);
    });
  }

  listChats(session: string, f: {
    query?: string; kind?: string; unreadOnly?: boolean; archived?: boolean; pinnedOnly?: boolean; tag?: string;
    limit: number; offset?: number;
  }): { rows: ChatRow[]; total: number } {
    const where = ['c.session = ?'];
    const args: Param[] = [session];
    if (f.query) {
      where.push(`(COALESCE(c.name, g.subject, ct.name, ct.notify, ct.verified_name, '') LIKE ? ESCAPE '\\' OR c.jid LIKE ? ESCAPE '\\')`);
      const q = `%${f.query.replace(/[%_\\]/g, '\\$&')}%`;
      args.push(q, q);
    }
    if (f.kind) { where.push('c.kind = ?'); args.push(f.kind); }
    if (f.unreadOnly) where.push('c.unread_count > 0');
    if (f.archived !== undefined) { where.push('c.archived = ?'); args.push(f.archived ? 1 : 0); }
    if (f.pinnedOnly) where.push('c.pinned = 1');
    if (f.tag) { where.push('EXISTS (SELECT 1 FROM tags t WHERE t.session = c.session AND t.jid = c.jid AND t.tag = ?)'); args.push(f.tag); }
    const w = where.join(' AND ');
    const total = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM chats c LEFT JOIN groups g ON g.session=c.session AND g.jid=c.jid LEFT JOIN contacts ct ON ct.session=c.session AND ct.jid=c.jid WHERE ${w}`, ...args)!.n;
    const rows = this.db.all<ChatRow>(
      `${CHAT_SELECT} WHERE ${w} ORDER BY c.pinned DESC, COALESCE(c.last_message_ts, 0) DESC LIMIT ? OFFSET ?`, ...args, f.limit, f.offset ?? 0);
    return { rows, total };
  }

  /**
   * Chats with the timestamps needed to decide "unread" and "waiting for my reply":
   * last_in_ts = newest real incoming message, last_out_ts = newest message I sent.
   */
  inboxCandidates(session: string, f: { includeArchived: boolean; includeMuted: boolean; includeGroups: boolean }) {
    const now = Math.floor(Date.now() / 1000);
    const where = ["c.session = ?", "c.kind IN ('user','group','community')"];
    if (!f.includeArchived) where.push('c.archived = 0');
    if (!f.includeMuted) where.push(`(c.muted_until IS NULL OR (c.muted_until <> -1 AND c.muted_until <= ${now}))`);
    if (!f.includeGroups) where.push("c.kind = 'user'");
    return this.db.all<ChatRow & { last_in_ts: number | null; last_out_ts: number | null; blocked: number | null }>(
      `SELECT c.*, COALESCE(c.name, g.subject, ct.name, ct.notify, ct.verified_name,
                CASE WHEN c.jid LIKE '%@s.whatsapp.net' THEN substr(c.jid, 1, instr(c.jid, '@') - 1) END) AS display_name,
              ct.blocked AS blocked,
              (SELECT MAX(m.ts) FROM messages m WHERE m.session = c.session AND m.chat_jid = c.jid AND m.from_me = 0 AND m.type <> 'system' AND m.deleted = 0) AS last_in_ts,
              (SELECT MAX(m.ts) FROM messages m WHERE m.session = c.session AND m.chat_jid = c.jid AND m.from_me = 1 AND m.deleted = 0) AS last_out_ts
       FROM chats c
       LEFT JOIN groups g ON g.session = c.session AND g.jid = c.jid
       LEFT JOIN contacts ct ON ct.session = c.session AND ct.jid = c.jid
       WHERE ${where.join(' AND ')}`, session);
  }

  /** Name/phone lookup used to turn "Juan" into a jid. */
  findChats(session: string, query: string, limit = 8): ChatRow[] {
    return this.listChats(session, { query, limit }).rows;
  }

  /* ------------------------------- contacts ------------------------------- */

  upsertContact(session: string, jid: string, p: Partial<Omit<ContactRow, 'session' | 'jid' | 'updated_at'>>) {
    const cols = ['name', 'notify', 'verified_name', 'lid', 'phone', 'about', 'about_ts', 'is_business', 'blocked'] as const;
    const vals = p as Record<string, Param>;
    const present = cols.filter((c) => vals[c] !== undefined && vals[c] !== null);
    const insertCols = ['session', 'jid', ...present, 'updated_at'];
    const sets = present.map((c) => `${c} = excluded.${c}`).concat('updated_at = excluded.updated_at').join(', ');
    this.db.run(
      `INSERT INTO contacts(${insertCols.join(',')}) VALUES (${insertCols.map(() => '?').join(',')}) ON CONFLICT(session, jid) DO UPDATE SET ${sets}`,
      session, jid, ...present.map((c) => vals[c]), now());
  }
  getContact(session: string, jid: string): ContactRow | undefined {
    return this.db.get<ContactRow>('SELECT * FROM contacts WHERE session = ? AND jid = ?', session, jid);
  }
  listContacts(session: string, f: { query?: string; blockedOnly?: boolean; businessOnly?: boolean; limit: number; offset?: number }) {
    const where = ['session = ?'];
    const args: Param[] = [session];
    if (f.query) {
      where.push(`(COALESCE(name,'') LIKE ? ESCAPE '\\' OR COALESCE(notify,'') LIKE ? ESCAPE '\\' OR COALESCE(verified_name,'') LIKE ? ESCAPE '\\' OR jid LIKE ? ESCAPE '\\')`);
      const q = `%${f.query.replace(/[%_\\]/g, '\\$&')}%`;
      args.push(q, q, q, q);
    }
    if (f.blockedOnly) where.push('blocked = 1');
    if (f.businessOnly) where.push('is_business = 1');
    const w = where.join(' AND ');
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM contacts WHERE ${w}`, ...args)!.n;
    const rows = this.db.all<ContactRow>(`SELECT * FROM contacts WHERE ${w} ORDER BY COALESCE(name, notify, verified_name, jid) COLLATE NOCASE LIMIT ? OFFSET ?`, ...args, f.limit, f.offset ?? 0);
    return { rows, total };
  }
  setBlocked(session: string, jids: string[], blocked: boolean) {
    this.db.tx(() => {
      for (const j of jids) {
        this.upsertContact(session, j, {});
        this.db.run('UPDATE contacts SET blocked = ? WHERE session = ? AND jid = ?', blocked, session, j);
      }
    });
  }
  replaceBlocklist(session: string, jids: string[]) {
    this.db.tx(() => {
      this.db.run('UPDATE contacts SET blocked = 0 WHERE session = ?', session);
      this.setBlocked(session, jids, true);
    });
  }

  /* ------------------------------- messages ------------------------------- */

  upsertMessage(session: string, m: NormalizedMessage, mediaPath?: string | null): boolean {
    const r = this.db.run(
      `INSERT INTO messages(session, chat_jid, id, from_me, sender_jid, sender_name, ts, type, text, caption, quoted_id, quoted_sender,
         quoted_text, quoted_type, mentions, forwarded, status, ephemeral_expiration, media_mime, media_name, media_size, media_path,
         media_seconds, extra, raw, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session, chat_jid, id, from_me) DO UPDATE SET
         sender_jid = COALESCE(excluded.sender_jid, sender_jid),
         sender_name = COALESCE(excluded.sender_name, sender_name),
         text = COALESCE(excluded.text, text),
         caption = COALESCE(excluded.caption, caption),
         raw = COALESCE(excluded.raw, raw),
         media_path = COALESCE(excluded.media_path, media_path),
         status = CASE WHEN excluded.status IS NULL THEN status WHEN status IS NULL THEN excluded.status ELSE MAX(status, excluded.status) END`,
      session, m.chat_jid, m.id, m.from_me, m.sender_jid, m.sender_name, m.ts, m.type, m.text, m.caption, m.quoted_id, m.quoted_sender,
      m.quoted_text, m.quoted_type, m.mentions.length ? JSON.stringify(m.mentions) : null, m.forwarded, m.status, m.ephemeral_expiration,
      m.media_mime, m.media_name, m.media_size, mediaPath ?? null, m.media_seconds, m.extra ? JSON.stringify(m.extra) : null, m.raw, now());
    return Number(r.changes) > 0;
  }

  /**
   * Compact transcripts show ids as "#" + last 8 chars. Resolve such a suffix to the full id
   * (undefined when unknown or ambiguous). Full ids are returned unchanged.
   */
  resolveMessageId(session: string, idOrSuffix: string): string | undefined | 'ambiguous' {
    const s = idOrSuffix.replace(/^#/, '');
    if (s.length > 16) return s;
    if (s.length < 5 || !/^[A-Za-z0-9]+$/.test(s)) return undefined;
    const rows = this.db.all<{ id: string }>('SELECT DISTINCT id FROM messages WHERE session = ? AND id LIKE ? LIMIT 3', session, `%${s}`);
    if (rows.length === 1) return rows[0]!.id;
    return rows.length ? 'ambiguous' : undefined;
  }

  hasMessage(session: string, chat: string, id: string, fromMe?: boolean): boolean {
    return !!this.db.get(
      `SELECT 1 FROM messages WHERE session = ? AND chat_jid = ? AND id = ? ${fromMe === undefined ? '' : 'AND from_me = ?'}`,
      ...(fromMe === undefined ? [session, chat, id] : [session, chat, id, fromMe]));
  }

  getMessage(session: string, chat: string, id: string, withRaw = false): MessageRow | undefined {
    return this.db.get<MessageRow>(
      `SELECT ${MSG_COLS}${withRaw ? ', m.raw' : ''} FROM messages m WHERE m.session = ? AND m.chat_jid = ? AND m.id = ? ORDER BY m.from_me DESC LIMIT 1`, session, chat, id);
  }
  /** Look a message up by id alone (WhatsApp ids are unique enough per session). */
  findMessageById(session: string, id: string, withRaw = false): MessageRow | undefined {
    return this.db.get<MessageRow>(`SELECT ${MSG_COLS}${withRaw ? ', m.raw' : ''} FROM messages m WHERE m.session = ? AND m.id = ? LIMIT 1`, session, id);
  }

  listMessages(session: string, f: {
    chat?: string; fromMe?: boolean; type?: string; sender?: string; since?: number; until?: number; hasMedia?: boolean;
    starred?: boolean; before?: [number, number]; after?: [number, number]; limit: number;
  }): MessageRow[] {
    const where = ['m.session = ?'];
    const args: Param[] = [session];
    if (f.chat) { where.push('m.chat_jid = ?'); args.push(f.chat); }
    if (f.fromMe !== undefined) { where.push('m.from_me = ?'); args.push(f.fromMe); }
    if (f.type) { where.push('m.type = ?'); args.push(f.type); }
    if (f.sender) { where.push('m.sender_jid = ?'); args.push(f.sender); }
    if (f.since !== undefined) { where.push('m.ts >= ?'); args.push(f.since); }
    if (f.until !== undefined) { where.push('m.ts <= ?'); args.push(f.until); }
    if (f.hasMedia) where.push('m.media_mime IS NOT NULL');
    if (f.starred) where.push('m.starred = 1');
    if (f.before) { where.push('(m.ts < ? OR (m.ts = ? AND m.rowid < ?))'); args.push(f.before[0], f.before[0], f.before[1]); }
    if (f.after) { where.push('(m.ts > ? OR (m.ts = ? AND m.rowid > ?))'); args.push(f.after[0], f.after[0], f.after[1]); }
    const asc = !!f.after;
    return this.db.all<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.ts ${asc ? 'ASC' : 'DESC'}, m.rowid ${asc ? 'ASC' : 'DESC'} LIMIT ?`,
      ...args, f.limit);
  }

  searchMessages(session: string, q: string, f: {
    chat?: string; fromMe?: boolean; sender?: string; type?: string; since?: number; until?: number; limit: number; offset?: number;
  }): (MessageRow & { snippet: string })[] {
    const where = ['messages_fts MATCH ?', 'm.session = ?'];
    const args: Param[] = [ftsQuery(q), session];
    if (f.chat) { where.push('m.chat_jid = ?'); args.push(f.chat); }
    if (f.fromMe !== undefined) { where.push('m.from_me = ?'); args.push(f.fromMe); }
    if (f.sender) { where.push('m.sender_jid = ?'); args.push(f.sender); }
    if (f.type) { where.push('m.type = ?'); args.push(f.type); }
    if (f.since !== undefined) { where.push('m.ts >= ?'); args.push(f.since); }
    if (f.until !== undefined) { where.push('m.ts <= ?'); args.push(f.until); }
    return this.db.all(
      `SELECT ${MSG_COLS}, snippet(messages_fts, -1, '[', ']', '…', 12) AS snippet
       FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE ${where.join(' AND ')} ORDER BY m.ts DESC LIMIT ? OFFSET ?`, ...args, f.limit, f.offset ?? 0) as (MessageRow & { snippet: string })[];
  }

  patchMessage(session: string, chat: string, id: string, patch: Partial<{
    text: string | null; caption: string | null; status: number; starred: boolean; edited: boolean; deleted: boolean;
    pinned: boolean; media_path: string | null; media_size: number | null; raw: string | null;
  }>, fromMe?: boolean) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.db.run(
      `UPDATE messages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE session = ? AND chat_jid = ? AND id = ?${fromMe === undefined ? '' : ' AND from_me = ?'}`,
      ...keys.map((k) => patch[k] as Param), session, chat, id, ...(fromMe === undefined ? [] : [fromMe]));
  }
  bumpStatus(session: string, chat: string, id: string, status: number) {
    this.db.run(
      'UPDATE messages SET status = MAX(COALESCE(status, 0), ?) WHERE session = ? AND chat_jid = ? AND id = ? AND from_me = 1', status, session, chat, id);
  }
  deleteMessage(session: string, chat: string, id: string) {
    this.db.run('DELETE FROM messages WHERE session = ? AND chat_jid = ? AND id = ?', session, chat, id);
  }
  markDeleted(session: string, chat: string, id: string) {
    this.db.run('UPDATE messages SET deleted = 1 WHERE session = ? AND chat_jid = ? AND id = ?', session, chat, id);
  }
  oldestMessage(session: string, chat: string) {
    return this.db.get<{ id: string; from_me: number; ts: number }>(
      'SELECT id, from_me, ts FROM messages WHERE session = ? AND chat_jid = ? ORDER BY ts ASC LIMIT 1', session, chat);
  }
  countMessages(session: string, chat?: string): number {
    return chat
      ? this.db.get<{ n: number }>('SELECT COUNT(*) n FROM messages WHERE session = ? AND chat_jid = ?', session, chat)!.n
      : this.db.get<{ n: number }>('SELECT COUNT(*) n FROM messages WHERE session = ?', session)!.n;
  }
  unreadMessages(session: string, chat: string, limit: number): MessageRow[] {
    const n = this.getChat(session, chat)?.unread_count ?? 0;
    if (!n) return [];
    return this.db.all<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages m WHERE m.session = ? AND m.chat_jid = ? AND m.from_me = 0 ORDER BY m.ts DESC, m.rowid DESC LIMIT ?`, session, chat, Math.min(n, limit)).reverse();
  }

  /* ------------------------ reactions / poll votes ------------------------ */

  setReaction(session: string, chat: string, messageId: string, reactor: string, emoji: string, ts: number) {
    if (!emoji) {
      this.db.run('DELETE FROM reactions WHERE session = ? AND chat_jid = ? AND message_id = ? AND reactor = ?', session, chat, messageId, reactor);
      return;
    }
    this.db.run(
      `INSERT INTO reactions(session, chat_jid, message_id, reactor, emoji, ts) VALUES (?,?,?,?,?,?)
       ON CONFLICT(session, chat_jid, message_id, reactor) DO UPDATE SET emoji = excluded.emoji, ts = excluded.ts`, session, chat, messageId, reactor, emoji, ts);
  }
  reactionsFor(session: string, chat: string, ids: string[]): Map<string, { reactor: string; emoji: string }[]> {
    const out = new Map<string, { reactor: string; emoji: string }[]>();
    if (!ids.length) return out;
    const rows = this.db.all<{ message_id: string; reactor: string; emoji: string }>(
      `SELECT message_id, reactor, emoji FROM reactions WHERE session = ? AND chat_jid = ? AND message_id IN (${ids.map(() => '?').join(',')})`, session, chat, ...ids);
    for (const r of rows) (out.get(r.message_id) ?? out.set(r.message_id, []).get(r.message_id)!).push({ reactor: r.reactor, emoji: r.emoji });
    return out;
  }
  setPollVote(session: string, chat: string, pollId: string, voter: string, options: string[], ts: number) {
    this.db.run(
      `INSERT INTO poll_votes(session, chat_jid, poll_id, voter, options, ts) VALUES (?,?,?,?,?,?)
       ON CONFLICT(session, chat_jid, poll_id, voter) DO UPDATE SET options = excluded.options, ts = excluded.ts`,
      session, chat, pollId, voter, JSON.stringify(options), ts);
  }
  pollVotes(session: string, chat: string, pollId: string) {
    return this.db.all<{ voter: string; options: string; ts: number }>(
      'SELECT voter, options, ts FROM poll_votes WHERE session = ? AND chat_jid = ? AND poll_id = ?', session, chat, pollId)
      .map((r) => ({ voter: r.voter, options: JSON.parse(r.options) as string[], ts: r.ts }));
  }

  /* -------------------------------- groups -------------------------------- */

  upsertGroup(session: string, g: {
    jid: string; subject?: string | null; description?: string | null; owner?: string | null; creation?: number | null;
    announce?: boolean; restrict?: boolean; joinApproval?: boolean; memberAddMode?: string | null; ephemeral?: number | null;
    isCommunity?: boolean; size?: number | null; participants?: unknown[] | null; meIsAdmin?: boolean;
  }) {
    this.db.run(
      `INSERT INTO groups(session, jid, subject, description, owner, creation, announce, restrict_info, join_approval, member_add_mode,
         ephemeral_duration, is_community, size, participants, me_is_admin, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session, jid) DO UPDATE SET
         subject = COALESCE(excluded.subject, subject), description = COALESCE(excluded.description, description),
         owner = COALESCE(excluded.owner, owner), creation = COALESCE(excluded.creation, creation),
         announce = excluded.announce, restrict_info = excluded.restrict_info, join_approval = excluded.join_approval,
         member_add_mode = COALESCE(excluded.member_add_mode, member_add_mode),
         ephemeral_duration = COALESCE(excluded.ephemeral_duration, ephemeral_duration), is_community = excluded.is_community,
         size = COALESCE(excluded.size, size), participants = COALESCE(excluded.participants, participants),
         me_is_admin = excluded.me_is_admin, updated_at = excluded.updated_at`,
      session, g.jid, g.subject ?? null, g.description ?? null, g.owner ?? null, g.creation ?? null, !!g.announce, !!g.restrict,
      !!g.joinApproval, g.memberAddMode ?? null, g.ephemeral ?? null, !!g.isCommunity, g.size ?? null,
      g.participants ? JSON.stringify(g.participants) : null, !!g.meIsAdmin, now());
  }
  patchGroup(session: string, jid: string, patch: Record<string, Param>) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.run(`UPDATE groups SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE session = ? AND jid = ?`, ...keys.map((k) => patch[k]), now(), session, jid);
  }
  getGroup(session: string, jid: string) {
    return this.db.get<Record<string, any>>('SELECT * FROM groups WHERE session = ? AND jid = ?', session, jid);
  }
  listGroups(session: string, query?: string, limit = 100, offset = 0) {
    const q = query ? `%${query.replace(/[%_\\]/g, '\\$&')}%` : null;
    return this.db.all<Record<string, any>>(
      `SELECT jid, subject, description, owner, creation, announce, restrict_info, join_approval, is_community, size, me_is_admin, updated_at
       FROM groups WHERE session = ? ${q ? "AND subject LIKE ? ESCAPE '\\'" : ''} ORDER BY subject COLLATE NOCASE LIMIT ? OFFSET ?`,
      ...(q ? [session, q, limit, offset] : [session, limit, offset]));
  }

  /* -------------------------------- labels -------------------------------- */

  upsertLabel(session: string, id: string, name: string | null, color: number | null, deleted: boolean) {
    this.db.run(
      `INSERT INTO labels(session, id, name, color, deleted) VALUES (?,?,?,?,?)
       ON CONFLICT(session, id) DO UPDATE SET name = COALESCE(excluded.name, name), color = COALESCE(excluded.color, color), deleted = excluded.deleted`,
      session, id, name, color, deleted);
  }
  listLabels(session: string) {
    return this.db.all<{ id: string; name: string | null; color: number | null }>(
      'SELECT id, name, color FROM labels WHERE session = ? AND deleted = 0 ORDER BY name COLLATE NOCASE', session);
  }
  setLabelAssoc(session: string, labelId: string, chat: string, messageId: string | null, add: boolean) {
    if (add) this.db.run('INSERT OR IGNORE INTO label_assoc(session, label_id, chat_jid, message_id) VALUES (?,?,?,?)', session, labelId, chat, messageId ?? '');
    else this.db.run('DELETE FROM label_assoc WHERE session = ? AND label_id = ? AND chat_jid = ? AND message_id = ?', session, labelId, chat, messageId ?? '');
  }
  labelsOfChat(session: string, chat: string) {
    return this.db.all<{ id: string; name: string | null }>(
      `SELECT l.id, l.name FROM label_assoc a JOIN labels l ON l.session = a.session AND l.id = a.label_id
       WHERE a.session = ? AND a.chat_jid = ? AND a.message_id = '' AND l.deleted = 0`, session, chat);
  }
  chatsWithLabel(session: string, labelId: string) {
    return this.db.all<{ chat_jid: string; message_id: string }>('SELECT chat_jid, message_id FROM label_assoc WHERE session = ? AND label_id = ?', session, labelId);
  }

  /* --------------------------------- calls --------------------------------- */

  upsertCall(session: string, c: { id: string; chat: string | null; from: string | null; video: boolean; group: boolean; status: string; ts: number }) {
    this.db.run(
      `INSERT INTO calls(session, call_id, chat_jid, from_jid, is_video, is_group, status, ts) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(session, call_id) DO UPDATE SET status = excluded.status`, session, c.id, c.chat, c.from, c.video, c.group, c.status, c.ts);
  }
  listCalls(session: string, limit: number) {
    return this.db.all('SELECT * FROM calls WHERE session = ? ORDER BY ts DESC LIMIT ?', session, limit);
  }

  /* ----------------------------- memory / tags ----------------------------- */

  setMemory(session: string, jid: string, key: string, value: string) {
    this.db.run(
      `INSERT INTO memory(session, jid, key, value, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(session, jid, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, session, jid, key, value, now());
  }
  /** Keys starting with "_" are internal (e.g. inbox dismissals) and hidden unless includeHidden. */
  getMemory(session: string, jid?: string, key?: string, includeHidden = false) {
    const where = ['session = ?'];
    const args: Param[] = [session];
    if (jid) { where.push('jid = ?'); args.push(jid); }
    if (key) { where.push('key = ?'); args.push(key); }
    if (!includeHidden) where.push("key NOT LIKE '\\_%' ESCAPE '\\'");
    return this.db.all<{ jid: string; key: string; value: string; updated_at: number }>(
      `SELECT jid, key, value, updated_at FROM memory WHERE ${where.join(' AND ')} ORDER BY jid, key`, ...args);
  }
  deleteMemory(session: string, jid: string, key?: string) {
    return Number((key
      ? this.db.run('DELETE FROM memory WHERE session = ? AND jid = ? AND key = ?', session, jid, key)
      : this.db.run('DELETE FROM memory WHERE session = ? AND jid = ?', session, jid)).changes);
  }
  addTags(session: string, jid: string, tags: string[]) {
    this.db.tx(() => { for (const t of tags) this.db.run('INSERT OR IGNORE INTO tags(session, jid, tag) VALUES (?,?,?)', session, jid, t); });
  }
  removeTags(session: string, jid: string, tags: string[]) {
    this.db.tx(() => { for (const t of tags) this.db.run('DELETE FROM tags WHERE session = ? AND jid = ? AND tag = ?', session, jid, t); });
  }
  tagsOf(session: string, jid: string): string[] {
    return this.db.all<{ tag: string }>('SELECT tag FROM tags WHERE session = ? AND jid = ? ORDER BY tag', session, jid).map((r) => r.tag);
  }
  listTags(session: string) {
    return this.db.all<{ tag: string; chats: number }>('SELECT tag, COUNT(*) AS chats FROM tags WHERE session = ? GROUP BY tag ORDER BY tag', session);
  }
  jidsWithTag(session: string, tag: string): string[] {
    return this.db.all<{ jid: string }>('SELECT jid FROM tags WHERE session = ? AND tag = ?', session, tag).map((r) => r.jid);
  }

  /* ----------------------------- interactions ----------------------------- */

  addInteraction(session: string, i: { jid: string; ts: number; kind: string; note: string; refId?: string | null; handled: boolean; dueAt?: number | null; status: 'open' | 'done' }): number {
    const r = this.db.run(
      'INSERT INTO interactions(session, jid, ts, kind, note, ref_id, handled, due_at, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      session, i.jid, i.ts, i.kind, i.note, i.refId ?? null, i.handled, i.dueAt ?? null, i.status, now());
    return Number(r.lastInsertRowid);
  }
  listInteractions(session: string, f: {
    jid?: string; kind?: string; status?: 'open' | 'done'; since?: number; until?: number; query?: string; dueBefore?: number; limit: number;
  }): InteractionRow[] {
    const where = ['session = ?'];
    const args: Param[] = [session];
    if (f.jid) { where.push('jid = ?'); args.push(f.jid); }
    if (f.kind) { where.push('kind = ?'); args.push(f.kind); }
    if (f.status) { where.push('status = ?'); args.push(f.status); }
    if (f.since !== undefined) { where.push('ts >= ?'); args.push(f.since); }
    if (f.until !== undefined) { where.push('ts <= ?'); args.push(f.until); }
    if (f.dueBefore !== undefined) { where.push('due_at IS NOT NULL AND due_at <= ?'); args.push(f.dueBefore); }
    if (f.query) { where.push("note LIKE ? ESCAPE '\\'"); args.push(`%${f.query.replace(/[%_\\]/g, '\\$&')}%`); }
    return this.db.all<InteractionRow>(`SELECT * FROM interactions WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`, ...args, f.limit);
  }
  getInteraction(id: number) {
    return this.db.get<InteractionRow>('SELECT * FROM interactions WHERE id = ?', id);
  }
  updateInteraction(id: number, patch: Partial<Pick<InteractionRow, 'note' | 'status' | 'handled' | 'due_at' | 'kind' | 'resolved_at' | 'resolved_by'>>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length) this.db.run(`UPDATE interactions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => patch[k] as Param), id);
  }
  deleteInteraction(id: number) {
    return Number(this.db.run('DELETE FROM interactions WHERE id = ?', id).changes);
  }
  /**
   * An incoming message arrived: every open "waiting for their reply" entry of that chat that was
   * logged before it is closed. Returns the entries that were closed.
   */
  resolveWaiting(session: string, jid: string, messageTs: number, messageId: string): InteractionRow[] {
    const open = this.db.all<InteractionRow>(
      "SELECT * FROM interactions WHERE session = ? AND jid = ? AND kind = 'waiting' AND status = 'open' AND ts < ?", session, jid, messageTs);
    for (const w of open) {
      this.db.run("UPDATE interactions SET status = 'done', resolved_at = ?, resolved_by = ? WHERE id = ?", messageTs, messageId, w.id);
    }
    return open;
  }
  /** Open "waiting" entries (optionally only the overdue ones), oldest due first. */
  openWaiting(session: string, f: { overdueBefore?: number; limit: number }): InteractionRow[] {
    return this.db.all<InteractionRow>(
      `SELECT * FROM interactions WHERE session = ? AND kind = 'waiting' AND status = 'open'
       ${f.overdueBefore !== undefined ? 'AND due_at IS NOT NULL AND due_at <= ?' : ''} ORDER BY COALESCE(due_at, ts) ASC LIMIT ?`,
      ...(f.overdueBefore !== undefined ? [session, f.overdueBefore, f.limit] : [session, f.limit]));
  }
  /** Latest time something "handled" this chat outside WhatsApp (call, meeting...). */
  handledTimes(session: string): Map<string, number> {
    const m = new Map<string, number>();
    for (const r of this.db.all<{ jid: string; t: number }>('SELECT jid, MAX(ts) AS t FROM interactions WHERE session = ? AND handled = 1 GROUP BY jid', session)) m.set(r.jid, r.t);
    return m;
  }

  /* ------------------------------ ignore list ------------------------------ */

  ignore(session: string, jid: string, reason?: string) {
    this.db.run('INSERT INTO ignore_list(session, jid, reason, created_at) VALUES (?,?,?,?) ON CONFLICT(session, jid) DO UPDATE SET reason = excluded.reason', session, jid, reason ?? null, now());
  }
  unignore(session: string, jid: string) {
    return Number(this.db.run('DELETE FROM ignore_list WHERE session = ? AND jid = ?', session, jid).changes);
  }
  isIgnored(session: string, jid: string): boolean {
    return !!this.db.get('SELECT 1 FROM ignore_list WHERE session = ? AND jid = ?', session, jid);
  }
  listIgnored(session: string) {
    return this.db.all<{ jid: string; reason: string | null; created_at: number }>('SELECT jid, reason, created_at FROM ignore_list WHERE session = ?', session);
  }

  /* ------------------------------- scheduled ------------------------------- */

  schedule(session: string, to: string, kind: string, payload: unknown, sendAt: number): number {
    const t = now();
    const r = this.db.run(
      'INSERT INTO scheduled_messages(session, to_jid, kind, payload, send_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      session, to, kind, JSON.stringify(payload), sendAt, t, t);
    return Number(r.lastInsertRowid);
  }
  dueScheduled(limit = 20): ScheduledRow[] {
    return this.db.all<ScheduledRow>("SELECT * FROM scheduled_messages WHERE status = 'pending' AND send_at <= ? ORDER BY send_at LIMIT ?", now(), limit);
  }
  listScheduled(session?: string, status?: string, limit = 100): ScheduledRow[] {
    const where: string[] = [];
    const args: Param[] = [];
    if (session) { where.push('session = ?'); args.push(session); }
    if (status) { where.push('status = ?'); args.push(status); }
    return this.db.all<ScheduledRow>(`SELECT * FROM scheduled_messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY send_at DESC LIMIT ?`, ...args, limit);
  }
  getScheduled(id: number) {
    return this.db.get<ScheduledRow>('SELECT * FROM scheduled_messages WHERE id = ?', id);
  }
  updateScheduled(id: number, patch: Partial<Pick<ScheduledRow, 'status' | 'attempts' | 'last_error' | 'sent_message_id' | 'send_at' | 'payload'>>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    this.db.run(`UPDATE scheduled_messages SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => patch[k] as Param), now(), id);
  }

  /* --------------------------------- events -------------------------------- */

  addEvent(session: string, type: string, chat: string | null, ref: string | null, payload: unknown): number {
    const r = this.db.run('INSERT INTO events(session, type, chat_jid, ref_id, ts, payload) VALUES (?,?,?,?,?,?)', session, type, chat, ref, now(), JSON.stringify(payload));
    return Number(r.lastInsertRowid);
  }
  listEvents(f: { session?: string; sinceId: number; types?: string[]; chat?: string; limit: number }): EventRow[] {
    const where = ['id > ?'];
    const args: Param[] = [f.sinceId];
    if (f.session) { where.push('session = ?'); args.push(f.session); }
    if (f.chat) { where.push('chat_jid = ?'); args.push(f.chat); }
    if (f.types?.length) { where.push(`type IN (${f.types.map(() => '?').join(',')})`); args.push(...f.types); }
    return this.db.all<EventRow>(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`, ...args, f.limit);
  }
  lastEventId(): number {
    return this.db.get<{ m: number | null }>('SELECT MAX(id) AS m FROM events')?.m ?? 0;
  }
  pruneEvents(olderThanDays: number): number {
    return Number(this.db.run('DELETE FROM events WHERE ts < ?', now() - olderThanDays * 86400).changes);
  }

  /* --------------------------------- audit --------------------------------- */

  audit(tool: string, session: string | null, target: string | null, ok: boolean, detail?: string) {
    try {
      this.db.run('INSERT INTO audit_log(ts, session, tool, target, ok, detail) VALUES (?,?,?,?,?,?)', now(), session, tool, target, ok, detail?.slice(0, 500) ?? null);
    } catch { /* never break a tool because of audit */ }
  }
  listAudit(limit: number, session?: string) {
    return this.db.all(`SELECT * FROM audit_log ${session ? 'WHERE session = ?' : ''} ORDER BY id DESC LIMIT ?`, ...(session ? [session, limit] : [limit]));
  }

  /* ---------------------------------- kv ---------------------------------- */

  kvGet(key: string): string | undefined {
    return this.db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value;
  }
  kvSet(key: string, value: string) {
    this.db.run('INSERT INTO kv(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  stats(session?: string) {
    const w = session ? 'WHERE session = ?' : '';
    const a: Param[] = session ? [session] : [];
    const n = (t: string) => this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${t} ${w}`, ...a)!.n;
    return { messages: n('messages'), chats: n('chats'), contacts: n('contacts'), groups: n('groups'), events: n('events'), scheduled_pending: this.db.get<{ n: number }>("SELECT COUNT(*) n FROM scheduled_messages WHERE status = 'pending'")!.n };
  }
}
