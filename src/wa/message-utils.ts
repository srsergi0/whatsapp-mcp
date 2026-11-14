import { BufferJSON, getContentType, normalizeMessageContent, proto, type WAMessage } from 'baileys';
import { bare, isGroupJid, STATUS_JID } from './jid.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export type MsgType =
  | 'text' | 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker' | 'location'
  | 'live_location' | 'contact' | 'contacts' | 'poll' | 'event' | 'button_response'
  | 'list_response' | 'product' | 'order' | 'group_invite' | 'call_log' | 'system' | 'unknown';

export interface NormalizedMessage {
  chat_jid: string;
  id: string;
  from_me: boolean;
  sender_jid: string | null;
  sender_name: string | null;
  ts: number;
  type: MsgType;
  text: string | null;
  caption: string | null;
  quoted_id: string | null;
  quoted_sender: string | null;
  quoted_text: string | null;
  quoted_type: string | null;
  mentions: string[];
  forwarded: boolean;
  status: number | null;
  ephemeral_expiration: number | null;
  media_mime: string | null;
  media_name: string | null;
  media_size: number | null;
  media_seconds: number | null;
  extra: Record<string, unknown> | null;
  raw: string | null;
  has_media: boolean;
}

/** Message types that carry no user-visible content of their own. */
const SKIP_TYPES = new Set([
  'protocolMessage', 'senderKeyDistributionMessage', 'reactionMessage', 'pollUpdateMessage',
  'encReactionMessage', 'encEventResponseMessage', 'keepInChatMessage', 'messageContextInfo',
  'peerDataOperationRequestMessage', 'peerDataOperationRequestResponseMessage',
  'secretEncryptedMessage', 'botInvokeMessage', 'requestWelcomeMessage',
]);

const STRIP_KEYS = new Set(['jpegThumbnail', 'pngThumbnail', 'thumbnail', 'thumbnailSha256', 'thumbnailEncSha256', 'streamingSidecar', 'scansSidecar']);

export function serializeRaw(message: proto.IMessage | null | undefined): string | null {
  if (!message) return null;
  return JSON.stringify(message, (k, v) => (STRIP_KEYS.has(k) ? undefined : BufferJSON.replacer(k, v)));
}

export function parseRaw(raw: string | null | undefined): proto.IMessage | undefined {
  if (!raw) return undefined;
  try {
    return proto.Message.fromObject(JSON.parse(raw, BufferJSON.reviver));
  } catch {
    return undefined;
  }
}

const long = (v: any): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v?.toNumber === 'function') return v.toNumber();
  if (typeof v === 'object' && 'low' in v) return Number(v.low) + Number(v.high) * 4294967296;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
export const toNum = long;

const STUB_NAMES: Record<number, string> = (() => {
  const out: Record<number, string> = {};
  for (const [k, v] of Object.entries(proto.WebMessageInfo.StubType)) if (typeof v === 'number') out[v] = k;
  return out;
})();

function previewOf(m: any): { type: MsgType; text: string | null; caption: string | null; extra: Record<string, unknown> | null } {
  const type = getContentType(m) as string | undefined;
  switch (type) {
    case 'conversation':
      return { type: 'text', text: m.conversation, caption: null, extra: null };
    case 'extendedTextMessage': {
      const e = m.extendedTextMessage;
      const extra: Record<string, unknown> = {};
      if (e.matchedText || e.canonicalUrl) extra.link = { url: e.canonicalUrl || e.matchedText, title: e.title, description: e.description };
      return { type: 'text', text: e.text ?? '', caption: null, extra: Object.keys(extra).length ? extra : null };
    }
    case 'imageMessage':
      return { type: 'image', text: null, caption: m.imageMessage.caption ?? null, extra: m.imageMessage.viewOnce ? { view_once: true } : null };
    case 'videoMessage':
      return { type: 'video', text: null, caption: m.videoMessage.caption ?? null, extra: { ...(m.videoMessage.gifPlayback ? { gif: true } : {}), ...(m.videoMessage.viewOnce ? { view_once: true } : {}) } };
    case 'ptvMessage':
      return { type: 'video', text: null, caption: null, extra: { video_note: true } };
    case 'audioMessage':
      return { type: m.audioMessage.ptt ? 'voice' : 'audio', text: null, caption: null, extra: null };
    case 'documentMessage':
      return { type: 'document', text: null, caption: m.documentMessage.caption ?? null, extra: m.documentMessage.pageCount ? { pages: m.documentMessage.pageCount } : null };
    case 'stickerMessage':
      return { type: 'sticker', text: null, caption: null, extra: { animated: !!m.stickerMessage.isAnimated } };
    case 'locationMessage': {
      const l = m.locationMessage;
      return { type: 'location', text: [l.name, l.address].filter(Boolean).join(' - ') || null, caption: null, extra: { latitude: l.degreesLatitude, longitude: l.degreesLongitude, name: l.name, address: l.address, url: l.url } };
    }
    case 'liveLocationMessage': {
      const l = m.liveLocationMessage;
      return { type: 'live_location', text: l.caption ?? null, caption: null, extra: { latitude: l.degreesLatitude, longitude: l.degreesLongitude } };
    }
    case 'contactMessage': {
      const c = m.contactMessage;
      return { type: 'contact', text: c.displayName ?? null, caption: null, extra: { contacts: [{ name: c.displayName, phones: phonesFromVcard(c.vcard) }] } };
    }
    case 'contactsArrayMessage': {
      const c = m.contactsArrayMessage;
      return { type: 'contacts', text: c.displayName ?? null, caption: null, extra: { contacts: (c.contacts ?? []).map((x: any) => ({ name: x.displayName, phones: phonesFromVcard(x.vcard) })) } };
    }
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
    case 'pollCreationMessageV4':
    case 'pollCreationMessageV5': {
      const p = m[type];
      return { type: 'poll', text: p.name ?? null, caption: null, extra: { options: (p.options ?? []).map((o: any) => o.optionName), selectable: p.selectableOptionsCount } };
    }
    case 'eventMessage': {
      const e = m.eventMessage;
      return { type: 'event', text: e.name ?? null, caption: null, extra: { description: e.description, start: long(e.startTime), end: long(e.endTime), location: e.location?.name, canceled: !!e.isCanceled } };
    }
    case 'buttonsResponseMessage':
      return { type: 'button_response', text: m.buttonsResponseMessage.selectedDisplayText ?? m.buttonsResponseMessage.selectedButtonId ?? null, caption: null, extra: { id: m.buttonsResponseMessage.selectedButtonId } };
    case 'templateButtonReplyMessage':
      return { type: 'button_response', text: m.templateButtonReplyMessage.selectedDisplayText ?? null, caption: null, extra: { id: m.templateButtonReplyMessage.selectedId } };
    case 'listResponseMessage':
      return { type: 'list_response', text: m.listResponseMessage.title ?? null, caption: null, extra: { id: m.listResponseMessage.singleSelectReply?.selectedRowId } };
    case 'interactiveResponseMessage':
      return { type: 'button_response', text: m.interactiveResponseMessage.body?.text ?? null, caption: null, extra: null };
    case 'buttonsMessage':
      return { type: 'text', text: m.buttonsMessage.contentText ?? null, caption: null, extra: { buttons: true } };
    case 'listMessage':
      return { type: 'text', text: m.listMessage.description ?? m.listMessage.title ?? null, caption: null, extra: { list: true } };
    case 'productMessage':
      return { type: 'product', text: m.productMessage.product?.title ?? null, caption: null, extra: { product_id: m.productMessage.product?.productId } };
    case 'orderMessage':
      return { type: 'order', text: m.orderMessage.message ?? null, caption: null, extra: { order_id: m.orderMessage.orderId, items: m.orderMessage.itemCount } };
    case 'groupInviteMessage':
      return { type: 'group_invite', text: m.groupInviteMessage.groupName ?? null, caption: null, extra: { code: m.groupInviteMessage.inviteCode, group_jid: m.groupInviteMessage.groupJid } };
    case 'call':
    case 'scheduledCallCreationMessage':
      return { type: 'call_log', text: null, caption: null, extra: null };
    default:
      return { type: 'unknown', text: null, caption: null, extra: type ? { content_type: type } : null };
  }
}

function phonesFromVcard(vcard?: string | null): string[] {
  if (!vcard) return [];
  const out: string[] = [];
  for (const line of vcard.split(/\r?\n/)) {
    const m = /^(?:item\d+\.)?TEL[^:]*:(.+)$/i.exec(line);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

export function mediaOf(m: any): { node: any; kind: string } | undefined {
  const t = getContentType(m) as string | undefined;
  if (t && ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'ptvMessage'].includes(t)) {
    return { node: m[t], kind: t };
  }
  return undefined;
}

export function contextInfoOf(m: any): any | undefined {
  const t = getContentType(m) as string | undefined;
  return t ? m[t]?.contextInfo : undefined;
}

/** One-line human summary of any message content, used for quoted previews and chat previews. */
export function summarize(type: string, text: string | null, caption: string | null): string {
  const label: Record<string, string> = {
    image: '[image]', video: '[video]', audio: '[audio]', voice: '[voice note]', document: '[document]', sticker: '[sticker]',
    location: '[location]', live_location: '[live location]', contact: '[contact]', contacts: '[contacts]', poll: '[poll]', event: '[event]',
    product: '[product]', order: '[order]', group_invite: '[group invite]', call_log: '[call]',
  };
  const body = text || caption;
  const tag = label[type];
  if (tag) return body ? `${tag} ${body}` : tag;
  return body ?? (type === 'system' ? '[system]' : '[message]');
}

export interface NormalizeCtx {
  /** map lid -> pn when known */
  canon: (jid: string) => string;
  meJid?: string;
  meLid?: string;
}

/**
 * WAMessage -> flat, storable record. Returns null for protocol noise
 * (receipts, key distribution, reactions, poll votes, app-state...).
 */
export function normalizeMessage(msg: WAMessage, ctx: NormalizeCtx): NormalizedMessage | null {
  const key = msg.key as any;
  if (!key?.id || !key.remoteJid) return null;
  const chat_jid = ctx.canon(bare(key.remoteJid) || key.remoteJid);
  const from_me = !!key.fromMe;
  const ts = long(msg.messageTimestamp) ?? Math.floor(Date.now() / 1000);

  let sender: string | null;
  if (from_me) sender = ctx.meJid ? bare(ctx.meJid) : null;
  else if (isGroupJid(chat_jid) || chat_jid === STATUS_JID) sender = key.participant || key.participantAlt || (msg as any).participant || null;
  else sender = chat_jid;
  if (sender) sender = ctx.canon(bare(sender) || sender);

  const base = {
    chat_jid, id: key.id as string, from_me, sender_jid: sender, sender_name: from_me ? null : (msg.pushName ?? null),
    ts, status: (msg.status as number | null | undefined) ?? null,
  };

  const content: any = normalizeMessageContent(msg.message as any);
  const ctype = content ? (getContentType(content) as string | undefined) : undefined;

  if (!content || !ctype || SKIP_TYPES.has(ctype)) {
    // group/system notifications (member added, subject changed, ...) arrive as stubs
    const stub = (msg as any).messageStubType as number | undefined;
    if (stub && STUB_NAMES[stub] && STUB_NAMES[stub] !== 'REVOKE' && STUB_NAMES[stub] !== 'CIPHERTEXT') {
      const params = ((msg as any).messageStubParameters ?? []) as string[];
      return {
        ...base, type: 'system', text: `${STUB_NAMES[stub]}${params.length ? ' ' + params.join(' ') : ''}`, caption: null,
        quoted_id: null, quoted_sender: null, quoted_text: null, quoted_type: null, mentions: [], forwarded: false,
        ephemeral_expiration: null, media_mime: null, media_name: null, media_size: null, media_seconds: null,
        extra: { stub: STUB_NAMES[stub], params }, raw: null, has_media: false,
      };
    }
    return null;
  }

  const p = previewOf(content);
  const ci = contextInfoOf(content);
  let quoted_text: string | null = null;
  let quoted_type: string | null = null;
  if (ci?.quotedMessage) {
    const q = previewOf(normalizeMessageContent(ci.quotedMessage) ?? ci.quotedMessage);
    quoted_type = q.type;
    quoted_text = summarize(q.type, q.text, q.caption).slice(0, 500);
  }
  const media = mediaOf(content);
  const mentions: string[] = (ci?.mentionedJid ?? []).map((j: string) => ctx.canon(bare(j) || j));

  return {
    ...base,
    type: p.type,
    text: p.text,
    caption: p.caption,
    quoted_id: ci?.stanzaId ?? null,
    quoted_sender: ci?.participant ? ctx.canon(bare(ci.participant) || ci.participant) : null,
    quoted_text,
    quoted_type,
    mentions,
    forwarded: !!ci?.isForwarded,
    ephemeral_expiration: ci?.expiration ?? null,
    media_mime: media?.node?.mimetype ?? null,
    media_name: media?.node?.fileName ?? null,
    media_size: long(media?.node?.fileLength),
    media_seconds: media?.node?.seconds ?? null,
    extra: p.extra && Object.keys(p.extra).length ? p.extra : null,
    raw: serializeRaw(msg.message),
    has_media: !!media,
  };
}

/** Text of an edit (`editedMessage`) or `null`. */
export function editedText(m: any): string | null {
  const n = normalizeMessageContent(m);
  if (!n) return null;
  const p = previewOf(n);
  return p.text ?? p.caption;
}
