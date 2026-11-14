import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Core } from '../../core.js';
import { loadSource, safeName } from '../../wa/media.js';
import { normalizePhone } from '../../wa/jid.js';
import { confirmField, defineTool, sessionField, type Env } from '../helpers.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerSessionTools(env: Env) {
  const { core } = env;

  defineTool(env, 'session_list', {
    title: 'List WhatsApp sessions',
    description: 'List every linked WhatsApp account (session) with connection state, phone number and local data counts.',
    toolset: 'sessions',
    input: {},
    network: false,
  }, async () => {
    const sessions = [...core.sessions.values()].map((s) => ({ ...s.info(), stats: core.repo.stats(s.name) }));
    return { sessions, passive: core.passive ? { owned_by_pid: core.passive.pid } : undefined, read_only: core.cfg.readOnly };
  });

  defineTool(env, 'session_pair', {
    title: 'Link a number with a pairing code',
    description:
      'Link a WhatsApp account using a PAIRING CODE (no QR). Returns an 8-character code; the user must open WhatsApp on the phone > Settings > Linked devices > Link a device > "Link with phone number instead", then type the code. ' +
      'Phone must be the number of the account being linked (digits with country code). Use wait_seconds to block until the phone accepts the code. Call again with force=true to get a fresh code.',
    toolset: 'sessions',
    effect: 'wa',
    input: {
      session: z.string().default('default').describe('Name for this session (e.g. "personal", "ventas").'),
      phone: z.string().describe('Phone number of the WhatsApp account to link, digits with country code, e.g. 5491112345678.'),
      force: z.boolean().optional().describe('Discard any pending code and request a new one.'),
      wait_seconds: z.number().int().min(0).max(240).default(0).describe('If > 0, wait up to this many seconds for the phone to accept the code and the session to open.'),
    },
  }, async (a, ctx) => {
    const phone = normalizePhone(a.phone);
    const s = core.createSession(Core.validName(a.session));
    const r = await s.pair(phone, { force: a.force });
    const out: Record<string, any> = {
      session: s.name,
      pairing_code: r.code,
      phone: r.phone,
      expires_in_seconds: r.expires_in_s,
      reused_pending_code: r.reused,
      instructions: [
        `On the phone with number +${r.phone}: open WhatsApp > Settings (or ⋮ menu) > Linked devices > Link a device.`,
        'Tap "Link with phone number instead" (below the QR scanner) and enter the 8-character code above.',
        'Then call session_status {wait_seconds: 60} to confirm the link finished.',
      ],
    };
    if (a.wait_seconds > 0) {
      await ctx.progress(0, a.wait_seconds, 'waiting for the code to be entered on the phone');
      try {
        await s.waitOpen(a.wait_seconds * 1000);
        out.linked = true;
        out.session_info = s.info();
      } catch (e) {
        out.linked = false;
        out.note = `Not linked yet: ${(e as Error).message}`;
      }
    }
    return out;
  });

  defineTool(env, 'session_status', {
    title: 'Session status',
    description: 'Connection state of a session, pairing progress, history-sync progress and local counters. wait_seconds blocks until the session is open.',
    toolset: 'sessions',
    input: {
      session: sessionField,
      wait_seconds: z.number().int().min(0).max(240).default(0).describe('Wait up to N seconds for state "open".'),
    },
    network: false,
  }, async (a) => {
    const s = core.resolve(a.session);
    let waited: string | undefined;
    if (a.wait_seconds > 0 && !s.isOpen) {
      try { await s.waitOpen(a.wait_seconds * 1000); } catch (e) { waited = (e as Error).message; }
    }
    return { ...s.info(), stats: core.repo.stats(s.name), wait_result: waited };
  });

  defineTool(env, 'session_control', {
    title: 'Connect / disconnect session',
    description: 'connect: open the WhatsApp socket of an already linked session. disconnect: close it but keep credentials and data. restart: disconnect + connect.',
    toolset: 'sessions',
    effect: 'wa',
    idempotent: true,
    input: {
      session: sessionField,
      action: z.enum(['connect', 'disconnect', 'restart']),
      wait_seconds: z.number().int().min(0).max(120).default(15).describe('After connecting, wait this long for the socket to open.'),
    },
  }, async (a) => {
    const s = core.resolve(a.session);
    if (a.action !== 'connect') {
      await s.stop();
      core.repo.updateSession(s.name, { auto_connect: a.action === 'disconnect' ? 0 : 1 });
    }
    if (a.action !== 'disconnect') {
      core.repo.updateSession(s.name, { auto_connect: 1 });
      await s.connect();
      if (a.wait_seconds > 0) await s.waitOpen(a.wait_seconds * 1000).catch(() => undefined);
    }
    return s.info();
  });

  defineTool(env, 'session_logout', {
    title: 'Unlink device (logout)',
    description: 'Log this device out of WhatsApp (removes it from the phone\'s Linked devices) and wipe its credentials. Local chats and messages are kept. IRREVERSIBLE: needs a new pairing code afterwards.',
    toolset: 'sessions',
    effect: 'wa',
    destructive: true,
    input: { session: sessionField, confirm: confirmField },
  }, async (a, ctx) => {
    const s = core.resolve(a.session);
    await ctx.confirm(a.confirm, `Unlink session "${s.name}" from WhatsApp?`);
    await s.logout();
    return { session: s.name, logged_out: true };
  });

  defineTool(env, 'session_delete', {
    title: 'Delete session and its local data',
    description: 'Unlink (if connected) and permanently delete a session with ALL its locally stored chats, messages, contacts, notes and media. IRREVERSIBLE.',
    toolset: 'sessions',
    effect: 'wa',
    destructive: true,
    input: { session: z.string(), confirm: confirmField },
  }, async (a, ctx) => {
    const s = core.resolve(a.session);
    await ctx.confirm(a.confirm, `Delete session "${s.name}" and ALL its local WhatsApp data?`);
    if (s.isOpen) await s.logout().catch(() => undefined);
    await s.stop().catch(() => undefined);
    core.repo.deleteSession(s.name);
    core.sessions.delete(s.name);
    await fsp.rm(path.join(core.cfg.mediaDir, safeName(s.name)), { recursive: true, force: true }).catch(() => undefined);
    return { session: s.name, deleted: true };
  });

  defineTool(env, 'profile_update', {
    title: 'Update my WhatsApp profile',
    description: 'Change the display name, the "About" text or the profile picture of the linked account.',
    toolset: 'sessions',
    effect: 'wa',
    idempotent: true,
    input: {
      session: sessionField,
      display_name: z.string().min(1).max(25).optional(),
      about: z.string().max(139).optional().describe('The "About" status text.'),
      picture_path: z.string().optional().describe('Local image file to set as profile picture.'),
      picture_url: z.string().optional().describe('Image URL to set as profile picture.'),
      remove_picture: z.boolean().optional(),
    },
  }, async (a, ctx) => {
    const s = await ctx.openForWrite(a.session);
    const sock = s.socket();
    const done: string[] = [];
    if (a.display_name) { await sock.updateProfileName(a.display_name); done.push('display_name'); }
    if (a.about !== undefined) { await sock.updateProfileStatus(a.about); done.push('about'); }
    if (a.picture_path || a.picture_url) {
      const m = await loadSource({ path: a.picture_path, url: a.picture_url }, core.cfg);
      await sock.updateProfilePicture(sock.user!.id, m.buffer as any);
      done.push('picture');
    } else if (a.remove_picture) {
      await sock.removeProfilePicture(sock.user!.id);
      done.push('picture_removed');
    }
    if (!done.length) throw new Error('Nothing to update: pass display_name, about, picture_path/picture_url or remove_picture.');
    return { updated: done };
  });

  defineTool(env, 'privacy_settings', {
    title: 'Privacy settings',
    description: 'Read the account privacy settings (last seen, profile photo, about, read receipts, groups add, ...).',
    toolset: 'sessions',
    input: { session: sessionField },
    network: true,
  }, async (a, ctx) => {
    const s = await ctx.open(a.session);
    return { privacy: await s.socket().fetchPrivacySettings(true) };
  });
}
