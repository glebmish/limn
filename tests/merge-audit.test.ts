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

/** While set, `mergeInWorktree` throws AFTER its merge has really landed — the shape
 *  of a failing post-merge `git rev-parse`, which is the one window in which the base
 *  ref has already moved and the caller is still inside executeMerge's try. */
const gitHooks = { throwAfterInWorktreeMerge: false }
vi.mock('../src/server/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/git')>()
  return {
    ...actual,
    mergeInWorktree: async (...args: Parameters<typeof actual.mergeInWorktree>) => {
      const sha = await actual.mergeInWorktree(...args)
      if (gitHooks.throwAfterInWorktreeMerge) throw new Error('boom: rev-parse after the merge failed')
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

    gitHooks.throwAfterInWorktreeMerge = true
    try {
      // preflight-changed is what the sheet RETRIES from — here it would double-land
      await expect(executeMerge(db, sessionId, req)).rejects.toThrow(MergeRecordWriteError)
    } finally {
      gitHooks.throwAfterInWorktreeMerge = false
    }

    // the merge really is on the base, and nothing was recorded
    const mainHead = fixtureGit(dir, 'rev-parse', 'main')
    expect(mainHead).not.toBe(shas.base)
    expect(fixtureGit(dir, 'log', '-1', '--format=%P', 'main').split(' ')).toEqual([shas.base, shas.head])
    expect(loadReviewState(db, sessionId).merged).toBeUndefined()
  })

  it('still reports preflight-changed when the base was moved by someone else', async () => {
    const { db, dir, shas, sessionId } = await setup()
    approveSessionSha(db, sessionId, shas.head)
    // a raced commit on main: the ref moved, but our merge never landed
    fixtureGit(dir, 'checkout', '-q', 'main')
    fs.writeFileSync(path.join(dir, 'raced.txt'), 'someone else\n')
    fixtureGit(dir, 'add', '-A')
    fixtureGit(dir, 'commit', '-m', 'raced base commit')
    const racedMain = fixtureGit(dir, 'rev-parse', 'main')

    const res = await executeMerge(db, sessionId, {
      strategy: 'merge',
      message: 'Merge feature',
      overrides: [],
      cleanup: { archiveSession: false, deleteBranch: false, removeWorktree: false, retarget: [] },
      expect: { baseHead: shas.base, tipSha: shas.head }
    })
    expect(res.status).toBe('preflight-changed')
    expect(fixtureGit(dir, 'rev-parse', 'main')).toBe(racedMain)
    expect(loadReviewState(db, sessionId).merged).toBeUndefined()
  })
})
