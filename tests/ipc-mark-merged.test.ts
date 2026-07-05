import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/main/db/db'
import { approveSessionSha, createSession, getSession, loadReviewState, markSessionMerged, retargetSession } from '../src/main/db/sessions'
import { registerIpc } from '../src/main/ipc'
import { resolveRefInput } from '../src/main/git'
import { makeFixtureRepo, fixtureGit, fixtureWrite, type FixtureRepo } from './helpers/fixtureRepo'
import type { AgentRef, MergeExecuteResult, MergeRecord, RefPair } from '../src/shared/types'
import type { LoadedReview, RepoChangedMsg } from '../src/shared/ipc'
import type { Transport } from '../src/main/transport'

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
