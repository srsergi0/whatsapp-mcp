import type { Core } from '../core.js';
import type { ChatRow, InteractionRow, MessageRow } from '../db/repo.js';
import { iso } from '../util.js';
import { bare, isGroupJid, phoneOf } from '../wa/jid.js';
import { summarize } from '../wa/message-utils.js';
import { mediaFileUri } from './uris.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Drop null / undefined / false / empty values so LLM context stays small. */
export function compact<T extends Record<string, any>>(o: T): Partial<T> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || v === false || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

export const STATUS_NAMES = ['failed', 'pending', 'sent', 'delivered', 'read', 'played'];

export class Presenter {
  private names = new Map<string, string | null>();

  constructor(private core: Core, readonly session: string) {}

  /** Best human label for a jid (saved name > push name > group subject > phone). */
  name(jid: string | null | undefined): string | null {
    if (!jid) return null;
    if (this.names.has(jid)) return this.names.get(jid)!;
    const repo = this.core.repo;
    let n: string | null = null;
    if (isGroupJid(jid)) n = (repo.getGroup(this.session, jid)?.subject as string | undefined) ?? repo.getChat(this.session, jid)?.name ?? null;
    else {
      const me = repo.getSession(this.session);
      if (me?.jid === jid) n = me.push_name ?? 'me';
      else {
        const c = repo.getContact(this.session, jid);
        n = c?.name ?? c?.notify ?? c?.verified_name ?? null;
      }
    }
    this.names.set(jid, n);
    return n;
  }

  who(jid: string | null | undefined): { jid: string; name?: string; phone?: string } | null {
    if (!jid) return null;
    return compact({ jid, name: this.name(jid) ?? undefined, phone: phoneOf(jid) }) as any;
  }

  private meIds?: Set<string>;
  private isMe(jid: string | null | undefined): boolean {
    if (!jid) return false;
    if (!this.meIds) {
      const s = this.core.repo.getSession(this.session);
      this.meIds = new Set([s?.jid, s?.lid].filter(Boolean).map((j) => bare(j!)));
    }
    return this.meIds.has(bare(jid));
  }

  /**
   * The message a reply points to, resolved against the local store when possible so the
   * reader knows WHO wrote it (me / name), WHEN, and its full text, even if it is far up the chat.
   */
  quote(r: MessageRow) {
    if (!r.quoted_id) return undefined;
    const orig = this.core.repo.getMessage(this.session, r.chat_jid, r.quoted_id);
    const authorJid = orig ? (orig.from_me ? null : orig.sender_jid) : r.quoted_sender;
    const fromMe = orig ? !!orig.from_me : this.isMe(r.quoted_sender);
    // in a 1:1 chat a quote without author can only be the other person or me: if the reply is mine it can be either, so stay silent
    const from = fromMe ? 'me' : (this.name(authorJid) ?? authorJid ?? (!isGroupJid(r.chat_jid) && !r.from_me ? 'me' : undefined));
    const text = orig ? summarize(orig.type, orig.text, orig.caption) : r.quoted_text;
    return compact({
      id: r.quoted_id,
      from,
      time: orig ? iso(orig.ts) : undefined,
      type: orig?.type ?? r.quoted_type,
      text: text ? text.slice(0, 600) : undefined,
      media: orig?.media_mime ? compact({ mime: orig.media_mime, name: orig.media_name, downloaded: !!orig.media_path }) : undefined,
      deleted: orig?.deleted ? true : undefined,
      not_in_local_store: orig ? undefined : true,
      unavailable: !orig && !r.quoted_text ? true : undefined,
    });
  }

  message(r: MessageRow, reactions?: { reactor: string; emoji: string }[]) {
    const media = r.media_mime
      ? compact({
          mime: r.media_mime, name: r.media_name, size: r.media_size, seconds: r.media_seconds,
          downloaded: !!r.media_path,
          uri: r.media_path ? mediaFileUri(this.session, r.chat_jid, r.id) : undefined,
        })
      : undefined;
    const extra = r.extra ? JSON.parse(r.extra) : undefined;
    const mentions = r.mentions ? (JSON.parse(r.mentions) as string[]) : undefined;
    return compact({
      id: r.id,
      chat: r.chat_jid,
      from_me: !!r.from_me || undefined,
      sender: r.from_me ? undefined : r.sender_jid,
      sender_name: r.from_me ? undefined : (this.name(r.sender_jid) ?? r.sender_name),
      time: iso(r.ts),
      ts: r.ts,
      type: r.type,
      text: r.text,
      caption: r.caption,
      quoted: this.quote(r),
      mentions,
      forwarded: !!r.forwarded,
      status: r.from_me && r.status !== null ? STATUS_NAMES[r.status] : undefined,
      starred: !!r.starred,
      edited: !!r.edited,
      deleted: !!r.deleted,
      pinned: !!r.pinned,
      media,
      extra,
      reactions: reactions?.map((x) => `${x.emoji} ${this.name(x.reactor) ?? x.reactor}`),
    });
  }

  messages(rows: MessageRow[]) {
    const byChat = new Map<string, string[]>();
    for (const r of rows) (byChat.get(r.chat_jid) ?? byChat.set(r.chat_jid, []).get(r.chat_jid)!).push(r.id);
    const reactions = new Map<string, { reactor: string; emoji: string }[]>();
    for (const [chat, ids] of byChat) for (const [id, list] of this.core.repo.reactionsFor(this.session, chat, ids)) reactions.set(`${chat}\u0000${id}`, list);
    return rows.map((r) => this.message(r, reactions.get(`${r.chat_jid}\u0000${r.id}`)));
  }

  /** A timeline entry saved with log_interaction (call made, meeting, to-do...). */
  interaction(i: InteractionRow) {
    const now = Math.floor(Date.now() / 1000);
    return compact({
      id: i.id,
      time: iso(i.ts),
      kind: i.kind,
      note: i.note,
      about_message: i.ref_id,
      resolved_pending: !!i.handled,
      status: i.status === 'open' ? (i.kind === 'waiting' ? 'waiting for their reply' : 'open') : i.kind === 'waiting' && i.resolved_at ? 'replied' : undefined,
      replied: i.kind === 'waiting' && i.resolved_at && i.resolved_by !== 'manual' ? iso(i.resolved_at) : undefined,
      reply_id: i.kind === 'waiting' && i.resolved_by && i.resolved_by !== 'manual' ? i.resolved_by : undefined,
      due: i.due_at ? iso(i.due_at) : undefined,
      overdue: i.status === 'open' && i.due_at && i.due_at < now ? true : undefined,
    });
  }

  chat(c: ChatRow) {
    const now = Math.floor(Date.now() / 1000);
    return compact({
      jid: c.jid,
      name: c.display_name ?? this.name(c.jid),
      kind: c.kind,
      unread: c.unread_count || undefined,
      archived: !!c.archived,
      pinned: !!c.pinned,
      muted: c.muted_until && (c.muted_until === -1 || c.muted_until > now) ? true : undefined,
      disappearing_s: c.ephemeral_duration || undefined,
      last_message: c.last_message_ts
        ? compact({ time: iso(c.last_message_ts), from_me: !!c.last_message_from_me, id: c.last_message_id, preview: c.last_message_preview })
        : undefined,
      tags: this.core.repo.tagsOf(this.session, c.jid),
      labels: this.core.repo.labelsOfChat(this.session, c.jid).map((l) => l.name ?? l.id),
    });
  }
}
