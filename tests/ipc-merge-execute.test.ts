import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/main/db/db'
import { approveSessionSha, createSession, getSession, listRepoSessions, loadReviewState } from '../src/main/db/sessions'
import { registerIpc } from '../src/main/ipc'
import { resolveRefInput } from '../src/main/git'
import { makeFixtureRepo, fixtureGit, fixtureWrite, type FixtureRepo } from './helpers/fixtureRepo'
import type { AgentRef, MergeExecuteRequest, MergeExecuteResult, MergePreflight, RefPair } from '../src/shared/types'
import type { Transport } from '../src/main/transport'

const agent: AgentRef = { engine: 'claude' }

interface Harness {
  db: ReturnType<typeof openDb>['db']
  dir: string
  shas: FixtureRepo['shas']
  sessionId: number
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>
}

async function setup(): Promise<Harness> {
  const { dir, shas } = makeFixtureRepo()
  const base = await resolveRefInput(dir, 'main')
  const compare = await resolveRefInput(dir, 'feature')
  const pair: RefPair = {
    base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
    compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  }
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-mx-')), 'db')).db
  const sessionId = createSession(db, dir, pair, agent).id
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn as (...a: unknown[]) => Promise<unknown>) },
    broadcast() { /* unused */ },
    notify() { /* unused */ },
    async pickDirectory() { return null }
  }
  registerIpc(db, [], transport)
  return { db, dir, shas, sessionId, handlers }
}

function baseReq(expect: MergeExecuteRequest['expect'], over: Partial<MergeExecuteRequest> = {}): MergeExecuteRequest {
  return {
    strategy: 'squash',
    overrides: [],
    cleanup: { archiveSession: false, deleteBranch: false, removeWorktree: false, retarget: [] },
    expect,
    ...over
  }
}

function externalWorktree(dir: string, ref: string, ...flags: string[]): string {
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-xwt-')), 'wt')
  fixtureGit(dir, 'worktree', 'add', ...flags, wt, ref)
  return wt
}

describe('mergeExecute — landing', () => {
  it('plumbing squash (base checked out nowhere): exact tree, single parent, record + keep-ref + compare retarget', async () => {
    const h = await setup()
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    const res = await h.handlers.get('mergeExecute')!(
      h.sessionId,
      baseReq({ baseHead: h.shas.base, tipSha: h.shas.head }, { message: 'Ship rate limiting' })
    ) as MergeExecuteResult
    expect(res.status).toBe('merged')
    if (res.status !== 'merged') return

    const mainHead = fixtureGit(h.dir, 'rev-parse', 'main')
    expect(mainHead).not.toBe(h.shas.base)
    expect(res.record.mergedSha).toBe(mainHead)
    // squash correctness: one parent (old base), tree identical to the reviewed tip's
    expect(fixtureGit(h.dir, 'log', '-1', '--format=%P', 'main')).toBe(h.shas.base)
    expect(fixtureGit(h.dir, 'rev-parse', 'main^{tree}'))
      .toBe(fixtureGit(h.dir, 'rev-parse', `${h.shas.head}^{tree}`))
    expect(fixtureGit(h.dir, 'log', '-1', '--format=%B', 'main').trim()).toBe('Ship rate limiting')
    // keep-ref planted at the reviewed tip (squash-orphan survival)
    expect(fixtureGit(h.dir, 'rev-parse', `refs/limn/keep/${h.sessionId}`)).toBe(h.shas.head)
    // compare side retargeted to a commit-kind anchor at the reviewed tip
    const session = getSession(h.db, h.sessionId)!
    expect(session.pair.compare.kind).toBe('commit')
    expect(session.pair.compare.anchorSha).toBe(h.shas.head)
    // record fields + persisted merged state
    expect(res.record.strategy).toBe('squash')
    expect(res.record.reviewedTipSha).toBe(h.shas.head)
    expect(res.record.baseShaBefore).toBe(h.shas.base)
    expect(res.record.baseSymbol).toBe('main')
    expect(res.record.external).toBeUndefined()
    expect(loadReviewState(h.db, h.sessionId).merged).toEqual(res.record)
    // nothing was cleaned up (all toggles off): the branch survives
    expect(fixtureGit(h.dir, 'rev-parse', '--verify', 'feature')).toBe(h.shas.head)
    expect(res.record.cleanup).toEqual({
      archived: false, branchDeleted: false, worktreeRemoved: false, retargeted: [], failures: []
    })
  })

  it('plumbing fast-forward: base ref moves to the tip via CAS', async () => {
    const h = await setup()
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    const res = await h.handlers.get('mergeExecute')!(
      h.sessionId,
      baseReq({ baseHead: h.shas.base, tipSha: h.shas.head }, { strategy: 'ff' })
    ) as MergeExecuteResult
    expect(res.status).toBe('merged')
    if (res.status !== 'merged') return
    expect(fixtureGit(h.dir, 'rev-parse', 'main')).toBe(h.shas.head)
    expect(res.record.mergedSha).toBe(h.shas.head)
    expect(res.record.strategy).toBe('ff')
    expect(res.record.message).toBeUndefined()
  })

  it('in-worktree merge commit when the base is checked out clean', async () => {
    const h = await setup()
    fixtureGit(h.dir, 'checkout', 'main') // primary now holds the base; feature checked out nowhere
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    const res = await h.handlers.get('mergeExecute')!(
      h.sessionId,
      baseReq({ baseHead: h.shas.base, tipSha: h.shas.head }, { strategy: 'merge', message: 'Merge feature' })
    ) as MergeExecuteResult
    expect(res.status).toBe('merged')
    if (res.status !== 'merged') return
    const parents = fixtureGit(h.dir, 'log', '-1', '--format=%P', 'main').split(' ')
    expect(parents).toEqual([h.shas.base, h.shas.head])
    expect(res.record.mergedSha).toBe(fixtureGit(h.dir, 'rev-parse', 'main'))
    // the base worktree advanced through a real merge — its files are current
    expect(fs.readFileSync(path.join(h.dir, 'src/c.ts'), 'utf8')).toBe('export const c = 3\n')
  })
})

describe('mergeExecute — authoritative re-check (S10 / Seq C)', () => {
  it('base moved after the sheet was shown: preflight-changed, nothing written', async () => {
    const h = await setup()
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    const pre = await h.handlers.get('mergePreflight')!(h.sessionId) as MergePreflight
    expect(pre.ok).toBe(true)

    // the race: base moves between preflight and confirm
    const wt = externalWorktree(h.dir, 'main')
    fixtureWrite(wt, 'docs/spec.md', '# Rate limiting spec v2\n')
    fixtureGit(wt, 'add', '-A')
    fixtureGit(wt, 'commit', '-m', 'raced base commit')
    const movedMain = fixtureGit(h.dir, 'rev-parse', 'main')

    const res = await h.handlers.get('mergeExecute')!(
      h.sessionId, baseReq({ baseHead: pre.baseHead, tipSha: pre.tipSha })
    ) as MergeExecuteResult
    expect(res.status).toBe('preflight-changed')
    if (res.status !== 'preflight-changed') return
    expect(res.preflight.gates.some((g) => g.id === 'base-moved')).toBe(true)
    expect(res.preflight.baseHead).toBe(movedMain)

    // nothing was written: no merge, no record, no keep-ref, no retarget
    expect(fixtureGit(h.dir, 'rev-parse', 'main')).toBe(movedMain)
    expect(fixtureGit(h.dir, 'merge-base', 'main', 'feature')).toBe(h.shas.base)
    expect(loadReviewState(h.db, h.sessionId).merged).toBeUndefined()
    expect(getSession(h.db, h.sessionId)!.pair.compare.kind).toBe('branch')
    expect(() => fixtureGit(h.dir, 'rev-parse', '--verify', `refs/limn/keep/${h.sessionId}`)).toThrow()
  })

  it('requested strategy no longer available (ff after base moved): preflight-changed even with the amber acked', async () => {
    const h = await setup()
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    const wt = externalWorktree(h.dir, 'main')
    fixtureWrite(wt, 'docs/spec.md', '# Rate limiting spec v2\n')
    fixtureGit(wt, 'add', '-A')
    fixtureGit(wt, 'commit', '-m', 'base drift')
    const pre = await h.handlers.get('mergePreflight')!(h.sessionId) as MergePreflight
    expect(pre.strategies.ff).toBe(false)

    const res = await h.handlers.get('mergeExecute')!(
      h.sessionId,
      baseReq({ baseHead: pre.baseHead, tipSha: pre.tipSha }, { strategy: 'ff', overrides: ['base-moved'] })
    ) as MergeExecuteResult
    expect(res.status).toBe('preflight-changed')
    expect(loadReviewState(h.db, h.sessionId).merged).toBeUndefined()
  })

  it('un-acked amber gate at confirm time: preflight-changed', async () => {
    const h = await setup()
    approveSessionSha(h.db, h.sessionId, h.shas.firstFeature) // stale on purpose
    const pre = await h.handlers.get('mergePreflight')!(h.sessionId) as MergePreflight
    const res = await h.handlers.get('mergeExecute')!(
      h.sessionId, baseReq({ baseHead: pre.baseHead, tipSha: pre.tipSha }) // overrides: []
    ) as MergeExecuteResult
    expect(res.status).toBe('preflight-changed')
    if (res.status !== 'preflight-changed') return
    expect(res.preflight.gates.map((g) => g.id)).toContain('stale-approval')
  })
})
