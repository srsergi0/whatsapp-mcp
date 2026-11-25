import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import type { Core } from '../core.js';
import type { Toolset } from '../config.js';
import { errMsg } from '../util.js';
import { looksLikeJidOrPhone, toJid } from '../wa/jid.js';
import { NotConnectedError, type WaSession } from '../wa/session.js';
import { Presenter } from './present.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Env {
  server: McpServer;
  core: Core;
}

export const sessionField = z.string().optional().describe('Session name. Required when more than one session exists (the error lists them).');
export const chatField = z.string().describe('Chat: phone with country code (e.g. 5491112345678), a full jid (…@s.whatsapp.net / …@g.us), or a saved contact/group name.');
export const jidField = z.string().describe('Phone with country code (e.g. 5491112345678) or full jid.');
export const limitField = (def: number, max: number) => z.number().int().min(1).max(max).default(def).describe(`Max results (default ${def}, max ${max}).`);
export const confirmField = z.boolean().optional().describe('Set true to confirm this irreversible action (or answer the confirmation prompt).');

/** Tool result with extra content blocks (images, resource links) beside the structured data. */
export class Rich {
  constructor(public data: Record<string, any>, public content: ContentBlock[] = [], public text?: string) {}
}

/** Human-readable text as the answer (compact), with only small metadata as structuredContent. */
export class TextResult extends Rich {
  constructor(text: string, meta: Record<string, any> = {}) {
    super(meta, [], text);
  }
}

const MAX_TEXT = 90_000;

export function ok(data: unknown): CallToolResult {
  const obj = data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, any>) : { result: data };
  let text = JSON.stringify(obj);
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + `…[truncated ${text.length - MAX_TEXT} chars; narrow the query or lower limit]`;
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

const ID_KEYS = ['message_id', 'quoted_id', 'poll_id', 'about_message_id', 'after_message_id'];

/** "#A1B2C3D4" (as printed in compact transcripts) -> full WhatsApp message id. */
export function expandShortIds(core: Core, args: any): any {
  if (!args || typeof args !== 'object') return args;
  let session: string | undefined;
  try { session = core.resolve(args.session).name; } catch { return args; }
  const fix = (v: unknown) => {
    if (typeof v !== 'string' || v.length > 17) return v;
    const r = core.repo.resolveMessageId(session!, v);
    if (r === 'ambiguous') throw new Error(`Message id "${v}" is ambiguous; use more characters of the id.`);
    return r ?? v;
  };
  const out = { ...args };
  for (const k of ID_KEYS) if (k in out) out[k] = fix(out[k]);
  if (Array.isArray(out.message_ids)) out.message_ids = out.message_ids.map(fix);
  return out;
}

export type Effect = 'read' | 'local' | 'wa';

export interface ToolDef<S extends z.ZodRawShape> {
  title: string;
  description: string;
  toolset: Toolset;
  input: S;
  output?: z.ZodRawShape;
  /** read: only reads | local: changes this server's own data | wa: changes WhatsApp / sends */
  effect?: Effect;
  destructive?: boolean;
  idempotent?: boolean;
  /** false for tools that only touch the local DB */
  network?: boolean;
}

export class Ctx {
  constructor(readonly env: Env, readonly extra: any, readonly toolName: string) {}

  get core() { return this.env.core; }
  get server() { return this.env.server; }

  /** Session (maybe offline) – for DB reads. */
  session(name?: string): WaSession { return this.core.resolve(name); }

  /** Session that must be online – for anything that talks to WhatsApp. */
  async open(name?: string): Promise<WaSession> {
    const s = this.core.resolve(name);
    if (this.core.passive && !s.isOpen) {
      throw new Error(`This instance is passive: process ${this.core.passive.pid} owns the WhatsApp connections. Local data tools still work.`);
    }
    if (s.isOpen) return s;
    if (s.state === 'connecting' || s.state === 'pairing') {
      try { await s.waitOpen(10_000); return s; } catch { /* fallthrough */ }
    }
    throw new NotConnectedError(s.name, s.state, s.lastError ? `Last error: ${s.lastError}.` : undefined);
  }

  /** Online session + write permission check. */
  async openForWrite(name?: string): Promise<WaSession> {
    this.core.assertWritable();
    return this.open(name);
  }

  presenter(session: string) { return new Presenter(this.core, session); }

  /** Strict: phone or jid only. */
  jid(session: string, input: string): string {
    return this.core.repo.canon(session, toJid(input));
  }

  /** For sends: phone / jid, or an EXACT (case-insensitive) unique chat or contact name. Never fuzzy. */
  recipient(session: string, input: string): string {
    if (looksLikeJidOrPhone(input)) return this.jid(session, input);
    const q = input.trim().toLowerCase();
    const hits = new Map<string, string>();
    for (const c of this.core.repo.findChats(session, input.trim(), 20)) if ((c.display_name ?? '').toLowerCase() === q) hits.set(c.jid, c.display_name ?? c.jid);
    for (const c of this.core.repo.listContacts(session, { query: input.trim(), limit: 20 }).rows) {
      if ([c.name, c.notify, c.verified_name].some((n) => n?.toLowerCase() === q)) hits.set(c.jid, c.name ?? c.notify ?? c.jid);
    }
    if (hits.size === 1) return [...hits.keys()][0]!;
    if (!hits.size) throw new Error(`Cannot find a chat or contact named exactly "${input}". Pass a phone number with country code or a jid (use find_contacts / list_chats to look it up).`);
    throw new Error(`Name "${input}" is ambiguous (${[...hits].map(([j, n]) => `${n} ${j}`).join('; ')}). Use the jid.`);
  }

  /** Lenient: phone, jid or unique name match among known chats/contacts. */
  chat(session: string, input: string): string {
    if (looksLikeJidOrPhone(input)) return this.jid(session, input);
    const q = input.trim();
    const chats = this.core.repo.findChats(session, q, 6);
    const exact = chats.filter((c) => (c.display_name ?? '').toLowerCase() === q.toLowerCase());
    const pick = exact.length === 1 ? exact : chats;
    if (pick.length === 1) return pick[0]!.jid;
    if (!pick.length) {
      const contacts = this.core.repo.listContacts(session, { query: q, limit: 6 }).rows;
      if (contacts.length === 1) return contacts[0]!.jid;
      if (contacts.length > 1) throw new Error(`"${q}" matches several contacts: ${contacts.map((c) => `${c.name ?? c.notify ?? c.jid} (${c.jid})`).join('; ')}. Use the jid.`);
      throw new Error(`No chat or contact matches "${q}". Use list_chats / find_contacts, or pass a phone number or jid.`);
    }
    throw new Error(`"${q}" is ambiguous: ${pick.map((c) => `${c.display_name ?? c.jid} (${c.jid})`).join('; ')}. Use the jid.`);
  }

  async log(level: 'debug' | 'info' | 'notice' | 'warning' | 'error', data: unknown) {
    try { await this.server.sendLoggingMessage({ level, logger: 'whatsapp', data }); } catch { /* client may not accept logs */ }
  }

  async progress(progress: number, total?: number, message?: string) {
    const token = this.extra?._meta?.progressToken;
    if (token === undefined) return;
    try { await this.extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, ...(total ? { total } : {}), ...(message ? { message } : {}) } }); } catch { /* ignore */ }
  }

  /** Irreversible actions: explicit flag, or ask the user through MCP elicitation when supported. */
  async confirm(flag: boolean | undefined, message: string): Promise<void> {
    if (flag === true) return;
    const caps = this.server.server.getClientCapabilities();
    if (caps?.elicitation) {
      try {
        const r = await this.server.server.elicitInput({
          message,
          requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Yes, do it', description: message } }, required: ['confirm'] },
        });
        if (r.action === 'accept' && (r.content as any)?.confirm === true) return;
        throw new Error('Cancelled: the user did not confirm.');
      } catch (e) {
        if ((e as Error).message.startsWith('Cancelled')) throw e;
        /* elicitation failed -> fall back to flag */
      }
    }
    throw new Error(`Confirmation required: ${message} Call again with confirm=true to proceed.`);
  }
}

/**
 * Register a tool with: toolset gating, read-only mode, friendly errors, audit trail,
 * structured + text output, MCP annotations.
 */
export function defineTool<S extends z.ZodRawShape>(
  env: Env,
  name: string,
  def: ToolDef<S>,
  handler: (args: z.infer<z.ZodObject<S>>, ctx: Ctx) => Promise<unknown>,
): void {
  if (!env.core.cfg.toolsets.has(def.toolset)) return;
  const effect = def.effect ?? 'read';
  const readOnlyMode = env.core.cfg.readOnly;
  if (readOnlyMode && effect === 'wa') return; // hide mutating tools entirely in read-only mode

  (env.server as any).registerTool(
    name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      ...(def.output ? { outputSchema: def.output } : {}),
      annotations: {
        title: def.title,
        readOnlyHint: effect === 'read',
        destructiveHint: effect === 'read' ? false : !!def.destructive,
        idempotentHint: effect === 'read' ? true : !!def.idempotent,
        openWorldHint: def.network ?? effect === 'wa',
      },
    },
    async (args: any, extra: any): Promise<CallToolResult> => {
      const ctx = new Ctx(env, extra, name);
      args = expandShortIds(env.core, args);
      const target = args?.chat ?? args?.to ?? args?.jid ?? args?.group ?? args?.name ?? null;
      try {
        if (effect === 'wa') env.core.assertWritable();
        const out = await handler(args, ctx);
        if (effect !== 'read') env.core.repo.audit(name, args?.session ?? null, typeof target === 'string' ? target : null, true);
        // TextResult: the readable text IS the answer. Some clients show structuredContent instead of the text, so none is sent.
        if (out instanceof TextResult) return { content: [{ type: 'text', text: (out.text ?? '').slice(0, MAX_TEXT) }] };
        if (out instanceof Rich) return { content: [{ type: 'text', text: (out.text ?? JSON.stringify(out.data)).slice(0, MAX_TEXT) }, ...out.content], structuredContent: out.data };
        return ok(out);
      } catch (e) {
        const msg = errMsg(e);
        if (effect !== 'read') env.core.repo.audit(name, args?.session ?? null, typeof target === 'string' ? target : null, false, msg);
        env.core.log.debug({ tool: name, err: msg }, 'tool error');
        return fail(msg);
      }
    },
  );
}
