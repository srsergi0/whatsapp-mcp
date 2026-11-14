/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Token-lean rendering of messages/inbox for LLMs.
 * A JSON message costs ~8x its content (repeated jids, ISO time + epoch, 32-char ids...);
 * a transcript line costs ~1.5x. Times are shown in the server's local timezone.
 */

export interface RenderOpts {
  /** append "#<last 8 chars of id>" so the message can be referenced by other tools */
  ids: boolean;
  /** cut long texts, with a marker telling how much was dropped */
  maxChars: number;
}

export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const hm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const ymd = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
const md = new Intl.DateTimeFormat('en-CA', { month: '2-digit', day: '2-digit' });

export const localHM = (ts: number) => hm.format(new Date(ts * 1000));
export const localDay = (ts: number) => ymd.format(new Date(ts * 1000));
/** "HH:MM" for today, "MM-DD HH:MM" otherwise */
export const localShort = (ts: number) => (localDay(ts) === localDay(Date.now() / 1000) ? localHM(ts) : `${md.format(new Date(ts * 1000))} ${localHM(ts)}`);

export const shortId = (id: string) => `#${id.slice(-8)}`;

/** seconds -> "3h 12m" / "2d 4h" */
export function humanAgo(sec: number): string {
  const m = Math.max(0, Math.round(sec / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m - h * 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function clip(s: string, max: number): string {
  if (max <= 0 || s.length <= max) return s;
  return `${s.slice(0, max)}…[+${s.length - max} chars]`;
}

const kb = (n?: number) => (n ? (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`) : '');

/** What the message is, in a few words. */
function bodyOf(m: any, max: number): string {
  const text = m.text ?? '';
  const cap = m.caption ?? '';
  const x = m.extra ?? {};
  const med = m.media ?? {};
  switch (m.type) {
    case 'text': return clip(text, max) + (x.link?.url && !text.includes(x.link.url) ? ` <${x.link.url}>` : '');
    case 'image': case 'video': return `[${m.type}${x.gif ? ' gif' : ''} ${kb(med.size)}${med.seconds ? ` ${med.seconds}s` : ''}]${cap ? ' ' + clip(cap, max) : ''}`.replace(/ \]/, ']');
    case 'voice': case 'audio': return `[${m.type}${med.seconds ? ` ${med.seconds}s` : ''}]`;
    case 'document': return `[doc ${med.name ?? ''} ${kb(med.size)}]${cap ? ' ' + clip(cap, max) : ''}`.replace(/ \]/, ']');
    case 'sticker': return '[sticker]';
    case 'location': return `[location ${x.latitude},${x.longitude}${x.name ? ' ' + x.name : ''}${x.address ? ' ' + x.address : ''}]`;
    case 'live_location': return `[live location ${x.latitude},${x.longitude}]`;
    case 'contact': case 'contacts': return `[contact ${(x.contacts ?? []).map((c: any) => `${c.name} ${(c.phones ?? []).join('/')}`).join('; ')}]`;
    case 'poll': return `[poll] ${clip(text, max)}: ${(x.options ?? []).join(' | ')}`;
    case 'event': return `[event] ${clip(text, max)}${x.description ? ' - ' + clip(x.description, 200) : ''}`;
    case 'system': return `· ${clip(text, max)}`;
    case 'button_response': case 'list_response': return `[choice] ${clip(text, max)}`;
    default: return text ? clip(text, max) : `[${m.type}]`;
  }
}

const STATUS_MARK: Record<string, string> = { read: ' ✓✓read', played: ' ✓✓played', failed: ' ✗failed' };

/** One message (plus quote/reactions lines) as transcript text. `stamp` formats the time prefix. */
export function renderMessage(m: any, o: RenderOpts, stamp: (ts: number) => string, withChat?: string): string {
  const who = m.from_me ? 'me' : (m.sender_name ?? m.sender ?? '?');
  const flags = `${m.edited ? ' (edited)' : ''}${m.deleted ? ' (deleted)' : ''}${m.starred ? ' ★' : ''}${m.pinned ? ' 📌' : ''}${m.forwarded ? ' (fwd)' : ''}`;
  const status = m.from_me ? (STATUS_MARK[m.status] ?? '') : '';
  const body = bodyOf(m, o.maxChars).replace(/\n/g, '\n    ');
  let out = `[${stamp(m.ts)}] ${withChat ? withChat + ' · ' : ''}${who}: ${body}${flags}${status}${o.ids ? ' ' + shortId(m.id) : ''}`;
  if (m.quoted) {
    const q = m.quoted;
    const qt = q.text ?? (q.unavailable ? '(original unavailable)' : `[${q.type ?? 'message'}]`);
    out += `\n    ↪ ${q.from ?? '?'}${q.time ? ' ' + localShort(Math.floor(Date.parse(q.time) / 1000)) : ''}: ${clip(String(qt).replace(/\n/g, ' '), Math.min(o.maxChars || 160, 160))}`;
  }
  if (m.reactions?.length) out += `\n    ${m.reactions.join(' ')}`;
  return out;
}

/** Messages and logged interactions, merged chronologically, with day headers. */
export function renderTranscript(messages: any[], notes: any[], o: RenderOpts): string[] {
  const items: { ts: number; line: string }[] = messages.map((m) => ({ ts: m.ts, line: renderMessage(m, o, localHM) }));
  for (const n of notes) {
    const ts = Math.floor(Date.parse(n.time) / 1000);
    items.push({ ts, line: `[${localHM(ts)}] ★ ${String(n.kind).toUpperCase()} (my note${n.resolved_pending ? ', resolved their pending' : ''}${n.status === 'open' ? ', OPEN' : ''}${n.due ? ', due ' + localShort(Math.floor(Date.parse(n.due) / 1000)) : ''}): ${clip(n.note, o.maxChars)} {n${n.id}}` });
  }
  items.sort((a, b) => a.ts - b.ts);
  const lines: string[] = [];
  let day = '';
  for (const it of items) {
    const d = localDay(it.ts);
    if (d !== day) { day = d; lines.push(`── ${d} ──`); }
    lines.push(it.line);
  }
  return lines;
}

export function chatHeader(name: string | null | undefined, jid: string, extra = ''): string {
  return `# ${name ? name + ' ' : ''}<${jid}>${extra ? ' · ' + extra : ''} · times ${TZ}`;
}

/** Inbox item(s) as text. `data` is the structure produced by computeInbox. */
export function renderInbox(data: any, o: RenderOpts): string {
  const s = data.summary;
  const lines: string[] = [
    `INBOX ${data.session} · ${s.chats_awaiting_my_reply} awaiting my reply · ${s.waiting_on_them ? `I wait on ${s.waiting_on_them} (${s.waiting_overdue || 0} overdue) · ` : ''}${s.chats_with_unread} chats / ${s.unread_messages} msgs unread${s.open_tasks ? ` · ${s.open_tasks} open tasks` : ''} · times ${TZ}`,
  ];
  data.items.forEach((it: any, i: number) => {
    const tags = [
      it.awaiting_reply ? `THEY WAIT ${it.waiting}${it.pending_count > 1 ? ` (${it.pending_count} msgs)` : ''}` : '',
      it.unread ? `unread ${it.unread}` : '',
      it.directed_at_me ? 'directed at me' : '',
      it.looks_like_question ? 'question?' : '',
      it.handled_outside_chat ? 'handled outside chat' : '',
      it.pinned ? 'pinned' : '',
      it.tags?.length ? `#${it.tags.join(' #')}` : '',
    ].filter(Boolean).join(' · ');
    lines.push(`${i + 1}. ${it.name ?? it.jid} <${it.jid}> · ${tags || it.kind}`);
    for (const n of it.my_notes ?? []) lines.push(`   ★ ${String(n.kind).toUpperCase()} ${localShort(Math.floor(Date.parse(n.time) / 1000))}: ${clip(n.note, 200)} {n${n.id}}`);
    if (it.already_seen) lines.push(`   (${it.already_seen} already shown earlier, hidden)`);
    for (const m of it.messages ?? []) lines.push('   ' + renderMessage(m, o, localShort).replace(/\n/g, '\n   '));
  });
  if (!data.items.length) lines.push('(nothing needs attention)');
  if (data.waiting_on_them?.length) {
    lines.push('I WAIT FOR THEIR REPLY');
    const nowTs = Math.floor(Date.now() / 1000);
    for (const w of data.waiting_on_them) {
      const since = Math.floor(Date.parse(w.time) / 1000);
      lines.push(`- ${w.chat_name ?? w.chat}: ${clip(w.note, 140)} · waiting ${humanAgo(nowTs - since)}${w.due ? ' · due ' + localShort(Math.floor(Date.parse(w.due) / 1000)) : ''}${w.overdue ? ' OVERDUE' : ''} {n${w.id}}`);
    }
  }
  if (data.tasks_due_soon?.length) {
    lines.push('TASKS DUE SOON');
    for (const t of data.tasks_due_soon) lines.push(`- ${t.chat_name ?? t.chat}: ${clip(t.note, 160)}${t.due ? ' (due ' + localShort(Math.floor(Date.parse(t.due) / 1000)) + ')' : ''}${t.overdue ? ' OVERDUE' : ''} {n${t.id}}`);
  }
  if (data.note) lines.push(data.note);
  return lines.join('\n');
}

/** follow_ups output as text. `data` is the structure produced by computeFollowUps. */
export function renderFollowUps(data: any, o: RenderOpts): string {
  const s = data.summary;
  const stages = Object.entries(s.by_stage ?? {}).map(([k, v]) => `${v} ${k}`).join(', ');
  const lines: string[] = [
    `FOLLOW-UPS ${data.session} · ${s.waiting_on_them} chats waiting on THEM${stages ? ` (${stages})` : ''}${s.hidden_max_attempts ? ` · ${s.hidden_max_attempts} hidden (max attempts reached)` : ''} · times ${TZ}`,
  ];
  data.items.forEach((it: any, i: number) => {
    const tags = [
      it.stage.toUpperCase(),
      `silent ${it.silent}`,
      `attempt${it.attempts === 1 ? '' : 's'} ${it.attempts}`,
      it.my_last_seen_by_them ? 'seen ✓✓' : '',
      it.their_messages ? `they wrote ${it.their_messages}` : '',
      it.tags?.length ? `#${it.tags.join(' #')}` : '',
    ].filter(Boolean).join(' · ');
    lines.push(`${i + 1}. ${it.name ?? it.jid} <${it.jid}> · ${tags}`);
    for (const n of it.my_notes ?? []) lines.push(`   ★ ${String(n.kind).toUpperCase()}${n.status === 'open' ? ' OPEN' : ''} ${localShort(Math.floor(Date.parse(n.time) / 1000))}: ${clip(n.note, 200)} {n${n.id}}`);
    for (const m of it.messages ?? []) lines.push('   ' + renderMessage(m, o, localShort).replace(/\n/g, '\n   '));
  });
  if (!data.items.length) lines.push('(nobody to follow up)');
  if (data.note) lines.push(data.note);
  return lines.join('\n');
}
