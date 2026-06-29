import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import {
  ensureRepo, touchRepo, recentRepoPaths,
  repoIndexRows,
  createSession, findSession, getSession, archiveSession, retargetSession,
  listRepoSessions, latestSessionForBranch, unarchiveSession,
  loadReviewState, updateSessionMeta, replaceUiState,
  upsertComment, deleteComment, addIteration, nextIterationNumber, latestIteration, reviewCopyCandidates, copyGeneratedReview, setArtifacts,
  approveArtifact, unapproveArtifact, approveSessionSha, approveSessionSurface, unapproveSessionSha, unapproveSessionSurface, unresolvedCount,
  createChatThread, addChatMessage, listChatThreads, getChatThread, setThreadAgent,
  deleteChatThread, threadIsEmpty, setThreadMode, setThreadTitle, deriveChatTitle,
  pruneEmptyUserChats, setThreadEngineSession, pruneOrphanReviewThreads, setActionResolution
} from '../src/main/db/sessions'
import type { AgentAction, Comment, RefPair, ToolCall } from '../src/shared/types'

let db: DatabaseSync
beforeEach(() => {
  db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-dao-')), 'db')).db
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

const ann = (title = 'Review') => ({ title, summary: `${title} summary`, sections: [], questions: [] })
const iter = (n: number, engine: 'claude' | 'codex', sessionId: string, endSha: string, at: string, title = `Review ${n}`) => {
  const annotations = ann(title)
  return { n, engine, sessionId, endSha, at, title: annotations.title, summary: annotations.summary, annotations }
}

describe('sessions DAO', () => {
  it('creates and finds a session by pair identity', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    expect(s.id).toBeGreaterThan(0)
    expect(findSession(db, '/repo', pair)?.id).toBe(s.id)
    expect(getSession(db, s.id)?.pair.compare.symbol).toBe('feature')
  })

  it('session lookup pins base by sha while branch compare follows the branch name', () => {
    const s = createSession(db, '/repo', pair)
    const compareDrifted: RefPair = { ...pair, compare: { ...pair.compare, anchorSha: 'e'.repeat(40) } }
    expect(findSession(db, '/repo', compareDrifted)?.id).toBe(s.id) // compare branch follows the branch

    const baseDrifted: RefPair = { ...pair, base: { ...pair.base, anchorSha: 'f'.repeat(40) } }
    expect(findSession(db, '/repo', baseDrifted)).toBeNull() // base anchor is immutable

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
    const s = createSession(db, '/repo', commitPair, { engine: 'claude' })
    upsertComment(db, s.id, mkComment('c1'))
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    addChatMessage(db, t.id, { role: 'user', text: 'q', at: 'T1' })
    addIteration(db, s.id, iter(1, 'claude', 'es-1', 'd'.repeat(40), 'T2'))
    setArtifacts(db, s.id, [{ role: 'spec', path: 'docs/spec.md' }])
    approveArtifact(db, s.id, 'docs/spec.md', 'd'.repeat(40))
    replaceUiState(db, s.id, { viewedAt: { 'a.ts': { sha: 'd'.repeat(40), hash: 'blob1' } }, reviewedSections: ['s1'] })

    const st = loadReviewState(db, s.id)
    expect(st.repo).toBe('/repo')
    expect(st.base).toBe('c'.repeat(40))   // commit side → frozen sha
    expect(st.branch).toBe('main')          // branch side → live name
    expect(st.comments).toHaveLength(1)
    expect(st.comments[0].id).toBe('c1')
    expect(st.chats).toHaveLength(1)
    expect(st.chats[0].messages).toEqual([{ role: 'user', text: 'q', at: 'T1' }])
    expect(st.iterations).toEqual([iter(1, 'claude', 'es-1', 'd'.repeat(40), 'T2')])
    expect(st.artifacts).toEqual([{ role: 'spec', path: 'docs/spec.md' }])
    expect(st.artifactApprovals).toEqual({ 'docs/spec.md': 'd'.repeat(40) })
    expect(st.viewedAt).toEqual({ 'a.ts': { sha: 'd'.repeat(40), hash: 'blob1' } })
    expect(st.reviewedSections).toEqual(['s1'])
    expect(st.engine).toBe('claude')
    expect(st.agent).toEqual({ engine: 'claude' })
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

  it('can clear session and artifact approvals', () => {
    const s = createSession(db, '/repo', pair)
    approveSessionSha(db, s.id, 'b'.repeat(40))
    approveArtifact(db, s.id, 'docs/spec.md', 'b'.repeat(40))

    unapproveSessionSha(db, s.id, 'b'.repeat(40))
    unapproveArtifact(db, s.id, 'docs/spec.md')

    const st = loadReviewState(db, s.id)
    expect(st.approvedSha).toBeUndefined()
    expect(st.approvedShas).toEqual([])
    expect(st.artifactApprovals).toEqual({})
  })

  it('keeps approval history so returning to an older approved state is approved', () => {
    const s = createSession(db, '/repo', pair)
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    approveSessionSha(db, s.id, a)
    approveSessionSha(db, s.id, b)

    const st = loadReviewState(db, s.id)
    expect(st.approvedSha).toBe(b)
    expect(st.approvedShas?.sort()).toEqual([a, b].sort())

    unapproveSessionSha(db, s.id, b)
    const after = loadReviewState(db, s.id)
    expect(after.approvedSha).toBe(a)
    expect(after.approvedShas).toEqual([a])
  })

  it('tracks multiple approved dirty surfaces on the same commit by hash', () => {
    const s = createSession(db, '/repo', pair)
    const sha = 'c'.repeat(40)
    const h1 = 'dirty:h1'
    const h2 = 'dirty:h2'
    approveSessionSurface(db, s.id, sha, h1)
    approveSessionSurface(db, s.id, sha, h2)

    const st = loadReviewState(db, s.id)
    expect(st.approvedSha).toBe(sha)
    expect(st.approvedShas).toEqual([sha])
    expect(st.approvedHashes?.sort()).toEqual([h1, h2].sort())

    unapproveSessionSurface(db, s.id, h2)
    expect(loadReviewState(db, s.id).approvedHashes).toEqual([h1])
  })

  it('repos: ensure + touch drives recents ordering', () => {
    ensureRepo(db, '/r1'); ensureRepo(db, '/r2')
    touchRepo(db, '/r1', '2026-06-12T10:00:00Z')
    touchRepo(db, '/r2', '2026-06-12T11:00:00Z')
    expect(recentRepoPaths(db, 8)).toEqual(['/r2', '/r1'])
  })

  it('repo index includes touched repos that have no sessions', () => {
    touchRepo(db, '/repo-preview', '2026-06-12T10:00:00Z')
    const sessionRepo = createSession(db, '/repo-session', pair)

    expect(repoIndexRows(db)).toEqual([
      { path: '/repo-session', sessionCount: 1, lastActivity: sessionRepo.updatedAt },
      { path: '/repo-preview', sessionCount: 0, lastActivity: '2026-06-12T10:00:00Z' }
    ])
  })

  it('nextIterationNumber appends generated review history', () => {
    const s = createSession(db, '/repo', pair)
    addIteration(db, s.id, iter(1, 'claude', 'es-1', 'a'.repeat(40), 'T1'))
    addIteration(db, s.id, iter(2, 'claude', 'es-2', 'b'.repeat(40), 'T2'))
    expect(() => addIteration(db, s.id, iter(2, 'codex', 'dupe', 'x'.repeat(40), 'TD'))).toThrow()
    expect(nextIterationNumber(db, s.id)).toBe(3)
    addIteration(db, s.id, iter(nextIterationNumber(db, s.id), 'codex', 'es-3', 'c'.repeat(40), 'T3'))
    const st = loadReviewState(db, s.id)
    expect(st.iterations.map((i) => i.endSha)).toEqual(['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)])
    expect(latestIteration(db, s.id)?.endSha).toBe('c'.repeat(40))
  })

  it('finds and copies the nearest generated review candidate by base and end sha', () => {
    const source = createSession(db, '/repo', pair, { engine: 'claude' })
    const target = createSession(db, '/repo', { ...pair, compare: { ...pair.compare, symbol: 'other', anchorSha: 'd'.repeat(40) } }, { engine: 'codex' })
    const annotations = { title: 'Copied title', summary: 'Copied summary', sections: [], questions: [] }
    addIteration(db, source.id, { n: 1, engine: 'claude', sessionId: 'es-old', endSha: 'b'.repeat(40), at: 'T1', title: annotations.title, summary: annotations.summary, annotations })
    updateSessionMeta(db, source.id, { annotations, title: annotations.title, summary: annotations.summary, reviewedAtSha: 'b'.repeat(40) })
    const reviewThread = createChatThread(db, source.id, { kind: 'review', agent: { engine: 'claude' }, engineSessionId: 'es-old' })
    addChatMessage(db, reviewThread.id, { role: 'agent', text: 'review text', at: 'T1' })

    const candidates = reviewCopyCandidates(db, '/repo', target.id, pair.base.anchorSha, new Map([
      ['d'.repeat(40), 0],
      ['c'.repeat(40), 1],
      ['b'.repeat(40), 2]
    ]))
    expect(candidates.map((c) => [c.sessionId, c.iteration, c.commitsOld])).toEqual([[source.id, 1, 2]])

    copyGeneratedReview(db, source.id, 1, target.id, 'd'.repeat(40))
    const copied = loadReviewState(db, target.id)
    expect(copied.annotations?.title).toBe('Copied title')
    expect(copied.reviewedAtSha).toBe('d'.repeat(40))
    expect(copied.latestIteration?.endSha).toBe('d'.repeat(40))
    expect(copied.chats.find((c) => c.kind === 'review')?.messages[0]?.text).toBe('review text')
  })

  it('retargetSession moves identity to the new side', () => {
    const s = createSession(db, '/repo', pair)
    retargetSession(db, s.id, 'compare', { kind: 'commit', symbol: 'HEAD~2', anchorSha: 'e'.repeat(40) })
    expect(findSession(db, '/repo', pair)).toBeNull() // old identity gone
    const moved: RefPair = { ...pair, compare: { kind: 'commit', symbol: 'HEAD~2', anchorSha: 'e'.repeat(40) } }
    expect(findSession(db, '/repo', moved)?.id).toBe(s.id) // generated ident recomputed
    expect(() => retargetSession(db, s.id, 'base', { kind: 'commit', symbol: 'x', anchorSha: 'f'.repeat(40) })).toThrow(/base cannot be changed/)
  })
})

describe('chat threads DAO', () => {
  it('deriveChatTitle: first non-empty line, trimmed to ~40 chars with an ellipsis when long', () => {
    expect(deriveChatTitle('Fix the bug')).toBe('Fix the bug')
    expect(deriveChatTitle('  Fix the bug  ')).toBe('Fix the bug')          // trims surrounding ws
    expect(deriveChatTitle('\n\nFirst real line\nsecond')).toBe('First real line') // skips leading blanks
    const long = 'a'.repeat(60)
    const out = deriveChatTitle(long)
    expect(out).toBe('a'.repeat(40) + '…')
    expect([...out].length).toBe(41)                                         // 40 chars + ellipsis
  })

  it('setThreadTitle round-trips the title onto the thread', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    expect(getChatThread(db, t.id)!.title).toBeUndefined()
    setThreadTitle(db, t.id, 'Refactor the store')
    expect(getChatThread(db, t.id)!.title).toBe('Refactor the store')
  })

  it('pruneEmptyUserChats removes empty user chats but keeps ones with a message or engine session, and never review threads', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const agent = { engine: 'claude' as const }

    const empty = createChatThread(db, s.id, { kind: 'user', agent })                       // no messages, no session → pruned
    const withMsg = createChatThread(db, s.id, { kind: 'user', agent })
    addChatMessage(db, withMsg.id, { role: 'user', text: 'hi', at: 'T1' })                  // has a message → kept
    const withSession = createChatThread(db, s.id, { kind: 'user', agent, engineSessionId: 'es-x' }) // bound session → kept
    const review = createChatThread(db, s.id, { kind: 'review', agent, title: 'Review agent' }) // empty but review → kept

    pruneEmptyUserChats(db, s.id)

    const ids = listChatThreads(db, s.id).map((c) => c.id)
    expect(ids).not.toContain(empty.id)
    expect(ids).toEqual(expect.arrayContaining([withMsg.id, withSession.id, review.id]))
  })

  it('pruneOrphanReviewThreads drops a crash-orphaned review (lone user turn, no session) but keeps finished/failed/active ones', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const agent = { engine: 'claude' as const }

    // orphan: only the opening user turn, never bound to an engine session
    const orphan = createChatThread(db, s.id, { kind: 'review', agent, title: 'Review agent' })
    addChatMessage(db, orphan.id, { role: 'user', text: 'Generate a guided review…', at: 'T1' })

    // finished: agent turn + bound session
    const done = createChatThread(db, s.id, { kind: 'review', agent, title: 'Review agent' })
    addChatMessage(db, done.id, { role: 'user', text: 'Generate…', at: 'T1' })
    addChatMessage(db, done.id, { role: 'agent', text: 'Produced a review.', at: 'T2' })
    setThreadEngineSession(db, done.id, 'es-done')

    // failed: user turn + outcome note, no session (kept per "keep with a note")
    const failed = createChatThread(db, s.id, { kind: 'review', agent, title: 'Review agent' })
    addChatMessage(db, failed.id, { role: 'user', text: 'Generate…', at: 'T1' })
    addChatMessage(db, failed.id, { role: 'agent', text: 'Generation failed: boom', at: 'T2' })

    // active: same shape as the orphan but its op is in flight → exempt
    const active = createChatThread(db, s.id, { kind: 'review', agent, title: 'Review agent' })
    addChatMessage(db, active.id, { role: 'user', text: 'Generate…', at: 'T1' })

    pruneOrphanReviewThreads(db, s.id, new Set([active.id]))

    const ids = listChatThreads(db, s.id).map((c) => c.id)
    expect(ids).not.toContain(orphan.id)
    expect(ids).toEqual(expect.arrayContaining([done.id, failed.id, active.id]))
  })

  it('pruneOrphanReviewThreads never drops the latest review thread (an in-flight one a reload could race)', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const agent = { engine: 'claude' as const }
    // a lone-user-turn review that is ALSO the latest thread (e.g. mid-first-generation
    // before the exempt set is consulted) must survive even when not passed as exempt.
    const latest = createChatThread(db, s.id, { kind: 'review', agent, title: 'Review agent' })
    addChatMessage(db, latest.id, { role: 'user', text: 'Generate…', at: 'T1' })
    pruneOrphanReviewThreads(db, s.id, new Set())
    expect(listChatThreads(db, s.id).map((c) => c.id)).toContain(latest.id)
  })

  it('threadIsEmpty: review chat (bound session) is never empty; fresh user chat is until a message lands', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const reviewChat = createChatThread(db, s.id, { kind: 'review', agent: { engine: 'claude' }, engineSessionId: 'es-1' })
    const userChat = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    expect(threadIsEmpty(db, reviewChat.id)).toBe(false) // has an engine session
    expect(threadIsEmpty(db, userChat.id)).toBe(true)
    addChatMessage(db, userChat.id, { role: 'user', text: 'hi', at: 'T1' })
    expect(threadIsEmpty(db, userChat.id)).toBe(false)
  })

  it('setThreadAgent retargets a chat in place; delete + session cascade clean up', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    setThreadAgent(db, t.id, { engine: 'codex', model: 'gpt-5-codex', reasoningEffort: 'high' })
    expect(getChatThread(db, t.id)!.agent).toEqual({ engine: 'codex', model: 'gpt-5-codex', reasoningEffort: 'high' })

    addChatMessage(db, t.id, { role: 'user', text: 'q', at: 'T1' })
    deleteChatThread(db, t.id)
    expect(getChatThread(db, t.id)).toBeNull()

    const t2 = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    addChatMessage(db, t2.id, { role: 'user', text: 'q', at: 'T2' })
    archiveSession(db, s.id)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id) // CASCADE → threads → messages
    expect(getChatThread(db, t2.id)).toBeNull()
    expect((db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }).n).toBe(0)
  })

  it('round-trips agent message actions through actions_json', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    const actions: AgentAction[] = [
      { kind: 'focus', anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '', lineContent: '' } },
      {
        kind: 'tour',
        loop: true,
        stops: [
          { target: { kind: 'file', file: 'src/a.ts' }, note: 'entry point' },
          { target: { kind: 'summary' } }
        ]
      },
      { kind: 'suggest_viewed', files: ['src/a.ts'], note: 'covered' }
    ]
    addChatMessage(db, t.id, { role: 'agent', text: 'done', at: 'T1', actions })
    addChatMessage(db, t.id, { role: 'user', text: 'thanks', at: 'T2' })

    const msgs = getChatThread(db, t.id)!.messages
    expect(msgs[0].actions).toEqual(actions)
    expect(msgs[1].actions).toBeUndefined() // no actions → no key, not []
  })

  it('defaults executionMode to ask and round-trips setThreadMode', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    expect(getChatThread(db, t.id)!.executionMode).toBe('ask')
    setThreadMode(db, t.id, 'full')
    expect(getChatThread(db, t.id)!.executionMode).toBe('full')
    expect(listChatThreads(db, s.id).find((c) => c.id === t.id)!.executionMode).toBe('full')
  })

  it('setActionResolution persists a dismissal onto the matching suggest_viewed action; unrelated ids no-op', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    const actions: AgentAction[] = [
      { kind: 'focus', anchor: { kind: 'file', file: 'src/a.ts' } },
      { kind: 'suggest_viewed', id: 'sv-1', files: ['src/a.ts'], note: 'covered' }
    ]
    addChatMessage(db, t.id, { role: 'agent', text: 'done', at: 'T1', actions })
    // unrelated row that must stay untouched
    addChatMessage(db, t.id, { role: 'agent', text: 'more', at: 'T2', segments: [{ kind: 'text', text: 'hi' }] })

    setActionResolution(db, t.id, 'sv-1', 'dismissed')
    const msgs = getChatThread(db, t.id)!.messages
    const sv = msgs[0].actions!.find((a) => a.kind === 'suggest_viewed')!
    expect(sv.kind === 'suggest_viewed' && sv.resolution).toBe('dismissed')
    // the focus action in the same row is left intact
    expect(msgs[0].actions![0]).toEqual({ kind: 'focus', anchor: { kind: 'file', file: 'src/a.ts' } })
    // the other row's segments_json is untouched
    expect(msgs[1].segments).toEqual([{ kind: 'text', text: 'hi' }])

    // a non-matching id changes nothing
    setActionResolution(db, t.id, 'nope', 'dismissed')
    const after = getChatThread(db, t.id)!.messages[0].actions!.find((a) => a.kind === 'suggest_viewed')!
    expect(after.kind === 'suggest_viewed' && after.resolution).toBe('dismissed')
  })

  it('round-trips agent message tools through tools_json', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    const tools: ToolCall[] = [
      { id: 'a', verb: 'grep', name: 'Grep', arg: 'x', state: 'ok', meta: '3 hits', out: 'a\nb' },
      { id: 'b', verb: 'edit', name: 'Edit', state: 'err', out: 'boom' },
    ]
    addChatMessage(db, t.id, { role: 'agent', text: 'done', at: 'T1', tools })
    addChatMessage(db, t.id, { role: 'user', text: 'thanks', at: 'T2' })

    const msgs = getChatThread(db, t.id)!.messages
    expect(msgs[0].tools).toEqual(tools)
    expect(msgs[1].tools).toBeUndefined() // no tools → no key, not []
  })
})

describe('repo-scoped session queries (hub + branch jump)', () => {
  it('allows multiple live sessions for the same branch pair', () => {
    const a = createSession(db, '/repo', pair, { engine: 'claude' })
    const b = createSession(db, '/repo', pair, { engine: 'codex' })
    expect(a.id).not.toBe(b.id) // no unique-per-pair constraint on sessions
    expect(listRepoSessions(db, '/repo').length).toBe(2)
  })

  it('latestSessionForBranch returns the most recently touched live match', () => {
    const old = createSession(db, '/repo', pair)
    const recent = createSession(db, '/repo', pair)
    updateSessionMeta(db, recent.id, { title: 'newer' })
    expect(latestSessionForBranch(db, '/repo', 'feature')?.id).toBe(recent.id)
    expect(latestSessionForBranch(db, '/repo', 'nope')).toBeNull()
    archiveSession(db, recent.id)
    expect(latestSessionForBranch(db, '/repo', 'feature')?.id).toBe(old.id) // falls back past archived
  })

  it('listRepoSessions denormalizes status and excludes archived', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    upsertComment(db, s.id, mkComment('c1'))            // queued → unresolved
    updateSessionMeta(db, s.id, { approvedSha: 'z'.repeat(40), reviewedAtSha: 'z'.repeat(40) })
    const otherRepo = createSession(db, '/other', pair)
    const list = listRepoSessions(db, '/repo')
    expect(list.map((r) => r.id)).not.toContain(otherRepo.id)
    const row = list.find((r) => r.id === s.id)!
    expect(row.compareSymbol).toBe('feature')
    expect(row.baseSymbol).toBe('main')
    expect(row.unresolved).toBe(1)
    expect(row.approved).toBe(true)
    archiveSession(db, s.id)
    expect(listRepoSessions(db, '/repo').map((r) => r.id)).not.toContain(s.id)
  })

  it('includeArchived lists archived rows flagged; unarchive restores them', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    archiveSession(db, s.id)
    expect(listRepoSessions(db, '/repo')).toHaveLength(0)                 // live-only by default
    const withArchived = listRepoSessions(db, '/repo', true)
    expect(withArchived).toHaveLength(1)
    expect(withArchived[0].archived).toBe(true)
    unarchiveSession(db, s.id)
    const live = listRepoSessions(db, '/repo')
    expect(live).toHaveLength(1)
    expect(live[0].archived).toBe(false)
  })
})
