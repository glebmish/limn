import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/server/db/db'
import {
  createSession, findSession, getSession, retargetSession, archiveSession,
  markSessionMerged, retargetSessionBase, dependentSessions,
  listRepoSessions, loadReviewState
} from '../src/server/db/sessions'
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

describe('baseline schema (merged sessions)', () => {
  it('carries merged_at and merge_json on sessions and lands schema_version at the current head (3)', () => {
    const db = freshDb()
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('merged_at')
    expect(cols).toContain('merge_json')
    const v = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }
    expect(parseInt(v.value, 10)).toBe(3)
    db.close()
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

describe('read-side merged plumbing', () => {
  it('loadReviewState returns the parsed merge record; unmerged sessions carry no merged field', () => {
    const db = freshDb()
    const s = createSession(db, '/repo', pair)
    expect(loadReviewState(db, s.id).merged).toBeUndefined()
    expect(listRepoSessions(db, '/repo').find((r) => r.id === s.id)!.merged).toBeUndefined()

    const rec = mergeRecord()
    markSessionMerged(db, s.id, rec)
    const st = loadReviewState(db, s.id)
    expect(st.merged).toEqual(rec)
    expect(st.loadWarnings).toBeUndefined()
    db.close()
  })

  it('toListItem surfaces merged: { sha } in both live and archived hub groups', () => {
    const db = freshDb()
    const s = createSession(db, '/repo', pair)
    const rec = mergeRecord()
    markSessionMerged(db, s.id, rec)
    expect(listRepoSessions(db, '/repo').find((r) => r.id === s.id)!.merged).toEqual({ sha: rec.mergedSha })
    archiveSession(db, s.id)
    const archived = listRepoSessions(db, '/repo', true).find((r) => r.id === s.id)!
    expect(archived.merged).toEqual({ sha: rec.mergedSha })
    expect(archived.archived).toBe(true)
    db.close()
  })

  it('corrupt merge_json degrades: state drops merged with a warning, list item still flags merged', () => {
    const db = freshDb()
    const s = createSession(db, '/repo', pair)
    markSessionMerged(db, s.id, mergeRecord())
    db.prepare('UPDATE sessions SET merge_json = ? WHERE id = ?').run('{oops', s.id)

    const st = loadReviewState(db, s.id)
    expect(st.merged).toBeUndefined()
    expect(st.loadWarnings).toEqual(expect.arrayContaining(['merge record could not be loaded']))
    // merged_at is authoritative for the badge; the sha degrades to '' when unreadable
    expect(listRepoSessions(db, '/repo').find((r) => r.id === s.id)!.merged).toEqual({ sha: '' })
    db.close()
  })

  it('merged + compare retarget to the kept tip: session still resolves and renders as merged (spec §2 durability)', () => {
    const db = freshDb()
    const s = createSession(db, '/repo', pair)
    const rec = mergeRecord()
    const keptTip: { kind: 'commit'; symbol: string; anchorSha: string } =
      { kind: 'commit', symbol: rec.reviewedTipSha.slice(0, 7), anchorSha: rec.reviewedTipSha }

    // the merge op's §4-step-3 write: record + compare retarget in one transaction
    db.exec('BEGIN')
    markSessionMerged(db, s.id, rec)
    retargetSession(db, s.id, 'compare', keptTip)
    db.exec('COMMIT')

    // findSession resolves under the retargeted identity (base anchor unchanged,
    // compare_ident recomputed to c:<kept tip>)
    const moved: RefPair = { ...pair, compare: keptTip }
    expect(findSession(db, '/repo', moved)?.id).toBe(s.id)
    expect(getSession(db, s.id)!.pair.compare).toEqual(keptTip)

    // loadReviewState resolves: commit-kind compare → effectiveRef is the frozen kept tip
    const st = loadReviewState(db, s.id)
    expect(st.branch).toBe(rec.reviewedTipSha)
    expect(st.merged).toEqual(rec)

    // hub row: merged badge with the landed sha, compare shown as the kept commit
    const item = listRepoSessions(db, '/repo').find((r) => r.id === s.id)!
    expect(item.merged).toEqual({ sha: rec.mergedSha })
    expect(item.compareKind).toBe('commit')
    expect(item.compareSymbol).toBe(rec.reviewedTipSha.slice(0, 7))
    db.close()
  })
})
