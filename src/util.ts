export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Deferred<T> {
  promise: Promise<T>;
  resolve!: (v: T) => void;
  reject!: (e: unknown) => void;
  settled = false;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = (v) => { this.settled = true; res(v); };
      this.reject = (e) => { this.settled = true; rej(e); };
    });
    this.promise.catch(() => undefined); // avoid unhandled rejection when nobody awaits
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`Timeout after ${ms}ms: ${what}`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

export function iso(ts: number | null | undefined): string | null {
  if (ts === null || ts === undefined) return null;
  return new Date(ts * 1000).toISOString();
}

/** Tiny TTL map; Baileys accepts anything with get/set/del/flushAll as CacheStore. */
export class TtlCache<V = unknown> {
  private m = new Map<string, { v: V; exp: number }>();
  constructor(private ttlMs: number, private max = 5000) {}
  get<T = V>(k: string): T | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) { this.m.delete(k); return undefined; }
    return e.v as unknown as T;
  }
  set(k: string, v: V) {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
    this.m.set(k, { v, exp: Date.now() + this.ttlMs });
  }
  del(k: string) { this.m.delete(k); }
  flushAll() { this.m.clear(); }
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Run async tasks one at a time. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => undefined);
    return p;
  }
}

/**
 * "2026-10-23T15:30:00-05:00" | "10m" / "-10m" (ago) | "+2h" (from now).
 * An unsigned relative value means `def` ("past" for when-it-happened, "future" for due dates).
 */
export function parseMoment(v: string, def: 'past' | 'future'): number {
  const rel = /^([+-]?)(\d+)\s*([smhdw])$/i.exec(v.trim());
  const now = Math.floor(Date.now() / 1000);
  if (rel) {
    const secs = Number(rel[2]) * ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 } as Record<string, number>)[rel[3]!.toLowerCase()]!;
    const future = rel[1] === '+' ? true : rel[1] === '-' ? false : def === 'future';
    return future ? now + secs : now - secs;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Invalid time "${v}": use ISO-8601 (2026-10-23T15:30:00-05:00) or relative (10m ago = "10m", in 2 days = "+2d").`);
  return Math.floor(t / 1000);
}
