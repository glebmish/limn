import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db/db'
import { createSession, updateSessionMeta, approveSessionSha, getSession } from '../src/server/db/sessions'
import { buildLoadedReview } from '../src/server/review'
import { makeFixtureRepo, fixtureGit } from './helpers/fixtureRepo'
import type { RefPair } from '../src/shared/types'

/** The fixture branch lands, in order: `feature work` (a.ts, b.ts, …) → `tweak b`
 *  (b.ts) → `add c` (c.ts). Generating the review at the first and approving at the
 *  second gives the two windows a crisp difference: b.ts moved after the review ran
 *  but before the approval, c.ts moved after both. */
function setup() {
  const fx = makeFixtureRepo()
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-base-')), 'db')).db
  const approvedAt = fixtureGit(fx.dir, 'rev-parse', 'HEAD~1')
  const pair: RefPair = {
    base: { kind: 'branch', symbol: 'main', anchorSha: fx.shas.base },
    compare: { kind: 'branch', symbol: 'feature', anchorSha: fx.shas.head }
  }
  const session = createSession(db, fx.dir, pair)
  return { fx, db, session, approvedAt }
}

describe('the four diff baselines', () => {
  it('attaches the since-review and since-approved slices separately', async () => {
    const { fx, db, session, approvedAt } = setup()
    updateSessionMeta(db, session.id, { reviewedAtSha: fx.shas.firstFeature })
    approveSessionSha(db, session.id, approvedAt)

    const loaded = await buildLoadedReview(db, getSession(db, session.id)!)
    const file = (p: string) => loaded.skeleton.files.find((f) => f.path === p)

    // b.ts changed between the review and the approval: in one window, not the other
    expect(file('src/b.ts')?.sinceReviewHunks?.length).toBeGreaterThan(0)
    expect(file('src/b.ts')?.sinceHunks).toBeUndefined()
    // c.ts landed after both
    expect(file('src/c.ts')?.sinceReviewHunks?.length).toBeGreaterThan(0)
    expect(file('src/c.ts')?.sinceHunks?.length).toBeGreaterThan(0)
  })

  it('does not compute a second slice when the review was generated at the approved sha', async () => {
    const { db, session, approvedAt } = setup()
    updateSessionMeta(db, session.id, { reviewedAtSha: approvedAt })
    approveSessionSha(db, session.id, approvedAt)

    const loaded = await buildLoadedReview(db, getSession(db, session.id)!)
    const c = loaded.skeleton.files.find((f) => f.path === 'src/c.ts')

    expect(c?.sinceHunks?.length).toBeGreaterThan(0)
    expect(c?.sinceReviewHunks).toBeUndefined()
  })

  it('still draws exactly one drift rail — the approval when there is one', async () => {
    const { fx, db, session, approvedAt } = setup()
    updateSessionMeta(db, session.id, { reviewedAtSha: fx.shas.firstFeature })
    approveSessionSha(db, session.id, approvedAt)

    const loaded = await buildLoadedReview(db, getSession(db, session.id)!)
    const b = loaded.skeleton.files.find((f) => f.path === 'src/b.ts')

    // b.ts moved only in the review window, so the (approval-based) rail leaves it alone
    expect(b?.hunks.some((h) => h.since)).toBe(false)
    expect(loaded.skeleton.files.find((f) => f.path === 'src/c.ts')?.hunks.some((h) => h.since)).toBe(true)
  })
})
