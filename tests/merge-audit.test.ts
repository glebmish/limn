import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db/db'
import { approveSessionSha, createSession, loadReviewState } from '../src/server/db/sessions'
import { resolveRefInput } from '../src/server/git'
import { executeMerge, MergeRecordWriteError } from '../src/server/merge'
import { makeFixtureRepo, fixtureGit, type FixtureRepo } from './helpers/fixtureRepo'
import type { AgentRef, MergeExecuteRequest, RefPair } from '../src/shared/types'

/** Both hooks fail the merge call with the base ref ALREADY moved — the only window
 *  in which executeMerge's catch has to tell "our merge landed" from "someone raced
 *  us", and the branch the pre-check at the top of executeMerge cannot reach (it runs
 *  before the ref moves). `throwAfterMerge` lands our merge for real and then throws,
 *  the shape of a failing post-merge `git rev-parse`; `raceInsteadOfMerge` lands
 *  SOMEONE ELSE's commit and never merges ours. */
const gitHooks = { throwAfterMerge: false, raceInsteadOfMerge: false }
vi.mock('../src/server/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/git')>()
  return {
    ...actual,
    mergeInWorktree: async (...args: Parameters<typeof actual.mergeInWorktree>) => {
      const [dir] = args
      if (gitHooks.raceInsteadOfMerge) {
        fs.writeFileSync(path.join(dir, 'raced.txt'), 'someone else\n')
        fixtureGit(dir, 'add', '-A')
        fixtureGit(dir, 'commit', '-m', 'raced base commit')
        throw new Error('boom: the merge itself failed')
      }
      const sha = await actual.mergeInWorktree(...args)
      if (gitHooks.throwAfterMerge) throw new Error('boom: rev-parse after the merge failed')
      return sha
    }
  }
})

const agent: AgentRef = { engine: 'claude' }

interface Ctx {
  db: ReturnType<typeof openDb>['db']
  dir: string
  shas: FixtureRepo['shas']
  sessionId: number
}

async function setup(): Promise<Ctx> {
  const { dir, shas } = makeFixtureRepo()
  const base = await resolveRefInput(dir, 'main')
  const compare = await resolveRefInput(dir, 'feature')
  const pair: RefPair = {
    base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
    compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  }
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-ma-')), 'db')).db
  return { db, dir, shas, sessionId: createSession(db, dir, pair, agent).id }
}

describe('executeMerge — a failure AFTER the merge landed', () => {
  it('reports the landed merge instead of the retryable preflight-changed', async () => {
    const { db, dir, shas, sessionId } = await setup()
    fixtureGit(dir, 'checkout', '-q', 'main') // base checked out → the in-worktree path
    approveSessionSha(db, sessionId, shas.head)
    const req: MergeExecuteRequest = {
      strategy: 'merge',
      message: 'Merge feature',
      overrides: [],
      cleanup: { archiveSession: false, deleteBranch: false, removeWorktree: false, retarget: [] },
      expect: { baseHead: shas.base, tipSha: shas.head }
    }

    gitHooks.throwAfterMerge = true
    try {
      // preflight-changed is what the sheet RETRIES from — here it would double-land
      await expect(executeMerge(db, sessionId, req)).rejects.toThrow(MergeRecordWriteError)
    } finally {
      gitHooks.throwAfterMerge = false
    }

    // the merge really is on the base, and nothing was recorded
    const mainHead = fixtureGit(dir, 'rev-parse', 'main')
    expect(mainHead).not.toBe(shas.base)
    expect(fixtureGit(dir, 'log', '-1', '--format=%P', 'main').split(' ')).toEqual([shas.base, shas.head])
    expect(loadReviewState(db, sessionId).merged).toBeUndefined()
  })

  it('still reports preflight-changed when the base moved but our merge did not land', async () => {
    const { db, dir, shas, sessionId } = await setup()
    fixtureGit(dir, 'checkout', '-q', 'main') // base checked out → the in-worktree path
    approveSessionSha(db, sessionId, shas.head)
    const req: MergeExecuteRequest = {
      strategy: 'merge',
      message: 'Merge feature',
      overrides: [],
      cleanup: { archiveSession: false, deleteBranch: false, removeWorktree: false, retarget: [] },
      expect: { baseHead: shas.base, tipSha: shas.head }
    }

    // the race happens INSIDE the merge call, so the pre-check at the top of
    // executeMerge passes and the catch is what has to make the call
    gitHooks.raceInsteadOfMerge = true
    let res
    try {
      res = await executeMerge(db, sessionId, req)
    } finally {
      gitHooks.raceInsteadOfMerge = false
    }

    expect(res.status).toBe('preflight-changed')
    // main moved, but the reviewed tip is NOT on it — nothing of ours landed
    expect(fixtureGit(dir, 'rev-parse', 'main')).not.toBe(shas.base)
    expect(fixtureGit(dir, 'merge-base', 'main', 'feature')).toBe(shas.base)
    expect(loadReviewState(db, sessionId).merged).toBeUndefined()
  })
})
