import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db/db'
import { approveArtifact, createSession, loadReviewState, setArtifacts, upsertComment } from '../src/server/db/sessions'
import { loadArtifactsFor } from '../src/server/review'
import { makeFixtureRepo, fixtureGit, fixtureWrite } from './helpers/fixtureRepo'
import type { Comment, RefPair } from '../src/shared/types'
import type { DatabaseSync } from 'node:sqlite'

const pair: RefPair = {
  base: { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
  compare: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) }
}
const A = 'specs/alpha/spec.md', B = 'specs/beta/spec.md', C = 'specs/gamma/spec.md', D = 'specs/delta/spec.md'

let db: DatabaseSync
let repo: string
let sid: number
beforeEach(() => {
  db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-rart-')), 'db')).db
  repo = makeFixtureRepo().dir
  for (const p of [A, B, C, D]) fixtureWrite(repo, p, `# ${p}\n\nspec body\n`)
  fixtureGit(repo, 'add', '-A')
  fixtureGit(repo, 'commit', '-m', 'specs')
  sid = createSession(db, repo, pair, { engine: 'claude' }).id
})

const artifactComment = (id: string, p: string): Comment => ({
  id, author: 'user', text: 'hm', status: 'queued', replies: [], iteration: 1, createdAt: new Date().toISOString(),
  anchor: { kind: 'artifact', path: p, line: 1, lineContent: `# ${p}` }
})
const load = (changed: string[]) => loadArtifactsFor(db, sid, repo, 'feature', loadReviewState(db, sid), changed)

describe('loadArtifactsFor reconciles the cached rail with the current diff', () => {
  it('a spec that dropped out of the diff (rebase, squash, dropped commit) leaves the rail and the cache', async () => {
    // first load: both specs are in the diff
    expect((await load([A, B])).map((a) => a.path).sort()).toEqual([A, B])
    expect(loadReviewState(db, sid).artifacts.map((a) => a.path).sort()).toEqual([A, B])
    // the branch was rebased; only A is still in the diff
    expect((await load([A])).map((a) => a.path)).toEqual([A])
    expect(loadReviewState(db, sid).artifacts).toEqual([{ role: 'spec', path: A, source: 'detected' }])
  })

  it('a spec that entered the diff since the first load joins the rail', async () => {
    await load([A])
    expect((await load([A, B])).map((a) => a.path).sort()).toEqual([A, B])
  })

  it('agent-reported, approved and commented specs survive even off the diff', async () => {
    setArtifacts(db, sid, [
      { role: 'spec', path: B, source: 'agent' },
      { role: 'spec', path: C },
      { role: 'spec', path: D }
    ])
    approveArtifact(db, sid, C, 'd'.repeat(40))
    upsertComment(db, sid, artifactComment('c1', D))
    const got = (await load([A])).map((a) => a.path).sort()
    expect(got).toEqual([A, B, C, D].sort())
    const cached = loadReviewState(db, sid).artifacts
    expect(cached.find((a) => a.path === B)?.source).toBe('agent')
    expect(cached.find((a) => a.path === A)?.source).toBe('detected')
  })

  it('a transient load never writes the cache', async () => {
    await load([A])
    await loadArtifactsFor(db, sid, repo, 'feature', loadReviewState(db, sid), [A, B], false)
    expect(loadReviewState(db, sid).artifacts.map((a) => a.path)).toEqual([A])
  })
})
