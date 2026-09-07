import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db/db'
import { addIteration, approveSessionSha, createChatThread, createSession, getSession, loadReviewState, markSessionMerged, retargetSession } from '../src/server/db/sessions'
import { buildLoadedReview } from '../src/server/review'
import { registerIpc } from '../src/server/ipc'
import { resolveRefInput } from '../src/server/git'
import { makeFixtureRepo, fixtureGit, fixtureWrite, type FixtureRepo } from './helpers/fixtureRepo'
import type { AgentRef, MergeExecuteResult, MergeRecord, RefPair } from '../src/shared/types'
import type { LoadedReview, RepoChangedMsg } from '../src/shared/ipc'
import type { Transport } from '../src/server/transport'

const agent: AgentRef = { engine: 'claude' }

interface Harness {
  db: ReturnType<typeof openDb>['db']
  dir: string
  shas: FixtureRepo['shas']
  sessionId: number
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>
  repoChanged: RepoChangedMsg[]
}

async function setup(): Promise<Harness> {
  const { dir, shas } = makeFixtureRepo()
  const base = await resolveRefInput(dir, 'main')
  const compare = await resolveRefInput(dir, 'feature')
  const pair: RefPair = {
    base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
    compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  }
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-mm-')), 'db')).db
  const sessionId = createSession(db, dir, pair, agent).id
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const repoChanged: RepoChangedMsg[] = []
  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn as (...a: unknown[]) => Promise<unknown>) },
    broadcast(channel, msg) { if (channel === 'repo:changed') repoChanged.push(msg as RepoChangedMsg) },
    notify() { /* unused */ },
    async pickDirectory() { return null }
  }
  registerIpc(db, [], transport)
  return { db, dir, shas, sessionId, handlers, repoChanged }
}

function fakeMergeRecord(over: Partial<MergeRecord> = {}): MergeRecord {
  return {
    strategy: 'squash', mergedSha: 'f'.repeat(40), reviewedTipSha: 'e'.repeat(40),
    baseSymbol: 'main', baseShaBefore: 'a'.repeat(40), mergedAt: new Date().toISOString(),
    overrides: [],
    cleanup: { archived: false, branchDeleted: false, worktreeRemoved: false, retargeted: [], failures: [] },
    dependents: [],
    ...over
  }
}

describe('mergedExternally detection (S12)', () => {
  it('approved tip reachable from the base head → mergedExternally: true', async () => {
    const h = await setup()
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    fixtureGit(h.dir, 'update-ref', 'refs/heads/main', h.shas.head) // external ff merge
    const loaded = await h.handlers.get('loadSession')!(h.sessionId) as LoadedReview
    expect(loaded.mergedExternally).toBe(true)
    expect(loaded.state.merged).toBeUndefined() // detected, not yet settled
  })

  it('no detection without approval', async () => {
    const h = await setup()
    fixtureGit(h.dir, 'update-ref', 'refs/heads/main', h.shas.head)
    const loaded = await h.handlers.get('loadSession')!(h.sessionId) as LoadedReview
    expect(loaded.mergedExternally).toBeUndefined()
  })

  it('no detection while the tip is not an ancestor of the base head', async () => {
    const h = await setup()
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    const loaded = await h.handlers.get('loadSession')!(h.sessionId) as LoadedReview
    expect(loaded.mergedExternally).toBeUndefined()
  })
})

describe('loadSession watcher gating for merged sessions', () => {
  it('does not start the branch watcher on a merged session', async () => {
    const h = await setup()
    // merged flag directly via the DAO (compare left branch-kind so ONLY the merged
    // gate can be what suppresses the watch)
    markSessionMerged(h.db, h.sessionId, fakeMergeRecord({ reviewedTipSha: h.shas.head }))
    const loaded = await h.handlers.get('loadSession')!(h.sessionId) as LoadedReview
    expect(loaded.state.merged).toBeDefined()
    // move the branch — an armed watcher would broadcast within LIVE_INTERVAL_MS
    const before = h.repoChanged.length
    fixtureWrite(h.dir, 'src/z.ts', 'export const z = 1\n') // primary holds feature
    fixtureGit(h.dir, 'add', '-A')
    fixtureGit(h.dir, 'commit', '-m', 'post-merge commit')
    await new Promise((r) => setTimeout(r, 1200))
    expect(h.repoChanged.length).toBe(before)
  })
})

describe('markMerged (S12)', () => {
  it('settles an externally merged branch: external record, same durability + cleanup path', async () => {
    const h = await setup()
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    fixtureGit(h.dir, 'update-ref', 'refs/heads/main', h.shas.head) // external ff
    fixtureGit(h.dir, 'checkout', 'main') // frees feature for deletion

    const res = await h.handlers.get('markMerged')!(h.sessionId, {
      archiveSession: true, deleteBranch: true, removeWorktree: false, retarget: []
    }) as MergeExecuteResult
    expect(res.status).toBe('merged')
    if (res.status !== 'merged') return
    expect(res.record.external).toBe(true)
    expect(res.record.strategy).toBe('ff') // baseHead === tip → recorded as ff
    expect(res.record.mergedSha).toBe(h.shas.head) // = base head (spec §8)
    expect(res.record.reviewedTipSha).toBe(h.shas.head)
    // same durability as a Limn merge: keep-ref + commit-kind compare retarget
    expect(fixtureGit(h.dir, 'rev-parse', `refs/limn/keep/${h.sessionId}`)).toBe(h.shas.head)
    const session = getSession(h.db, h.sessionId)!
    // persistMergeRecord (shared with executeMerge) keeps compare.symbol as the
    // BRANCH NAME on a commit-kind retarget — display-only, identity is anchorSha
    // (merge.ts persistMergeRecord, Tasks 16-17 rely on this for rendering).
    expect(session.pair.compare).toEqual(
      { kind: 'commit', symbol: 'feature', anchorSha: h.shas.head })
    // cleanup ran on the same shared path
    expect(res.record.cleanup.branchDeleted).toBe(true)
    expect(() => fixtureGit(h.dir, 'rev-parse', '--verify', 'refs/heads/feature')).toThrow()
    expect(res.record.cleanup.archived).toBe(true)
    expect(loadReviewState(h.db, h.sessionId).merged).toEqual(res.record)
    // base pinned to its reviewed anchor too (§2) — so the record still renders the
    // reviewed diff after feature is deleted and main advanced past the tip
    expect(session.pair.base).toEqual({ kind: 'commit', symbol: 'main', anchorSha: h.shas.base })
    const loaded = await buildLoadedReview(h.db, session)
    expect(loaded.skeleton.files.length).toBeGreaterThan(0)
    expect(loaded.refMissing).toBeUndefined()
  })

  it('records strategy merge when the base head is a descendant, not the tip itself', async () => {
    const h = await setup()
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    const wtPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-mmwt-')), 'wt')
    fixtureGit(h.dir, 'worktree', 'add', wtPath, 'main')
    fixtureGit(wtPath, 'merge', '--no-ff', '-m', 'external merge', 'feature')
    const mainHead = fixtureGit(h.dir, 'rev-parse', 'main')

    const res = await h.handlers.get('markMerged')!(h.sessionId, {
      archiveSession: false, deleteBranch: false, removeWorktree: false, retarget: []
    }) as MergeExecuteResult
    expect(res.status).toBe('merged')
    if (res.status !== 'merged') return
    expect(res.record.strategy).toBe('merge')
    expect(res.record.mergedSha).toBe(mainHead)
    expect(res.record.external).toBe(true)
  })

  it('rejects when the branch is not actually merged into the base', async () => {
    const h = await setup()
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    await expect(h.handlers.get('markMerged')!(h.sessionId, {
      archiveSession: false, deleteBranch: false, removeWorktree: false, retarget: []
    })).rejects.toThrow(/not merged into/)
  })
})

describe('merged sessions are read-only (main-process guards)', () => {
  async function mergedHarness(): Promise<Harness> {
    const h = await setup()
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    markSessionMerged(h.db, h.sessionId, fakeMergeRecord({ reviewedTipSha: h.shas.head }))
    retargetSession(h.db, h.sessionId, 'compare',
      { kind: 'commit', symbol: h.shas.head.slice(0, 7), anchorSha: h.shas.head })
    return h
  }

  it('approve rejects', async () => {
    const h = await mergedHarness()
    await expect(h.handlers.get('approve')!(h.sessionId))
      .rejects.toThrow('This review is merged and read-only')
  })

  it('generate rejects before taking the lane', async () => {
    const h = await mergedHarness()
    await expect(h.handlers.get('generate')!(h.sessionId, agent, 'op-guard', 999))
      .rejects.toThrow('This review is merged and read-only')
  })

  it('sendBatch rejects and persists nothing to the thread', async () => {
    const h = await mergedHarness()
    const t = createChatThread(h.db, h.sessionId, { kind: 'user', agent }).id
    await expect(h.handlers.get('sendBatch')!(t, [], 'do things', 'op-guard-2'))
      .rejects.toThrow('This review is merged and read-only')
    expect(loadReviewState(h.db, h.sessionId).chats.find((c) => c.id === t)!.messages).toEqual([])
  })

  it('sendRebase rejects and persists nothing to the thread', async () => {
    const h = await mergedHarness()
    const t = createChatThread(h.db, h.sessionId, { kind: 'review', agent }).id
    await expect(h.handlers.get('sendRebase')!(t, 'op-guard-3'))
      .rejects.toThrow('This review is merged and read-only')
    expect(loadReviewState(h.db, h.sessionId).chats.find((c) => c.id === t)!.messages).toEqual([])
  })

  it('unapprove rejects (§7 names unapprove explicitly)', async () => {
    const h = await mergedHarness()
    await expect(h.handlers.get('unapprove')!(h.sessionId))
      .rejects.toThrow('This review is merged and read-only')
  })

  it('comment composition rejects — upsert and delete leave the record untouched', async () => {
    const h = await mergedHarness()
    const comment = {
      id: 'c1', anchor: { kind: 'summary' }, author: 'user', text: 'late note',
      status: 'queued', replies: [], createdAt: new Date().toISOString(), iteration: 1
    }
    await expect(h.handlers.get('upsertComment')!(h.sessionId, comment))
      .rejects.toThrow('This review is merged and read-only')
    await expect(h.handlers.get('deleteComment')!(h.sessionId, 'c1'))
      .rejects.toThrow('This review is merged and read-only')
    expect(loadReviewState(h.db, h.sessionId).comments).toEqual([])
  })

  it('artifact approve/unapprove reject — the terminal record keeps its approvals', async () => {
    const h = await mergedHarness()
    await expect(h.handlers.get('approveArtifact')!(h.sessionId, 'specs/spec.md'))
      .rejects.toThrow('This review is merged and read-only')
    await expect(h.handlers.get('unapproveArtifact')!(h.sessionId, 'specs/spec.md'))
      .rejects.toThrow('This review is merged and read-only')
  })

  it('compare retarget rejects — the merge pinned the compare to the merged sha', async () => {
    const h = await mergedHarness()
    await expect(h.handlers.get('retargetSession')!(h.sessionId, 'compare', 'main'))
      .rejects.toThrow('This review is merged and read-only')
  })

  it('copyReviewFrom rejects — a terminal record cannot take a copied review', async () => {
    const h = await mergedHarness()
    // a genuinely copyable source: another session in the repo with one iteration
    const source = createSession(h.db, h.dir, {
      base: { kind: 'branch', symbol: 'main', anchorSha: h.shas.base },
      compare: { kind: 'commit', symbol: 'feature~1', anchorSha: h.shas.firstFeature }
    }, agent).id
    const annotations = { title: 'Copied title', summary: 'Copied summary', sections: [], questions: [] }
    addIteration(h.db, source, {
      n: 1, engine: 'claude', sessionId: 'es-src', endSha: h.shas.firstFeature,
      at: 'T1', title: annotations.title, summary: annotations.summary, annotations, scope: 'full'
    })

    await expect(h.handlers.get('copyReviewFrom')!(source, 1, h.sessionId))
      .rejects.toThrow('This review is merged and read-only')
    // the merged record kept its (empty) review — the copy's DELETEs never ran
    expect(loadReviewState(h.db, h.sessionId).annotations).toBeUndefined()
    expect(loadReviewState(h.db, h.sessionId).iterations).toEqual([])

    // control: the same copy lands on a session that is not merged
    const open = createSession(h.db, h.dir, {
      base: { kind: 'branch', symbol: 'main', anchorSha: h.shas.base },
      compare: { kind: 'commit', symbol: 'feature~2', anchorSha: h.shas.base }
    }, agent).id
    await h.handlers.get('copyReviewFrom')!(source, 1, open)
    expect(loadReviewState(h.db, open).annotations?.title).toBe('Copied title')
  })

  // Note: sendChat is intentionally NOT guarded — read-only chat about a landed
  // review is allowed (§7 / open question 7). It has no assertNotMerged call, so
  // there is nothing to assert here without driving a real engine turn.
})
