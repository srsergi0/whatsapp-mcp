import { proto, type AnyMessageContent, type MiscMessageGenerationOptions, type WAMessage } from 'baileys';
import type { Core } from '../core.js';
import type { ScheduledRow } from '../db/repo.js';
import { toJid } from './jid.js';
import { loadSource, toStickerWebp, toVoiceOpus, type MediaSource } from './media.js';
import { parseRaw, toNum } from './message-utils.js';
import type { WaSession } from './session.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CommonSend {
  /** id of a stored message in the same chat to reply to */
  quoted_id?: string;
  /** phones / jids to @mention (the text should contain @<number>) */
  mentions?: string[];
  /** disappearing-message timer to stamp on this message (seconds) */
  ephemeral_seconds?: number;
  /** show "typing..." for N ms before sending */
  typing_ms?: number;
  /** Called right before the message goes out; throw to abort (freshness guard). */
  beforeSend?: () => void | Promise<void>;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';

export interface SentInfo { id: string; chat: string; ts: number; type: string; from_me: true }

function info(msg: WAMessage, type: string): SentInfo {
  return { id: msg.key.id!, chat: msg.key.remoteJid!, ts: toNum(msg.messageTimestamp) ?? Math.floor(Date.now() / 1000), type, from_me: true };
}

/** Rebuild a stored message as the WAMessage Baileys needs for quoting / forwarding / keys. */
export function storedWaMessage(core: Core, s: WaSession, chat: string, id: string): WAMessage {
  const row = core.repo.getMessage(s.name, chat, id, true);
  if (!row) throw new Error(`Message ${id} not found in the local store for ${chat}. It can only be referenced if this server has seen it.`);
  const message = parseRaw(row.raw ?? undefined);
  if (!message) throw new Error(`Message ${id} has no stored payload (system or history-only entry).`);
  return {
    key: { remoteJid: chat, id, fromMe: !!row.from_me, ...(row.sender_jid && !row.from_me && chat.endsWith('@g.us') ? { participant: row.sender_jid } : {}) },
    message,
    messageTimestamp: row.ts,
    pushName: row.sender_name ?? undefined,
  } as WAMessage;
}

function prepare(core: Core, s: WaSession, jid: string, c: CommonSend): { options: MiscMessageGenerationOptions; mentions?: string[] } {
  const options: MiscMessageGenerationOptions = {};
  if (c.quoted_id) options.quoted = storedWaMessage(core, s, jid, c.quoted_id);
  const exp = c.ephemeral_seconds ?? core.repo.getChat(s.name, jid)?.ephemeral_duration ?? undefined;
  if (exp) options.ephemeralExpiration = exp;
  const mentions = c.mentions?.length ? c.mentions.map(toJid) : undefined;
  return { options, mentions };
}

async function deliver(core: Core, s: WaSession, jid: string, content: AnyMessageContent, c: CommonSend, type: string): Promise<SentInfo> {
  const { options, mentions } = prepare(core, s, jid, c);
  if (mentions) (content as any).mentions = mentions;
  if (c.typing_ms) await s.typing(jid, c.typing_ms, type === 'voice' ? 'recording' : 'composing').catch(() => undefined);
  return info(await s.send(jid, content, options, c.beforeSend), type);
}

/* ---------------------------------- builders ---------------------------------- */

export async function sendText(core: Core, s: WaSession, to: string, a: CommonSend & { text: string; link_preview?: boolean }) {
  const jid = toJid(to);
  return deliver(core, s, jid, { text: a.text, ...(a.link_preview === false ? { linkPreview: null } : {}) } as any, a, 'text');
}

export interface MediaArgs extends CommonSend, MediaSource {
  kind: MediaKind;
  caption?: string;
  view_once?: boolean;
  /** treat a video as a looping GIF */
  gif?: boolean;
  /** animated sticker from gif/video (needs ffmpeg) */
  animated?: boolean;
}

export async function sendMedia(core: Core, s: WaSession, to: string, a: MediaArgs) {
  const jid = toJid(to);
  const m = await loadSource(a, core.cfg);
  let content: any;
  switch (a.kind) {
    case 'image':
      content = { image: m.buffer, caption: a.caption, mimetype: m.mimetype.startsWith('image/') ? m.mimetype : undefined, ...(a.view_once ? { viewOnce: true } : {}) };
      break;
    case 'video':
      content = { video: m.buffer, caption: a.caption, mimetype: m.mimetype.startsWith('video/') ? m.mimetype : undefined, gifPlayback: !!a.gif, ...(a.view_once ? { viewOnce: true } : {}) };
      break;
    case 'audio':
      content = { audio: m.buffer, mimetype: m.mimetype.startsWith('audio/') ? m.mimetype : 'audio/mpeg', ptt: false };
      break;
    case 'voice': {
      const v = await toVoiceOpus(m);
      content = { audio: v.buffer, mimetype: v.mimetype, ptt: true };
      break;
    }
    case 'document':
      content = { document: m.buffer, mimetype: m.mimetype, fileName: m.fileName, caption: a.caption };
      break;
    case 'sticker': {
      const animated = a.animated ?? /^(image\/gif|video\/)/.test(m.mimetype);
      const webp = m.mimetype === 'image/webp' ? m.buffer : await toStickerWebp(m, animated);
      content = { sticker: webp };
      break;
    }
  }
  return deliver(core, s, jid, content, a, a.kind);
}

export async function sendLocation(core: Core, s: WaSession, to: string, a: CommonSend & { latitude: number; longitude: number; name?: string; address?: string }) {
  const jid = toJid(to);
  return deliver(core, s, jid, { location: { degreesLatitude: a.latitude, degreesLongitude: a.longitude, name: a.name, address: a.address } }, a, 'location');
}

export interface ContactArg { name: string; phone: string; organization?: string; email?: string }

export function vcard(c: ContactArg): string {
  const digits = c.phone.replace(/\D/g, '');
  if (!/^\d{7,15}$/.test(digits)) throw new Error(`Invalid contact phone: ${c.phone}`);
  const esc = (v: string) => v.replace(/[\\;,\n]/g, (m) => (m === '\n' ? '\\n' : '\\' + m));
  return [
    'BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(c.name)}`, `N:;${esc(c.name)};;;`,
    ...(c.organization ? [`ORG:${esc(c.organization)}`] : []),
    `TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}`,
    ...(c.email ? [`EMAIL;type=INTERNET:${esc(c.email)}`] : []),
    'END:VCARD',
  ].join('\n');
}

export async function sendContacts(core: Core, s: WaSession, to: string, a: CommonSend & { contacts: ContactArg[] }) {
  const jid = toJid(to);
  const cards = a.contacts.map((c) => ({ displayName: c.name, vcard: vcard(c) }));
  return deliver(core, s, jid, { contacts: { displayName: cards.length === 1 ? cards[0]!.displayName : `${cards.length} contacts`, contacts: cards } }, a, cards.length === 1 ? 'contact' : 'contacts');
}

export async function sendPoll(core: Core, s: WaSession, to: string, a: CommonSend & { question: string; options: string[]; selectable_count?: number }) {
  const jid = toJid(to);
  const opts = [...new Set(a.options.map((o) => o.trim()).filter(Boolean))];
  if (opts.length < 2 || opts.length > 12) throw new Error('A poll needs 2-12 distinct options.');
  const sel = a.selectable_count ?? 1;
  if (sel < 0 || sel > opts.length) throw new Error(`selectable_count must be between 0 (unlimited) and ${opts.length}.`);
  return deliver(core, s, jid, { poll: { name: a.question, values: opts, selectableCount: sel } }, a, 'poll');
}

export async function sendEvent(core: Core, s: WaSession, to: string, a: CommonSend & {
  name: string; start: string; end?: string; description?: string; location_name?: string; call_type?: 'audio' | 'video'; allow_extra_guests?: boolean;
}) {
  const jid = toJid(to);
  const startDate = new Date(a.start);
  if (Number.isNaN(startDate.getTime())) throw new Error('Invalid "start": use an ISO-8601 date-time, e.g. 2026-11-02T18:00:00-05:00');
  const endDate = a.end ? new Date(a.end) : undefined;
  if (endDate && (Number.isNaN(endDate.getTime()) || endDate <= startDate)) throw new Error('"end" must be a valid date after "start".');
  return deliver(core, s, jid, {
    event: {
      name: a.name, description: a.description, startDate, ...(endDate ? { endDate } : {}),
      ...(a.location_name ? { location: { name: a.location_name } } : {}), ...(a.call_type ? { call: a.call_type } : {}), extraGuestsAllowed: !!a.allow_extra_guests,
    },
  } as any, a, 'event');
}

export async function reactTo(core: Core, s: WaSession, chat: string, messageId: string, emoji: string) {
  const jid = toJid(chat);
  const key = storedWaMessage(core, s, jid, messageId).key;
  return info(await s.send(jid, { react: { text: emoji, key } }), 'reaction');
}

export async function editText(core: Core, s: WaSession, chat: string, messageId: string, text: string) {
  const jid = toJid(chat);
  const row = core.repo.getMessage(s.name, jid, messageId);
  if (!row) throw new Error(`Message ${messageId} not found locally.`);
  if (!row.from_me) throw new Error('Only your own messages can be edited.');
  if (!['text'].includes(row.type) && !row.caption) throw new Error('Only text messages (or media captions) can be edited.');
  if (Date.now() / 1000 - row.ts > 15 * 60) throw new Error('WhatsApp only allows editing within 15 minutes of sending.');
  const key = { remoteJid: jid, id: messageId, fromMe: true };
  const sent = await s.send(jid, { text, edit: key } as any);
  core.repo.patchMessage(s.name, jid, messageId, row.type === 'text' ? { text, edited: true } : { caption: text, edited: true }, true);
  return info(sent, 'edit');
}

export async function revokeMessage(core: Core, s: WaSession, chat: string, messageId: string) {
  const jid = toJid(chat);
  const row = core.repo.getMessage(s.name, jid, messageId);
  if (!row) throw new Error(`Message ${messageId} not found locally.`);
  const key: any = { remoteJid: jid, id: messageId, fromMe: !!row.from_me };
  if (!row.from_me && jid.endsWith('@g.us') && row.sender_jid) key.participant = row.sender_jid;
  await s.send(jid, { delete: key });
  core.repo.markDeleted(s.name, jid, messageId);
  return { id: messageId, chat: jid, deleted_for_everyone: true };
}

export async function forwardMessage(core: Core, s: WaSession, from: string, messageId: string, to: string) {
  const src = toJid(from);
  const dst = toJid(to);
  const msg = storedWaMessage(core, s, src, messageId);
  const sent = await s.send(dst, { forward: msg } as any);
  return info(sent, 'forward');
}

export async function pinMessage(core: Core, s: WaSession, chat: string, messageId: string, pin: boolean, durationSeconds: 86400 | 604800 | 2592000) {
  const jid = toJid(chat);
  const key = storedWaMessage(core, s, jid, messageId).key;
  await s.send(jid, { pin: key, type: pin ? proto.PinInChat.Type.PIN_FOR_ALL : proto.PinInChat.Type.UNPIN_FOR_ALL, time: durationSeconds } as any);
  core.repo.patchMessage(s.name, jid, messageId, { pinned: pin });
  return { id: messageId, chat: jid, pinned: pin };
}

/* --------------------------------- scheduled --------------------------------- */

export type ScheduledKind = 'text' | 'media' | 'location' | 'contacts' | 'poll';

export async function sendScheduled(core: Core, s: WaSession, row: ScheduledRow): Promise<string> {
  const args = JSON.parse(row.payload) as any;
  let r: SentInfo;
  switch (row.kind as ScheduledKind) {
    case 'text': r = await sendText(core, s, row.to_jid, args); break;
    case 'media': r = await sendMedia(core, s, row.to_jid, args); break;
    case 'location': r = await sendLocation(core, s, row.to_jid, args); break;
    case 'contacts': r = await sendContacts(core, s, row.to_jid, args); break;
    case 'poll': r = await sendPoll(core, s, row.to_jid, args); break;
    default: throw new Error(`Unknown scheduled kind ${row.kind}`);
  }
  return r.id;
}
