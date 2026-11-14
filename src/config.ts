import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..');

/** Minimal .env loader (no dependency). Real env vars win over the file. */
function loadDotEnv(file: string) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trimStart().startsWith('#')) continue;
      const v = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
      if (process.env[m[1]!] === undefined && v !== '') process.env[m[1]!] = v;
    }
  } catch { /* no .env */ }
}
loadDotEnv(path.join(PROJECT_ROOT, '.env'));

const bool = (v: string | undefined, d: boolean) =>
  v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v);
const int = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};
const list = (v: string | undefined) =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export const TOOLSETS = ['sessions', 'messages', 'read', 'contacts', 'chats', 'groups', 'business', 'memory', 'admin'] as const;
export type Toolset = (typeof TOOLSETS)[number];

export interface Config {
  dataDir: string;
  dbPath: string;
  mediaDir: string;
  logDir: string;
  readOnly: boolean;
  autoConnect: boolean;
  syncFullHistory: boolean;
  autoDownload: 'off' | 'all';
  mediaMaxBytes: number;
  sendDelayMs: number;
  maxMsgsPerMin: number;
  toolsets: Set<Toolset>;
  http: { host: string; port: number; token?: string };
  channel: { enabled: boolean; allow: string[] };
  /** POST every matching event to this URL (owner process only). Disabled when url is empty. */
  webhook: { url?: string; token?: string; events: string[]; groups: boolean; allow: string[]; groupAllow: string[] };
  /** If non-empty, local files may only be sent/read from these directories. */
  allowedDirs: string[];
  allowPrivateUrls: boolean;
  rejectCalls: boolean;
  /** Refuse to send when new incoming messages arrived since the agent last read the chat. */
  freshnessGuard: boolean;
  logLevel: string;
  version: string;
}

export function loadConfig(): Config {
  const e = process.env;
  const dataDir = path.resolve(e.WA_MCP_DATA_DIR || path.join(PROJECT_ROOT, 'data'));
  const raw = list(e.WA_MCP_TOOLSETS).flatMap((t) => (t === 'lite' ? ['sessions', 'messages', 'read', 'contacts', 'groups', 'memory'] : [t]));
  const requested = raw.filter((t): t is Toolset => (TOOLSETS as readonly string[]).includes(t));
  return {
    dataDir,
    dbPath: path.join(dataDir, 'whatsapp.db'),
    mediaDir: path.join(dataDir, 'media'),
    logDir: path.join(dataDir, 'logs'),
    readOnly: bool(e.WA_MCP_READ_ONLY, false),
    autoConnect: bool(e.WA_MCP_AUTOCONNECT, true),
    syncFullHistory: bool(e.WA_MCP_SYNC_FULL_HISTORY, true),
    autoDownload: /^(off|none|0|false)$/i.test(e.WA_MCP_AUTO_DOWNLOAD ?? '') ? 'off' : 'all',
    mediaMaxBytes: int(e.WA_MCP_MEDIA_MAX_MB, 16) * 1024 * 1024,
    sendDelayMs: int(e.WA_MCP_SEND_DELAY_MS, 700),
    maxMsgsPerMin: int(e.WA_MCP_MAX_MSGS_PER_MIN, 40),
    toolsets: new Set(requested.length ? requested : TOOLSETS),
    http: {
      host: e.WA_MCP_HTTP_HOST || '127.0.0.1',
      port: int(e.WA_MCP_HTTP_PORT, 3939),
      token: e.WA_MCP_HTTP_TOKEN || undefined,
    },
    channel: { enabled: bool(e.WA_MCP_CHANNEL, false), allow: list(e.WA_MCP_CHANNEL_ALLOW) },
    webhook: {
      url: e.WA_MCP_WEBHOOK_URL || undefined,
      token: e.WA_MCP_WEBHOOK_TOKEN || undefined,
      events: list(e.WA_MCP_WEBHOOK_EVENTS).length ? list(e.WA_MCP_WEBHOOK_EVENTS) : ['message.in'],
      groups: bool(e.WA_MCP_WEBHOOK_GROUPS, false),
      allow: list(e.WA_MCP_WEBHOOK_ALLOW).map((x) => x.replace(/\D/g, '')).filter(Boolean),
      groupAllow: list(e.WA_MCP_WEBHOOK_GROUP_ALLOW).map((x) => x.split('@')[0]!.replace(/\D/g, '')).filter(Boolean),
    },
    allowedDirs: list(e.WA_MCP_ALLOWED_DIRS).map((d) => path.resolve(d)),
    allowPrivateUrls: bool(e.WA_MCP_ALLOW_PRIVATE_URLS, false),
    rejectCalls: bool(e.WA_MCP_REJECT_CALLS, false),
    freshnessGuard: bool(e.WA_MCP_FRESHNESS_GUARD, true),
    logLevel: e.WA_MCP_LOG_LEVEL || 'info',
    version: '1.0.0',
  };
}
