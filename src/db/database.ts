import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';

export type Param = string | number | bigint | Uint8Array | null | undefined | boolean;

function clean(p: Param): string | number | bigint | Uint8Array | null {
  if (p === undefined || p === null) return null;
  if (typeof p === 'boolean') return p ? 1 : 0;
  return p;
}

/** Thin wrapper over node:sqlite: statement cache, undefined/boolean coercion, transactions. */
export class Db {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 8000;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -32000;
    `);
    this.migrate();
  }

  private migrate() {
    const row = this.raw.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let i = row.user_version; i < MIGRATIONS.length; i++) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(MIGRATIONS[i]!);
        this.raw.exec(`PRAGMA user_version = ${i + 1}`);
        this.raw.exec('COMMIT');
      } catch (e) {
        this.raw.exec('ROLLBACK');
        throw new Error(`DB migration ${i + 1} failed: ${(e as Error).message}`);
      }
    }
  }

  get schemaVersion(): number {
    return (this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: Param[]) {
    return this.stmt(sql).run(...params.map(clean));
  }
  get<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params.map(clean)) as T | undefined;
  }
  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params.map(clean)) as T[];
  }
  exec(sql: string) {
    this.raw.exec(sql);
  }

  /** Re-entrant transaction (nested calls join the outer one). */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  close() {
    try {
      this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch { /* ignore */ }
    this.cache.clear();
    this.raw.close();
  }
}
