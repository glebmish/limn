import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import {
  createSession, findSession, getSession, retargetSession, archiveSession,
  markSessionMerged, retargetSessionBase, dependentSessions
} from '../src/main/db/sessions'
import type { MergeRecord, RefPair } from '../src/shared/types'

function tmpDbFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-merge-')), 'db')
}

function freshDb(): DatabaseSync {
  return openDb(tmpDbFile()).db
}

const pair: RefPair = {
  base: { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
  compare: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) }
}

const mergeRecord = (over: Partial<MergeRecord> = {}): MergeRecord => ({
  strategy: 'squash',
  mergedSha: '1'.repeat(40),
  reviewedTipSha: '2'.repeat(40),
  baseSymbol: 'main',
  baseShaBefore: 'a'.repeat(40),
  mergedAt: '2026-07-05T12:00:00.000Z',
  message: 'Ship the feature\n\nReviewed-with: Limn',
  overrides: [{ gate: 'stale-approval', detail: '2 commits after c7e0d44' }],
  cleanup: { archived: false, branchDeleted: true, worktreeRemoved: false, retargeted: [], failures: [] },
  dependents: [],
  ...over
})

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

describe('merged-session DAO', () => {
  it('markSessionMerged stamps merged_at from the record, persists the blob, touches updated_at', () => {
    const db = freshDb()
    const s = createSession(db, '/repo', pair)
    db.prepare(`UPDATE sessions SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(s.id)
    const rec = mergeRecord()
    markSessionMerged(db, s.id, rec)
    const row = db.prepare('SELECT merged_at, merge_json, updated_at FROM sessions WHERE id = ?')
      .get(s.id) as { merged_at: string; merge_json: string; updated_at: string }
    expect(row.merged_at).toBe(rec.mergedAt)
    expect(JSON.parse(row.merge_json)).toEqual(rec)
    expect(row.updated_at > '2020-01-01T00:00:00.000Z').toBe(true)
    db.close()
  })

  it('retargetSessionBase repoints the base; the public retargetSession keeps throwing for base', () => {
    const db = freshDb()
    const s = createSession(db, '/repo', pair)
    const newHead = '9'.repeat(40)
    retargetSessionBase(db, s.id, { kind: 'branch', symbol: 'main', anchorSha: newHead })

    // findSession pins base identity by base_anchor_sha — the old identity is gone,
    // the session resolves only under the new anchor
    expect(findSession(db, '/repo', pair)).toBeNull()
    const moved: RefPair = { ...pair, base: { kind: 'branch', symbol: 'main', anchorSha: newHead } }
    expect(findSession(db, '/repo', moved)?.id).toBe(s.id)
    expect(getSession(db, s.id)!.pair.base.anchorSha).toBe(newHead)

    // the STORED base_ident generated column recomputes on UPDATE (kind change → c: ident)
    retargetSessionBase(db, s.id, { kind: 'commit', symbol: 'main@{1}', anchorSha: newHead })
    const ident = db.prepare('SELECT base_ident FROM sessions WHERE id = ?').get(s.id) as { base_ident: string }
    expect(ident.base_ident).toBe(`c:${newHead}`)

    // base immutability stays the public rule — this DAO function is its one exception
    expect(() => retargetSession(db, s.id, 'base', { kind: 'branch', symbol: 'main', anchorSha: newHead }))
      .toThrow(/base cannot be changed/)
    db.close()
  })

  it('retargetSessionBase rejects a commit side with no resolved sha', () => {
    const db = freshDb()
    const s = createSession(db, '/repo', pair)
    expect(() => retargetSessionBase(db, s.id, { kind: 'commit', symbol: 'HEAD~2', anchorSha: '' }))
      .toThrow(/no resolved sha/)
    db.close()
  })

  it('dependentSessions finds live branch-on-branch stacks based on the merged branch, nothing else', () => {
    const db = freshDb()
    const stacked: RefPair = {
      base: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) },
      compare: { kind: 'branch', symbol: 'feature-2', anchorSha: 'c'.repeat(40) }
    }
    const dep = createSession(db, '/repo', stacked)

    // excluded: archived
    const gone = createSession(db, '/repo', { ...stacked, compare: { ...stacked.compare, symbol: 'feature-3' } })
    archiveSession(db, gone.id)
    // excluded: already merged
    const landed = createSession(db, '/repo', { ...stacked, compare: { ...stacked.compare, symbol: 'feature-4' } })
    markSessionMerged(db, landed.id, mergeRecord())
    // excluded: commit-kind base (frozen-base review, not a stack)
    createSession(db, '/repo', { ...stacked, base: { kind: 'commit', symbol: 'feature@{1}', anchorSha: 'b'.repeat(40) } })
    // excluded: commit-kind compare (nothing to rebase)
    createSession(db, '/repo', { ...stacked, compare: { kind: 'commit', symbol: 'HEAD', anchorSha: 'e'.repeat(40) } })
    // excluded: other repo, other base branch
    createSession(db, '/other', stacked)
    createSession(db, '/repo', pair)

    expect(dependentSessions(db, '/repo', 'feature')).toEqual([{ sessionId: dep.id, branch: 'feature-2' }])
    expect(dependentSessions(db, '/repo', 'no-such-branch')).toEqual([])
    db.close()
  })
})
