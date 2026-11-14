import { z } from 'zod';
import { iso } from '../../util.js';
import { isGroupJid, toJid } from '../../wa/jid.js';
import { loadSource } from '../../wa/media.js';
import { compact } from '../present.js';
import { confirmField, defineTool, limitField, sessionField, type Ctx, type Env } from '../helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerGroupTools(env: Env) {
  const { core } = env;

  const groupJid = (ctx: Ctx, session: string, input: string) => {
    const jid = ctx.chat(session, input);
    if (!isGroupJid(jid)) throw new Error(`${input} is not a group (jid must end in @g.us).`);
    return jid;
  };

  const present = (ctx: Ctx, session: string, g: any) => {
    const p = ctx.presenter(session);
    const parts: any[] = typeof g.participants === 'string' ? JSON.parse(g.participants) : (g.participants ?? []);
    return compact({
      jid: g.id ?? g.jid, subject: g.subject, description: g.desc ?? g.description, owner: p.who(g.ownerPn ?? g.owner),
      created: iso(g.creation), size: g.size ?? parts.length,
      only_admins_send: !!g.announce, only_admins_edit_info: !!(g.restrict ?? g.restrict_info), join_approval: !!(g.joinApprovalMode ?? g.join_approval),
      member_add_mode: g.memberAddMode === true ? 'all_member_add' : g.memberAddMode === false ? 'admin_add' : g.member_add_mode,
      disappearing_s: g.ephemeralDuration ?? g.ephemeral_duration, community: !!(g.isCommunity ?? g.is_community),
      members: parts.map((m) => compact({ jid: m.phone ?? m.phoneNumber ?? m.id, name: p.name(m.phone ?? m.phoneNumber ?? m.id) ?? undefined, admin: m.admin ?? undefined })),
    });
  };

  defineTool(env, 'list_groups', {
    title: 'List groups',
    description: 'Groups this account belongs to (from the local store; refresh=true re-fetches from WhatsApp).',
    toolset: 'groups',
    network: true,
    input: { session: sessionField, query: z.string().optional(), refresh: z.boolean().default(false), limit: limitField(50, 300) },
  }, async (a, ctx) => {
    const s = a.refresh ? await ctx.open(a.session) : ctx.session(a.session);
    if (a.refresh) {
      const all = await s.socket().groupFetchAllParticipating();
      for (const g of Object.values(all)) s.ingestApi()?.saveGroup(g);
    }
    const rows = core.repo.listGroups(s.name, a.query, a.limit);
    return { count: rows.length, groups: rows.map((g) => compact({ jid: g.jid, subject: g.subject, size: g.size, i_am_admin: !!g.me_is_admin, only_admins_send: !!g.announce })) };
  });

  defineTool(env, 'group_info', {
    title: 'Group details and members',
    description: 'Subject, description, settings and member list (with admin flags) of a group.',
    toolset: 'groups',
    network: true,
    input: { session: sessionField, group: z.string(), refresh: z.boolean().default(false).describe('Fetch fresh metadata from WhatsApp.') },
  }, async (a, ctx) => {
    const base = ctx.session(a.session);
    const jid = groupJid(ctx, base.name, a.group);
    let g: any = core.repo.getGroup(base.name, jid);
    if (a.refresh || !g) {
      const s = await ctx.open(a.session);
      const meta = await s.socket().groupMetadata(jid);
      s.ingestApi()?.saveGroup(meta);
      g = meta;
    }
    return present(ctx, base.name, g);
  });

  defineTool(env, 'create_group', {
    title: 'Create a group',
    description: 'Create a new group with the given participants (phones/jids).',
    toolset: 'groups',
    effect: 'wa',
    input: { session: sessionField, subject: z.string().min(1).max(100), participants: z.array(z.string()).min(1).max(256) },
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    const meta = await s.socket().groupCreate(a.subject, a.participants.map((p) => toJid(p)));
    s.ingestApi()?.saveGroup(meta);
    return present(ctx, s.name, meta);
  });

  defineTool(env, 'group_update', {
    title: 'Edit group settings',
    description:
      'Change a group: subject (name), description, who can send (only_admins_send), who can edit info (only_admins_edit_info), join approval, who can add members, disappearing timer, or picture. Needs admin rights for most.',
    toolset: 'groups',
    effect: 'wa',
    idempotent: true,
    input: {
      session: sessionField,
      group: z.string(),
      subject: z.string().min(1).max(100).optional(),
      description: z.string().max(2048).optional().describe('Empty string clears it.'),
      only_admins_send: z.boolean().optional(),
      only_admins_edit_info: z.boolean().optional(),
      join_approval: z.boolean().optional(),
      member_add_mode: z.enum(['all_member_add', 'admin_add']).optional(),
      disappearing_seconds: z.number().int().optional().describe('0, 86400, 604800 or 7776000.'),
      picture_path: z.string().optional(),
      picture_url: z.string().optional(),
    },
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    const sock = s.socket();
    const jid = groupJid(ctx, s.name, a.group);
    const done: string[] = [];
    if (a.subject) { await sock.groupUpdateSubject(jid, a.subject); done.push('subject'); }
    if (a.description !== undefined) { await sock.groupUpdateDescription(jid, a.description || undefined); done.push('description'); }
    if (a.only_admins_send !== undefined) { await sock.groupSettingUpdate(jid, a.only_admins_send ? 'announcement' : 'not_announcement'); done.push('only_admins_send'); }
    if (a.only_admins_edit_info !== undefined) { await sock.groupSettingUpdate(jid, a.only_admins_edit_info ? 'locked' : 'unlocked'); done.push('only_admins_edit_info'); }
    if (a.join_approval !== undefined) { await sock.groupJoinApprovalMode(jid, a.join_approval ? 'on' : 'off'); done.push('join_approval'); }
    if (a.member_add_mode) { await sock.groupMemberAddMode(jid, a.member_add_mode); done.push('member_add_mode'); }
    if (a.disappearing_seconds !== undefined) { await sock.groupToggleEphemeral(jid, a.disappearing_seconds); done.push('disappearing'); }
    if (a.picture_path || a.picture_url) {
      const m = await loadSource({ path: a.picture_path, url: a.picture_url }, core.cfg);
      await sock.updateProfilePicture(jid, m.buffer as any);
      done.push('picture');
    }
    if (!done.length) throw new Error('Nothing to change.');
    try { s.ingestApi()?.saveGroup(await sock.groupMetadata(jid)); } catch { /* best effort */ }
    return { group: jid, updated: done };
  });

  defineTool(env, 'group_participants', {
    title: 'Add / remove / promote / demote members',
    description: 'Manage group members. Returns the per-participant result status from WhatsApp (200 = ok).',
    toolset: 'groups',
    effect: 'wa',
    destructive: true,
    input: {
      session: sessionField,
      group: z.string(),
      action: z.enum(['add', 'remove', 'promote', 'demote']),
      participants: z.array(z.string()).min(1).max(100),
      confirm: confirmField,
    },
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    const jid = groupJid(ctx, s.name, a.group);
    const list = a.participants.map((p) => toJid(p));
    if (a.action === 'remove') await ctx.confirm(a.confirm, `Remove ${list.length} member(s) from ${ctx.presenter(s.name).name(jid) ?? jid}?`);
    const res = await s.socket().groupParticipantsUpdate(jid, list, a.action);
    try { s.ingestApi()?.saveGroup(await s.socket().groupMetadata(jid)); } catch { /* best effort */ }
    return { group: jid, action: a.action, results: res.map((r: any) => ({ jid: r.jid ?? r.content?.attrs?.jid, status: r.status })) };
  });

  defineTool(env, 'group_invite', {
    title: 'Group invite links',
    description: 'get: invite link of a group you admin. revoke: invalidate the link and create a new one. preview: inspect a group by invite code/link without joining. join: join a group by invite code/link.',
    toolset: 'groups',
    effect: 'wa',
    input: {
      session: sessionField,
      action: z.enum(['get', 'revoke', 'preview', 'join']),
      group: z.string().optional().describe('For get / revoke.'),
      code: z.string().optional().describe('Invite code or full chat.whatsapp.com link, for preview / join.'),
    },
  }, async (a, ctx) => {
    const s = a.action === 'get' || a.action === 'preview' ? await ctx.open(a.session) : await ctx.openForWrite(a.session);
    const sock = s.socket();
    const code = (a.code ?? '').replace(/^.*chat\.whatsapp\.com\//i, '').trim();
    switch (a.action) {
      case 'get': { const c = await sock.groupInviteCode(groupJid(ctx, s.name, a.group ?? '')); return { link: `https://chat.whatsapp.com/${c}` }; }
      case 'revoke': { const c = await sock.groupRevokeInvite(groupJid(ctx, s.name, a.group ?? '')); return { link: `https://chat.whatsapp.com/${c}` }; }
      case 'preview': { if (!code) throw new Error('code required'); return present(ctx, s.name, await sock.groupGetInviteInfo(code)); }
      case 'join': { if (!code) throw new Error('code required'); const jid = await sock.groupAcceptInvite(code); return { joined: jid }; }
    }
  });

  defineTool(env, 'group_join_requests', {
    title: 'Pending join requests',
    description: 'List, approve or reject pending join requests of a group with approval mode.',
    toolset: 'groups',
    effect: 'wa',
    input: { session: sessionField, group: z.string(), action: z.enum(['list', 'approve', 'reject']).default('list'), participants: z.array(z.string()).optional() },
  }, async (a, ctx) => {
    const s = a.action === 'list' ? await ctx.open(a.session) : await ctx.openForWrite(a.session);
    const jid = groupJid(ctx, s.name, a.group);
    if (a.action === 'list') return { requests: await s.socket().groupRequestParticipantsList(jid) };
    if (!a.participants?.length) throw new Error('participants required');
    const res = await s.socket().groupRequestParticipantsUpdate(jid, a.participants.map((p) => toJid(p)), a.action);
    return { group: jid, action: a.action, results: res };
  });

  defineTool(env, 'leave_group', {
    title: 'Leave a group',
    description: 'Leave a group. You will need a new invite/add to return.',
    toolset: 'groups',
    effect: 'wa',
    destructive: true,
    input: { session: sessionField, group: z.string(), confirm: confirmField },
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    const jid = groupJid(ctx, s.name, a.group);
    await ctx.confirm(a.confirm, `Leave group ${ctx.presenter(s.name).name(jid) ?? jid}?`);
    await s.socket().groupLeave(jid);
    return { left: jid };
  });
}
