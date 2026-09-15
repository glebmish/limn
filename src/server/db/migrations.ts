import type { DatabaseSync } from 'node:sqlite'

export interface Migration { version: number; up(db: DatabaseSync): void }

/** Forward-only, applied in order inside a transaction. Never edit a shipped
 *  migration — append a new one.
 *
 *  Greenfield baseline: there are no released databases to preserve, so the
 *  entire migration history is squashed into this single starting schema. When
 *  evolving from here, append a new migration with the next version — don't edit
 *  this one. */
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
          merged_at TEXT,
          merge_json TEXT,
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
          tools_json TEXT,
          segments_json TEXT,
          comment_refs_json TEXT
        );

        CREATE TABLE iterations (
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          n INTEGER NOT NULL,
          engine TEXT NOT NULL,
          engine_session_id TEXT NOT NULL,
          end_sha TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT,
          annotations_json TEXT NOT NULL,
          scope TEXT,
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

        CREATE TABLE session_approvals (
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          sha TEXT NOT NULL,
          hash TEXT NOT NULL,
          approved_at TEXT NOT NULL,
          PRIMARY KEY (session_id, hash)
        );

        CREATE TABLE excluded_files (
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          file TEXT NOT NULL,
          excluded INTEGER NOT NULL,
          PRIMARY KEY (session_id, file)
        );
      `)
    }
  },
  {
    // the review's default diff stack (design board 13): which sheets are out beside
    // current and what Unified is measured against — JSON, parsed by parseStack
    version: 2,
    up(db) {
      db.exec('ALTER TABLE sessions ADD COLUMN diff_stack TEXT')
    }
  },
  {
    // the per-section "verify" step (a copyable command chip) was dropped from the
    // review: it was the agent's own self-report that tests passed, nothing the
    // reviewer could act on. Strip the key from every stored annotations blob so the
    // Section type and the stored shape agree; a blob that doesn't parse is left as-is
    // (loadSession already reports those as unloadable — not this migration's job).
    version: 3,
    up(db) {
      for (const table of ['sessions', 'iterations']) {
        const key = table === 'sessions' ? 'id' : 'rowid'
        const rows = db.prepare(`SELECT ${key} AS k, annotations_json FROM ${table} WHERE annotations_json IS NOT NULL`)
          .all() as { k: number; annotations_json: string }[]
        const write = db.prepare(`UPDATE ${table} SET annotations_json = ? WHERE ${key} = ?`)
        for (const r of rows) {
          let ann: { sections?: unknown }
          try { ann = JSON.parse(r.annotations_json) as { sections?: unknown } } catch { continue }
          if (!Array.isArray(ann.sections)) continue
          let touched = false
          for (const s of ann.sections as Record<string, unknown>[]) {
            if (s && typeof s === 'object' && 'verify' in s) { delete s.verify; touched = true }
          }
          if (touched) write.run(JSON.stringify(ann), r.k)
        }
      }
    }
  },
  {
    // base_ident was dead weight: findSession deliberately keys the base side on the
    // immutable base_anchor_sha ("a session's base is pinned once generated"), so no
    // statement ever read this generated column — while the docs still demanded it be
    // kept in lockstep with refIdentity(). compare_ident stays: findSession filters on it.
    version: 4,
    up(db) {
      db.exec('ALTER TABLE sessions DROP COLUMN base_ident')
    }
  },
  {
    // chat_messages is the one table that grows without bound and is keyed only by its
    // own autoincrement id, so every per-thread read (once per thread on every session
    // load) and every chat_threads cascade delete scanned it. (thread_id, id) also
    // covers the ORDER BY id those reads use.
    version: 5,
    up(db) {
      db.exec('CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_id, id)')
    }
  },
  {
    // reviewed_sections lost its last writer when section completeness became derived
    // from the section's per-file view marks (a section is done when all its files are
    // ticked). The table only ever emptied out after that, so every read of it — the
    // review-copy loop, the ReviewState field, and the agent's get_review_progress —
    // reported "no sections read" no matter how far the reviewer had got.
    version: 6,
    up(db) {
      db.exec('DROP TABLE reviewed_sections')
    }
  },
  {
    // Agent actions (design board 14): an ACTION thread remembers which pinned action
    // runs in it, and the messages that launch / end a run carry the run's identity
    // and outcome. Both are JSON blobs — nothing filters on them; the DAO reads the
    // thread and rebuilds run numbering from the messages. Comments gain two statuses,
    // `proposed` (an agent finding the reviewer has not taken) and `dismissed` (hidden,
    // restorable); SQLite cannot widen a CHECK in place, so the table is rebuilt —
    // the same rows, the same primary key, one longer status list. Stored hotspots
    // stay `resolved` (pre-v3 notes); only new generations mint proposals.
    version: 7,
    up(db) {
      db.exec('ALTER TABLE chat_threads ADD COLUMN action_json TEXT')
      db.exec('ALTER TABLE chat_messages ADD COLUMN run_json TEXT')
      db.exec(`
        CREATE TABLE comments_v7 (
          id TEXT NOT NULL,
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('queued','sent','resolved','outdated','proposed','dismissed')),
          json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (session_id, id)
        );
        INSERT INTO comments_v7 (id, session_id, status, json, created_at)
          SELECT id, session_id, status, json, created_at FROM comments;
        DROP TABLE comments;
        ALTER TABLE comments_v7 RENAME TO comments;
      `)
    }
  },
  {
    // The specs/plans rail is reconciled with the current diff on every load instead
    // of being detected once and cached for good (a rebase or squash that drops a
    // spec from the diff used to leave it in the rail forever). Reconciling needs to
    // know which cached rows the AGENT reported — those are kept off-diff, detected
    // ones are not. Existing rows are all detection's.
    version: 8,
    up(db) {
      db.exec("ALTER TABLE artifacts ADD COLUMN source TEXT NOT NULL DEFAULT 'detected' CHECK (source IN ('detected','agent'))")
    }
  }
]
