import type { Core } from '../core.js';
import type { MessageRow } from '../db/repo.js';
import { isGroupJid } from '../wa/jid.js';
import { renderTranscript } from './compact.js';
import { Presenter } from './present.js';

/**
 * Send guard: never answer a conversation that moved while you were thinking.
 *
 * Every tool that shows the agent incoming messages records a per-client "seen up to"
 * mark for that chat. Before a message is sent (and again right before it hits the wire)
 * we check for incoming messages newer than the mark. If there are any, the send is
 * refused and the new messages are returned instead, so the agent can adapt its reply.
 */

type Mark = [ts: number, rid: number];
const marks = new WeakMap<object, Map<string, Mark>>();      // newest INCOMING message seen (send guard)
const reads = new WeakMap<object, Map<string, Mark>>();      // newest message of ANY direction read (incremental reads)
const key = (session: string, chat: string) => `${session}\u0000${chat}`;

type Seen = Pick<MessageRow, 'from_me' | 'ts' | '_rid'>;

/** Record that `owner` (one MCP client connection) has now seen these messages. */
export function markSeen(owner: object, session: string, chat: string, rows: Seen[]): void {
  bump(reads, owner, key(session, chat), newest(rows, true));
  let best: Mark | undefined;
  for (const r of rows) {
    if (r.from_me) continue;
    if (!best || r.ts > best[0] || (r.ts === best[0] && r._rid > best[1])) best = [r.ts, r._rid];
  }
  if (!best) return;
  let m = marks.get(owner);
  if (!m) marks.set(owner, (m = new Map()));
  const cur = m.get(key(session, chat));
  if (!cur || best[0] > cur[0] || (best[0] === cur[0] && best[1] > cur[1])) m.set(key(session, chat), best);
}

function newest(rows: Seen[], anyDirection: boolean): Mark | undefined {
  let best: Mark | undefined;
  for (const r of rows) {
    if (!anyDirection && r.from_me) continue;
    if (!best || r.ts > best[0] || (r.ts === best[0] && r._rid > best[1])) best = [r.ts, r._rid];
  }
  return best;
}

function bump(store: WeakMap<object, Map<string, Mark>>, owner: object, k: string, mark?: Mark) {
  if (!mark) return;
  let m = store.get(owner);
  if (!m) store.set(owner, (m = new Map()));
  const cur = m.get(k);
  if (!cur || mark[0] > cur[0] || (mark[0] === cur[0] && mark[1] > cur[1])) m.set(k, mark);
}

/** Newest message (any direction) this client has been shown for the chat: "read up to here". */
export function readCursor(owner: object, session: string, chat: string): Mark | undefined {
  return reads.get(owner)?.get(key(session, chat));
}

export function seenMark(owner: object, session: string, chat: string): Mark | undefined {
  return marks.get(owner)?.get(key(session, chat));
}

const relevant = (m: MessageRow) => m.type !== 'system' && !m.deleted;

/**
 * Incoming messages the agent has not seen yet.
 *  - with a mark: everything newer than it
 *  - without a mark (never read in this client): direct chats only, everything they sent
 *    after my last reply / last call (what I would be answering blind)
 */
export function unseenIncoming(core: Core, owner: object, session: string, chat: string): MessageRow[] {
  const repo = core.repo;
  const mark = seenMark(owner, session, chat);
  if (mark) {
    return repo.listMessages(session, { chat, fromMe: false, after: mark, limit: 30 }).filter(relevant);
  }
  if (isGroupJid(chat)) return []; // busy groups: only enforce once the agent has read them
  const lastOut = repo.db.get<{ t: number | null }>('SELECT MAX(ts) AS t FROM messages WHERE session = ? AND chat_jid = ? AND from_me = 1', session, chat)?.t ?? 0;
  const handled = repo.handledTimes(session).get(chat) ?? 0;
  const since = Math.max(lastOut, handled);
  return repo.listMessages(session, { chat, fromMe: false, since: since || undefined, limit: 30 })
    .filter((m) => relevant(m) && m.ts > since)
    .reverse();
}

export class StaleChatError extends Error {
  constructor(message: string, readonly count: number) {
    super(message);
  }
}

/**
 * Throws StaleChatError (message NOT sent) when new incoming messages exist.
 * The new messages are marked as seen first, so calling the tool again goes through
 * once the agent has had the chance to react to them.
 */
export function assertFresh(core: Core, owner: object, session: string, chat: string): void {
  if (!core.cfg.freshnessGuard) return;
  if (chat.endsWith('@newsletter') || chat.endsWith('@broadcast')) return;
  const fresh = unseenIncoming(core, owner, session, chat);
  if (!fresh.length) {
    // nothing new: remember the current state so a later send is judged against it
    const latest = core.repo.listMessages(session, { chat, fromMe: false, limit: 1 });
    markSeen(owner, session, chat, latest);
    return;
  }
  markSeen(owner, session, chat, fresh);
  const p = new Presenter(core, session);
  const name = p.name(chat) ?? chat;
  const shown = p.messages(fresh.slice(-10));
  throw new StaleChatError(
    `NOT SENT: ${fresh.length} new incoming message(s) from "${name}" arrived since you last read this chat. ` +
    'Read them and make sure your reply still makes sense (adjust it if needed). They are included below and are now marked as seen: ' +
    'if your message is still appropriate, call the same tool again and it will be sent.\n' +
    `${name} <${chat}> · ${fresh.length} new${fresh.length > shown.length ? ` (last ${shown.length} shown)` : ''}\n` +
    renderTranscript(shown as any[], [], { ids: true, maxChars: 400 }).join('\n'),
    fresh.length,
  );
}
