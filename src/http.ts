import crypto from 'node:crypto';
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config.js';
import type { Core } from './core.js';
import { createMcpServer } from './mcp/server.js';
import { errMsg } from './util.js';

async function readBody(req: http.IncomingMessage, max = 25 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new Error('Request body too large');
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}

export interface Bridge { port: number; host: string; token: string; clients: () => number; close: () => Promise<void> }

// A client that dies (crash, killed window) never sends DELETE, and its session would keep a stdio
// owner alive forever. Live proxies hold a GET event stream open, so reap a session shortly after its
// last stream drops; one that never opened a stream is reaped after a longer idle period.
const STREAM_GONE_MS = 30_000;
const IDLE_MS = 12 * 60 * 60_000; // long: reaping a live proxy's session breaks every later call

interface Entry { transport: StreamableHTTPServerTransport; dispose: () => void; streams: number; reap?: NodeJS.Timeout }

/**
 * Streamable HTTP endpoint (/mcp, bearer token, loopback). Serves explicit `--http` mode
 * and, in stdio mode, the bridge that lets other MCP clients share this one process.
 */
export async function startHttpBridge(core: Core, cfg: Config, o: { host: string; port: number; token: string }): Promise<Bridge> {
  const tokenBuf = Buffer.from(o.token);
  const sessions = new Map<string, Entry>();
  let boundPort = o.port;

  const scheduleReap = (e: Entry, ms: number) => {
    clearTimeout(e.reap);
    e.reap = setTimeout(() => {
      if (e.streams > 0) return;
      core.log.info({ sid: e.transport.sessionId }, 'bridge session reaped (client gone)');
      void e.transport.close().catch(() => undefined);
    }, ms);
    e.reap.unref();
  };

  const authorized = (req: http.IncomingMessage) => {
    const h = req.headers.authorization ?? '';
    const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
    return given.length === tokenBuf.length && crypto.timingSafeEqual(given, tokenBuf);
  };

  const srv = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/health') return send(200, { ok: true, version: cfg.version, pid: process.pid });
      if (url.pathname !== '/mcp') return send(404, { error: 'not found' });
      if (!authorized(req)) { res.setHeader('www-authenticate', 'Bearer'); return send(401, { error: 'unauthorized' }); }

      const sid = req.headers['mcp-session-id'] as string | undefined;
      if (req.method === 'POST') {
        const body = await readBody(req);
        let entry = sid ? sessions.get(sid) : undefined;
        if (!entry) {
          if (sid || !isInitializeRequest(body)) {
            const method = (body as { method?: string } | undefined)?.method ?? 'response';
            core.log.warn({ method, sid: sid ?? null }, 'bridge rejected message without a valid session');
            return send(400,{ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session' }, id: null });
          }
          const { server, dispose } = createMcpServer(core);
          const created: Entry = { transport: undefined as unknown as StreamableHTTPServerTransport, dispose, streams: 0 };
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableDnsRebindingProtection: true,
            allowedHosts: [`${o.host}:${boundPort}`, `localhost:${boundPort}`, `127.0.0.1:${boundPort}`, `[::1]:${boundPort}`],
            onsessioninitialized: (id) => { sessions.set(id, created); },
          });
          created.transport = transport;
          transport.onclose = () => { clearTimeout(created.reap); if (transport.sessionId) sessions.delete(transport.sessionId); dispose(); };
          await server.connect(transport);
          entry = created;
        }
        if (entry.streams === 0) scheduleReap(entry, IDLE_MS);
        return void (await entry.transport.handleRequest(req, res, body));
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        const entry = sid ? sessions.get(sid) : undefined;
        if (!entry) return send(400, { error: 'invalid or missing mcp-session-id' });
        if (req.method === 'GET') {
          entry.streams++;
          clearTimeout(entry.reap);
          res.on('close', () => { if (--entry.streams === 0) scheduleReap(entry, STREAM_GONE_MS); });
        }
        return void (await entry.transport.handleRequest(req, res));
      }
      res.setHeader('allow', 'GET, POST, DELETE');
      return send(405, { error: 'method not allowed' });
    } catch (e) {
      core.log.error({ err: errMsg(e) }, 'http handler error');
      send(500, { error: errMsg(e) });
    }
  });

  await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(o.port, o.host, resolve); });
  boundPort = (srv.address() as { port: number }).port;
  return {
    port: boundPort, host: o.host, token: o.token, clients: () => sessions.size,
    close: async () => {
      for (const { transport } of sessions.values()) await transport.close().catch(() => undefined);
      await new Promise<void>((r) => srv.close(() => r()));
    },
  };
}
