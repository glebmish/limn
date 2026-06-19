import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import {
  ensureRepo, touchRepo, recentRepoPaths,
  createSession, findSession, getSession, archiveSession, retargetSession,
  loadReviewState, updateSessionMeta, replaceUiState,
  upsertComment, deleteComment, addIteration, resetIterations, setArtifacts,
  approveArtifact, unresolvedCount,
  createChatThread, addChatMessage, listChatThreads, getChatThread, setThreadAgent,
  deleteChatThread, threadIsEmpty, reconcileChats
} from '../src/main/db/sessions'
import type { AgentAction, Comment, RefPair, ToolCall } from '../src/shared/types'

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
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
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
    const s = createSession(db, '/repo', commitPair, { engine: 'claude' })
    upsertComment(db, s.id, mkComment('c1'))
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    addChatMessage(db, t.id, { role: 'user', text: 'q', at: 'T1' })
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
    expect(st.chats).toHaveLength(1)
    expect(st.chats[0].messages).toEqual([{ role: 'user', text: 'q', at: 'T1' }])
    expect(st.iterations).toEqual([{ n: 1, engine: 'claude', sessionId: 'es-1', endSha: 'd'.repeat(40), at: 'T2' }])
    expect(st.artifacts).toEqual([{ role: 'spec', path: 'docs/spec.md' }])
    expect(st.artifactApprovals).toEqual({ 'docs/spec.md': 'd'.repeat(40) })
    expect(st.viewedAt).toEqual({ 'a.ts': 'd'.repeat(40) })
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

  it('repos: ensure + touch drives recents ordering', () => {
    ensureRepo(db, '/r1'); ensureRepo(db, '/r2')
    touchRepo(db, '/r1', '2026-06-12T10:00:00Z')
    touchRepo(db, '/r2', '2026-06-12T11:00:00Z')
    expect(recentRepoPaths(db, 8)).toEqual(['/r2', '/r1'])
  })

  it('resetIterations wipes history down to the fresh first iteration', () => {
    const s = createSession(db, '/repo', pair)
    addIteration(db, s.id, { n: 1, engine: 'claude', sessionId: 'es-1', endSha: 'a'.repeat(40), at: 'T1' })
    addIteration(db, s.id, { n: 2, engine: 'claude', sessionId: 'es-2', endSha: 'b'.repeat(40), at: 'T2' })
    resetIterations(db, s.id, { n: 1, engine: 'codex', sessionId: 'es-3', endSha: 'c'.repeat(40), at: 'T3' })
    const st = loadReviewState(db, s.id)
    expect(st.iterations).toEqual([{ n: 1, engine: 'codex', sessionId: 'es-3', endSha: 'c'.repeat(40), at: 'T3' }])
  })

  it('retargetSession moves identity to the new side', () => {
    const s = createSession(db, '/repo', pair)
    retargetSession(db, s.id, 'compare', { kind: 'commit', symbol: 'HEAD~2', anchorSha: 'e'.repeat(40) })
    expect(findSession(db, '/repo', pair)).toBeNull() // old identity gone
    const moved: RefPair = { ...pair, compare: { kind: 'commit', symbol: 'HEAD~2', anchorSha: 'e'.repeat(40) } }
    expect(findSession(db, '/repo', moved)?.id).toBe(s.id) // generated ident recomputed
    expect(() => retargetSession(db, s.id, 'base', { kind: 'commit', symbol: 'x', anchorSha: '' })).toThrow(/no resolved sha/)
  })
})

describe('chat threads DAO', () => {
  const sha = 'a'.repeat(40)

  it('reconcileChats creates the review + empty user chat once a review exists, idempotently', () => {
    const s = createSession(db, '/repo', pair, { engine: 'claude', model: 'opus' })
    reconcileChats(db, s.id)
    expect(listChatThreads(db, s.id)).toHaveLength(0) // no iteration yet → no chats

    addIteration(db, s.id, { n: 1, engine: 'claude', sessionId: 'es-1', endSha: sha, at: 'T1' })
    reconcileChats(db, s.id)
    let chats = listChatThreads(db, s.id)
    expect(chats.map((c) => c.kind)).toEqual(['review', 'user'])
    const review = chats.find((c) => c.kind === 'review')!
    expect(review.engineSessionId).toBe('es-1')        // bound to the review-gen session
    expect(review.agent).toEqual({ engine: 'claude', model: 'opus' })

    reconcileChats(db, s.id)                            // idempotent — no duplicate chats
    expect(listChatThreads(db, s.id)).toHaveLength(2)

    // regenerate → review chat re-syncs to the new engine session
    resetIterations(db, s.id, { n: 1, engine: 'claude', sessionId: 'es-2', endSha: sha, at: 'T2' })
    reconcileChats(db, s.id)
    chats = listChatThreads(db, s.id)
    expect(chats).toHaveLength(2)
    expect(chats.find((c) => c.kind === 'review')!.engineSessionId).toBe('es-2')
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
      { kind: 'suggest_viewed', files: ['src/a.ts'], note: 'covered' }
    ]
    addChatMessage(db, t.id, { role: 'agent', text: 'done', at: 'T1', actions })
    addChatMessage(db, t.id, { role: 'user', text: 'thanks', at: 'T2' })

    const msgs = getChatThread(db, t.id)!.messages
    expect(msgs[0].actions).toEqual(actions)
    expect(msgs[1].actions).toBeUndefined() // no actions → no key, not []
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
