import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db/db'
import { approveSessionSha, createSession, getSession, loadReviewState, replaceUiState } from '../src/server/db/sessions'
import { resolveRefInput } from '../src/server/git'
import { buildLoadedReview } from '../src/server/review'
import { fixtureGit, makeFixtureRepo } from './helpers/fixtureRepo'
import type { RefPair } from '../src/shared/types'

/** A transient git failure (an index.lock during a concurrent rebase, spawn EAGAIN,
 *  the 64 MB maxBuffer) in the since-diff for a viewed sha that is perfectly
 *  reachable — the case the viewed loop must NOT confuse with "rebased away". */
const gitHooks = { failDiffSinceFor: null as string | null, breakCommitExists: false }
/** Every `diffRefs(dir, from, to)` the load ran, in order. */
const diffRefsCalls: { dir: string; from: string; to: string }[] = []
vi.mock('../src/server/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/git')>()
  return {
    ...actual,
    diffSince: async (...args: Parameters<typeof actual.diffSince>) => {
      if (gitHooks.failDiffSinceFor && args[1] === gitHooks.failDiffSinceFor) {
        throw new Error('git diff failed: fatal: Unable to create index.lock: File exists')
      }
      return actual.diffSince(...args)
    },
    // git cannot run in this repo at all (a broken/absent binary, spawn EAGAIN): the
    // probe returns false for every sha, reachable or not
    commitExists: async (...args: Parameters<typeof actual.commitExists>) =>
      gitHooks.breakCommitExists ? false : actual.commitExists(...args),
    diffRefs: async (...args: Parameters<typeof actual.diffRefs>) => {
      diffRefsCalls.push({ dir: args[0], from: args[1], to: args[2] })
      return actual.diffRefs(...args)
    }
  }
})

async function setup(): Promise<{ dir: string; db: ReturnType<typeof openDb>['db']; sessionId: number; shas: { base: string; firstFeature: string; head: string } }> {
  const { dir, shas } = makeFixtureRepo()
  const base = await resolveRefInput(dir, 'main')
  const compare = await resolveRefInput(dir, 'feature')
  const pair: RefPair = {
    base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
    compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  }
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-rev-audit-')), 'db')).db
  return { dir, db, sessionId: createSession(db, dir, pair).id, shas }
}

describe('viewed marks vs. a failing since-diff', () => {
  it('keeps the marks — in the load and in the DB — when the git call fails but the sha is reachable', async () => {
    const { db, sessionId, shas } = await setup()
    replaceUiState(db, sessionId, { viewedAt: { 'src/a.ts': { sha: shas.firstFeature, hash: 'h0' } } })
    gitHooks.failDiffSinceFor = shas.firstFeature
    try {
      const loaded = await buildLoadedReview(db, getSession(db, sessionId)!)
      expect(loaded.state.viewedAt['src/a.ts']).toEqual({ sha: shas.firstFeature, hash: 'h0' })
    } finally {
      gitHooks.failDiffSinceFor = null
    }
    expect(loadReviewState(db, sessionId).viewedAt['src/a.ts']).toEqual({ sha: shas.firstFeature, hash: 'h0' })
  })

  it('keeps the marks when the reachability probe itself cannot run', async () => {
    const { db, sessionId, shas } = await setup()
    const mark = { sha: shas.firstFeature, hash: 'h0' }
    replaceUiState(db, sessionId, { viewedAt: { 'src/a.ts': mark } })
    gitHooks.breakCommitExists = true
    try {
      const loaded = await buildLoadedReview(db, getSession(db, sessionId)!)
      expect(loaded.state.viewedAt['src/a.ts']).toEqual(mark)
    } finally {
      gitHooks.breakCommitExists = false
    }
    expect(loadReviewState(db, sessionId).viewedAt['src/a.ts']).toEqual(mark)
  })

  it('drops the marks recorded at a sha that no longer names a commit', async () => {
    const { db, sessionId } = await setup()
    const gone = '0'.repeat(40)
    replaceUiState(db, sessionId, { viewedAt: { 'src/a.ts': { sha: gone, hash: 'h0' } } })

    const loaded = await buildLoadedReview(db, getSession(db, sessionId)!)
    expect(loaded.state.viewedAt['src/a.ts']).toBeUndefined()
    expect(loadReviewState(db, sessionId).viewedAt['src/a.ts']).toBeUndefined()
  })
})

describe('base→checkpoint slices on a dirty load', () => {
  it('diffs each checkpoint once instead of repeating it in worktree space', async () => {
    const { dir, db, sessionId, shas } = await setup()
    approveSessionSha(db, sessionId, shas.firstFeature)
    replaceUiState(db, sessionId, { viewedAt: { 'src/a.ts': { sha: shas.base, hash: 'h0' } } })
    fs.appendFileSync(path.join(dir, 'src/a.ts'), 'export const dirty = true\n') // dirty → the merged pass runs

    diffRefsCalls.length = 0
    const loaded = await buildLoadedReview(db, getSession(db, sessionId)!)
    expect(loaded.dirty).toBe(true)

    // both passes ask for the same (mergeBase, checkpoint) pairs — the second ask is
    // the memo's, not git's
    const pairs = diffRefsCalls.map((c) => `${c.from}\0${c.to}`)
    expect(pairs).toContain(`${loaded.skeleton.mergeBase}\0${shas.firstFeature}`)
    expect(pairs).toContain(`${loaded.skeleton.mergeBase}\0${shas.base}`)
    expect(pairs.length).toBe(new Set(pairs).size)

    // …and both surfaces still carry their slices
    expect(loaded.skeleton.files.find((f) => f.path === 'src/a.ts')?.baseToApprovedHunks).toBeDefined()
    expect(loaded.merged?.find((f) => f.path === 'src/a.ts')?.baseToApprovedHunks).toBeDefined()
    expect(loaded.merged?.find((f) => f.path === 'src/a.ts')?.baseToViewedHunks).toBeDefined()
  })

  // …but the memo may NOT collapse to the sha alone: git resolves diff attributes from
  // the working tree it runs in, so the same two shas render differently in a linked
  // worktree whose .gitattributes differs from the primary checkout's.
  it('still diffs per checkout when the two checkouts disagree about a file', async () => {
    const { dir, shas } = makeFixtureRepo()
    fixtureGit(dir, 'checkout', '-q', 'main') // free `feature` for a linked worktree
    const wtDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-lw-')), 'wt')
    fixtureGit(dir, 'worktree', 'add', '-q', wtDir, 'feature')
    // …the primary checkout alone calls src/b.ts binary
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'src/b.ts -diff\n')
    fs.appendFileSync(path.join(wtDir, 'src/a.ts'), 'export const dirty = true\n') // dirty → merged pass

    const base = await resolveRefInput(dir, 'main')
    const compare = await resolveRefInput(dir, 'feature')
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-lw-db-')), 'db')).db
    const session = createSession(db, dir, {
      base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
      compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
    })
    approveSessionSha(db, session.id, shas.firstFeature)

    diffRefsCalls.length = 0
    const loaded = await buildLoadedReview(db, getSession(db, session.id)!)
    expect(loaded.dirty).toBe(true)

    // one diff per checkout for the one checkpoint — the memo did not share across them
    const forApproved = diffRefsCalls.filter((c) => c.from === loaded.skeleton.mergeBase && c.to === shas.firstFeature)
    expect(forApproved.length).toBe(2)
    expect(new Set(forApproved.map((c) => c.dir)).size).toBe(2)
    // and the two really do disagree: no hunks where `-diff` applies, hunks where it doesn't
    expect(loaded.skeleton.files.find((f) => f.path === 'src/b.ts')?.baseToApprovedHunks).toEqual([])
    expect(loaded.merged?.find((f) => f.path === 'src/b.ts')?.baseToApprovedHunks?.length).toBeGreaterThan(0)
  })
})
