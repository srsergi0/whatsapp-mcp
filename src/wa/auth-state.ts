import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from 'baileys';
import type { Repo } from '../db/repo.js';

/**
 * Baileys auth state backed by SQLite instead of thousands of json files.
 * Writes of one `keys.set` batch are atomic (single transaction), which removes the
 * half-written-file corruption the multi-file state is known for.
 */
export function useSqliteAuthState(repo: Repo, session: string): { state: AuthenticationState; saveCreds: () => Promise<void>; registered: boolean } {
  const db = repo.db;
  const row = db.get<{ data: string }>('SELECT data FROM auth_creds WHERE session = ?', session);
  const creds: AuthenticationCreds = row ? JSON.parse(row.data, BufferJSON.reviver) : initAuthCreds();

  const saveCreds = async () => {
    db.run(
      'INSERT INTO auth_creds(session, data) VALUES (?,?) ON CONFLICT(session) DO UPDATE SET data = excluded.data',
      session, JSON.stringify(creds, BufferJSON.replacer));
  };
  if (!row) void saveCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          const r = db.get<{ data: string }>('SELECT data FROM auth_keys WHERE session = ? AND type = ? AND id = ?', session, type, id);
          if (!r) continue;
          let value = JSON.parse(r.data, BufferJSON.reviver);
          if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
          out[id] = value;
        }
        return out;
      },
      set: async (data) => {
        db.tx(() => {
          for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            const bucket = data[type] as Record<string, unknown> | undefined;
            if (!bucket) continue;
            for (const id of Object.keys(bucket)) {
              const value = bucket[id];
              if (value === null || value === undefined) {
                db.run('DELETE FROM auth_keys WHERE session = ? AND type = ? AND id = ?', session, type, id);
              } else {
                db.run(
                  'INSERT INTO auth_keys(session, type, id, data) VALUES (?,?,?,?) ON CONFLICT(session, type, id) DO UPDATE SET data = excluded.data',
                  session, type, id, JSON.stringify(value, BufferJSON.replacer));
              }
            }
          }
        });
      },
      clear: async () => {
        db.run('DELETE FROM auth_keys WHERE session = ?', session);
      },
    },
  };

  return { state, saveCreds, registered: !!creds.registered };
}
