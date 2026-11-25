import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import type { LockInfo } from './lock.js';
import { errMsg } from './util.js';

/** Is the owner's bridge reachable (and really our server)? */
export async function ownerReachable(info: LockInfo): Promise<boolean> {
  if (!info.port || !info.token) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok && ((await r.json()) as { pid?: number }).pid === info.pid;
  } catch {
    return false;
  }
}

/**
 * Secondary MCP client: this process owns nothing. It forwards JSON-RPC between the
 * client's stdio and the owner's HTTP bridge, so every client sees the same live
 * WhatsApp connection, database and tool set. If the owner dies we exit and the client respawns us (as the new owner).
 */
export async function runProxy(info: LockInfo, log: (m: string) => void): Promise<() => Promise<void>> {
  const stdio = new StdioServerTransport();
  const remote = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${info.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${info.token}` } },
  });
  let closing = false;
  const shutdown = async (code: number, why: string) => {
    if (closing) return;
    closing = true;
    log(`proxy closing: ${why}`);
    // DELETE our bridge session so the owner stops counting us as a connected client
    await remote.terminateSession().catch(() => undefined);
    await remote.close().catch(() => undefined);
    await stdio.close().catch(() => undefined);
    process.exit(code);
  };

  const forward = async (msg: JSONRPCMessage) => {
    try {
      // transient network errors (stale keep-alive socket, owner busy) get a few retries
      for (let attempt = 0; ; attempt++) {
        try {
          await remote.send(msg);
          break;
        } catch (e) {
          const transient = /fetch failed|ECONNRESET|ECONNREFUSED|UND_ERR|socket|terminated/i.test(errMsg(e));
          if (!transient || attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
    } catch (e) {
      const what = 'method' in msg ? msg.method : 'response';
      log(`proxy forward failed (${what}): ${errMsg(e)}`);
      if ('id' in msg && 'method' in msg) {
        void stdio.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `whatsapp-mcp proxy: ${errMsg(e)}` } });
      }
      // one rejected message is not a dead owner: only give up when the bridge itself is gone
      // require several consecutive failed health checks before giving up
      let alive = false;
      for (let i = 0; i < 4 && !alive; i++) {
        alive = await ownerReachable(info);
        if (!alive) await new Promise((r) => setTimeout(r, 1000));
      }
      if (!alive) void shutdown(1, 'owner unreachable');
    }
  };
  // Until the owner has assigned our mcp-session-id (initialize response), forward strictly in
  // order: anything sent earlier carries no session id and the owner rejects it.
  let queue: Promise<void> = Promise.resolve();
  stdio.onmessage = (msg: JSONRPCMessage) => {
    if (remote.sessionId) queue = queue.then(() => void forward(msg));
    else queue = queue.then(() => forward(msg));
  };
  remote.onmessage = (msg: JSONRPCMessage) => {
    // keep the HTTP transport on the negotiated protocol version after `initialize`
    const v = (msg as { result?: { protocolVersion?: string } }).result?.protocolVersion;
    if (v) remote.setProtocolVersion?.(v);
    stdio.send(msg).catch((e) => log(`proxy reply failed: ${errMsg(e)}`));
  };
  remote.onerror = (e) => log(`proxy transport error: ${errMsg(e)}`);
  remote.onclose = () => void shutdown(1, 'owner closed the connection');
  stdio.onclose = () => void shutdown(0, 'client closed stdio');

  await remote.start();
  await stdio.start();
  log(`proxying to whatsapp-mcp owner pid ${info.pid} on 127.0.0.1:${info.port}`);
  return () => shutdown(0, 'signal');
}
