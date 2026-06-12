import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import {
  ensureRepo, touchRepo, recentRepoPaths,
  createSession, findSession, getSession, archiveSession,
  loadReviewState, updateSessionMeta, replaceUiState,
  upsertComment, deleteComment, addChat, addIteration, setArtifacts,
  approveArtifact, unresolvedCount
} from '../src/main/db/sessions'
import type { Comment, RefPair } from '../src/shared/types'

let db: DatabaseSync
beforeEach(() => {
  db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-dao-')), 'db')).db
})

const pair: RefPair = {
  base: { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
  compare: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) }
}
const commitPair: RefPair = {
  base: { kind: 'commit', symbol: 'HEAD~3', anchorSha: 'c'.repeat(40) },
  compare: { kind: 'branch', symbol: 'main', anchorSha: 'd'.repeat(40) }
}

function mkComment(id: string): Comment {
  return {
    id, author: 'user', text: 'hm', status: 'queued', replies: [], iteration: 1,
    createdAt: new Date().toISOString(),
    anchor: { kind: 'diff', file: 'a.ts', side: 'new', line: 3, hunkRange: '@@ -1 +1 @@', lineContent: 'x' }
  }
}

describe('sessions DAO', () => {
  it('creates and finds a session by pair identity', () => {
    const s = createSession(db, '/repo', pair, 'claude')
    expect(s.id).toBeGreaterThan(0)
    expect(findSession(db, '/repo', pair)?.id).toBe(s.id)
    expect(getSession(db, s.id)?.pair.compare.symbol).toBe('feature')
  })

  it('branch identity ignores anchor drift; commit identity keys on sha', () => {
    const s = createSession(db, '/repo', pair)
    const drifted: RefPair = { ...pair, compare: { ...pair.compare, anchorSha: 'e'.repeat(40) } }
    expect(findSession(db, '/repo', drifted)?.id).toBe(s.id) // same branch names → same session

    const c1 = createSession(db, '/repo', commitPair)
    const otherSha: RefPair = { ...commitPair, base: { ...commitPair.base, anchorSha: 'f'.repeat(40) } }
    expect(findSession(db, '/repo', otherSha)).toBeNull() // different commit → different session
    expect(findSession(db, '/repo', commitPair)?.id).toBe(c1.id)
  })

  it('rejects a commit side with no resolved sha', () => {
    const bad: RefPair = { ...pair, base: { kind: 'commit', symbol: 'HEAD~9', anchorSha: '' } }
    expect(() => createSession(db, '/repo', bad)).toThrow(/no resolved sha/)
  })

  it('archive frees the identity slot for a fresh session', () => {
    const s = createSession(db, '/repo', pair)
    archiveSession(db, s.id)
    expect(findSession(db, '/repo', pair)).toBeNull()
    const fresh = createSession(db, '/repo', pair)
    expect(fresh.id).not.toBe(s.id)
  })

  it('assembles ReviewState with effective refs and all children', () => {
    const s = createSession(db, '/repo', commitPair, 'claude')
    upsertComment(db, s.id, mkComment('c1'))
    addChat(db, s.id, { role: 'user', text: 'q', at: 'T1' })
    addIteration(db, s.id, { n: 1, engine: 'claude', sessionId: 'es-1', endSha: 'd'.repeat(40), at: 'T2' })
    setArtifacts(db, s.id, [{ role: 'spec', path: 'docs/spec.md' }])
    approveArtifact(db, s.id, 'docs/spec.md', 'd'.repeat(40))
    replaceUiState(db, s.id, { viewedAt: { 'a.ts': 'd'.repeat(40) }, reviewedSections: ['s1'] })

    const st = loadReviewState(db, s.id)
    expect(st.repo).toBe('/repo')
    expect(st.base).toBe('c'.repeat(40))   // commit side → frozen sha
    expect(st.branch).toBe('main')          // branch side → live name
    expect(st.comments).toHaveLength(1)
    expect(st.comments[0].id).toBe('c1')
    expect(st.chat).toEqual([{ role: 'user', text: 'q', at: 'T1' }])
    expect(st.iterations).toEqual([{ n: 1, engine: 'claude', sessionId: 'es-1', endSha: 'd'.repeat(40), at: 'T2' }])
    expect(st.artifacts).toEqual([{ role: 'spec', path: 'docs/spec.md' }])
    expect(st.artifactApprovals).toEqual({ 'docs/spec.md': 'd'.repeat(40) })
    expect(st.viewedAt).toEqual({ 'a.ts': 'd'.repeat(40) })
    expect(st.reviewedSections).toEqual(['s1'])
    expect(st.engine).toBe('claude')
  })

  it('comment upsert updates in place; delete removes; unresolvedCount counts queued+sent', () => {
    const s = createSession(db, '/repo', pair)
    upsertComment(db, s.id, mkComment('c1'))
    upsertComment(db, s.id, { ...mkComment('c2'), status: 'sent' })
    upsertComment(db, s.id, { ...mkComment('c3'), status: 'resolved' })
    expect(unresolvedCount(db, s.id)).toBe(2)
    upsertComment(db, s.id, { ...mkComment('c1'), text: 'edited' })
    expect(loadReviewState(db, s.id).comments.find((c) => c.id === 'c1')?.text).toBe('edited')
    deleteComment(db, s.id, 'c1')
    expect(loadReviewState(db, s.id).comments.map((c) => c.id).sort()).toEqual(['c2', 'c3'])
  })

  it('updateSessionMeta persists annotations and approval shas', () => {
    const s = createSession(db, '/repo', pair)
    updateSessionMeta(db, s.id, {
      engine: 'codex',
      annotations: { title: 'T', summary: 'S', sections: [], questions: [] },
      approvedSha: 'b'.repeat(40), reviewedAtSha: 'b'.repeat(40)
    })
    const st = loadReviewState(db, s.id)
    expect(st.engine).toBe('codex')
    expect(st.annotations?.title).toBe('T')
    expect(st.approvedSha).toBe('b'.repeat(40))
  })

  it('repos: ensure + touch drives recents ordering', () => {
    ensureRepo(db, '/r1'); ensureRepo(db, '/r2')
    touchRepo(db, '/r1', '2026-06-12T10:00:00Z')
    touchRepo(db, '/r2', '2026-06-12T11:00:00Z')
    expect(recentRepoPaths(db, 8)).toEqual(['/r2', '/r1'])
  })
})
