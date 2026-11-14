import type { Core } from '../core.js';
import type { MessageRow } from '../db/repo.js';
import { iso } from '../util.js';
import { bare } from '../wa/jid.js';
import { markSeen, readCursor } from './freshness.js';
import { Presenter, compact } from './present.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const DISMISS_KEY = '_inbox_dismissed';

export interface InboxOpts {
  /** unread: chats with unread messages | unanswered: waiting for MY reply | any: either */
  filter: 'unread' | 'unanswered' | 'any';
  /** Only count a chat as unanswered after this many minutes of waiting. */
  minWaitMinutes: number;
  /** Ignore unanswered chats whose last incoming message is older than this. */
  maxAgeDays: number;
  includeGroups: boolean;
  includeArchived: boolean;
  includeMuted: boolean;
  includeDismissed: boolean;
  /** Messages shown per chat. */
  perChat: number;
  limit: number;
  sort: 'oldest' | 'newest';
  /** Hide messages this client already read (needs `owner`). */
  skipSeen?: boolean;
}

export function humanDuration(minutes: number): string {
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h}h ${Math.round(minutes - h * 60)}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h - d * 24}h`;
}

/**
 * The "what needs my attention" view, computed from the local store:
 *  - unread: the chat has unread incoming messages
 *  - awaiting_reply: the newest real message is from them and I have not answered since
 *    (in groups only messages that @mention me or quote me count)
 */
export function computeInbox(core: Core, session: string, o: InboxOpts, owner?: object) {
  const repo = core.repo;
  const p = new Presenter(core, session);
  const me = repo.getSession(session);
  const myIds = new Set([me?.jid, me?.lid].filter(Boolean).map((j) => bare(j!)));
  const now = Math.floor(Date.now() / 1000);

  const directed = (m: MessageRow) => {
    if (m.quoted_sender && myIds.has(bare(m.quoted_sender))) return true;
    if (!m.mentions) return false;
    try { return (JSON.parse(m.mentions) as string[]).some((j) => myIds.has(bare(j))); } catch { return false; }
  };

  let unreadChats = 0, unreadMessages = 0, awaitingChats = 0;
  const items: any[] = [];
  // things the user did outside WhatsApp (call, meeting, "handled") count like a reply
  const handledAt = repo.handledTimes(session);

  for (const c of repo.inboxCandidates(session, { includeArchived: o.includeArchived, includeMuted: o.includeMuted, includeGroups: o.includeGroups })) {
    if (c.blocked) continue;
    const isGroup = c.kind !== 'user';
    const outT = Math.max(c.last_out_ts ?? 0, handledAt.get(c.jid) ?? 0);
    const unread = c.unread_count > 0;

    // incoming messages after my last outgoing one
    let pending: MessageRow[] = [];
    if (c.last_in_ts !== null && c.last_in_ts > outT) {
      pending = repo.listMessages(session, { chat: c.jid, fromMe: false, since: outT || undefined, limit: 80 })
        .filter((m) => m.ts > outT && m.type !== 'system' && !m.deleted);
      if (isGroup) pending = pending.filter(directed);
    }
    let awaiting = pending.length > 0;
    let waitingSince = pending.length ? pending[pending.length - 1]!.ts : undefined; // list is newest-first
    if (awaiting) {
      const dismissed = Number(repo.getMemory(session, c.jid, DISMISS_KEY, true)[0]?.value ?? 0);
      if (!o.includeDismissed && c.last_in_ts !== null && c.last_in_ts <= dismissed) awaiting = false;
      else if (c.last_in_ts !== null && now - c.last_in_ts > o.maxAgeDays * 86400) awaiting = false;
      else if (waitingSince !== undefined && (now - waitingSince) / 60 < o.minWaitMinutes) awaiting = false;
    }

    if (unread) { unreadChats++; unreadMessages += c.unread_count; }
    if (awaiting) awaitingChats++;

    const wanted = o.filter === 'unread' ? unread : o.filter === 'unanswered' ? awaiting : unread || awaiting;
    if (!wanted) continue;

    let shown: MessageRow[];
    if (awaiting) shown = pending.slice(0, o.perChat);
    else shown = repo.listMessages(session, { chat: c.jid, fromMe: false, limit: Math.min(Math.max(c.unread_count, 1), o.perChat) });
    shown = [...shown].reverse();
    let alreadySeen = 0;
    if (owner && o.skipSeen) {
      const cursor = readCursor(owner, session, c.jid);
      if (cursor) {
        const fresh = shown.filter((m) => m.ts > cursor[0] || (m.ts === cursor[0] && m._rid > cursor[1]));
        alreadySeen = shown.length - fresh.length;
        shown = fresh;
      }
    }
    if (owner) markSeen(owner, session, c.jid, shown);

    const last = shown[shown.length - 1];
    const lastText = last ? (last.text ?? last.caption ?? '') : '';
    const refTs = awaiting ? waitingSince : last?.ts;
    const waitMin = awaiting && waitingSince !== undefined ? (now - waitingSince) / 60 : undefined;

    items.push({
      _sort: refTs ?? 0,
      ...compact({
        jid: c.jid,
        name: c.display_name ?? p.name(c.jid),
        kind: c.kind,
        unread: c.unread_count || undefined,
        awaiting_reply: awaiting,
        waiting: waitMin !== undefined ? humanDuration(waitMin) : undefined,
        waiting_minutes: waitMin !== undefined ? Math.round(waitMin) : undefined,
        waiting_since: awaiting && waitingSince ? iso(waitingSince) : undefined,
        directed_at_me: isGroup && awaiting ? true : undefined,
        looks_like_question: awaiting && /[?¿]/.test(lastText) ? true : undefined,
        pending_count: awaiting ? pending.length : undefined,
        last_reply_from_me: c.last_out_ts ? iso(c.last_out_ts) : undefined,
        handled_outside_chat: handledAt.get(c.jid) ? iso(handledAt.get(c.jid)!) : undefined,
        pinned: !!c.pinned,
        tags: repo.tagsOf(session, c.jid),
        // what the user already did/agreed about this chat: read it before suggesting a reply
        already_seen: alreadySeen || undefined,
        my_notes: repo.listInteractions(session, { jid: c.jid, limit: 3 }).map((i) => p.interaction(i)),
        messages: p.messages(shown),
      }),
    });
  }

  // to-dos I owe vs. replies I am waiting for from THEM (kind "waiting") are different lists
  const dueTasks = repo.listInteractions(session, { status: 'open', dueBefore: now + 86400, limit: 30 })
    .filter((i) => i.kind !== 'waiting').slice(0, 10)
    .map((i) => ({ ...p.interaction(i), chat: i.jid, chat_name: p.name(i.jid) ?? undefined }));
  const openTasks = repo.listInteractions(session, { status: 'open', limit: 500 }).filter((i) => i.kind !== 'waiting').length;
  const waitingOn = repo.openWaiting(session, { limit: 15 })
    .map((i) => ({ ...p.interaction(i), chat: i.jid, chat_name: p.name(i.jid) ?? undefined }));
  const waitingOverdue = waitingOn.filter((w: any) => w.overdue).length;

  items.sort((a, b) => (o.sort === 'oldest' ? a._sort - b._sort : b._sort - a._sort));
  const total = items.length;
  const out = items.slice(0, o.limit).map(({ _sort, ...rest }) => rest);
  return {
    session,
    summary: { chats_with_unread: unreadChats, unread_messages: unreadMessages, chats_awaiting_my_reply: awaitingChats, listed: out.length, matching: total, open_tasks: openTasks, ...(waitingOn.length ? { waiting_on_them: waitingOn.length, waiting_overdue: waitingOverdue } : {}) },
    items: out,
    tasks_due_soon: dueTasks.length ? dueTasks : undefined,
    waiting_on_them: waitingOn.length ? waitingOn : undefined,
    sort: o.sort,
    note: total > out.length ? `Showing ${out.length} of ${total}; raise limit or tighten filters.` : undefined,
  };
}

/** Chats tagged with one of these never show up in follow_ups (set with chat_tags). */
export const NO_FOLLOWUP_TAGS = ['no-followup', 'no_followup'];
/** My messages closer than this belong to the same follow-up attempt ("Hola" + "¿cómo estás?" = 1). */
const ATTEMPT_GAP = 6 * 3600;

export interface FollowUpOpts {
  /** Only chats where my last message is at least this old. */
  minSilenceHours: number;
  /** Ignore chats where my last message is older than this. */
  maxAgeDays: number;
  /** Hide chats where I already made this many attempts without an answer (0 = no limit). */
  maxAttempts: number;
  /** Also list chats where they never wrote (cold outreach I started). */
  includeNeverReplied: boolean;
  includeGroups: boolean;
  includeArchived: boolean;
  excludeTags: string[];
  perChat: number;
  limit: number;
  sort: 'priority' | 'oldest' | 'newest';
}

/**
 * The "who went silent on me" view: chats where MY message is the newest (they never answered it),
 * with how many attempts I already made, whether a proposal/document was sent, and my notes/tasks.
 * Used to recover leads without spamming the ones I already chased several times.
 */
export function computeFollowUps(core: Core, session: string, o: FollowUpOpts, owner?: object) {
  const repo = core.repo;
  const p = new Presenter(core, session);
  const now = Math.floor(Date.now() / 1000);
  const handledAt = repo.handledTimes(session);
  const excluded = new Set(o.excludeTags);
  const items: any[] = [];
  let exhausted = 0;

  for (const c of repo.inboxCandidates(session, { includeArchived: o.includeArchived, includeMuted: true, includeGroups: o.includeGroups })) {
    if (c.blocked || c.last_out_ts === null) continue;
    const lastIn = c.last_in_ts ?? 0;
    if (c.last_out_ts <= lastIn) continue; // they spoke last: that is inbox territory
    if (!lastIn && !o.includeNeverReplied) continue;
    // a call/meeting logged after my last message means the conversation moved outside WhatsApp
    if ((handledAt.get(c.jid) ?? 0) > c.last_out_ts) continue;
    const silence = now - c.last_out_ts;
    if (silence < o.minSilenceHours * 3600 || silence > o.maxAgeDays * 86400) continue;
    const tags = repo.tagsOf(session, c.jid);
    if (tags.some((t) => excluded.has(t))) continue;

    // my messages since their last one, oldest first, grouped into attempts
    const mine = repo.listMessages(session, { chat: c.jid, fromMe: true, since: lastIn || undefined, limit: 200 })
      .filter((m) => m.ts > lastIn && !m.deleted).reverse();
    let attempts = 0, prev = -Infinity;
    for (const m of mine) { if (m.ts - prev > ATTEMPT_GAP) attempts++; prev = m.ts; }
    if (o.maxAttempts > 0 && attempts >= o.maxAttempts) { exhausted++; continue; }

    const theirCount = lastIn ? repo.listMessages(session, { chat: c.jid, fromMe: false, limit: 50 }).filter((m) => m.type !== 'system').length : 0;
    const sentDocs = repo.listMessages(session, { chat: c.jid, fromMe: true, type: 'document', limit: 1 }).length > 0;
    const openTasks = repo.listInteractions(session, { jid: c.jid, status: 'open', limit: 5 });
    // a proposal sent or a real back-and-forth makes a lead warm; a lone "Quiero más información" is cold
    const stage = sentDocs ? 'proposal_sent' : theirCount > 1 ? 'engaged' : lastIn ? 'cold' : 'never_replied';

    const shown = repo.listMessages(session, { chat: c.jid, limit: o.perChat }).reverse();
    if (owner) markSeen(owner, session, c.jid, shown);
    const last = mine[mine.length - 1];
    items.push({
      _rank: ({ proposal_sent: 0, engaged: 1, cold: 2, never_replied: 3 } as const)[stage] * 100 + attempts,
      _ts: c.last_out_ts,
      ...compact({
        jid: c.jid,
        name: c.display_name ?? p.name(c.jid),
        kind: c.kind,
        stage,
        attempts,
        silent: humanDuration(silence / 60),
        silent_hours: Math.round(silence / 3600),
        my_last_message: iso(c.last_out_ts),
        my_last_seen_by_them: last && (last.status ?? 0) >= 4 ? true : undefined, // 4 read, 5 played
        their_last_message: lastIn ? iso(lastIn) : undefined,
        their_messages: theirCount || undefined,
        open_tasks: openTasks.length ? openTasks.map((i) => p.interaction(i)) : undefined,
        tags: tags.length ? tags : undefined,
        my_notes: repo.listInteractions(session, { jid: c.jid, limit: 3 }).map((i) => p.interaction(i)),
        messages: p.messages(shown),
      }),
    });
  }

  if (o.sort === 'priority') items.sort((a, b) => a._rank - b._rank || a._ts - b._ts);
  else items.sort((a, b) => (o.sort === 'oldest' ? a._ts - b._ts : b._ts - a._ts));
  const total = items.length;
  const out = items.slice(0, o.limit).map(({ _rank, _ts, ...rest }) => rest);
  const byStage: Record<string, number> = {};
  for (const i of items) byStage[i.stage] = (byStage[i.stage] ?? 0) + 1;
  return {
    session,
    summary: { waiting_on_them: total, listed: out.length, by_stage: byStage, hidden_max_attempts: exhausted || undefined },
    items: out,
    sort: o.sort,
    note: total > out.length ? `Showing ${out.length} of ${total}; raise limit or tighten filters.` : undefined,
  };
}
