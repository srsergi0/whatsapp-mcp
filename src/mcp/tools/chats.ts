import { z } from 'zod';
import { toJid } from '../../wa/jid.js';
import { confirmField, defineTool, sessionField, type Ctx, type Env } from '../helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const MUTE: Record<string, number> = { '8h': 8 * 3600_000, '1w': 7 * 86400_000, forever: -1 };

export function registerChatTools(env: Env) {
  const { core } = env;

  /** Baileys wants the last message of the chat to anchor archive / read / clear / delete. */
  const lastMessages = (session: string, jid: string) => {
    const [m] = core.repo.listMessages(session, { chat: jid, limit: 1 });
    return m ? [{ key: { remoteJid: jid, id: m.id, fromMe: !!m.from_me }, messageTimestamp: m.ts }] : [];
  };

  defineTool(env, 'chat_action', {
    title: 'Archive / pin / mute / clear / delete a chat',
    description:
      'Chat-level actions (synced to the phone): archive, unarchive, pin, unpin, mute (8h | 1w | forever), unmute, mark_unread, star_message, unstar_message, ' +
      'disappearing (set the disappearing-messages timer: 0=off, 86400, 604800, 7776000), clear (delete all messages in the chat), delete (remove the chat). clear/delete need confirm.',
    toolset: 'chats',
    effect: 'wa',
    destructive: true,
    idempotent: true,
    input: {
      session: sessionField,
      chat: z.string(),
      action: z.enum(['archive', 'unarchive', 'pin', 'unpin', 'mute', 'unmute', 'mark_unread', 'star_message', 'unstar_message', 'disappearing', 'clear', 'delete']),
      duration: z.enum(['8h', '1w', 'forever']).default('8h').describe('For mute.'),
      message_id: z.string().optional().describe('For star_message / unstar_message.'),
      seconds: z.number().int().optional().describe('For disappearing: 0, 86400, 604800 or 7776000.'),
      confirm: confirmField,
    },
  }, async (a, ctx: Ctx) => {
    const s = await ctx.openForWrite(a.session);
    const sock = s.socket();
    const jid = ctx.chat(s.name, a.chat);
    const wireJid = toJid(jid);
    const last = lastMessages(s.name, jid);
    switch (a.action) {
      case 'archive': await sock.chatModify({ archive: true, lastMessages: last as any }, wireJid); core.repo.upsertChat(s.name, jid, { archived: 1 }); break;
      case 'unarchive': await sock.chatModify({ archive: false, lastMessages: last as any }, wireJid); core.repo.upsertChat(s.name, jid, { archived: 0 }); break;
      case 'pin': await sock.chatModify({ pin: true }, wireJid); core.repo.upsertChat(s.name, jid, { pinned: 1 }); break;
      case 'unpin': await sock.chatModify({ pin: false }, wireJid); core.repo.upsertChat(s.name, jid, { pinned: 0 }); break;
      case 'mute': {
        const ms = MUTE[a.duration]!;
        await sock.chatModify({ mute: ms === -1 ? -1 : Date.now() + ms }, wireJid);
        core.repo.upsertChat(s.name, jid, { muted_until: ms === -1 ? -1 : Math.floor((Date.now() + ms) / 1000) });
        break;
      }
      case 'unmute': await sock.chatModify({ mute: null }, wireJid); core.repo.upsertChat(s.name, jid, { muted_until: null }); break;
      case 'mark_unread': await sock.chatModify({ markRead: false, lastMessages: last as any }, wireJid); core.repo.upsertChat(s.name, jid, { unread_count: 1 }); break;
      case 'star_message':
      case 'unstar_message': {
        if (!a.message_id) throw new Error('message_id is required');
        const row = core.repo.getMessage(s.name, jid, a.message_id);
        if (!row) throw new Error('Message not found locally.');
        const star = a.action === 'star_message';
        await sock.chatModify({ star: { messages: [{ id: a.message_id, fromMe: !!row.from_me }], star } }, wireJid);
        core.repo.patchMessage(s.name, jid, a.message_id, { starred: star });
        break;
      }
      case 'disappearing': {
        const secs = a.seconds ?? 0;
        if (![0, 86400, 604800, 7776000].includes(secs)) throw new Error('seconds must be 0, 86400, 604800 or 7776000');
        await s.send(wireJid, { disappearingMessagesInChat: secs || false } as any);
        core.repo.upsertChat(s.name, jid, { ephemeral_duration: secs });
        break;
      }
      case 'clear':
        await ctx.confirm(a.confirm, `Clear ALL messages in ${ctx.presenter(s.name).name(jid) ?? jid}? (also removes the local copy)`);
        await sock.chatModify({ clear: true, lastMessages: last as any }, wireJid);
        core.repo.clearChat(s.name, jid);
        break;
      case 'delete':
        await ctx.confirm(a.confirm, `Delete the chat ${ctx.presenter(s.name).name(jid) ?? jid} and its local history?`);
        await sock.chatModify({ delete: true, lastMessages: last as any }, wireJid);
        core.repo.deleteChat(s.name, jid);
        break;
    }
    return { chat: jid, action: a.action, done: true };
  });

  /* ---------------------------------- labels ---------------------------------- */

  defineTool(env, 'labels', {
    title: 'WhatsApp Business labels',
    description: 'Manage labels (WhatsApp Business): list, create, edit, delete, and assign/remove them on chats or messages. Labels are learned from the phone, so list first.',
    toolset: 'chats',
    effect: 'wa',
    input: {
      session: sessionField,
      action: z.enum(['list', 'create', 'edit', 'delete', 'assign_chat', 'unassign_chat', 'assign_message', 'unassign_message', 'chats_with_label']),
      label_id: z.string().optional(),
      name: z.string().optional(),
      color: z.number().int().min(0).max(19).optional(),
      chat: z.string().optional(),
      message_id: z.string().optional(),
    },
  }, async (a, ctx) => {
    const s = a.action === 'list' || a.action === 'chats_with_label' ? ctx.session(a.session) : await ctx.openForWrite(a.session);
    if (a.action === 'list') return { labels: core.repo.listLabels(s.name) };
    if (a.action === 'chats_with_label') {
      if (!a.label_id) throw new Error('label_id required');
      const p = ctx.presenter(s.name);
      return { chats: core.repo.chatsWithLabel(s.name, a.label_id).map((r) => ({ chat: r.chat_jid, name: p.name(r.chat_jid) ?? undefined, message_id: r.message_id || undefined })) };
    }
    const sock = s.socket();
    if (a.action === 'create' || a.action === 'edit' || a.action === 'delete') {
      const id = a.label_id ?? String(Math.max(0, ...core.repo.listLabels(s.name).map((l) => Number(l.id) || 0)) + 1);
      if (a.action !== 'delete' && !a.name && a.action === 'create') throw new Error('name required');
      await sock.addLabel('' as any, { id, name: a.name, color: a.color ?? 0, deleted: a.action === 'delete' } as any);
      core.repo.upsertLabel(s.name, id, a.name ?? null, a.color ?? null, a.action === 'delete');
      return { label_id: id, action: a.action };
    }
    if (!a.label_id || !a.chat) throw new Error('label_id and chat are required');
    const jid = ctx.chat(s.name, a.chat);
    const w = toJid(jid);
    if (a.action === 'assign_chat') await sock.addChatLabel(w, a.label_id);
    else if (a.action === 'unassign_chat') await sock.removeChatLabel(w, a.label_id);
    else {
      if (!a.message_id) throw new Error('message_id required');
      if (a.action === 'assign_message') await sock.addMessageLabel(w, a.message_id, a.label_id);
      else await sock.removeMessageLabel(w, a.message_id, a.label_id);
    }
    core.repo.setLabelAssoc(s.name, a.label_id, jid, a.message_id ?? null, a.action.startsWith('assign'));
    return { label_id: a.label_id, chat: jid, action: a.action };
  });
}
