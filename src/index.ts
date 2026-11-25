#!/usr/bin/env node
import './boot.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig, type Config } from './config.js';
import { Core } from './core.js';
import { startHttpBridge } from './http.js';
import { acquireLock, publishBridge, releaseLock } from './lock.js';
import { createLogger } from './logger.js';
import { createMcpServer } from './mcp/server.js';
import { ownerReachable, runProxy } from './proxy.js';
import { errMsg } from './util.js';

const HELP = `whatsapp-mcp - WhatsApp MCP server (Baileys, SQLite persistence)

Usage:
  node dist/index.js                 stdio transport (Claude Desktop / Claude Code / any MCP client)
  node dist/index.js --http          Streamable HTTP transport on http://127.0.0.1:3939/mcp (bearer token)
  node dist/cli.js pair --phone N    link a number with a pairing code from the terminal

Only one process can own the WhatsApp connection. When several MCP clients start this server at once,
the first becomes the owner and every other one transparently proxies to it (same tools, same live data).

Options:
  --http                 serve over HTTP instead of stdio
  --port <n> --host <h>  HTTP bind (default 127.0.0.1:3939)
  --data-dir <dir>       where whatsapp.db, media and logs live
  --read-only            disable every tool that sends or changes WhatsApp state
  --version, --help

Environment: see .env.example
`;

function applyArgs(argv: string[]) {
  const get = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  if (get('--data-dir')) process.env.WA_MCP_DATA_DIR = get('--data-dir');
  if (get('--port')) process.env.WA_MCP_HTTP_PORT = get('--port');
  if (get('--host')) process.env.WA_MCP_HTTP_HOST = get('--host');
  if (argv.includes('--read-only')) process.env.WA_MCP_READ_ONLY = '1';
}

/** Fixed token for explicit --http mode (env or data/http-token); random per run for the stdio bridge. */
function httpToken(cfg: Config): string {
  if (cfg.http.token) return cfg.http.token;
  const file = path.join(cfg.dataDir, 'http-token');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const t = crypto.randomBytes(24).toString('base64url');
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(file, t, { mode: 0o600 });
    return t;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.error(HELP); return; }
  if (argv.includes('--version')) { console.error(loadConfig().version); return; }
  applyArgs(argv);

  const cfg = loadConfig();
  const httpMode = argv.includes('--http');

  /* ---- who owns the WhatsApp connection? ---- */
  const lock = acquireLock(cfg.dataDir);
  let passive: { pid: number } | null = null;
  if (!lock.acquired) {
    if (!httpMode && (await ownerReachable(lock.info))) {
      // another client already runs the server: be a thin proxy to it
      await runProxy(lock.info, (m) => console.error(`[whatsapp-mcp] ${m}`));
      process.on('SIGINT', () => process.exit(0));
      process.on('SIGTERM', () => process.exit(0));
      return;
    }
    if (httpMode) {
      console.error(`whatsapp-mcp is already running (pid ${lock.info.pid}${lock.info.port ? `, port ${lock.info.port}` : ''}). Stop it first.`);
      process.exit(2);
    }
    // owner exists but exposes no bridge (older build): serve the local database read-only
    passive = { pid: lock.info.pid };
  }

  const log = createLogger(cfg);
  const core = new Core(cfg, log, passive);
  await core.start();

  let closeTransport: (() => Promise<void>) | undefined;
  let bridge: Awaited<ReturnType<typeof startHttpBridge>> | undefined;

  if (!passive) {
    // owner: always expose the loopback bridge so other clients can share this process
    const token = httpMode ? httpToken(cfg) : crypto.randomBytes(24).toString('base64url');
    bridge = await startHttpBridge(core, cfg, { host: httpMode ? cfg.http.host : '127.0.0.1', port: httpMode ? cfg.http.port : 0, token });
    publishBridge(cfg.dataDir, bridge.port, bridge.token);
    if (httpMode) {
      console.error(`whatsapp-mcp listening on http://${bridge.host}:${bridge.port}/mcp`);
      console.error(`Authorization: Bearer ${bridge.token}   (stored in ${path.join(cfg.dataDir, 'http-token')})`);
    }
  }

  if (httpMode) {
    closeTransport = async () => { await bridge?.close(); };
  } else {
    const { server, dispose } = createMcpServer(core);
    await server.connect(new StdioServerTransport());
    closeTransport = async () => { dispose(); await server.close().catch(() => undefined); await bridge?.close(); };
    log.info({ mode: 'stdio', passive: !!passive, bridge_port: bridge?.port }, 'whatsapp-mcp ready');
  }

  let down = false;
  const shutdown = async (why: string) => {
    if (down) return;
    down = true;
    log.info({ why }, 'shutting down');
    await closeTransport?.().catch(() => undefined);
    await core.shutdown();
    if (!passive) releaseLock(cfg.dataDir);
    process.exit(0);
  };
  // A stdio owner that still serves proxied clients ignores the first stop signal from its own client
  // (so closing one window does not cut the others); a second signal forces shutdown.
  let signalled = false;
  const onSignal = (sig: string) => {
    if (!httpMode && bridge && bridge.clients() > 0 && !signalled) {
      signalled = true;
      log.info({ sig, proxied_clients: bridge.clients() }, 'stop signal ignored once: other clients are connected through this process');
      setTimeout(() => { signalled = false; }, 4000).unref();
      return;
    }
    void shutdown(sig);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('exit', () => { if (!passive) releaseLock(cfg.dataDir); });
  // stdio owner: when its own client goes away the process ends; proxied clients then respawn and one becomes the new owner
  if (!httpMode) {
    process.stdin.on('close', () => {
      // keep serving proxied clients until the last one is gone
      if (!bridge || bridge.clients() === 0) return void shutdown('stdin closed');
      log.info({ proxied_clients: bridge.clients() }, 'own client left; staying alive for proxied clients');
      let idle = 0;
      const t = setInterval(() => {
        idle = bridge!.clients() === 0 ? idle + 1 : 0;
        if (idle >= 3) { clearInterval(t); void shutdown('last proxied client left'); }
      }, 5000);
    });
  }
  process.on('unhandledRejection', (e) => log.error({ err: errMsg(e) }, 'unhandledRejection'));
  process.on('uncaughtException', (e) => { log.error({ err: errMsg(e), stack: e.stack }, 'uncaughtException'); });
}

main().catch((e) => {
  console.error('fatal:', errMsg(e));
  process.exit(1);
});
