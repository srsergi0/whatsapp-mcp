import { z } from 'zod';
import { iso, parseMoment } from '../../util.js';
import { defineTool, sessionField, type Env } from '../helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Persistent notes / tags / ignore list that live in SQLite next to the chats:
 * a durable memory the agent can use across conversations and restarts.
 */
export function registerMemoryTools(env: Env) {
  const { core } = env;

  defineTool(env, 'chat_memory', {
    title: 'Persistent notes about a chat or contact',
    description:
      'Durable key/value notes attached to a chat or contact (preferences, language, context, follow-ups). Survives restarts and new conversations. ' +
      'set/get/delete one key, or list everything for a chat (or for all chats if chat is omitted).',
    toolset: 'memory',
    effect: 'local',
    idempotent: true,
    network: false,
    input: {
      session: sessionField,
      action: z.enum(['set', 'get', 'delete', 'list']),
      chat: z.string().optional(),
      key: z.string().min(1).max(64).optional(),
      value: z.string().max(4000).optional(),
    },
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    const jid = a.chat ? ctx.chat(s.name, a.chat) : undefined;
    const p = ctx.presenter(s.name);
    switch (a.action) {
      case 'set':
        if (!jid || !a.key || a.value === undefined) throw new Error('chat, key and value are required');
        core.repo.setMemory(s.name, jid, a.key, a.value);
        return { chat: jid, key: a.key, saved: true };
      case 'get':
      case 'list': {
        const rows = core.repo.getMemory(s.name, jid, a.action === 'get' ? a.key : undefined);
        return { notes: rows.map((r) => ({ chat: r.jid, name: p.name(r.jid) ?? undefined, key: r.key, value: r.value, updated: iso(r.updated_at) })) };
      }
      case 'delete':
        if (!jid) throw new Error('chat required');
        return { deleted: core.repo.deleteMemory(s.name, jid, a.key) };
    }
  });

  /* ---------------------- interaction timeline (outside-chat events) ---------------------- */

  const KINDS = ['call', 'meeting', 'handled', 'note', 'task', 'waiting'] as const;

  defineTool(env, 'log_interaction', {
    title: 'Log something that happened outside the chat',
    description:
      'Record in the persistent timeline of a chat what the user did or agreed OUTSIDE WhatsApp, so it is remembered later and the inbox stays accurate. ' +
      'E.g. they wrote "llámame" and the user called them -> log_interaction {chat, kind:"call", note:"Lo llamé, quedamos en enviar la cotización"}. ' +
      'kind: call | meeting | handled (resolved by other means) -> marks the pending messages as answered until they write again; note (context only); task (a to-do / promise, stays open until completed, optional due). ' +
      'waiting = I am WAITING FOR THEIR REPLY (e.g. after sending a proposal or asking a question): it stays open with a due date (default +2d) and CLOSES BY ITSELF the moment they write back; if they stay silent it shows as OVERDUE in inbox / follow_ups. ' +
      'Call this whenever the user tells you they dealt with a chat some other way, or after sending something that needs an answer. Nothing is sent to WhatsApp.',
    toolset: 'memory',
    effect: 'local',
    network: false,
    input: {
      session: sessionField,
      chat: z.string(),
      note: z.string().min(1).max(2000).describe('What happened / what was agreed, in the user\'s words.'),
      kind: z.enum(KINDS).default('note'),
      resolves_pending: z.boolean().optional().describe('Treat their waiting messages as answered. Default: true for call/meeting/handled, false for note/task.'),
      when: z.string().optional().describe('When it happened: ISO-8601 or relative ("15m" = 15 minutes ago). Default: now.'),
      about_message_id: z.string().optional().describe('The specific message this refers to (e.g. the "llámame" message).'),
      due: z.string().optional().describe('For task / waiting: due date, ISO-8601 or relative future ("+2d", "+3h"). Default for waiting: +2d.'),
    },
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    const jid = ctx.chat(s.name, a.chat);
    const ts = a.when ? parseMoment(a.when, 'past') : Math.floor(Date.now() / 1000);
    const handled = a.resolves_pending ?? (a.kind === 'call' || a.kind === 'meeting' || a.kind === 'handled');
    const id = core.repo.addInteraction(s.name, {
      jid, ts, kind: a.kind, note: a.note, refId: a.about_message_id ?? null, handled,
      dueAt: a.due ? parseMoment(a.due, 'future') : a.kind === 'waiting' ? Math.floor(Date.now() / 1000) + 2 * 86400 : null,
      status: a.kind === 'task' || a.kind === 'waiting' ? 'open' : 'done',
    });
    return { id, chat: jid, name: ctx.presenter(s.name).name(jid) ?? undefined, saved: ctx.presenter(s.name).interaction(core.repo.getInteraction(id)!) };
  });

  defineTool(env, 'list_interactions', {
    title: 'Timeline of logged interactions and to-dos',
    description: 'Read the interaction timeline (calls, meetings, notes, tasks) for a chat or across all chats. Use status "open" to list pending to-dos; overdue_only for tasks past due.',
    toolset: 'memory',
    network: false,
    input: {
      session: sessionField,
      chat: z.string().optional(),
      kind: z.enum(KINDS).optional(),
      status: z.enum(['open', 'done']).optional(),
      overdue_only: z.boolean().optional(),
      query: z.string().optional().describe('Text contained in the note.'),
      since: z.string().optional().describe('ISO-8601 or relative like "7d".'),
      limit: z.number().int().min(1).max(200).default(30),
    },
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    const p = ctx.presenter(s.name);
    const rows = core.repo.listInteractions(s.name, {
      jid: a.chat ? ctx.chat(s.name, a.chat) : undefined, kind: a.kind, status: a.overdue_only ? 'open' : a.status, query: a.query,
      since: a.since ? parseMoment(a.since, 'past') : undefined, dueBefore: a.overdue_only ? Math.floor(Date.now() / 1000) : undefined, limit: a.limit,
    });
    return { count: rows.length, interactions: rows.map((r) => ({ ...p.interaction(r), chat: r.jid, chat_name: p.name(r.jid) ?? undefined })) };
  });

  defineTool(env, 'update_interaction', {
    title: 'Complete, reopen, edit or delete a logged interaction',
    description: 'complete: mark a task done (or stop waiting for a reply). reopen: mark it open again. edit: change note/due. delete: remove the entry.',
    toolset: 'memory',
    effect: 'local',
    network: false,
    input: {
      id: z.number().int(),
      action: z.enum(['complete', 'reopen', 'edit', 'delete']),
      note: z.string().max(2000).optional(),
      due: z.string().optional(),
    },
  }, async (a) => {
    const row = core.repo.getInteraction(a.id);
    if (!row) throw new Error(`No interaction #${a.id}`);
    if (a.action === 'delete') return { id: a.id, deleted: core.repo.deleteInteraction(a.id) > 0 };
    if (a.action === 'complete') core.repo.updateInteraction(a.id, { status: 'done', ...(row.kind === 'waiting' ? { resolved_at: Math.floor(Date.now() / 1000), resolved_by: 'manual' } : {}) });
    else if (a.action === 'reopen') core.repo.updateInteraction(a.id, { status: 'open', resolved_at: null, resolved_by: null });
    else {
      if (a.note === undefined && a.due === undefined) throw new Error('Provide note and/or due.');
      core.repo.updateInteraction(a.id, { ...(a.note !== undefined ? { note: a.note } : {}), ...(a.due !== undefined ? { due_at: parseMoment(a.due, 'future') } : {}) });
    }
    return { id: a.id, status: core.repo.getInteraction(a.id)!.status };
  });

  defineTool(env, 'chat_tags', {
    title: 'Tag chats (local CRM labels)',
    description: 'Free-form local tags on chats (e.g. "cliente", "pendiente", "vip"). add/remove on a chat, list all tags, or find the chats having a tag. list_chats can filter by tag.',
    toolset: 'memory',
    effect: 'local',
    idempotent: true,
    network: false,
    input: {
      session: sessionField,
      action: z.enum(['add', 'remove', 'list', 'find']),
      chat: z.string().optional(),
      tags: z.array(z.string().min(1).max(40)).optional(),
      tag: z.string().optional().describe('For find.'),
    },
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    const p = ctx.presenter(s.name);
    if (a.action === 'list') {
      if (a.chat) return { chat: ctx.chat(s.name, a.chat), tags: core.repo.tagsOf(s.name, ctx.chat(s.name, a.chat)) };
      return { tags: core.repo.listTags(s.name) };
    }
    if (a.action === 'find') {
      if (!a.tag) throw new Error('tag required');
      return { chats: core.repo.jidsWithTag(s.name, a.tag).map((j) => ({ jid: j, name: p.name(j) ?? undefined })) };
    }
    if (!a.chat || !a.tags?.length) throw new Error('chat and tags are required');
    const jid = ctx.chat(s.name, a.chat);
    const tags = a.tags.map((t) => t.trim().toLowerCase());
    if (a.action === 'add') core.repo.addTags(s.name, jid, tags);
    else core.repo.removeTags(s.name, jid, tags);
    return { chat: jid, tags: core.repo.tagsOf(s.name, jid) };
  });

  defineTool(env, 'ignore_list', {
    title: 'Ignore list (silence senders)',
    description: 'Chats/senders on this list are NOT stored or reported when they message you (no events, no unread count). Useful for spam or bots. add / remove / list.',
    toolset: 'memory',
    effect: 'local',
    idempotent: true,
    network: false,
    input: { session: sessionField, action: z.enum(['add', 'remove', 'list']), chat: z.string().optional(), reason: z.string().optional() },
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    if (a.action === 'list') return { ignored: core.repo.listIgnored(s.name).map((r) => ({ jid: r.jid, reason: r.reason ?? undefined, since: iso(r.created_at) })) };
    if (!a.chat) throw new Error('chat required');
    const jid = ctx.chat(s.name, a.chat);
    if (a.action === 'add') core.repo.ignore(s.name, jid, a.reason);
    else core.repo.unignore(s.name, jid);
    return { jid, ignored: a.action === 'add' };
  });
}
