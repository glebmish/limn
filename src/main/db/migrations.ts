import type { DatabaseSync } from 'node:sqlite'

export interface Migration { version: number; up(db: DatabaseSync): void }

/** Forward-only, applied in order inside a transaction. Never edit a shipped
 *  migration — append a new one.
 *
 *  Greenfield baseline: the original v1–v5 history was squashed into this single
 *  schema (no released databases to preserve). When evolving the schema from
 *  here, append a new migration with the next version — don't edit this one. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);

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
          execution_mode TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user','agent')),
          text TEXT NOT NULL,
          at TEXT NOT NULL,
          anchor_json TEXT,
          actions_json TEXT,
          tools_json TEXT
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
          hash TEXT NOT NULL,
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
    // ordered text↔tool segments for inline tool-call rendering in chat messages.
    // Nullable: old rows have NULL → renderer falls back to the legacy tools-then-text path.
    version: 2,
    up(db) {
      db.exec('ALTER TABLE chat_messages ADD COLUMN segments_json TEXT')
    }
  },
  {
    // Approval is a set of previously approved committed states. `sessions.approved_sha`
    // remains the current baseline pointer for older code/data, while this table lets
    // reopening or checking out any earlier approved SHA restore the approved state.
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE session_approvals (
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          sha TEXT NOT NULL,
          hash TEXT NOT NULL,
          approved_at TEXT NOT NULL,
          PRIMARY KEY (session_id, hash)
        );
        INSERT INTO session_approvals (session_id, sha, hash, approved_at)
          SELECT id, approved_sha, approved_sha, updated_at FROM sessions WHERE approved_sha IS NOT NULL;
      `)
    }
  },
  {
    // Compatibility for dev builds that created the first approval-history table as
    // `(session_id, sha)` only. Re-key it by branch surface hash; legacy rows use
    // `hash = sha`, which is exactly the clean-tree surface hash.
    version: 4,
    up(db) {
      const cols = db.prepare('PRAGMA table_info(session_approvals)').all() as { name: string }[]
      if (cols.some((c) => c.name === 'hash')) return
      db.exec(`
        CREATE TABLE session_approvals_new (
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          sha TEXT NOT NULL,
          hash TEXT NOT NULL,
          approved_at TEXT NOT NULL,
          PRIMARY KEY (session_id, hash)
        );
        INSERT INTO session_approvals_new (session_id, sha, hash, approved_at)
          SELECT session_id, sha, sha, approved_at FROM session_approvals;
        DROP TABLE session_approvals;
        ALTER TABLE session_approvals_new RENAME TO session_approvals;
      `)
    }
  }
]
