import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import { createSession, unresolvedCount, upsertComment } from '../src/main/db/sessions'
import { buildCompareData } from '../src/main/compare'
import { resolveRefInput } from '../src/main/git'
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixtureRepo'
import type { Comment, RefPair } from '../src/shared/types'

let db: DatabaseSync
let fx: FixtureRepo
beforeEach(() => {
  db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-cmp-')), 'db')).db
  fx = makeFixtureRepo()
})

function mkComment(id: string): Comment {
  return {
    id, author: 'user', text: 'q', status: 'queued', replies: [], iteration: 0,
    createdAt: new Date().toISOString(), anchor: { kind: 'summary' }
  }
}

describe('buildCompareData', () => {
  it('returns commits, files, totals, and context for a valid branch pair', async () => {
    const data = await buildCompareData(db, fx.dir, 'main', 'feature')
    expect(data.baseError).toBeUndefined()
    expect(data.compareError).toBeUndefined()
    expect(data.base?.symbol).toBe('main')
    expect(data.base?.kind).toBe('branch')
    expect(data.compare?.symbol).toBe('feature')
    expect(data.commits.length).toBeGreaterThan(0)        // feature is ahead of main
    expect(data.files.length).toBeGreaterThan(0)
    expect(data.add).toBeGreaterThan(0)
    expect(data.base?.context).toMatch(/branch tip/)
    expect(data.existingSession).toBeNull()
  })

  it('reports a per-side error for an invalid ref without throwing', async () => {
    const data = await buildCompareData(db, fx.dir, 'no-such-ref', 'feature')
    expect(data.baseError).toMatch(/not a branch or commit/)
    expect(data.base).toBeUndefined()
    expect(data.commits).toEqual([])
    expect(data.files).toEqual([])
  })

  it('flags identical base/compare as a compareError', async () => {
    const data = await buildCompareData(db, fx.dir, 'main', 'main')
    expect(data.compareError).toBe('base and compare point at the same commit')
    expect(data.commits).toEqual([])
  })

  it('surfaces an existing unarchived session with its unresolved count', async () => {
    const base = await resolveRefInput(fx.dir, 'main')
    const compare = await resolveRefInput(fx.dir, 'feature')
    const pair: RefPair = {
      base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
      compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
    }
    const s = createSession(db, fx.dir, pair, { engine: 'claude' })
    upsertComment(db, s.id, mkComment('c1'))
    upsertComment(db, s.id, { ...mkComment('c2'), status: 'sent' })
    upsertComment(db, s.id, { ...mkComment('c3'), status: 'resolved' })
    const data = await buildCompareData(db, fx.dir, 'main', 'feature')
    expect(data.existingSession).toEqual({ id: s.id, unresolved: 2 })
    expect(unresolvedCount(db, s.id)).toBe(2)             // sanity: matches DAO
  })
})
