import fs from 'node:fs';
import path from 'node:path';

/**
 * Single-owner lock: WhatsApp allows one connection per session, so exactly one
 * process (the owner) talks to it. The owner publishes a loopback HTTP bridge
 * (port + token) in the lock so every other MCP client can proxy to it.
 */
export interface LockInfo {
  pid: number;
  started: string;
  port?: number;
  token?: string;
}

const lockPath = (dir: string) => path.join(dir, 'server.lock');

function alive(pid: number): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(dir: string): LockInfo | undefined {
  try {
    const raw = fs.readFileSync(lockPath(dir), 'utf8').trim();
    if (raw.startsWith('{')) return JSON.parse(raw) as LockInfo;
    const [pid, started] = raw.split(/\s+/); // legacy "pid iso-date"
    return { pid: Number(pid), started: started ?? '' };
  } catch {
    return undefined;
  }
}

export type Acquired = { acquired: true } | { acquired: false; info: LockInfo };

export function acquireLock(dir: string): Acquired {
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, started: new Date().toISOString() } satisfies LockInfo), { flag: 'wx', mode: 0o600 });
      return { acquired: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const info = readLock(dir);
    if (info && alive(info.pid)) return { acquired: false, info };
    try { fs.unlinkSync(lockPath(dir)); } catch { /* raced with another process */ }
  }
  const info = readLock(dir);
  return info ? { acquired: false, info } : { acquired: true };
}

/** Owner publishes how others can reach it. */
export function publishBridge(dir: string, port: number, token: string) {
  const cur = readLock(dir);
  if (cur && cur.pid !== process.pid) return;
  fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, started: cur?.started ?? new Date().toISOString(), port, token } satisfies LockInfo), { mode: 0o600 });
}

export function releaseLock(dir: string) {
  const cur = readLock(dir);
  if (cur?.pid === process.pid) {
    try { fs.unlinkSync(lockPath(dir)); } catch { /* ignore */ }
  }
}
