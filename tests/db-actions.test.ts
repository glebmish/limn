import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/server/db/db'
import { MIGRATIONS } from '../src/server/db/migrations'
import {
  addChatMessage, createChatThread, createSession, getChatThread, nextRunNumber, setRunResult
} from '../src/server/db/sessions'
import type { ActionRunRef, RefPair } from '../src/shared/types'

let db: DatabaseSync
beforeEach(() => {
  db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-act-')), 'db')).db
})

const pair: RefPair = {
  base: { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
  compare: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) }
}
const run = (n: number): ActionRunRef => ({ actionId: 'act-1', runId: `run-1-${n}`, n, name: 'Simplify', kind: 'skill' })

describe('migration 7 — action threads and run metadata', () => {
  it('is the newest migration and adds the two columns', () => {
    expect(MIGRATIONS[MIGRATIONS.length - 1].version).toBe(8)
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('chat_threads')).toContain('action_json')
    expect(cols('chat_messages')).toContain('run_json')
  })

  it('applies on top of a v6 database, keeping every comment and widening the status check', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-v6-')), 'db')
    const raw = new DatabaseSync(file)
    raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    for (const m of MIGRATIONS.filter((m) => m.version <= 6)) m.up(raw)
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '6')").run()
    // seed through the DAO — v6 is the current schema, so its SQL applies as-is
    raw.exec('PRAGMA foreign_keys = ON')
    const seeded = createSession(raw, '/repo', pair, { engine: 'claude' })
    raw.prepare("INSERT INTO comments (id, session_id, status, json, created_at) VALUES ('c1', ?, 'resolved', '{}', 't')").run(seeded.id)
    raw.close()
    const { db: upgraded } = openDb(file)
    const v = upgraded.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }
    expect(v.value).toBe('8')
    expect((upgraded.prepare('SELECT status FROM comments WHERE id = ?').get('c1') as { status: string }).status).toBe('resolved')
    const sid = (upgraded.prepare('SELECT session_id FROM comments WHERE id = ?').get('c1') as { session_id: number }).session_id
    upgraded.prepare("INSERT INTO comments (id, session_id, status, json, created_at) VALUES ('c2', ?, 'proposed', '{}', 't')").run(sid)
    upgraded.prepare("INSERT INTO comments (id, session_id, status, json, created_at) VALUES ('c3', ?, 'dismissed', '{}', 't')").run(sid)
    expect(() => upgraded.prepare("INSERT INTO comments (id, session_id, status, json, created_at) VALUES ('c4', ?, 'bogus', '{}', 't')").run(sid)).toThrow(/CHECK/)
    // the cascade survives the rebuild
    upgraded.prepare('DELETE FROM sessions WHERE id = ?').run(sid)
    expect((upgraded.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n).toBe(0)
    upgraded.close()
  })
})

describe('action threads', () => {
  it('round-trips the action on a thread', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' }, title: 'Simplify', action: { actionId: 'act-1', name: 'Simplify', kind: 'skill' } })
    expect(t.action).toEqual({ actionId: 'act-1', name: 'Simplify', kind: 'skill' })
    expect(getChatThread(db, t.id)?.action?.actionId).toBe('act-1')
    // a plain user thread has no action
    const plain = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    expect(plain.action).toBeUndefined()
  })

  it('numbers runs by the launching user messages and round-trips run metadata', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' }, action: { actionId: 'act-1', name: 'Simplify', kind: 'skill' } })
    expect(nextRunNumber(db, t.id)).toBe(1)
    addChatMessage(db, t.id, { role: 'user', text: '/simplify', at: 't1', run: run(1) })
    addChatMessage(db, t.id, { role: 'agent', text: 'done', at: 't2', runResult: { runId: 'run-1-1', outcome: 'finished' } })
    // an ordinary follow-up reply does not count as a run
    addChatMessage(db, t.id, { role: 'user', text: 'you missed one', at: 't3' })
    expect(nextRunNumber(db, t.id)).toBe(2)
    const msgs = getChatThread(db, t.id)!.messages
    expect(msgs[0].run).toEqual(run(1))
    expect(msgs[1].runResult).toEqual({ runId: 'run-1-1', outcome: 'finished' })
    expect(msgs[2].run).toBeUndefined()
  })

  it('patches a run result in place (keep as prose)', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' }, action: { actionId: 'act-1', name: 'Simplify', kind: 'skill' } })
    addChatMessage(db, t.id, { role: 'user', text: '/simplify', at: 't1', run: run(1) })
    addChatMessage(db, t.id, { role: 'agent', text: 'report', at: 't2', runResult: { runId: 'run-1-1', outcome: 'finished' } })
    setRunResult(db, t.id, 'run-1-1', { keepProse: true })
    expect(getChatThread(db, t.id)!.messages[1].runResult).toEqual({ runId: 'run-1-1', outcome: 'finished', keepProse: true })
    // unknown run: no-op
    setRunResult(db, t.id, 'nope', { keepProse: true })
  })
})
