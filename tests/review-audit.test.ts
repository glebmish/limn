import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db/db'
import { createSession, getSession, loadReviewState, replaceUiState } from '../src/server/db/sessions'
import { resolveRefInput } from '../src/server/git'
import { buildLoadedReview } from '../src/server/review'
import { makeFixtureRepo } from './helpers/fixtureRepo'
import type { RefPair } from '../src/shared/types'

/** A transient git failure (an index.lock during a concurrent rebase, spawn EAGAIN,
 *  the 64 MB maxBuffer) in the since-diff for a viewed sha that is perfectly
 *  reachable — the case the viewed loop must NOT confuse with "rebased away". */
const gitHooks = { failDiffSinceFor: null as string | null }
vi.mock('../src/server/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/git')>()
  return {
    ...actual,
    diffSince: async (...args: Parameters<typeof actual.diffSince>) => {
      if (gitHooks.failDiffSinceFor && args[1] === gitHooks.failDiffSinceFor) {
        throw new Error('git diff failed: fatal: Unable to create index.lock: File exists')
      }
      return actual.diffSince(...args)
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
  it('keeps (and does not re-persist) the marks when the git call fails but the sha is reachable', async () => {
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

  it('drops the marks recorded at a sha that no longer names a commit', async () => {
    const { db, sessionId } = await setup()
    const gone = '0'.repeat(40)
    replaceUiState(db, sessionId, { viewedAt: { 'src/a.ts': { sha: gone, hash: 'h0' } } })

    const loaded = await buildLoadedReview(db, getSession(db, sessionId)!)
    expect(loaded.state.viewedAt['src/a.ts']).toBeUndefined()
    expect(loadReviewState(db, sessionId).viewedAt['src/a.ts']).toBeUndefined()
  })
})
