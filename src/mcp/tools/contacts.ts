import { z } from 'zod';
import type { ContentBlock } from '@modelcontextprotocol/server';
import { iso, sleep } from '../../util.js';
import { bare, normalizePhone, phoneOf, toJid } from '../../wa/jid.js';
import { fetchLimited } from '../../wa/media.js';
import { compact } from '../present.js';
import { confirmField, defineTool, jidField, limitField, Rich, sessionField, type Env } from '../helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerContactTools(env: Env) {
  const { core } = env;

  defineTool(env, 'find_contacts', {
    title: 'Find contacts and groups by name',
    description: 'Search saved contacts, push names and group subjects stored locally. Use it to turn a name into a jid/phone before sending.',
    toolset: 'contacts',
    input: {
      session: sessionField,
      query: z.string().optional().describe('Name or number substring. Empty = list all.'),
      blocked_only: z.boolean().optional(),
      business_only: z.boolean().optional(),
      include_groups: z.boolean().default(true),
      limit: limitField(25, 200),
      offset: z.number().int().min(0).default(0),
    },
    network: false,
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    const { rows, total } = core.repo.listContacts(s.name, { query: a.query, blockedOnly: a.blocked_only, businessOnly: a.business_only, limit: a.limit, offset: a.offset });
    const p = ctx.presenter(s.name);
    const groups = a.include_groups && !a.blocked_only && !a.business_only ? core.repo.listGroups(s.name, a.query || undefined, Math.min(a.limit, 50)) : [];
    return {
      session: s.name, total_contacts: total,
      contacts: rows.map((c) => compact({ jid: c.jid, name: c.name, push_name: c.notify, verified_name: c.verified_name, phone: c.phone ?? phoneOf(c.jid), about: c.about, business: !!c.is_business, blocked: !!c.blocked, tags: core.repo.tagsOf(s.name, c.jid) })),
      groups: groups.map((g) => compact({ jid: g.jid, subject: g.subject, size: g.size, i_am_admin: !!g.me_is_admin })),
      next_offset: a.offset + rows.length < total ? a.offset + rows.length : undefined,
      me: p.who(core.repo.getSession(s.name)?.jid),
    };
  });

  defineTool(env, 'check_numbers', {
    title: 'Check if numbers are on WhatsApp',
    description: 'Check which phone numbers have a WhatsApp account (and get their jid). Do this before messaging a new number.',
    toolset: 'contacts',
    network: true,
    input: { session: sessionField, numbers: z.array(z.string()).min(1).max(50).describe('Phones with country code.') },
  }, async (a, ctx) => {
    const s = await ctx.open(a.session);
    const jids = a.numbers.map((n) => `${normalizePhone(n)}@s.whatsapp.net`);
    const res = (await s.socket().onWhatsApp(...jids)) ?? [];
    const by = new Map(res.map((r: any) => [phoneOf(r.jid) ?? r.jid, r]));
    return {
      results: a.numbers.map((n) => {
        const d = normalizePhone(n);
        const r: any = by.get(d);
        return { number: d, exists: !!r?.exists, jid: r?.exists ? bare(r.jid) : undefined, lid: r?.lid };
      }),
    };
  });

  defineTool(env, 'get_profile_picture', {
    title: 'Profile picture',
    description: 'Get the profile picture of a contact or group (URL, and the image itself inline when small).',
    toolset: 'contacts',
    network: true,
    input: { session: sessionField, jid: z.string(), high_res: z.boolean().default(false), inline: z.boolean().default(true) },
  }, async (a, ctx) => {
    const s = await ctx.open(a.session);
    const jid = ctx.chat(s.name, a.jid);
    const url = await s.socket().profilePictureUrl(jid, a.high_res ? 'image' : 'preview').catch((e: any) => {
      if (/not-authorized|item-not-found|404|401|403/.test(String(e?.message ?? e))) return undefined;
      throw e;
    });
    if (!url) return { jid, has_picture: false };
    const content: ContentBlock[] = [];
    if (a.inline) {
      try {
        const f = await fetchLimited(url, { ...core.cfg, allowPrivateUrls: false }, 1024 * 1024);
        content.push({ type: 'image', data: f.buffer.toString('base64'), mimeType: f.mimetype ?? 'image/jpeg' });
      } catch { /* url only */ }
    }
    return new Rich({ jid, has_picture: true, url }, content);
  });

  defineTool(env, 'get_about', {
    title: 'Contact "About" status',
    description: 'Fetch the About/status text of one or more contacts.',
    toolset: 'contacts',
    network: true,
    input: { session: sessionField, jids: z.array(z.string()).min(1).max(30) },
  }, async (a, ctx) => {
    const s = await ctx.open(a.session);
    const jids = a.jids.map((j) => ctx.chat(s.name, j));
    const res: any[] = (await s.socket().fetchStatus(...jids)) ?? [];
    return {
      statuses: res.map((r, i) => {
        const jid = jids[i]!;
        const text: string | undefined = r?.status?.status ?? r?.status;
        if (typeof text === 'string') core.repo.upsertContact(s.name, jid, { about: text, about_ts: Math.floor(Date.now() / 1000) });
        return { jid, about: typeof text === 'string' ? text : null, set_at: r?.status?.setAt ? iso(Math.floor(new Date(r.status.setAt).getTime() / 1000)) : undefined };
      }),
    };
  });

  defineTool(env, 'get_presence', {
    title: 'Online / typing presence',
    description: 'Subscribe to a contact\'s presence and report whether they are online/typing right now (works only if their privacy settings allow).',
    toolset: 'contacts',
    network: true,
    input: { session: sessionField, jid: z.string(), wait_ms: z.number().int().min(500).max(8000).default(2500) },
  }, async (a, ctx) => {
    const s = await ctx.open(a.session);
    const jid = ctx.chat(s.name, a.jid);
    await s.socket().presenceSubscribe(jid);
    await sleep(a.wait_ms);
    const p = s.presence.get(jid);
    return { jid, presence: p ? p.state : 'unknown (hidden by privacy settings or no update received)' };
  });

  defineTool(env, 'get_business_profile', {
    title: 'Business profile',
    description: 'Get the WhatsApp Business profile (description, category, website, hours) of a business account.',
    toolset: 'business',
    network: true,
    input: { session: sessionField, jid: z.string() },
  }, async (a, ctx) => {
    const s = await ctx.open(a.session);
    const jid = ctx.chat(s.name, a.jid);
    const profile = await s.socket().getBusinessProfile(jid);
    if (profile) core.repo.upsertContact(s.name, jid, { is_business: 1 });
    return { jid, is_business: !!profile, profile: profile ?? undefined };
  });

  defineTool(env, 'block_contact', {
    title: 'Block / unblock a contact',
    description: 'Block or unblock a contact on WhatsApp.',
    toolset: 'contacts',
    effect: 'wa',
    idempotent: true,
    input: { session: sessionField, jid: jidField, blocked: z.boolean().default(true) },
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    const jid = ctx.jid(s.name, a.jid);
    await s.socket().updateBlockStatus(toJid(jid), a.blocked ? 'block' : 'unblock');
    core.repo.setBlocked(s.name, [jid], a.blocked);
    return { jid, blocked: a.blocked };
  });

  defineTool(env, 'get_blocklist', {
    title: 'Blocked contacts',
    description: 'List blocked contacts (refreshed from WhatsApp when online).',
    toolset: 'contacts',
    network: true,
    input: { session: sessionField },
  }, async (a, ctx) => {
    const s = ctx.session(a.session);
    if (s.isOpen) {
      const bl = (await s.socket().fetchBlocklist().catch(() => undefined)) as string[] | undefined;
      if (bl) core.repo.replaceBlocklist(s.name, bl.filter(Boolean).map((j) => core.repo.canon(s.name, bare(j))));
    }
    const p = ctx.presenter(s.name);
    return { blocked: core.repo.listContacts(s.name, { blockedOnly: true, limit: 500 }).rows.map((c) => p.who(c.jid)) };
  });

  defineTool(env, 'save_contact', {
    title: 'Save contact in the address book',
    description: 'Create or rename a contact (synced to the phone address book through WhatsApp app-state).',
    toolset: 'contacts',
    effect: 'wa',
    idempotent: true,
    input: { session: sessionField, jid: jidField, full_name: z.string().min(1), first_name: z.string().optional() },
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    const jid = ctx.jid(s.name, a.jid);
    await s.socket().addOrEditContact(jid, { fullName: a.full_name, firstName: a.first_name ?? a.full_name.split(' ')[0], saveOnPrimaryAddressbook: true } as any);
    core.repo.upsertContact(s.name, jid, { name: a.full_name });
    return { jid, name: a.full_name };
  });

  defineTool(env, 'remove_contact', {
    title: 'Remove saved contact',
    description: 'Remove a contact from the address book (the chat and messages stay).',
    toolset: 'contacts',
    effect: 'wa',
    destructive: true,
    input: { session: sessionField, jid: jidField, confirm: confirmField },
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    const jid = ctx.jid(s.name, a.jid);
    await ctx.confirm(a.confirm, `Remove ${ctx.presenter(s.name).name(jid) ?? jid} from your contacts?`);
    await s.socket().removeContact(jid);
    return { jid, removed: true };
  });
}
