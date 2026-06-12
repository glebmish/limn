import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/main/db/db'

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-db-')), 'local-review.db')
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
      'pinned_dirs', 'scan_cache', 'prefs']) {
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
    expect(recoveredFrom).toMatch(/local-review\.db\.corrupt-/)
    expect(fs.existsSync(recoveredFrom!)).toBe(true)
    // fresh db is usable
    db.prepare(`INSERT INTO prefs (key, value) VALUES ('a', 'b')`).run()
    db.close()
  })
})
