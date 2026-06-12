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
  } catch {
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

function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined
  let version = row ? parseInt(row.value, 10) : 0
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
