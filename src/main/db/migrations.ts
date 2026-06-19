import type { DatabaseSync } from 'node:sqlite'

export interface Migration { version: number; up(db: DatabaseSync): void }

/** Forward-only, applied in order inside a transaction. Never edit a shipped
 *  migration — append a new one. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);

        CREATE TABLE pinned_dirs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL UNIQUE,
          position INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE scan_cache (
          pin_id INTEGER PRIMARY KEY REFERENCES pinned_dirs(id) ON DELETE CASCADE,
          tree_json TEXT NOT NULL,
          scanned_at TEXT NOT NULL
        );

        CREATE TABLE repos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL UNIQUE,
          first_commit_sha TEXT,
          last_opened_at TEXT
        );

        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
          base_kind TEXT NOT NULL CHECK (base_kind IN ('branch','commit')),
          base_symbol TEXT NOT NULL,
          base_anchor_sha TEXT NOT NULL,
          compare_kind TEXT NOT NULL CHECK (compare_kind IN ('branch','commit')),
          compare_symbol TEXT NOT NULL,
          compare_anchor_sha TEXT NOT NULL,
          base_ident TEXT GENERATED ALWAYS AS
            (CASE base_kind WHEN 'branch' THEN 'b:' || base_symbol ELSE 'c:' || base_anchor_sha END) STORED,
          compare_ident TEXT GENERATED ALWAYS AS
            (CASE compare_kind WHEN 'branch' THEN 'b:' || compare_symbol ELSE 'c:' || compare_anchor_sha END) STORED,
          engine TEXT,
          model TEXT,
          reasoning_effort TEXT,
          title TEXT,
          summary TEXT,
          annotations_json TEXT,
          approved_sha TEXT,
          reviewed_at_sha TEXT,
          archived_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_sessions_pair
          ON sessions(repo_id, base_ident, compare_ident) WHERE archived_at IS NULL;

        CREATE TABLE comments (
          id TEXT NOT NULL,
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('queued','sent','resolved','outdated')),
          json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (session_id, id)
        );

        CREATE TABLE chat_threads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('review','user')),
          engine TEXT NOT NULL,
          model TEXT,
          reasoning_effort TEXT,
          engine_session_id TEXT,
          title TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user','agent')),
          text TEXT NOT NULL,
          at TEXT NOT NULL,
          anchor_json TEXT
        );

        CREATE TABLE iterations (
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          n INTEGER NOT NULL,
          engine TEXT NOT NULL,
          engine_session_id TEXT NOT NULL,
          end_sha TEXT NOT NULL,
          summary TEXT,
          at TEXT NOT NULL,
          PRIMARY KEY (session_id, n)
        );

        CREATE TABLE viewed_files (
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          file TEXT NOT NULL,
          sha TEXT NOT NULL,
          PRIMARY KEY (session_id, file)
        );

        CREATE TABLE reviewed_sections (
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          section_id TEXT NOT NULL,
          PRIMARY KEY (session_id, section_id)
        );

        CREATE TABLE artifacts (
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('spec','plan')),
          path TEXT NOT NULL,
          PRIMARY KEY (session_id, path)
        );

        CREATE TABLE artifact_approvals (
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          sha TEXT NOT NULL,
          PRIMARY KEY (session_id, path)
        );
      `)
    }
  },
  {
    // Agent tool actions persisted on the authoring chat message, so the action
    // chips (focus, suggest, …) rebuild on reload.
    version: 2,
    up(db) {
      db.exec('ALTER TABLE chat_messages ADD COLUMN actions_json TEXT;')
    }
  }
]
