import { z } from 'zod';
import { iso, parseMoment } from '../../util.js';
import { toJid } from '../../wa/jid.js';
import { assertReadablePath } from '../../wa/media.js';
import {
  editText, forwardMessage, pinMessage, reactTo, revokeMessage, sendContacts, sendEvent, sendLocation, sendMedia, sendPoll, sendText,
  type SentInfo,
} from '../../wa/send.js';
import { confirmField, defineTool, sessionField, type Ctx, type Env } from '../helpers.js';
import { assertFresh } from '../freshness.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const toField = z.string().describe('Recipient: phone with country code (5491112345678), a full jid (…@s.whatsapp.net, …@g.us), or the EXACT name of a saved contact/group.');
const common = {
  session: sessionField,
  to: toField,
  quoted_id: z.string().optional().describe('Id of a message in the same chat to reply to (quote it).'),
  mentions: z.array(z.string()).optional().describe('Phones/jids to @mention. Put @<phone> in the text.'),
  typing_ms: z.number().int().min(0).max(15000).optional().describe('Show "typing…" for this long before sending (looks human).'),
  ephemeral_seconds: z.number().int().optional().describe('Disappearing timer to stamp on this message (86400 / 604800 / 7776000).'),
  wait_for_reply: z.string().optional().describe('Also log that you are WAITING for their answer: due date, ISO-8601 or relative ("+2d", "+3h"). It closes by itself when they write back and shows as overdue in inbox / follow_ups if they stay silent.'),
  ignore_new_messages: z.boolean().optional().describe('Send even if the other side wrote something new since you last read the chat. Only when the user explicitly asked for that; by default the send is refused and the new messages are shown.'),
};
const sendOutput = {
  id: z.string(), chat: z.string(), time: z.string(), ts: z.number(), type: z.string(), to_name: z.string().optional(),
};

export function sentResult(ctx: Ctx, session: string, r: SentInfo) {
  return { id: r.id, chat: r.chat, time: iso(r.ts)!, ts: r.ts, type: r.type, to_name: ctx.presenter(session).name(r.chat) ?? undefined };
}

export function registerMessageTools(env: Env) {
  const { core } = env;

  /**
   * Resolve target + freshness guard: refuses (and shows the new messages) when the other side
   * wrote since the agent last read the chat; the same check runs again right before the wire.
   */
  /** Build the tool answer; with wait_for_reply, also log "waiting for their reply" tied to this message. */
  const track = (ctx: Ctx, s: { name: string }, jid: string, a: { wait_for_reply?: string; text?: string; caption?: string; question?: string; name?: string }, r: SentInfo) => {
    if (a.wait_for_reply) {
      const preview = String(a.text ?? a.caption ?? a.question ?? a.name ?? r.type).replace(/s+/g, ' ').slice(0, 120);
      core.repo.addInteraction(s.name, {
        jid, ts: r.ts, kind: 'waiting', note: `Waiting for their reply to: ${preview}`, refId: r.id, handled: false,
        dueAt: parseMoment(a.wait_for_reply, 'future'), status: 'open',
      });
    }
    return sentResult(ctx, s.name, r);
  };

  const prep = async (ctx: Ctx, sessionName: string | undefined, to: string, ignoreNew?: boolean) => {
    const s = await ctx.openForWrite(sessionName);
    const jid = ctx.recipient(s.name, to);
    const guard = ignoreNew ? undefined : () => assertFresh(core, ctx.server, s.name, jid);
    await guard?.();
    return { s, jid, guard };
  };

  defineTool(env, 'send_text', {
    title: 'Send text message',
    description: 'Send a text message to a person or group. Supports replying (quoted_id), @mentions and a typing indicator.',
    toolset: 'messages',
    effect: 'wa',
    input: { ...common, text: z.string().min(1).max(60000), link_preview: z.boolean().optional().describe('Set false to disable link preview.') },
    output: sendOutput,
  }, async (a, ctx) => {
    const { s, jid, guard } = await prep(ctx, a.session, a.to, a.ignore_new_messages);
    return track(ctx, s, jid, a, await sendText(core, s, jid, { ...a, beforeSend: guard }));
  });

  defineTool(env, 'send_media', {
    title: 'Send image / video / audio / voice note / document / sticker',
    description:
      'Send a file. kind: image | video | audio (music file) | voice (voice-note bubble, auto-converted to opus with ffmpeg) | document | sticker. ' +
      'Provide exactly one source: path (local file), url (http/https) or base64. caption applies to image/video/document. view_once for self-destructing image/video.',
    toolset: 'messages',
    effect: 'wa',
    input: {
      ...common,
      kind: z.enum(['image', 'video', 'audio', 'voice', 'document', 'sticker']),
      path: z.string().optional().describe('Local file path.'),
      url: z.string().optional().describe('Public http(s) URL to download and send.'),
      base64: z.string().optional().describe('Base64 content (optionally a data: URI).'),
      file_name: z.string().optional().describe('File name shown for documents.'),
      mimetype: z.string().optional(),
      caption: z.string().max(4000).optional(),
      view_once: z.boolean().optional(),
      gif: z.boolean().optional().describe('Send a video as a looping GIF.'),
      animated: z.boolean().optional().describe('Animated sticker (from gif/video; needs ffmpeg).'),
    },
    output: sendOutput,
  }, async (a, ctx) => {
    const { s, jid, guard } = await prep(ctx, a.session, a.to, a.ignore_new_messages);
    return track(ctx, s, jid, a, await sendMedia(core, s, jid, { ...a, beforeSend: guard }));
  });

  defineTool(env, 'send_location', {
    title: 'Send location',
    description: 'Send a map pin with optional name and address.',
    toolset: 'messages',
    effect: 'wa',
    input: { ...common, latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), name: z.string().optional(), address: z.string().optional() },
    output: sendOutput,
  }, async (a, ctx) => {
    const { s, jid, guard } = await prep(ctx, a.session, a.to, a.ignore_new_messages);
    return track(ctx, s, jid, a, await sendLocation(core, s, jid, { ...a, beforeSend: guard }));
  });

  defineTool(env, 'send_contacts', {
    title: 'Send contact card(s)',
    description: 'Share one or more contacts (vCard) with a chat.',
    toolset: 'messages',
    effect: 'wa',
    input: {
      ...common,
      contacts: z.array(z.object({ name: z.string(), phone: z.string(), organization: z.string().optional(), email: z.string().optional() })).min(1).max(10),
    },
    output: sendOutput,
  }, async (a, ctx) => {
    const { s, jid, guard } = await prep(ctx, a.session, a.to, a.ignore_new_messages);
    return track(ctx, s, jid, a, await sendContacts(core, s, jid, { ...a, beforeSend: guard }));
  });

  defineTool(env, 'send_poll', {
    title: 'Send poll',
    description: 'Create a poll (2-12 options). Votes are collected automatically; read them with get_poll_results.',
    toolset: 'messages',
    effect: 'wa',
    input: {
      ...common,
      question: z.string().min(1).max(250),
      options: z.array(z.string().min(1).max(100)).min(2).max(12),
      selectable_count: z.number().int().min(0).max(12).default(1).describe('How many options a voter can pick (0 = any number).'),
    },
    output: sendOutput,
  }, async (a, ctx) => {
    const { s, jid, guard } = await prep(ctx, a.session, a.to, a.ignore_new_messages);
    return track(ctx, s, jid, a, await sendPoll(core, s, jid, { ...a, beforeSend: guard }));
  });

  defineTool(env, 'send_event', {
    title: 'Send calendar event',
    description: 'Send a WhatsApp event invitation (name, start/end, location, optional call link).',
    toolset: 'messages',
    effect: 'wa',
    input: {
      ...common,
      name: z.string().min(1).max(100),
      start: z.string().describe('ISO-8601 start, e.g. 2026-11-02T18:00:00-05:00'),
      end: z.string().optional(),
      description: z.string().max(2000).optional(),
      location_name: z.string().optional(),
      call_type: z.enum(['audio', 'video']).optional().describe('Attach a WhatsApp call link.'),
      allow_extra_guests: z.boolean().optional(),
    },
    output: sendOutput,
  }, async (a, ctx) => {
    const { s, jid, guard } = await prep(ctx, a.session, a.to, a.ignore_new_messages);
    return track(ctx, s, jid, a, await sendEvent(core, s, jid, { ...a, beforeSend: guard }));
  });

  defineTool(env, 'react_to_message', {
    title: 'React to a message',
    description: 'React with an emoji to a message (empty emoji removes your reaction).',
    toolset: 'messages',
    effect: 'wa',
    idempotent: true,
    input: { session: sessionField, chat: z.string(), message_id: z.string(), emoji: z.string().max(8).describe('Single emoji, or "" to remove.') },
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    const chat = ctx.chat(s.name, a.chat);
    await reactTo(core, s, chat, a.message_id, a.emoji);
    return { chat, message_id: a.message_id, emoji: a.emoji || null };
  });

  defineTool(env, 'edit_message', {
    title: 'Edit a sent message',
    description: 'Edit the text of a message YOU sent (WhatsApp allows this for 15 minutes).',
    toolset: 'messages',
    effect: 'wa',
    idempotent: true,
    input: { session: sessionField, chat: z.string(), message_id: z.string(), text: z.string().min(1).max(60000) },
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    const chat = ctx.chat(s.name, a.chat);
    await editText(core, s, chat, a.message_id, a.text);
    return { chat, message_id: a.message_id, edited: true };
  });

  defineTool(env, 'delete_message', {
    title: 'Delete message for everyone',
    description: 'Revoke a message for everyone in the chat (yours, or anyone\'s if you are a group admin). Cannot be undone.',
    toolset: 'messages',
    effect: 'wa',
    destructive: true,
    input: { session: sessionField, chat: z.string(), message_id: z.string(), confirm: confirmField },
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    const chat = ctx.chat(s.name, a.chat);
    await ctx.confirm(a.confirm, `Delete message ${a.message_id} for everyone in ${ctx.presenter(s.name).name(chat) ?? chat}?`);
    return revokeMessage(core, s, chat, a.message_id);
  });

  defineTool(env, 'forward_message', {
    title: 'Forward a message',
    description: 'Forward a stored message to another chat.',
    toolset: 'messages',
    effect: 'wa',
    input: { session: sessionField, from_chat: z.string(), message_id: z.string(), to: toField },
    output: sendOutput,
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    const dest = ctx.recipient(s.name, a.to);
    assertFresh(core, ctx.server, s.name, dest);
    return sentResult(ctx, s.name, await forwardMessage(core, s, ctx.chat(s.name, a.from_chat), a.message_id, dest));
  });

  defineTool(env, 'pin_message', {
    title: 'Pin / unpin a message in a chat',
    description: 'Pin a message at the top of a chat for 24h, 7 days or 30 days, or unpin it.',
    toolset: 'messages',
    effect: 'wa',
    idempotent: true,
    input: {
      session: sessionField, chat: z.string(), message_id: z.string(), pin: z.boolean().default(true),
      duration: z.enum(['24h', '7d', '30d']).default('7d'),
    },
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    const secs = ({ '24h': 86400, '7d': 604800, '30d': 2592000 } as const)[a.duration];
    return pinMessage(core, s, ctx.chat(s.name, a.chat), a.message_id, a.pin, secs);
  });

  defineTool(env, 'set_presence', {
    title: 'Typing / recording / online indicator',
    description: 'Show "typing…" or "recording audio…" in a chat for a few seconds, or set your availability.',
    toolset: 'messages',
    effect: 'wa',
    input: {
      session: sessionField,
      chat: z.string().optional().describe('Required for composing/recording/paused.'),
      state: z.enum(['composing', 'recording', 'paused', 'available', 'unavailable']),
      duration_ms: z.number().int().min(0).max(15000).default(3000).describe('For composing/recording: how long to keep it before returning to paused.'),
    },
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    const sock = s.socket();
    if (a.state === 'available' || a.state === 'unavailable') {
      await sock.sendPresenceUpdate(a.state);
      return { state: a.state };
    }
    if (!a.chat) throw new Error('"chat" is required for composing / recording / paused.');
    const jid = ctx.chat(s.name, a.chat);
    if (a.state === 'paused') await sock.sendPresenceUpdate('paused', jid);
    else await s.typing(jid, a.duration_ms, a.state);
    return { chat: jid, state: a.state };
  });

  defineTool(env, 'mark_read', {
    title: 'Mark messages as read',
    description: 'Send read receipts (blue ticks) for the unread incoming messages of a chat, or for specific message ids. Resets the unread counter.',
    toolset: 'messages',
    effect: 'wa',
    idempotent: true,
    input: { session: sessionField, chat: z.string(), message_ids: z.array(z.string()).optional().describe('Default: all unread incoming messages of the chat.') },
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    const chat = ctx.chat(s.name, a.chat);
    const rows = a.message_ids?.length
      ? a.message_ids.map((id) => core.repo.getMessage(s.name, chat, id)).filter((r): r is NonNullable<typeof r> => !!r)
      : core.repo.unreadMessages(s.name, chat, 200);
    const keys = rows.filter((r) => !r.from_me).map((r) => ({ remoteJid: chat, id: r.id, fromMe: false, ...(r.sender_jid && chat.endsWith('@g.us') ? { participant: r.sender_jid } : {}) }));
    if (keys.length) await s.socket().readMessages(keys as any);
    core.repo.upsertChat(s.name, chat, { unread_count: 0 });
    return { chat, marked: keys.length };
  });

  /* ------------------------------- scheduling ------------------------------- */

  defineTool(env, 'schedule_message', {
    title: 'Schedule a message',
    description:
      'Queue a text or media message to be sent later (persisted in SQLite; sent while this server is running, up to 1h late). Give send_at (ISO-8601) or delay_seconds.',
    toolset: 'messages',
    effect: 'local',
    input: {
      session: sessionField,
      to: toField,
      text: z.string().max(60000).optional(),
      media: z.object({
        kind: z.enum(['image', 'video', 'audio', 'voice', 'document']),
        path: z.string().optional(),
        url: z.string().optional(),
        file_name: z.string().optional(),
        caption: z.string().optional(),
      }).optional(),
      send_at: z.string().optional().describe('ISO-8601 date-time with timezone.'),
      delay_seconds: z.number().int().min(5).optional(),
      quoted_id: z.string().optional(),
    },
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    if (!a.text && !a.media) throw new Error('Provide text and/or media.');
    const when = a.send_at ? Math.floor(new Date(a.send_at).getTime() / 1000) : a.delay_seconds ? Math.floor(Date.now() / 1000) + a.delay_seconds : NaN;
    if (!Number.isFinite(when)) throw new Error('Provide send_at (ISO-8601) or delay_seconds.');
    if (when < Date.now() / 1000 - 30) throw new Error('send_at is in the past.');
    const jid = ctx.recipient(s.name, a.to);
    let kind: 'text' | 'media';
    let payload: any;
    if (a.media) {
      if (!a.media.path && !a.media.url) throw new Error('media needs path or url (base64 is not allowed for scheduled messages).');
      if (a.media.path) assertReadablePath(a.media.path, core.cfg);
      kind = 'media';
      payload = { ...a.media, caption: a.media.caption ?? a.text, quoted_id: a.quoted_id };
    } else {
      kind = 'text';
      payload = { text: a.text, quoted_id: a.quoted_id };
    }
    const id = core.repo.schedule(s.name, jid, kind, payload, when);
    return { scheduled_id: id, to: jid, send_at: iso(when) };
  });

  defineTool(env, 'list_scheduled', {
    title: 'List scheduled messages',
    description: 'Show queued / sent / failed scheduled messages.',
    toolset: 'messages',
    input: { session: sessionField, status: z.enum(['pending', 'held', 'sent', 'failed', 'cancelled']).optional(), limit: z.number().int().min(1).max(200).default(50) },
    network: false,
  }, async (a, ctx) => {
    const name = a.session ? ctx.session(a.session).name : undefined;
    const rows = core.repo.listScheduled(name, a.status, a.limit);
    return {
      scheduled: rows.map((r) => ({
        id: r.id, session: r.session, to: r.to_jid, kind: r.kind, status: r.status, send_at: iso(r.send_at), attempts: r.attempts,
        error: r.last_error ?? undefined, sent_message_id: r.sent_message_id ?? undefined,
        preview: (JSON.parse(r.payload).text ?? JSON.parse(r.payload).caption ?? '').slice(0, 80),
      })),
    };
  });

  defineTool(env, 'cancel_scheduled', {
    title: 'Cancel or release a scheduled message',
    description:
      'Cancel a pending/held scheduled message by id. Messages are HELD (not sent) when the other side wrote after the message was scheduled: read the chat, then cancel it, or pass release=true to send it anyway.',
    toolset: 'messages',
    effect: 'local',
    idempotent: true,
    input: { id: z.number().int(), release: z.boolean().optional().describe('For a held message: send it anyway in a few seconds.') },
    network: false,
  }, async (a) => {
    const row = core.repo.getScheduled(a.id);
    if (!row) throw new Error(`No scheduled message #${a.id}`);
    if (row.status !== 'pending' && row.status !== 'held') throw new Error(`#${a.id} is already ${row.status}`);
    if (a.release) {
      core.repo.updateScheduled(a.id, { status: 'pending', send_at: Math.floor(Date.now() / 1000) + 5, last_error: null, payload: JSON.stringify({ ...JSON.parse(row.payload), ignore_new_messages: true }) });
      return { id: a.id, released: true };
    }
    core.repo.updateScheduled(a.id, { status: 'cancelled' });
    return { id: a.id, cancelled: true };
  });

  /* --------------------------------- status --------------------------------- */

  defineTool(env, 'post_status', {
    title: 'Post a WhatsApp Status (story)',
    description: 'Publish a text or media Status visible to your contacts (or to the given recipients only).',
    toolset: 'messages',
    effect: 'wa',
    input: {
      session: sessionField,
      text: z.string().max(700).optional().describe('Text status (or caption for media).'),
      kind: z.enum(['image', 'video']).optional(),
      path: z.string().optional(),
      url: z.string().optional(),
      background_color: z.string().optional().describe('Hex color for text statuses, e.g. #128C7E'),
      recipients: z.array(z.string()).optional().describe('Phones/jids that can see it. Default: all saved contacts.'),
    },
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    let list: string[];
    if (a.recipients?.length) list = a.recipients.map((r) => toJid(r));
    else {
      list = core.repo.listContacts(s.name, { limit: 2000 }).rows.filter((c) => c.jid.endsWith('@s.whatsapp.net') && !c.blocked).map((c) => c.jid);
      const me = core.repo.getSession(s.name)?.jid;
      if (me) list.push(me);
    }
    if (!list.length) throw new Error('No recipients: no contacts are known yet.');
    let content: any;
    if (a.kind) {
      const { loadSource } = await import('../../wa/media.js');
      const m = await loadSource({ path: a.path, url: a.url }, core.cfg);
      content = { [a.kind]: m.buffer, caption: a.text };
    } else if (a.text) {
      content = { text: a.text };
    } else throw new Error('Provide text, or kind + path/url.');
    const sent = await s.send('status@broadcast', content, { statusJidList: [...new Set(list)], backgroundColor: a.background_color, broadcast: true } as any);
    return { id: sent.key.id, visible_to: list.length };
  });
}
