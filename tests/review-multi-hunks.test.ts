import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db/db'
import { createSession, updateSessionMeta, approveSessionSha, getSession, replaceUiState } from '../src/server/db/sessions'
import { buildLoadedReview } from '../src/server/review'
import { makeFixtureRepo, fixtureGit, fixtureWrite } from './helpers/fixtureRepo'
import type { RefPair } from '../src/shared/types'

function setup() {
  const fx = makeFixtureRepo()
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-multi-')), 'db')).db
  const approvedAt = fixtureGit(fx.dir, 'rev-parse', 'HEAD~1')
  const pair: RefPair = {
    base: { kind: 'branch', symbol: 'main', anchorSha: fx.shas.base },
    compare: { kind: 'branch', symbol: 'feature', anchorSha: fx.shas.head }
  }
  return { fx, db, session: createSession(db, fx.dir, pair), approvedAt }
}

describe('base → checkpoint hunks (the Multi middle column)', () => {
  it('attaches base→review and base→approved per file, [] where the file was unchanged at that checkpoint', async () => {
    const { fx, db, session, approvedAt } = setup()
    updateSessionMeta(db, session.id, { reviewedAtSha: fx.shas.firstFeature })
    approveSessionSha(db, session.id, approvedAt)
    const loaded = await buildLoadedReview(db, getSession(db, session.id)!)
    const file = (p: string) => loaded.skeleton.files.find((f) => f.path === p)!
    // a.ts changed in the first feature commit: present at both checkpoints
    expect(file('src/a.ts').baseToReviewHunks?.length).toBeGreaterThan(0)
    expect(file('src/a.ts').baseToApprovedHunks?.length).toBeGreaterThan(0)
    // c.ts landed after both: the checkpoint exists but the file was untouched there
    expect(file('src/c.ts').baseToReviewHunks).toEqual([])
    expect(file('src/c.ts').baseToApprovedHunks).toEqual([])
    // the middle column is base-relative: old numbers are base numbers
    expect(file('src/a.ts').baseToReviewHunks![0].lines.find((l) => l.kind === 'del')?.old).toBe(2)
  })

  it('leaves the fields absent when the review has no checkpoint', async () => {
    const { db, session } = setup()
    const loaded = await buildLoadedReview(db, getSession(db, session.id)!)
    const a = loaded.skeleton.files.find((f) => f.path === 'src/a.ts')!
    expect(a.baseToReviewHunks).toBeUndefined()
    expect(a.baseToApprovedHunks).toBeUndefined()
  })

  it('attaches base→viewed only for the viewed paths, on the merged view too when dirty', async () => {
    const { fx, db, session } = setup()
    replaceUiState(db, session.id, { viewedAt: { 'src/b.ts': { sha: fx.shas.firstFeature, hash: '' } } })
    fixtureWrite(fx.dir, 'src/b.ts', 'export function b() {\n  return 44\n}\n') // dirty
    const loaded = await buildLoadedReview(db, getSession(db, session.id)!)
    expect(loaded.dirty).toBe(true)
    const files = loaded.merged!
    expect(files.find((f) => f.path === 'src/b.ts')!.baseToViewedHunks?.length).toBeGreaterThan(0)
    expect(files.find((f) => f.path === 'src/a.ts')!.baseToViewedHunks).toBeUndefined()
  })
})
