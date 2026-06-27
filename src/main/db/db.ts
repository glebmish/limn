import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { MIGRATIONS } from './migrations.js'

export interface OpenResult { db: DatabaseSync; recoveredFrom?: string }

/** Open (creating if needed) and migrate the app database.
 *  A corrupt/unreadable file is moved aside — never silently dropped — and a
 *  fresh db is created; `recoveredFrom` carries the backup path for the UI.
 *  A migration failure on a healthy db throws (data preserved). */
export function openDb(file: string): OpenResult {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let db: DatabaseSync
  let recoveredFrom: string | undefined
  try {
    db = open(file)
  } catch (err) {
    // Only move the live db aside when the file is genuinely corrupt. Transient
    // failures (lock contention from a concurrent desktop+web open, a permissions
    // error) must NOT rename the user's real database away and create an empty one
    // — that would be surprising data loss. Rethrow those instead.
    if (!isCorruptionError(err)) throw err
    recoveredFrom = `${file}.corrupt-${Date.now()}`
    fs.renameSync(file, recoveredFrom)
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true })
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

/** True when an open/integrity error indicates an actually corrupt database file
 *  (as opposed to a lock, permission, or other transient failure). Matches the
 *  integrity_check sentinel raised by open() and SQLite's corruption messages. */
export function isCorruptionError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /\bintegrity\b|malformed|not a database|file is encrypted|database disk image|sqlite_corrupt|sqlite_notadb/.test(msg)
}

function open(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    const check = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    if (check.integrity_check !== 'ok') throw new Error(`integrity: ${check.integrity_check}`)
  } catch (err) {
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
