import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, isCorruptionError } from '../src/main/db/db'

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-db-')), 'limn.db')
}

describe('openDb', () => {
  it('creates schema and records schema_version', () => {
    const { db, recoveredFrom } = openDb(tmpFile())
    expect(recoveredFrom).toBeUndefined()
    const v = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }
    expect(parseInt(v.value, 10)).toBeGreaterThanOrEqual(1)
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
      .map((r) => r.name)
    for (const t of ['repos', 'sessions', 'comments', 'chat_messages', 'iterations',
      'viewed_files', 'reviewed_sections', 'artifacts', 'artifact_approvals',
      'prefs', 'meta']) {
      expect(tables).toContain(t)
    }
    db.close()
  })

  it('reopen is idempotent (migrations do not re-run)', () => {
    const file = tmpFile()
    openDb(file).db.close()
    const { db, recoveredFrom } = openDb(file)
    expect(recoveredFrom).toBeUndefined()
    db.close()
  })

  it('corrupt file is backed up, fresh db created, backup path reported', () => {
    const file = tmpFile()
    fs.writeFileSync(file, 'this is not a sqlite database, not even close — pad pad pad')
    const { db, recoveredFrom } = openDb(file)
    expect(recoveredFrom).toMatch(/limn\.db\.corrupt-/)
    expect(fs.existsSync(recoveredFrom!)).toBe(true)
    // fresh db is usable
    db.prepare(`INSERT INTO prefs (key, value) VALUES ('a', 'b')`).run()
    db.close()
  })

  it('migration failure on a healthy db throws and preserves data', () => {
    const file = tmpFile()
    const first = openDb(file)
    first.db.prepare(`INSERT INTO prefs (key, value) VALUES ('keep', 'me')`).run()
    // force migration 1 to re-run against the existing schema → CREATE TABLE collides → throws
    first.db.prepare(`UPDATE meta SET value = '0' WHERE key = 'schema_version'`).run()
    first.db.close()
    expect(() => openDb(file)).toThrow()
    // not treated as corruption: no backup-aside, the original file is left in place
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-'))).toEqual([])
    const again = new DatabaseSync(file)
    const row = again.prepare(`SELECT value FROM prefs WHERE key = 'keep'`).get() as { value: string }
    expect(row.value).toBe('me')
    again.close()
  })
})

describe('isCorruptionError', () => {
  it('classifies genuine corruption as corruption (→ move aside)', () => {
    for (const m of [
      'integrity: page 3 missing',
      'file is not a database',
      'SQLITE_NOTADB: file is not a database',
      'database disk image is malformed',
      'file is encrypted or is not a database',
      'SQLITE_CORRUPT: database corruption detected'
    ]) {
      expect(isCorruptionError(new Error(m))).toBe(true)
    }
  })

  it('classifies transient/permission failures as NOT corruption (→ rethrow, never drop data)', () => {
    for (const m of [
      'SQLITE_BUSY: database is locked',
      'database is locked',
      'EACCES: permission denied, open',
      'EBUSY: resource busy or locked',
      'unable to open database file'
    ]) {
      expect(isCorruptionError(new Error(m))).toBe(false)
    }
  })
})
