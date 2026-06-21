import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/main/db/db'
import { createSession } from '../src/main/db/sessions'
import { buildLoadedReview, previewReview } from '../src/main/review'
import { resolveRefInput } from '../src/main/git'
import { fixtureGit as git, fixtureWrite as write } from './helpers/fixtureRepo'
import type { RefPair } from '../src/shared/types'

let db: DatabaseSync

/** A repo with a recognized superpowers spec added on the feature branch, so the
 *  artifact detector surfaces it from the diff (exercises the persist flag). */
function makeRepoWithArtifact(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-rev-'))
  git(dir, 'init', '-b', 'main')
  write(dir, 'src/a.ts', 'export const a = 1\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base')

  git(dir, 'checkout', '-q', '-b', 'feature')
  write(dir, 'src/a.ts', 'export const a = 2\n')
  write(dir, 'src/b.ts', 'export const b = 3\n')
  write(dir, 'docs/superpowers/specs/2026-feature-design.md', '# Feature spec\n\nGoal: ship the feature.\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'feature work')
  return dir
}

const count = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

beforeEach(() => {
  db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-revdb-')), 'db')).db
})

describe('previewReview', () => {
  it('builds a transient review (sentinel id, empty state, real diff) without any DB writes', async () => {
    const dir = makeRepoWithArtifact()
    const loaded = await previewReview(db, dir, 'main', 'feature', { engine: 'claude' })

    // sentinel identity — never persisted
    expect(loaded.sessionId).toBe(0)
    expect(loaded.session.id).toBe(0)

    // empty in-memory state (nothing generated/commented yet)
    expect(loaded.state.comments).toEqual([])
    expect(loaded.state.chats).toEqual([])
    expect(loaded.state.annotations).toBeUndefined()
    expect(loaded.state.viewedAt).toEqual({})

    // real assembled diff + detected artifact
    expect(loaded.skeleton.files.length).toBeGreaterThan(0)
    expect(loaded.commits.length).toBeGreaterThan(0)
    expect(loaded.artifacts.some((a) => a.role === 'spec')).toBe(true)

    // no rows minted anywhere — transient means transient
    expect(count('sessions')).toBe(0)
    expect(count('artifacts')).toBe(0)
  })

  it('throws when a ref does not resolve', async () => {
    const dir = makeRepoWithArtifact()
    await expect(previewReview(db, dir, 'no-such-ref', 'feature', { engine: 'claude' }))
      .rejects.toThrow(/not a branch or commit/)
  })
})

describe('buildLoadedReview (persisted path) still writes', () => {
  it('caches detected artifacts to the DB for a real session', async () => {
    const dir = makeRepoWithArtifact()
    const base = await resolveRefInput(dir, 'main')
    const compare = await resolveRefInput(dir, 'feature')
    const pair: RefPair = {
      base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
      compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
    }
    const session = createSession(db, dir, pair, { engine: 'claude' })
    expect(count('artifacts')).toBe(0)

    const loaded = await buildLoadedReview(db, session)
    expect(loaded.artifacts.some((a) => a.role === 'spec')).toBe(true)
    // persisted path caches the detection
    expect(count('artifacts')).toBeGreaterThan(0)
  })
})
