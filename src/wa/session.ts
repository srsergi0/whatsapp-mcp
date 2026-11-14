import { EventEmitter } from 'node:events';
import makeWASocket, {
  Browsers, DisconnectReason, fetchLatestBaileysVersion, isJidBroadcast, makeCacheableSignalKeyStore,
  type WAMessage, type WASocket, type AnyMessageContent, type MiscMessageGenerationOptions,
} from 'baileys';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import { baileysLogger } from '../logger.js';
import { Deferred, errMsg, Mutex, sleep, TtlCache, withTimeout } from '../util.js';
import { useSqliteAuthState } from './auth-state.js';
import { bindIngest, type Ingest } from './ingest.js';
import { bare, normalizePhone } from './jid.js';
import { parseRaw } from './message-utils.js';

export type SessionState = 'idle' | 'connecting' | 'pairing' | 'open' | 'closed' | 'logged_out' | 'replaced';

export interface SessionHub {
  cfg: Config;
  log: Logger;
  repo: Repo;
  publish(session: string, type: string, chat: string | null, ref: string | null, payload: unknown): void;
}

export class NotConnectedError extends Error {
  constructor(public session: string, public state: SessionState, extra?: string) {
    super(`Session "${session}" is not connected (state: ${state}).${extra ? ' ' + extra : ''} Use session_status, then session_control {action:"connect"} or session_pair.`);
  }
}

let waVersionCache: { v: [number, number, number]; at: number } | undefined;

async function getWaVersion(repo: Repo, log: Logger): Promise<[number, number, number] | undefined> {
  const fresh = (at: number) => Date.now() - at < 12 * 3600_000;
  if (waVersionCache && fresh(waVersionCache.at)) return waVersionCache.v;
  try {
    const stored = repo.kvGet('wa_version');
    if (stored) {
      const s = JSON.parse(stored) as { v: [number, number, number]; at: number };
      if (fresh(s.at)) { waVersionCache = s; return s.v; }
    }
  } catch { /* ignore */ }
  try {
    const { version } = await withTimeout(fetchLatestBaileysVersion(), 10_000, 'fetchLatestBaileysVersion');
    waVersionCache = { v: version as [number, number, number], at: Date.now() };
    repo.kvSet('wa_version', JSON.stringify(waVersionCache));
    return waVersionCache.v;
  } catch (e) {
    log.warn({ err: errMsg(e) }, 'could not fetch latest WhatsApp Web version; using Baileys default');
    try {
      const stored = repo.kvGet('wa_version');
      if (stored) return (JSON.parse(stored) as { v: [number, number, number] }).v;
    } catch { /* ignore */ }
    return undefined;
  }
}

const PAIRING_TTL_MS = 4 * 60_000;

/**
 * One WhatsApp linked device. Owns the Baileys socket, reconnects, pairing-code flow
 * and the throttled send path. All state that must survive restarts goes through Repo.
 */
export class WaSession extends EventEmitter {
  state: SessionState = 'idle';
  sock: WASocket | null = null;
  lastError: string | null = null;
  lastDisconnectCode: number | null = null;
  history = { syncType: null as string | null, progress: null as number | null, isLatest: false, messages: 0, updatedAt: 0 };
  presence = new Map<string, { state: string; at: number }>();
  groupCache = new TtlCache<any>(5 * 60_000, 2000);

  private ingest: Ingest | null = null;
  private stopping = false;
  private attempts = 0;
  private retryTimer?: NodeJS.Timeout;
  private pairingTimer?: NodeJS.Timeout;
  private pairing: { phone: string; code?: string; issuedAt?: number; requested: boolean; deferred: Deferred<string> } | null = null;
  private openWaiters: Deferred<void>[] = [];
  private sendMutex = new Mutex();
  private lastSendAt = 0;
  private sentWindow: number[] = [];
  private msgRetryCache = new TtlCache<number>(10 * 60_000);
  private connectSeq = 0;

  constructor(readonly name: string, private hub: SessionHub) {
    super();
  }

  private get repo() { return this.hub.repo; }
  private get log() { return this.hub.log.child({ session: this.name }); }

  /* --------------------------------- status --------------------------------- */

  get isOpen() { return this.state === 'open' && !!this.sock; }
  get registered(): boolean { return !!this.repo.getSession(this.name)?.registered; }

  info() {
    const row = this.repo.getSession(this.name);
    return {
      name: this.name,
      state: this.state,
      registered: !!row?.registered,
      phone: row?.phone ?? null,
      jid: row?.jid ?? null,
      push_name: row?.push_name ?? null,
      auto_connect: !!row?.auto_connect,
      connected_at: row?.connected_at ?? null,
      last_error: this.lastError,
      last_disconnect_code: this.lastDisconnectCode,
      history_sync: this.history,
      pairing: this.pairing ? { phone: this.pairing.phone, code_issued: !!this.pairing.code, issued_at: this.pairing.issuedAt ?? null } : null,
    };
  }

  private setState(s: SessionState, reason?: string) {
    if (this.state === s) return;
    const prev = this.state;
    this.state = s;
    this.repo.updateSession(this.name, { status: s, ...(s === 'open' ? { connected_at: Math.floor(Date.now() / 1000) } : {}) });
    this.log.info({ from: prev, to: s, reason }, 'session state');
    this.hub.publish(this.name, 'connection', null, null, { state: s, previous: prev, reason: reason ?? null, code: this.lastDisconnectCode });
    this.emit('state', s);
    if (s === 'open') {
      for (const w of this.openWaiters.splice(0)) w.resolve();
    } else if (['closed', 'logged_out', 'replaced'].includes(s)) {
      for (const w of this.openWaiters.splice(0)) w.reject(new Error(`Session ${this.name} ${s}${reason ? ': ' + reason : ''}`));
    }
  }

  /** Resolve when the session is open; reject on timeout / terminal state. */
  waitOpen(timeoutMs: number): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    const d = new Deferred<void>();
    this.openWaiters.push(d);
    return withTimeout(d.promise, timeoutMs, `session ${this.name} to open`).catch((e) => {
      this.openWaiters = this.openWaiters.filter((w) => w !== d);
      throw e;
    });
  }

  socket(): WASocket {
    if (!this.sock || this.state !== 'open') throw new NotConnectedError(this.name, this.state, this.lastError ? `Last error: ${this.lastError}.` : undefined);
    return this.sock;
  }

  /* -------------------------------- lifecycle -------------------------------- */

  /** Connect an already-paired session. */
  async connect(): Promise<void> {
    if (!this.registered && !this.pairing) {
      throw new Error(`Session "${this.name}" is not linked to a WhatsApp account yet. Use session_pair with the phone number to get a pairing code.`);
    }
    await this.open();
  }

  private async open(): Promise<void> {
    if (this.sock && ['connecting', 'open', 'pairing'].includes(this.state)) return;
    this.stopping = false;
    clearTimeout(this.retryTimer);
    const seq = ++this.connectSeq;
    this.setState(this.pairing ? 'pairing' : 'connecting');

    const { state, saveCreds, registered } = useSqliteAuthState(this.repo, this.name);
    const bl = baileysLogger(this.hub.log, this.name);
    const version = await getWaVersion(this.repo, this.hub.log);
    if (seq !== this.connectSeq || this.stopping) return;

    const cfg = this.hub.cfg;
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, bl as any) },
      logger: bl as any,
      // 'Desktop' + syncFullHistory is rejected by the server (428) before pairing; 'Chrome' works with full history.
      browser: Browsers.macOS('Chrome'),
      syncFullHistory: cfg.syncFullHistory && !registered,
      shouldSyncHistoryMessage: () => true,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      emitOwnEvents: true,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 30_000,
      defaultQueryTimeoutMs: 120_000,
      retryRequestDelayMs: 350,
      maxMsgRetryCount: 5,
      shouldIgnoreJid: (jid) => !!isJidBroadcast(jid),
      msgRetryCounterCache: this.msgRetryCache as any,
      cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
      getMessage: async (key) => {
        const row = key.remoteJid && key.id ? this.repo.getMessage(this.name, this.repo.canon(this.name, bare(key.remoteJid)), key.id, true) : undefined;
        return parseRaw(row?.raw ?? undefined);
      },
    });
    this.sock = sock;
    this.ingest?.dispose();
    this.ingest = bindIngest(this, sock, this.hub);

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        const me = state.creds.me;
        if (me?.id) {
          this.repo.updateSession(this.name, {
            jid: bare(me.id), phone: bare(me.id).split('@')[0] ?? null, lid: (me as any).lid ?? null,
            push_name: me.name && me.name !== '~' ? me.name : null, registered: state.creds.registered ? 1 : 0,
          });
        }
      } catch (e) {
        this.log.error({ err: errMsg(e) }, 'failed to persist credentials');
      }
    });

    sock.ev.on('connection.update', (u) => {
      if (this.sock !== sock) return; // stale socket
      void this.onConnectionUpdate(sock, u).catch((e) => this.log.error({ err: errMsg(e) }, 'connection.update handler failed'));
    });
  }

  private async onConnectionUpdate(sock: WASocket, u: Partial<import('baileys').ConnectionState>) {
    const { connection, lastDisconnect, qr } = u;

    // `qr` fires once the server is ready to register this device: the moment to ask for a pairing code.
    if (qr && this.pairing && !this.pairing.requested && !sock.authState.creds.registered) {
      this.pairing.requested = true;
      try {
        const raw = await sock.requestPairingCode(this.pairing.phone);
        const code = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
        this.pairing.code = code;
        this.pairing.issuedAt = Date.now();
        this.pairing.deferred.resolve(code);
        this.setState('pairing', 'code issued');
        clearTimeout(this.pairingTimer);
        this.pairingTimer = setTimeout(() => void this.pairingExpired(), PAIRING_TTL_MS);
        this.hub.publish(this.name, 'pairing', null, null, { phone: this.pairing.phone, issued: true });
      } catch (e) {
        this.pairing.deferred.reject(e);
        this.lastError = `pairing code request failed: ${errMsg(e)}`;
        this.pairing = null;
        await this.hardStop('closed', this.lastError);
      }
      return;
    }

    if (connection === 'open') {
      this.attempts = 0;
      this.lastError = null;
      this.lastDisconnectCode = null;
      clearTimeout(this.pairingTimer);
      if (this.pairing) {
        this.pairing.deferred.resolve(this.pairing.code ?? '');
        this.pairing = null;
      }
      const me = sock.authState.creds.me;
      this.repo.updateSession(this.name, {
        registered: 1, jid: me?.id ? bare(me.id) : null, phone: me?.id ? (bare(me.id).split('@')[0] ?? null) : null,
        lid: (me as any)?.lid ?? null, push_name: me?.name && me.name !== '~' ? me.name : null, auto_connect: 1,
      });
      this.setState('open');
      void this.afterOpen(sock);
      return;
    }

    if (connection === 'close') {
      const err: any = lastDisconnect?.error;
      const code: number | undefined = err?.output?.statusCode ?? err?.statusCode;
      this.lastDisconnectCode = code ?? null;
      this.lastError = err ? errMsg(err) : 'connection closed';
      this.repo.updateSession(this.name, { last_disconnect_code: code ?? null, last_disconnect_reason: this.lastError });
      this.detach(sock);
      await this.handleClose(code);
    }
  }

  private async handleClose(code: number | undefined) {
    if (this.stopping) { this.setState('closed', 'stopped'); return; }
    const registered = this.registered;

    if (code === DisconnectReason.loggedOut) {
      this.log.warn('logged out from the phone');
      this.repo.clearAuth(this.name);
      this.repo.updateSession(this.name, { registered: 0 });
      this.pairing?.deferred.reject(new Error('Logged out before pairing completed'));
      this.pairing = null;
      this.setState('logged_out', 'logged out from phone (unlinked device)');
      return;
    }
    if (code === DisconnectReason.connectionReplaced) {
      this.setState('replaced', 'another instance is using this session (440)');
      return;
    }
    if (code === DisconnectReason.forbidden || code === DisconnectReason.multideviceMismatch) {
      this.setState('closed', `WhatsApp rejected the session (code ${code})`);
      return;
    }

    if (this.pairing && !registered) {
      // pre-registration: only the 515 restart that follows a successful link is recoverable
      if (code === DisconnectReason.restartRequired) { await this.reopen(0); return; }
      if (!this.pairing.requested) { await this.reopen(Math.min(3000 * ++this.attempts, 15000)); return; }
      this.pairing.deferred.reject(new Error(`Pairing interrupted (code ${code ?? 'unknown'})`));
      this.pairing = null;
      clearTimeout(this.pairingTimer);
      this.setState('closed', `pairing interrupted (code ${code ?? 'unknown'}); request a new code with session_pair`);
      return;
    }

    if (code === DisconnectReason.restartRequired) { await this.reopen(0); return; }
    const delay = Math.min(60_000, 2000 * 2 ** Math.min(this.attempts++, 5)) + Math.floor(Math.random() * 1000);
    this.setState('connecting', `reconnecting in ${Math.round(delay / 1000)}s (code ${code ?? 'unknown'})`);
    await this.reopen(delay);
  }

  private async reopen(delayMs: number) {
    clearTimeout(this.retryTimer);
    const run = () => this.open().catch((e) => {
      this.lastError = errMsg(e);
      this.log.error({ err: this.lastError }, 'reopen failed');
      this.setState('closed', this.lastError);
    });
    if (delayMs <= 0) { this.sock = null; await run(); return; }
    this.sock = null;
    this.retryTimer = setTimeout(() => { void run(); }, delayMs);
  }

  private detach(sock: WASocket) {
    try { this.ingest?.dispose(); } catch { /* ignore */ }
    this.ingest = null;
    try { sock.ev.removeAllListeners('connection.update'); sock.ev.removeAllListeners('creds.update'); } catch { /* ignore */ }
    if (this.sock === sock) this.sock = null;
  }

  private async afterOpen(sock: WASocket) {
    await sleep(4000);
    if (this.sock !== sock) return;
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const g of Object.values(groups)) this.ingest?.saveGroup(g);
      this.log.info({ groups: Object.keys(groups).length }, 'groups synced');
    } catch (e) {
      this.log.warn({ err: errMsg(e) }, 'group sync failed');
    }
    try {
      const bl = await sock.fetchBlocklist();
      this.repo.replaceBlocklist(this.name, (bl ?? []).filter(Boolean).map((j) => this.repo.canon(this.name, bare(j))));
    } catch (e) {
      this.log.debug({ err: errMsg(e) }, 'blocklist fetch failed');
    }
    this.emit('ready');
  }

  /** Close the socket but keep credentials. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.connectSeq++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.pairingTimer);
    this.pairing?.deferred.reject(new Error('Session stopped'));
    this.pairing = null;
    const sock = this.sock;
    if (sock) {
      this.detach(sock);
      try { sock.end(undefined); } catch { /* ignore */ }
      try { sock.ws?.close(); } catch { /* ignore */ }
    }
    this.sock = null;
    this.setState('closed', 'stopped');
  }

  private async hardStop(state: SessionState, reason: string) {
    this.stopping = true;
    this.connectSeq++;
    const sock = this.sock;
    if (sock) {
      this.detach(sock);
      try { sock.end(undefined); } catch { /* ignore */ }
    }
    this.sock = null;
    this.setState(state, reason);
  }

  private async pairingExpired() {
    if (!this.pairing || this.registered) return;
    this.log.warn('pairing code not entered in time');
    this.pairing = null;
    this.lastError = 'pairing code expired (not entered on the phone in time)';
    await this.hardStop('closed', this.lastError);
  }

  /** Unlink the device (also removes it from the phone) and wipe credentials. */
  async logout(): Promise<void> {
    const sock = this.sock;
    this.stopping = true;
    this.connectSeq++;
    try { if (sock && this.state === 'open') await withTimeout(sock.logout(), 10_000, 'logout'); } catch { /* phone may already be unlinked */ }
    if (sock) this.detach(sock);
    try { sock?.end(undefined); } catch { /* ignore */ }
    this.sock = null;
    this.repo.clearAuth(this.name);
    this.repo.updateSession(this.name, { registered: 0, jid: null, lid: null, phone: null, push_name: null, auto_connect: 0 });
    this.setState('logged_out', 'logged out by request');
  }

  /* -------------------------------- pairing code -------------------------------- */

  /**
   * Link a phone number with an 8-char pairing code (no QR). The user types the
   * code on the phone: WhatsApp > Linked devices > Link a device > Link with phone number.
   */
  async pair(phoneInput: string, opts: { force?: boolean; timeoutMs?: number } = {}): Promise<{ code: string; phone: string; reused: boolean; expires_in_s: number }> {
    const phone = normalizePhone(phoneInput);
    if (this.registered && this.state !== 'logged_out') {
      throw new Error(`Session "${this.name}" is already linked to ${this.repo.getSession(this.name)?.phone}. Use session_logout first if you want to relink it.`);
    }
    const cur = this.pairing;
    if (cur && !opts.force && cur.phone === phone && cur.code && cur.issuedAt && Date.now() - cur.issuedAt < 110_000 && this.sock) {
      return { code: cur.code, phone, reused: true, expires_in_s: Math.max(1, Math.round((PAIRING_TTL_MS - (Date.now() - cur.issuedAt)) / 1000)) };
    }

    // start from a clean unregistered state so every code belongs to a fresh handshake
    await this.stop();
    this.repo.clearAuth(this.name);
    this.attempts = 0;
    this.pairing = { phone, requested: false, deferred: new Deferred<string>() };
    const deferred = this.pairing.deferred;
    this.repo.updateSession(this.name, { phone, registered: 0, auto_connect: 1 });
    await this.open();
    const code = await withTimeout(deferred.promise, opts.timeoutMs ?? 45_000, 'WhatsApp to issue a pairing code').catch(async (e) => {
      if (this.pairing?.deferred === deferred) { this.pairing = null; await this.hardStop('closed', errMsg(e)); }
      throw e;
    });
    return { code, phone, reused: false, expires_in_s: Math.round(PAIRING_TTL_MS / 1000) };
  }

  /* ---------------------------------- sending ---------------------------------- */

  private rateCheck() {
    const max = this.hub.cfg.maxMsgsPerMin;
    if (!max) return;
    const t = Date.now();
    this.sentWindow = this.sentWindow.filter((x) => t - x < 60_000);
    if (this.sentWindow.length >= max) {
      const wait = Math.ceil((60_000 - (t - this.sentWindow[0]!)) / 1000);
      throw new Error(`Rate limit: ${max} messages/min per session (anti-ban). Retry in ~${wait}s or raise WA_MCP_MAX_MSGS_PER_MIN.`);
    }
    this.sentWindow.push(t);
  }

  /** Throttled, serialized send that also persists the outgoing message. */
  async send(jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions, beforeSend?: () => void | Promise<void>): Promise<WAMessage> {
    this.socket();
    this.rateCheck();
    return this.sendMutex.run(async () => {
      const gap = this.hub.cfg.sendDelayMs - (Date.now() - this.lastSendAt);
      if (gap > 0) await sleep(gap);
      // last-moment check (after the anti-ban delay): lets callers abort if the chat moved meanwhile
      await beforeSend?.();
      const sock = this.socket();
      const msg = await sock.sendMessage(jid, content, options);
      this.lastSendAt = Date.now();
      if (!msg) throw new Error('WhatsApp did not return a message (nothing was sent)');
      this.ingest?.persistOutgoing(msg);
      return msg;
    });
  }

  /** Run a non-message socket call (queries, group ops...) with the open-socket guard. */
  async call<T>(fn: (sock: WASocket) => Promise<T>): Promise<T> {
    return fn(this.socket());
  }

  async typing(jid: string, ms: number, kind: 'composing' | 'recording' = 'composing') {
    const sock = this.socket();
    try { await sock.presenceSubscribe(jid); } catch { /* ignore */ }
    await sock.sendPresenceUpdate(kind, jid);
    await sleep(Math.min(ms, 15_000));
    await sock.sendPresenceUpdate('paused', jid);
  }

  ingestApi(): Ingest | null {
    return this.ingest;
  }
}
