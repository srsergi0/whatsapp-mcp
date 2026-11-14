import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { Db } from './db/database.js';
import { Repo, type EventRow } from './db/repo.js';
import { WaSession, type SessionHub } from './wa/session.js';
import { errMsg } from './util.js';
import { sendScheduled } from './wa/send.js';
import { bare, isGroupJid, phoneOf } from './wa/jid.js';

const SESSION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;

export interface WaEvent { id: number; session: string; type: string; chat: string | null; ref: string | null; ts: number; payload: any }

/** Process-wide singleton: DB, event bus, session registry, scheduler. Shared by every MCP connection. */
export class Core extends EventEmitter implements SessionHub {
  readonly db: Db;
  readonly repo: Repo;
  readonly sessions = new Map<string, WaSession>();
  /** True when another live process already owns the WhatsApp sockets (we serve DB data only). */
  passive: { pid: number } | null = null;
  private schedTimer?: NodeJS.Timeout;
  private pruneTimer?: NodeJS.Timeout;
  private hookTimer?: NodeJS.Timeout;
  private shuttingDown = false;
  readonly startedAt = Date.now();

  constructor(readonly cfg: Config, readonly log: Logger, passive: { pid: number } | null = null) {
    super();
    this.passive = passive;
    this.setMaxListeners(100);
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.mkdirSync(path.join(cfg.dataDir, 'outbox'), { recursive: true });
    this.db = new Db(cfg.dbPath);
    this.repo = new Repo(this.db);
  }

  /* ----------------------------------- startup ----------------------------------- */

  async start(): Promise<void> {
    for (const row of this.repo.listSessions()) this.getOrCreate(row.name);
    if (this.passive) return;
    if (this.cfg.autoConnect) {
      for (const row of this.repo.listSessions()) {
        if (row.registered && row.auto_connect) {
          // staggered start avoids a burst of logins hitting WhatsApp at once
          const s = this.sessions.get(row.name)!;
          setTimeout(() => s.connect().catch((e) => this.log.error({ session: row.name, err: errMsg(e) }, 'auto-connect failed')), 300 * this.sessions.size);
        }
      }
    }
    if (this.cfg.webhook.url) {
      // start from "now" the first time: history that existed before the webhook was configured is not replayed
      if (this.hookCursor === null) this.setHookCursor(this.repo.lastEventId());
      this.on('event', (ev: WaEvent) => { if (this.cfg.webhook.events.includes(ev.type)) void this.pumpWebhook(); });
      this.hookTimer = setInterval(() => void this.pumpWebhook(), 30_000);
      this.hookTimer.unref();
      void this.pumpWebhook();
    }
    this.schedTimer = setInterval(() => { void this.runScheduler(); this.checkWaiting(); }, 15_000);
    this.pruneTimer = setInterval(() => this.prune(), 6 * 3600_000);
    this.schedTimer.unref();
    this.pruneTimer.unref();
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    clearInterval(this.schedTimer);
    clearInterval(this.pruneTimer);
    clearInterval(this.hookTimer);
    await Promise.allSettled([...this.sessions.values()].map((s) => s.stop()));
    try { this.db.close(); } catch { /* ignore */ }
  }

  /* ----------------------------------- sessions ----------------------------------- */

  static validName(name: string): string {
    if (!SESSION_NAME.test(name)) throw new Error('Invalid session name: use 1-48 letters, digits, "_" or "-" (must start with a letter or digit).');
    return name;
  }

  getOrCreate(name: string): WaSession {
    let s = this.sessions.get(name);
    if (!s) {
      s = new WaSession(name, this);
      this.sessions.set(name, s);
    }
    return s;
  }

  createSession(name: string): WaSession {
    Core.validName(name);
    this.repo.ensureSession(name);
    return this.getOrCreate(name);
  }

  /** Resolve the target session: explicit name, or the only/connected one. */
  resolve(name?: string): WaSession {
    if (name) {
      const s = this.sessions.get(name);
      if (!s) throw new Error(`Unknown session "${name}". Known: ${[...this.sessions.keys()].join(', ') || '(none - use session_pair)'}.`);
      return s;
    }
    const all = [...this.sessions.values()];
    if (all.length === 1) return all[0]!;
    const open = all.filter((s) => s.isOpen);
    if (open.length === 1) return open[0]!;
    if (!all.length) throw new Error('No WhatsApp session configured yet. Use session_pair {session, phone} to link a number with a pairing code.');
    throw new Error(`Several sessions exist (${all.map((s) => s.name).join(', ')}); pass "session" explicitly.`);
  }

  /** Same as resolve() but the session must be paired in the DB (for read-only DB queries). */
  resolveName(name?: string): string {
    return this.resolve(name).name;
  }

  assertWritable() {
    if (this.cfg.readOnly) throw new Error('Server is in read-only mode (WA_MCP_READ_ONLY=1): sending and modifying WhatsApp state is disabled.');
    if (this.passive) throw new Error(`Another whatsapp-mcp process (pid ${this.passive.pid}) owns the WhatsApp connections, so this instance is read-only. Restart this MCP client so it connects to it as a proxy.`);
  }

  /* ------------------------------------ events ------------------------------------ */

  publish(session: string, type: string, chat: string | null, ref: string | null, payload: unknown): void {
    try {
      const id = this.repo.addEvent(session, type, chat, ref, payload);
      const ev: WaEvent = { id, session, type, chat, ref, ts: Math.floor(Date.now() / 1000), payload };
      this.emit('event', ev);
    } catch (e) {
      this.log.error({ err: errMsg(e), type }, 'failed to publish event');
    }
  }

  parseEvent(r: EventRow): WaEvent {
    return { id: r.id, session: r.session, type: r.type, chat: r.chat_jid, ref: r.ref_id, ts: r.ts, payload: JSON.parse(r.payload) };
  }

  /** Long-poll: resolves with events > sinceId, or [] after timeout. */
  async waitForEvents(opts: { sinceId: number; session?: string; types?: string[]; chat?: string; timeoutMs: number; limit: number; signal?: AbortSignal }): Promise<WaEvent[]> {
    const query = () => this.repo.listEvents({ session: opts.session, sinceId: opts.sinceId, types: opts.types, chat: opts.chat, limit: opts.limit }).map((r) => this.parseEvent(r));
    const first = query();
    if (first.length || opts.timeoutMs <= 0) return first;
    return new Promise<WaEvent[]>((resolve) => {
      const done = () => { clearTimeout(timer); this.off('event', onEvent); opts.signal?.removeEventListener('abort', onAbort); resolve(query()); };
      const onEvent = (ev: WaEvent) => {
        if (opts.session && ev.session !== opts.session) return;
        if (opts.types?.length && !opts.types.includes(ev.type)) return;
        if (opts.chat && ev.chat !== opts.chat) return;
        setTimeout(done, 150); // let a burst settle
      };
      const onAbort = () => done();
      const timer = setTimeout(done, opts.timeoutMs);
      this.on('event', onEvent);
      opts.signal?.addEventListener('abort', onAbort);
    });
  }

  /* ------------------------------------ webhook ------------------------------------ */

  /*
   * At-least-once delivery to WA_MCP_WEBHOOK_URL, in event order. A persisted cursor (data/webhook-cursor)
   * marks the last event the receiver accepted; anything after it is re-sent until it is acknowledged,
   * so a receiver that was down catches up when it comes back. Receivers dedupe on dedupe_key.
   * Owner process only (passive instances never start this).
   */
  private hookBusy = false;
  private hookAgain = false;

  private get hookCursorFile() { return path.join(this.cfg.dataDir, 'webhook-cursor'); }
  private get hookCursor(): number | null {
    try { return Number(fs.readFileSync(this.hookCursorFile, 'utf8')) || 0; } catch { return null; }
  }
  private setHookCursor(id: number) { fs.writeFileSync(this.hookCursorFile, String(id)); }

  /** Filters run at the source: a chat outside WA_MCP_WEBHOOK_ALLOW never leaves this process. */
  private webhookWanted(ev: WaEvent): boolean {
    const { groups, allow, groupAllow } = this.cfg.webhook;
    if (ev.chat && isGroupJid(ev.chat)) {
      // groups: all of them (WA_MCP_WEBHOOK_GROUPS=1) or only the listed ones (e.g. a "master" group)
      return groups || groupAllow.includes(ev.chat.split('@')[0]!.replace(/\D/g, ''));
    }
    if (allow.length) {
      const from = (phoneOf(ev.payload?.sender ?? ev.chat) ?? bare(ev.payload?.sender ?? ev.chat)).replace(/\D/g, '');
      if (!allow.includes(from)) return false;
    }
    return true;
  }

  async pumpWebhook(): Promise<void> {
    if (!this.cfg.webhook.url) return;
    if (this.hookBusy) { this.hookAgain = true; return; }
    this.hookBusy = true;
    try {
      for (;;) {
        const rows = this.repo.listEvents({ sinceId: this.hookCursor ?? 0, types: this.cfg.webhook.events, limit: 50 });
        if (!rows.length) return;
        for (const row of rows) {
          const ev = this.parseEvent(row);
          if (this.webhookWanted(ev) && !(await this.postWebhook(ev))) return; // keep the cursor: retried on the next event or in 30 s
          this.setHookCursor(ev.id);
        }
      }
    } finally {
      this.hookBusy = false;
      if (this.hookAgain) { this.hookAgain = false; void this.pumpWebhook(); }
    }
  }

  /** true = accepted (or permanently rejected: 4xx, so one bad event cannot block the queue); false = retry later. */
  private async postWebhook(ev: WaEvent): Promise<boolean> {
    const p = ev.payload ?? {};
    const body = JSON.stringify({
      source: 'whatsapp',
      type: ev.type,
      from: phoneOf(p.sender ?? ev.chat) ?? bare(p.sender ?? ev.chat),
      from_name: p.sender_name ?? null,
      text: p.text ?? (p.type ? `[${p.type}]` : null),
      has_media: !!p.has_media,
      group: !!(ev.chat && isGroupJid(ev.chat)),
      reply: { channel: 'whatsapp', session: ev.session, to: ev.chat },
      dedupe_key: `wa:${ev.session}:${ev.type}:${ev.ref ?? ev.id}`,
      ts: ev.ts,
      raw: ev,
    });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.webhook.token) headers.authorization = `Bearer ${this.cfg.webhook.token}`;
    try {
      const r = await fetch(this.cfg.webhook.url!, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
      if (r.ok) return true;
      if (r.status < 500) { this.log.warn({ status: r.status, event: ev.id, reason: (await r.text().catch(() => '')).slice(0, 300) }, 'webhook rejected event (skipped)'); return true; }
      this.log.warn({ status: r.status, event: ev.id }, 'webhook receiver error, will retry');
      return false;
    } catch (e) {
      this.log.debug({ err: errMsg(e), event: ev.id }, 'webhook receiver unreachable, will retry');
      return false;
    }
  }

  /* ----------------------------------- scheduler ----------------------------------- */

  /** Once per entry: a reply I was waiting for is now overdue (event feed + MCP log notification). */
  checkWaiting() {
    if (this.passive) return;
    try {
      const now = Math.floor(Date.now() / 1000);
      for (const sess of this.sessions.keys()) {
        for (const w of this.repo.openWaiting(sess, { overdueBefore: now, limit: 20 })) {
          const k = `waiting_overdue:${w.id}`;
          if (this.repo.kvGet(k)) continue;
          this.repo.kvSet(k, String(now));
          this.publish(sess, 'waiting.overdue', w.jid, String(w.id), { waiting_id: w.id, note: w.note, waited_s: now - w.ts, due_at: w.due_at });
        }
      }
    } catch (e) {
      this.log.debug({ err: errMsg(e) }, 'checkWaiting failed');
    }
  }

  private schedBusy = false;
  async runScheduler() {
    if (this.schedBusy || this.passive || this.cfg.readOnly) return;
    this.schedBusy = true;
    try {
      for (const row of this.repo.dueScheduled(10)) {
        const s = this.sessions.get(row.session);
        if (!s?.isOpen) {
          // keep it pending for up to 1h past due, then fail it
          if (Date.now() / 1000 - row.send_at > 3600) this.repo.updateScheduled(row.id, { status: 'failed', last_error: 'session offline for more than 1h after due time' });
          continue;
        }
        // the conversation moved after this was scheduled: do not send blind, hold it for review
        if (this.cfg.freshnessGuard && !(JSON.parse(row.payload) as { ignore_new_messages?: boolean }).ignore_new_messages) {
          const newer = this.repo.listMessages(row.session, { chat: row.to_jid, fromMe: false, since: row.created_at, limit: 5 })
            .filter((m) => m.type !== 'system' && !m.deleted && m.ts >= row.created_at);
          if (newer.length) {
            this.repo.updateScheduled(row.id, { status: 'held', last_error: `${newer.length}+ new incoming message(s) arrived after this was scheduled; review the chat, then cancel it or release it` });
            this.publish(row.session, 'scheduled.held', row.to_jid, String(row.id), { scheduled_id: row.id, new_messages: newer.length });
            this.repo.audit('scheduled_send', row.session, row.to_jid, false, 'held: chat has new messages');
            continue;
          }
        }
        this.repo.updateScheduled(row.id, { attempts: row.attempts + 1 });
        try {
          const id = await sendScheduled(this, s, row);
          this.repo.updateScheduled(row.id, { status: 'sent', sent_message_id: id, last_error: null });
          this.repo.audit('scheduled_send', row.session, row.to_jid, true, `#${row.id}`);
        } catch (e) {
          const failed = row.attempts + 1 >= 3;
          this.repo.updateScheduled(row.id, { status: failed ? 'failed' : 'pending', last_error: errMsg(e), send_at: Math.floor(Date.now() / 1000) + 60 });
          this.repo.audit('scheduled_send', row.session, row.to_jid, false, errMsg(e));
        }
      }
    } finally {
      this.schedBusy = false;
    }
  }

  prune() {
    try {
      const n = this.repo.pruneEvents(30);
      if (n) this.log.info({ pruned_events: n }, 'pruned old events');
    } catch (e) {
      this.log.warn({ err: errMsg(e) }, 'prune failed');
    }
  }
}
