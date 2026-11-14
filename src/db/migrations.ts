/** Append-only list. Index + 1 == PRAGMA user_version after applying. */
export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
CREATE TABLE sessions (
  name TEXT PRIMARY KEY,
  phone TEXT,
  jid TEXT,
  lid TEXT,
  push_name TEXT,
  registered INTEGER NOT NULL DEFAULT 0,
  auto_connect INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'disconnected',
  last_disconnect_code INTEGER,
  last_disconnect_reason TEXT,
  connected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Baileys auth state lives in SQLite: atomic, one file, no thousands of json files.
CREATE TABLE auth_creds (
  session TEXT PRIMARY KEY REFERENCES sessions(name) ON DELETE CASCADE,
  data TEXT NOT NULL
);
CREATE TABLE auth_keys (
  session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (session, type, id)
) WITHOUT ROWID;

CREATE TABLE jid_map (
  session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
  lid TEXT NOT NULL,
  pn TEXT NOT NULL,
  PRIMARY KEY (session, lid)
) WITHOUT ROWID;
CREATE INDEX idx_jid_map_pn ON jid_map(session, pn);

CREATE TABLE chats (
  session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'user',
  name TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER,
  ephemeral_duration INTEGER,
  last_message_ts INTEGER,
  last_message_id TEXT,
  last_message_preview TEXT,
  last_message_from_me INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session, jid)
) WITHOUT ROWID;
CREATE INDEX idx_chats_recent ON chats(session, last_message_ts DESC);

CREATE TABLE contacts (
  session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  name TEXT,
  notify TEXT,
  verified_name TEXT,
  lid TEXT,
  phone TEXT,
  about TEXT,
  about_ts INTEGER,
  is_business INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session, jid)
) WITHOUT ROWID;

CREATE TABLE messages (
  session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
  chat_jid TEXT NOT NULL,
  id TEXT NOT NULL,
  from_me INTEGER NOT NULL,
  sender_jid TEXT,
  sender_name TEXT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  text TEXT,
  caption TEXT,
  quoted_id TEXT,
  quoted_sender TEXT,
  quoted_text TEXT,
  quoted_type TEXT,
  mentions TEXT,
  forwarded INTEGER NOT NULL DEFAULT 0,
  status INTEGER,
  starred INTEGER NOT NULL DEFAULT 0,
  edited INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  ephemeral_expiration INTEGER,
  media_mime TEXT,
  media_name TEXT,
  media_size INTEGER,
  media_path TEXT,
  media_seconds INTEGER,
  extra TEXT,
  raw TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session, chat_jid, id, from_me)
);
CREATE INDEX idx_messages_chat_ts ON messages(session, chat_jid, ts DESC);
CREATE INDEX idx_messages_ts ON messages(session, ts DESC);
CREATE INDEX idx_messages_id ON messages(session, id);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  text, caption, sender_name,
  content='messages', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, caption, sender_name) VALUES (new.rowid, new.text, new.caption, new.sender_name);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, caption, sender_name) VALUES ('delete', old.rowid, old.text, old.caption, old.sender_name);
END;
CREATE TRIGGER messages_au AFTER UPDATE OF text, caption, sender_name ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, caption, sender_name) VALUES ('delete', old.rowid, old.text, old.caption, old.sender_name);
  INSERT INTO messages_fts(rowid, text, caption, sender_name) VALUES (new.rowid, new.text, new.caption, new.sender_name);
END;

CREATE TABLE reactions (
  session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
  chat_jid TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reactor TEXT NOT NULL,
  emoji TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (session, chat_jid, message_id, reactor)
) WITHOUT ROWID;

CREATE TABLE poll_votes (
  session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
  chat_jid TEXT NOT NULL,
  poll_id TEXT NOT NULL,
  voter TEXT NOT NULL,
  options TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (session, chat_jid, poll_id, voter)
) WITHOUT ROWID;

CREATE TABLE groups (
  session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  subject TEXT,
  description TEXT,
  owner TEXT,
  creation INTEGER,
  announce INTEGER NOT NULL DEFAULT 0,
  restrict_info INTEGER NOT NULL DEFAULT 0,
  join_approval INTEGER NOT NULL DEFAULT 0,
  member_add_mode TEXT,
  ephemeral_duration INTEGER,
  is_community INTEGER NOT NULL DEFAULT 0,
  size INTEGER,
  participants TEXT,
  me_is_admin INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session, jid)
) WITHOUT ROWID;

CREATE TABLE labels (
  session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT,
  color INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session, id)
) WITHOUT ROWID;
CREATE TABLE label_assoc (
  session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
  label_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  message_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session, label_id, chat_jid, message_id)
) WITHOUT ROWID;

CREATE TABLE calls (
  session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  chat_jid TEXT,
  from_jid TEXT,
  is_video INTEGER NOT NULL DEFAULT 0,
  is_group INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  ts INTEGER NOT NULL,
  PRIMARY KEY (session, call_id)
) WITHOUT ROWID;

-- Agent memory: free-form facts and tags attached to a chat/contact. Survives restarts.
CREATE TABLE memory (
  session TEXT NOT NULL,
  jid TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session, jid, key)
) WITHOUT ROWID;
CREATE TABLE tags (
  session TEXT NOT NULL,
  jid TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (session, jid, tag)
) WITHOUT ROWID;
CREATE INDEX idx_tags_tag ON tags(session, tag);

CREATE TABLE ignore_list (
  session TEXT NOT NULL,
  jid TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session, jid)
) WITHOUT ROWID;

CREATE TABLE scheduled_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL,
  to_jid TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  send_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_sched_due ON scheduled_messages(status, send_at);

-- Durable event journal: a client can resume after a restart with since_id.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL,
  type TEXT NOT NULL,
  chat_jid TEXT,
  ref_id TEXT,
  ts INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX idx_events_session ON events(session, id);
CREATE INDEX idx_events_chat ON events(session, chat_jid, id);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session TEXT,
  tool TEXT NOT NULL,
  target TEXT,
  ok INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX idx_audit_ts ON audit_log(ts DESC);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
`,
  /* 2: direction-aware index for the inbox (unanswered detection) */ `
CREATE INDEX idx_messages_dir ON messages(session, chat_jid, from_me, ts DESC);
`,
  /* 3: interaction timeline: things that happened OUTSIDE the chat (calls, meetings, to-dos) */ `
CREATE TABLE interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  note TEXT NOT NULL,
  ref_id TEXT,
  handled INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER,
  status TEXT NOT NULL DEFAULT 'done',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_interactions_chat ON interactions(session, jid, ts DESC);
CREATE INDEX idx_interactions_open ON interactions(session, status, due_at);
`,
  /* 4: "waiting for their reply" entries close themselves when the answer arrives */ `
ALTER TABLE interactions ADD COLUMN resolved_at INTEGER;
ALTER TABLE interactions ADD COLUMN resolved_by TEXT;
CREATE INDEX idx_interactions_waiting ON interactions(session, jid, kind, status);
`,
];
