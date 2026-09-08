import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, isCorruptionError } from '../src/server/db/db'
import { MIGRATIONS } from '../src/server/db/migrations'

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
      'viewed_files', 'artifacts', 'artifact_approvals',
      'session_approvals',
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

  it('sets busy_timeout to 5000 so a concurrent writer waits instead of failing instantly', () => {
    const { db } = openDb(tmpFile())
    const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number }
    expect(row.timeout).toBe(5000)
    db.close()
  })

  it('a writer colliding with an open write transaction waits its busy_timeout, then succeeds once the lock clears', () => {
    const file = tmpFile()
    const a = openDb(file).db
    const b = openDb(file).db
    // Shrink B's wait so the test is fast; proves the stall is governed by busy_timeout.
    b.exec('PRAGMA busy_timeout = 100')

    a.exec('BEGIN IMMEDIATE') // A takes the write lock
    a.prepare(`INSERT INTO prefs (key, value) VALUES ('a', '1')`).run()

    const started = Date.now()
    expect(() => b.prepare(`INSERT INTO prefs (key, value) VALUES ('b', '2')`).run()).toThrow()
    expect(Date.now() - started).toBeGreaterThanOrEqual(90) // it waited ~100 ms, not 0

    a.exec('COMMIT') // release the lock
    b.prepare(`INSERT INTO prefs (key, value) VALUES ('b', '2')`).run() // now succeeds
    expect((b.prepare(`SELECT value FROM prefs WHERE key = 'b'`).get() as { value: string }).value).toBe('2')

    a.close(); b.close()
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

  it('a corrupt file keeps its -wal/-shm sidecars beside the backup instead of deleting them', () => {
    const file = tmpFile()
    fs.writeFileSync(file, 'this is not a sqlite database, not even close — pad pad pad')
    fs.writeFileSync(`${file}-wal`, 'pretend write-ahead log with the last committed transactions')
    fs.writeFileSync(`${file}-shm`, 'pretend shared-memory index')
    const { db, recoveredFrom } = openDb(file)
    // the last committed transactions live in the WAL — the aside copy must keep it
    expect(fs.readFileSync(`${recoveredFrom!}-wal`, 'utf8')).toBe('pretend write-ahead log with the last committed transactions')
    // the -shm is only a regenerable index (and SQLite rewrites it during the failed
    // open), so it just has to travel with the backup rather than be destroyed
    expect(fs.existsSync(`${recoveredFrom!}-shm`)).toBe(true)
    // and the fresh db is not poisoned by the stale sidecars
    db.prepare(`INSERT INTO prefs (key, value) VALUES ('a', 'b')`).run()
    expect((db.prepare(`SELECT value FROM prefs WHERE key = 'a'`).get() as { value: string }).value).toBe('b')
    db.close()
  })

  it('a real db that fails its integrity check is moved aside with its sidecars, and the fresh db is clean', () => {
    const file = tmpFile()
    // a genuine SQLite file with enough b-tree pages to damage past the header — unlike
    // the plain-text cases above, this one opens fine and takes journal_mode = WAL, so
    // the failed handle is live (and holds sidecars) when recovery runs.
    const first = openDb(file).db
    first.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    const ins = first.prepare('INSERT INTO t (v) VALUES (?)')
    for (let i = 0; i < 500; i++) ins.run(`row-${i}-${'x'.repeat(60)}`)
    first.close()
    const fd = fs.openSync(file, 'r+')
    const pages = fs.statSync(file).size / 4096
    for (let page = 1; page < pages; page++) fs.writeSync(fd, Buffer.alloc(2000, 0x5a), 0, 2000, 4096 * page + 24)
    fs.closeSync(fd)

    const { db, recoveredFrom } = openDb(file)
    expect(recoveredFrom).toMatch(/limn\.db\.corrupt-/)
    expect(fs.existsSync(recoveredFrom!)).toBe(true)
    expect(fs.existsSync(`${recoveredFrom!}-wal`)).toBe(true)
    expect(fs.existsSync(`${recoveredFrom!}-shm`)).toBe(true)

    // the fresh db is genuinely fresh and migrated — nothing of the corrupt one leaked
    // back in through a sidecar left at the original path
    expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = 't'`).get()).toBeUndefined()
    expect(db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get())
      .toEqual({ value: String(MIGRATIONS[MIGRATIONS.length - 1].version) })
    db.prepare(`INSERT INTO prefs (key, value) VALUES ('a', 'b')`).run()
    expect((db.prepare(`SELECT value FROM prefs WHERE key = 'a'`).get() as { value: string }).value).toBe('b')
    db.close()
    // once the fresh handle is closed, the only sidecars left are the backup's
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('-wal') || f.endsWith('-shm')).sort())
      .toEqual([`${path.basename(recoveredFrom!)}-shm`, `${path.basename(recoveredFrom!)}-wal`])
  })

  it('recover: false on a corrupt file rejects instead of moving it aside', () => {
    const file = tmpFile()
    fs.writeFileSync(file, 'this is not a sqlite database, not even close — pad pad pad')
    expect(() => openDb(file, { recover: false })).toThrow(/corrupt/)
    // the file is untouched — no backup-aside, nothing renamed
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('this is not a sqlite database, not even close — pad pad pad')
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-'))).toEqual([])
  })

  it('recover: true (the default) on a corrupt file still moves it aside', () => {
    const file = tmpFile()
    fs.writeFileSync(file, 'this is not a sqlite database, not even close — pad pad pad')
    const { db, recoveredFrom } = openDb(file, { recover: true })
    expect(recoveredFrom).toMatch(/limn\.db\.corrupt-/)
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

describe('migrate: two processes starting during a schema bump', () => {
  /** Seed a db at schema_version 1 — the state a user's file is in before migration 2
   *  (`ALTER TABLE sessions ADD COLUMN diff_stack`, deliberately non-idempotent) runs. */
  function seedAtVersion1(file: string): void {
    const db = new DatabaseSync(file)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    MIGRATIONS[0].up(db)
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '1')`).run()
    db.close()
  }

  it('skips a migration the other process already committed instead of aborting with "duplicate column name"', () => {
    const file = tmpFile()
    seedAtVersion1(file)

    // Deterministic stand-in for the race docs/storage-layer.md blesses (an installed
    // service plus a foreground `limn service serve` on the same file): the other
    // process migrates the file to the newest version in the window between our read
    // of schema_version and our own write lock.
    // NOTE: this patches DatabaseSync.prototype.prepare *globally* (restored in the
    // finally below), so this test must not run concurrently with another in this file
    // — vitest runs the cases in a file sequentially, keep it that way.
    const realPrepare = DatabaseSync.prototype.prepare
    let raced = false
    DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
      const stmt = realPrepare.call(this, sql)
      if (!raced && /^\s*SELECT/i.test(sql) && sql.includes('schema_version')) {
        const get = stmt.get.bind(stmt) as (...args: unknown[]) => unknown
        stmt.get = ((...args: unknown[]) => {
          const row = get(...args) // our (about to be stale) read
          if (!raced) { raced = true; openDb(file).db.close() }
          return row
        }) as typeof stmt.get
      }
      return stmt
    } as DatabaseSync['prepare']

    try {
      const { db } = openDb(file)
      expect(raced).toBe(true)
      expect((db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value)
        .toBe(String(MIGRATIONS[MIGRATIONS.length - 1].version))
      // the other process's schema is intact — diff_stack exists exactly once
      const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((c) => c.name)
      expect(cols.filter((c) => c === 'diff_stack')).toEqual(['diff_stack'])
      db.close()
    } finally {
      DatabaseSync.prototype.prepare = realPrepare
    }
  })
})

describe('migration 4: drop the dead base_ident column', () => {
  it('drops base_ident from an existing db, keeping its rows and compare_ident', () => {
    const file = tmpFile()
    // seed a db as it looked before this migration: everything up to version 3
    const seed = new DatabaseSync(file)
    seed.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    for (const m of MIGRATIONS.filter((m) => m.version <= 3)) m.up(seed)
    seed.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '3')`).run()
    seed.prepare(`INSERT INTO repos (id, path) VALUES (1, '/r')`).run()
    seed.prepare(`INSERT INTO sessions (id, repo_id, base_kind, base_symbol, base_anchor_sha, compare_kind, compare_symbol, compare_anchor_sha, created_at, updated_at)
      VALUES (1, 1, 'branch', 'main', 'a', 'branch', 'feat', 'b', 't', 't')`).run()
    // table_xinfo, not table_info: generated columns are hidden from the latter
    expect((seed.prepare('PRAGMA table_xinfo(sessions)').all() as { name: string }[]).map((c) => c.name)).toContain('base_ident')
    seed.close()

    const { db } = openDb(file)
    const cols = (db.prepare('PRAGMA table_xinfo(sessions)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).not.toContain('base_ident')
    expect(cols).toContain('compare_ident') // findSession still filters on this one
    // the row survives the rebuild, compare identity intact
    expect(db.prepare('SELECT base_symbol, base_anchor_sha, compare_ident FROM sessions WHERE id = 1').get())
      .toEqual({ base_symbol: 'main', base_anchor_sha: 'a', compare_ident: 'b:feat' })
    db.close()
  })
})

describe('migration 5: index chat_messages by thread', () => {
  it('adds the index to an existing db and the per-thread read uses it instead of scanning', () => {
    const file = tmpFile()
    // seed a db as it looked before this migration: everything up to version 4
    const seed = new DatabaseSync(file)
    seed.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    for (const m of MIGRATIONS.filter((m) => m.version <= 4)) m.up(seed)
    seed.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '4')`).run()
    expect(seed.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_chat_messages_thread'`).get()).toBeUndefined()
    seed.close()

    const { db } = openDb(file)
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_chat_messages_thread'`).get())
      .toEqual({ name: 'idx_chat_messages_thread' })
    // the read rowToThread runs once per thread on every session load
    const plan = (db.prepare('EXPLAIN QUERY PLAN SELECT role, text, at FROM chat_messages WHERE thread_id = ? ORDER BY id')
      .all(1) as { detail: string }[]).map((r) => r.detail).join(' ')
    expect(plan).toContain('idx_chat_messages_thread')
    expect(plan).not.toContain('SCAN')
    db.close()
  })
})

describe('migration 3: drop the per-section verify step', () => {
  function seedAtVersion2(file: string): void {
    // build the schema as it was at version 2, rather than faking the version on a
    // fully-migrated file — later migrations must see a genuinely older db
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    for (const m of MIGRATIONS.filter((m) => m.version <= 2)) m.up(db)
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '2')`).run()
    db.prepare(`INSERT INTO repos (id, path) VALUES (1, '/r')`).run()
    db.prepare(`INSERT INTO sessions (id, repo_id, base_kind, base_symbol, base_anchor_sha, compare_kind, compare_symbol, compare_anchor_sha, annotations_json, created_at, updated_at)
      VALUES (1, 1, 'branch', 'main', 'a', 'branch', 'feat', 'b', ?, 't', 't')`)
      .run(JSON.stringify({ title: 'T', summary: 'S', sections: [
        { id: 's1', name: 'A', files: [], narration: [], verify: 'npm test', contrast: { was: 'x', now: 'y' } },
        { id: 's2', name: 'B', files: [], narration: [] }
      ] }))
    db.prepare(`INSERT INTO sessions (id, repo_id, base_kind, base_symbol, base_anchor_sha, compare_kind, compare_symbol, compare_anchor_sha, annotations_json, created_at, updated_at)
      VALUES (2, 1, 'branch', 'main', 'a', 'branch', 'feat', 'b', NULL, 't', 't')`).run()
    db.prepare(`INSERT INTO iterations (session_id, n, engine, engine_session_id, end_sha, title, annotations_json, at)
      VALUES (1, 1, 'claude', 'e', 'b', 'T', ?, 't')`)
      .run(JSON.stringify({ title: 'T', summary: 'S', sections: [{ id: 's1', name: 'A', files: [], narration: [], verify: 'go test ./...' }] }))
    db.close()
  }

  it('strips verify from every section in sessions and iterations, keeping everything else', () => {
    const file = tmpFile()
    seedAtVersion2(file)
    const { db } = openDb(file)
    const sess = JSON.parse((db.prepare('SELECT annotations_json FROM sessions WHERE id = 1').get() as { annotations_json: string }).annotations_json)
    expect(sess.sections[0]).toEqual({ id: 's1', name: 'A', files: [], narration: [], contrast: { was: 'x', now: 'y' } })
    expect(sess.sections[1]).toEqual({ id: 's2', name: 'B', files: [], narration: [] })
    expect(sess.title).toBe('T')
    const it1 = JSON.parse((db.prepare('SELECT annotations_json FROM iterations WHERE session_id = 1').get() as { annotations_json: string }).annotations_json)
    expect(it1.sections[0]).toEqual({ id: 's1', name: 'A', files: [], narration: [] })
    // a session with no review is left alone
    expect((db.prepare('SELECT annotations_json FROM sessions WHERE id = 2').get() as { annotations_json: string | null }).annotations_json).toBeNull()
    db.close()
  })

  it('leaves a malformed annotations blob untouched rather than failing the migration', () => {
    const file = tmpFile()
    seedAtVersion2(file)
    const raw = new DatabaseSync(file)
    raw.prepare(`UPDATE sessions SET annotations_json = 'not json' WHERE id = 1`).run()
    raw.close()
    const { db } = openDb(file)
    expect((db.prepare('SELECT annotations_json FROM sessions WHERE id = 1').get() as { annotations_json: string }).annotations_json).toBe('not json')
    db.close()
  })
})
