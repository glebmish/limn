import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'

function tmpDbFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-merge-')), 'db')
}

function freshDb(): DatabaseSync {
  return openDb(tmpDbFile()).db
}

describe('migration v8 (merged sessions)', () => {
  it('adds merged_at and merge_json to sessions and lands schema_version at 8', () => {
    const db = freshDb()
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('merged_at')
    expect(cols).toContain('merge_json')
    const v = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }
    expect(parseInt(v.value, 10)).toBe(8)
    db.close()
  })

  it('re-runs idempotently over a db that already has the columns (PRAGMA guard)', () => {
    const file = tmpDbFile()
    const first = openDb(file).db
    // simulate a dev build that added the columns but still recorded v7 — the
    // exact situation the v4/v5/v7 guards exist for
    first.prepare(`UPDATE meta SET value = '7' WHERE key = 'schema_version'`).run()
    first.close()
    const again = openDb(file).db // v8 re-runs over existing columns — must not throw
    const cols = (again.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name)
    expect(cols.filter((c) => c === 'merged_at')).toHaveLength(1)
    expect(cols.filter((c) => c === 'merge_json')).toHaveLength(1)
    again.close()
  })
})
