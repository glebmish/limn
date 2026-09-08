import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db/db'
import { approveSessionSha, createSession, getSession, listRepoSessions, loadReviewState } from '../src/server/db/sessions'
import { buildLoadedReview } from '../src/server/review'
import { registerIpc } from '../src/server/ipc'
import { resolveRefInput } from '../src/server/git'
import { makeFixtureRepo, fixtureGit, fixtureWrite, type FixtureRepo } from './helpers/fixtureRepo'
import type { AgentRef, MergeExecuteRequest, MergeExecuteResult, MergePreflight, RefPair } from '../src/shared/types'
import type { Transport } from '../src/server/transport'

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

describe('mergeExecute — merged record renders the reviewed diff (§2 durability)', () => {
  // The record must render the reviewed file diff even after the branch (compare) is
  // gone and the base branch advanced past the tip. Regression: pinning only the
  // compare side left base a live branch, so getDiff collapsed merge-base onto the
  // tip → an empty diff for every strategy except squash.
  for (const strategy of ['ff', 'merge', 'squash'] as const) {
    it(`${strategy}: non-empty diff after landing`, async () => {
      const h = await setup()
      approveSessionSha(h.db, h.sessionId, h.shas.head)
      const res = await h.handlers.get('mergeExecute')!(
        h.sessionId,
        baseReq({ baseHead: h.shas.base, tipSha: h.shas.head },
          { strategy, ...(strategy === 'ff' ? {} : { message: 'Land feature' }) })
      ) as MergeExecuteResult
      expect(res.status).toBe('merged')
      const loaded = await buildLoadedReview(h.db, getSession(h.db, h.sessionId)!)
      expect(loaded.state.merged?.strategy).toBe(strategy)
      // the reviewed change (feature edits a.ts, adds b.ts, deletes old.ts, …) renders
      expect(loaded.skeleton.files.length).toBeGreaterThan(0)
      expect(loaded.refMissing).toBeUndefined()
    })
  }

  it('after a mid-review rebase onto a moved base: no base commits in the rendered diff', async () => {
    const h = await setup()
    // the base moves during the review …
    const wt = externalWorktree(h.dir, 'main')
    fixtureWrite(wt, 'm.txt', 'base-only work\n')
    fixtureGit(wt, 'add', '-A')
    fixtureGit(wt, 'commit', '-m', 'base moves on')
    const movedMain = fixtureGit(h.dir, 'rev-parse', 'main')
    // … and the branch absorbs it, so the reviewed diff is movedMain..tip
    fixtureGit(h.dir, 'rebase', 'main')
    const rebasedTip = fixtureGit(h.dir, 'rev-parse', 'feature')
    approveSessionSha(h.db, h.sessionId, rebasedTip)

    const res = await h.handlers.get('mergeExecute')!(
      h.sessionId, baseReq({ baseHead: movedMain, tipSha: rebasedTip })
    ) as MergeExecuteResult
    expect(res.status).toBe('merged')

    const loaded = await buildLoadedReview(h.db, getSession(h.db, h.sessionId)!)
    expect(loaded.skeleton.mergeBase).toBe(movedMain)
    // m.txt is the BASE's own commit — it was never part of the reviewed branch
    expect(loaded.skeleton.files.map((f) => f.path)).not.toContain('m.txt')
    expect(loaded.skeleton.files.length).toBeGreaterThan(0)
  })
})

describe('mergeExecute — post-land record-write failure (#5)', () => {
  it('surfaces a distinct "landed but not recorded" error, not a generic merge failure', async () => {
    const h = await setup()
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    // Force the keep-ref write inside persistMergeRecord to fail: occupy refs/limn/keep
    // as a ref so refs/limn/keep/<id> hits a git directory/file conflict. The land
    // (ff CAS) runs first and succeeds, so this exercises the after-land path.
    fixtureGit(h.dir, 'update-ref', 'refs/limn/keep', h.shas.base)
    await expect(h.handlers.get('mergeExecute')!(
      h.sessionId, baseReq({ baseHead: h.shas.base, tipSha: h.shas.head }, { strategy: 'ff' })
    )).rejects.toThrow(/merge landed/)
    // the merge really landed despite the record failure — main advanced to the tip
    expect(fixtureGit(h.dir, 'rev-parse', 'main')).toBe(h.shas.head)
    // and the session is NOT recorded as merged (the record write is what failed)
    expect(loadReviewState(h.db, h.sessionId).merged).toBeUndefined()
  })
})

describe('mergeExecute — authoritative re-check (S10 / Seq C)', () => {
  it('base moved after the sheet was shown: preflight-changed, nothing written', async () => {
    const h = await setup()
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    const pre = await h.handlers.get('mergePreflight')!(h.sessionId) as MergePreflight
    expect(pre.gates).toEqual([])

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

/** A dependent session stacked on feature: branch `dep` in an external worktree. */
function addDependent(h: Harness, edit: { rel: string; content: string }): { depId: number; depSha: string; wt: string } {
  const wt = externalWorktree(h.dir, 'feature', '-b', 'dep')
  fixtureWrite(wt, edit.rel, edit.content)
  fixtureGit(wt, 'add', '-A')
  fixtureGit(wt, 'commit', '-m', 'dep work')
  const depSha = fixtureGit(h.dir, 'rev-parse', 'dep')
  const depPair: RefPair = {
    base: { kind: 'branch', symbol: 'feature', anchorSha: h.shas.head },
    compare: { kind: 'branch', symbol: 'dep', anchorSha: depSha }
  }
  const depId = createSession(h.db, h.dir, depPair, agent).id
  return { depId, depSha, wt }
}

/** A LIVE session based on feature but with a commit-kind compare — it can never be
 *  offered for retarget (nothing to rebase), but it still depends on the branch ref
 *  existing until it degrades to refMissing. */
function addCommitCompareDependent(h: Harness): { depId: number } {
  const depPair: RefPair = {
    base: { kind: 'branch', symbol: 'feature', anchorSha: h.shas.head },
    compare: { kind: 'commit', symbol: h.shas.head, anchorSha: h.shas.head }
  }
  const depId = createSession(h.db, h.dir, depPair, agent).id
  return { depId }
}

describe('mergeExecute — dependents + cleanup', () => {
  it('clean retarget: rebase lands before the base repoint; branch deletion then proceeds', async () => {
    const h = await setup()
    fixtureGit(h.dir, 'checkout', 'main') // frees feature so deleteBranch can succeed
    const { depId } = addDependent(h, { rel: 'src/d.ts', content: 'export const d = 4\n' })
    approveSessionSha(h.db, h.sessionId, h.shas.head)

    const res = await h.handlers.get('mergeExecute')!(
      h.sessionId,
      baseReq({ baseHead: h.shas.base, tipSha: h.shas.head }, {
        cleanup: { archiveSession: true, deleteBranch: true, removeWorktree: false, retarget: [depId] }
      })
    ) as MergeExecuteResult
    expect(res.status).toBe('merged')
    if (res.status !== 'merged') return
    const mergedSha = res.record.mergedSha

    // dep rebased onto the new base head: exactly its own commit replayed
    expect(fixtureGit(h.dir, 'rev-parse', 'dep^')).toBe(mergedSha)
    expect(fixtureGit(h.dir, 'show', 'dep:src/d.ts')).toBe('export const d = 4')
    // base repointed only after the successful rebase (the audited exception)
    const dep = getSession(h.db, depId)!
    expect(dep.pair.base).toEqual({ kind: 'branch', symbol: 'main', anchorSha: mergedSha })
    expect(res.record.cleanup.retargeted).toEqual(['dep'])
    expect(res.record.cleanup.failures).toEqual([])
    // no live session bases on feature anymore → deletion proceeded
    expect(res.record.cleanup.branchDeleted).toBe(true)
    expect(() => fixtureGit(h.dir, 'rev-parse', '--verify', 'refs/heads/feature')).toThrow()
    // the reviewed tip survives the deletion via the keep-ref
    expect(fixtureGit(h.dir, 'rev-parse', `refs/limn/keep/${h.sessionId}`)).toBe(h.shas.head)
    // archive honored + reported
    expect(res.record.cleanup.archived).toBe(true)
    expect(listRepoSessions(h.db, h.dir, true).find((s) => s.id === h.sessionId)!.archived).toBe(true)
  })

  it('conflicted retarget: rebase aborts, dependent untouched, branch deletion skipped with a recorded reason, record still durable', async () => {
    const h = await setup()
    fixtureGit(h.dir, 'checkout', 'main')
    // dep edits docs/spec.md; main will edit the same line → the replay conflicts
    const { depId, depSha, wt } = addDependent(h, { rel: 'docs/spec.md', content: '# Rate limiting spec (dep)\n' })
    fixtureWrite(h.dir, 'docs/spec.md', '# Rate limiting spec v2\n')
    fixtureGit(h.dir, 'add', '-A')
    fixtureGit(h.dir, 'commit', '-m', 'base edits spec')
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    const pre = await h.handlers.get('mergePreflight')!(h.sessionId) as MergePreflight
    expect(pre.gates.map((g) => g.id)).toEqual(['base-moved']) // probe clean: feature never touches spec.md

    const res = await h.handlers.get('mergeExecute')!(
      h.sessionId,
      baseReq({ baseHead: pre.baseHead, tipSha: pre.tipSha }, {
        strategy: 'merge',
        overrides: ['base-moved'],
        cleanup: { archiveSession: false, deleteBranch: true, removeWorktree: false, retarget: [depId] }
      })
    ) as MergeExecuteResult
    expect(res.status).toBe('merged')
    if (res.status !== 'merged') return

    // merge-anyway over a clean probe landed the true merge result
    expect(fixtureGit(h.dir, 'show', 'main:docs/spec.md')).toBe('# Rate limiting spec v2')
    expect(fixtureGit(h.dir, 'show', 'main:src/b.ts')).toContain('return 43')
    // the dependent's rebase conflicted and aborted: branch + worktree exactly as before
    expect(res.record.cleanup.retargeted).toEqual([])
    expect(res.record.cleanup.failures.some((f) => f.startsWith('retarget dep'))).toBe(true)
    expect(fixtureGit(h.dir, 'rev-parse', 'dep')).toBe(depSha)
    expect(fixtureGit(wt, 'status', '--porcelain')).toBe('')
    expect(getSession(h.db, depId)!.pair.base.symbol).toBe('feature')
    // branch deletion refused while dep still bases on feature — recorded, not thrown
    expect(res.record.cleanup.branchDeleted).toBe(false)
    expect(res.record.cleanup.failures.some((f) => f.startsWith('delete branch skipped'))).toBe(true)
    expect(fixtureGit(h.dir, 'rev-parse', '--verify', 'refs/heads/feature')).toBe(h.shas.head)
    // record written before (and despite) the cleanup failures
    expect(loadReviewState(h.db, h.sessionId).merged!.cleanup.failures.length).toBeGreaterThan(0)
    expect(res.record.overrides).toEqual([
      expect.objectContaining({ gate: 'base-moved' })
    ])
  })

  it('unselected dependent alone blocks deletion (record lists it in dependents)', async () => {
    const h = await setup()
    fixtureGit(h.dir, 'checkout', 'main')
    addDependent(h, { rel: 'src/d.ts', content: 'export const d = 4\n' })
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    const res = await h.handlers.get('mergeExecute')!(
      h.sessionId,
      baseReq({ baseHead: h.shas.base, tipSha: h.shas.head }, {
        cleanup: { archiveSession: false, deleteBranch: true, removeWorktree: false, retarget: [] }
      })
    ) as MergeExecuteResult
    expect(res.status).toBe('merged')
    if (res.status !== 'merged') return
    expect(res.record.dependents).toEqual(['dep'])
    expect(res.record.cleanup.branchDeleted).toBe(false)
    expect(res.record.cleanup.failures.some((f) => f.startsWith('delete branch skipped'))).toBe(true)
  })

  it('a live commit-kind-compare session based on feature blocks branch deletion (unretargetable, but still refs the branch)', async () => {
    const h = await setup()
    fixtureGit(h.dir, 'checkout', 'main')
    addCommitCompareDependent(h)
    approveSessionSha(h.db, h.sessionId, h.shas.head)
    const res = await h.handlers.get('mergeExecute')!(
      h.sessionId,
      baseReq({ baseHead: h.shas.base, tipSha: h.shas.head }, {
        cleanup: { archiveSession: false, deleteBranch: true, removeWorktree: false, retarget: [] }
      })
    ) as MergeExecuteResult
    expect(res.status).toBe('merged')
    if (res.status !== 'merged') return
    // not offered as a retarget candidate (commit-kind compare — nothing to rebase)
    expect(res.record.dependents).toEqual([])
    // but it still blocks the delete: deleting the branch would refMissing it
    expect(res.record.cleanup.branchDeleted).toBe(false)
    expect(res.record.cleanup.failures.some((f) => f.startsWith('delete branch skipped'))).toBe(true)
    expect(fixtureGit(h.dir, 'rev-parse', '--verify', 'refs/heads/feature')).toBe(h.shas.head)
  })
})
