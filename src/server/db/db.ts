import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { MIGRATIONS } from './migrations.js'

export interface OpenResult { db: DatabaseSync; recoveredFrom?: string }

export interface OpenOptions {
  /** When the file turns out to be corrupt: move it aside and create a fresh one
   *  (the default, today's behaviour — appropriate for a genuine write path). Pass
   *  `false` for a read-only caller (e.g. the CLI's local prefs read) that must
   *  never risk renaming away a database the user still cares about — a corrupt
   *  file then rejects instead. */
  recover?: boolean
}

/** Open (creating if needed) and migrate the app database.
 *  A corrupt/unreadable file is moved aside — never silently dropped — and a
 *  fresh db is created; `recoveredFrom` carries the backup path for the UI.
 *  A migration failure on a healthy db throws (data preserved). */
export function openDb(file: string, opts: OpenOptions = {}): OpenResult {
  const recover = opts.recover ?? true
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let db: DatabaseSync
  let recoveredFrom: string | undefined
  try {
    db = open(file, (err) => {
      // Last window before SQLite unlinks the sidecars (it does that when the failed
      // handle closes). In WAL mode the most recent committed transactions live in the
      // -wal, so a backup kept without it can be missing everything written since the
      // last checkpoint — move them with the backup rather than losing them. They must
      // still leave this path: a stale WAL would poison the freshly created db.
      if (!recover || !isCorruptionError(err)) return
      recoveredFrom = `${file}.corrupt-${Date.now()}`
      for (const suffix of ['-wal', '-shm']) {
        if (!fs.existsSync(`${file}${suffix}`)) continue
        // best-effort: if the move fails (a platform that won't rename an open file),
        // fall back to the removal the fresh open needs.
        try { fs.renameSync(`${file}${suffix}`, `${recoveredFrom}${suffix}`) }
        catch { fs.rmSync(`${file}${suffix}`, { force: true }) }
      }
    })
  } catch (err) {
    // Only move the live db aside when the file is genuinely corrupt. Transient
    // failures (lock contention from a concurrent desktop+web open, a permissions
    // error) must NOT rename the user's real database away and create an empty one
    // — that would be surprising data loss. Rethrow those instead.
    if (!isCorruptionError(err)) throw err
    if (!recover) throw new Error(`database at ${file} is corrupt; starting the Limn service will recover it (a backup of the corrupt file will be kept)`, { cause: err })
    // recoveredFrom was chosen (and the sidecars moved under it) by the hook above
    recoveredFrom ??= `${file}.corrupt-${Date.now()}`
    fs.renameSync(file, recoveredFrom)
    db = open(file)
  }
  try {
    migrate(db) // throws on failure; data stays intact
  } catch (err) {
    db.close()
    throw err
  }
  return { db, recoveredFrom }
}

/** Run writes in one transaction (node:sqlite has no db.transaction()).
 *  Not re-entrant: `fn` must not open its own transaction — including via a dao
 *  helper that opens one itself (e.g. `setArtifacts`, which is why ipc.ts's
 *  generate persist calls it just outside its `inTx` block). */
export function inTx(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* no active txn — keep original error */ }
    throw err
  }
}

/** True when an open/integrity error indicates an actually corrupt database file
 *  (as opposed to a lock, permission, or other transient failure). Matches the
 *  integrity_check sentinel raised by open() and SQLite's corruption messages. */
export function isCorruptionError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /\bintegrity\b|malformed|not a database|file is encrypted|database disk image|sqlite_corrupt|sqlite_notadb/.test(msg)
}

/** `onOpenFailed` runs with the open error while the failed handle is still open —
 *  the only window in which the -wal/-shm sidecars still exist, since SQLite unlinks
 *  them as the last connection closes. */
function open(file: string, onOpenFailed?: (err: unknown) => void): DatabaseSync {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA foreign_keys = ON')
    const check = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    if (check.integrity_check !== 'ok') throw new Error(`integrity: ${check.integrity_check}`)
  } catch (err) {
    onOpenFailed?.(err)
    db.close()
    throw err
  }
  return db
}

/** Parse a stored schema_version. A missing or corrupt (non-numeric) value
 *  becomes 0 — never NaN, which would make `m.version <= version` false for
 *  every migration and silently re-run them all on a healthy db. */
export function parseSchemaVersion(raw: string | undefined): number {
  if (raw == null) return 0
  const v = parseInt(raw, 10)
  return Number.isNaN(v) ? 0 : v
}

function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined
  let version = parseSchemaVersion(row?.value)
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue
    db.exec('BEGIN')
    try {
      m.up(db)
      db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(m.version))
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    version = m.version
  }
}
