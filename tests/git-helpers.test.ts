import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFixtureRepo, fixtureWrite, fixtureGit, type FixtureRepo } from './helpers/fixtureRepo'
import { recentCommits, repoRoot, headSha, driftSummary } from '../src/main/git'

let fx: FixtureRepo
beforeAll(() => { fx = makeFixtureRepo() })
afterAll(() => { fs.rmSync(fx.dir, { recursive: true, force: true }) })

describe('recentCommits', () => {
  it('returns CommitInfo[] newest-first, capped at the limit', async () => {
    const commits = await recentCommits(fx.dir, 'feature', 2)
    expect(commits).toHaveLength(2)
    expect(commits[0].sha).toBe(await headSha(fx.dir, 'feature'))   // newest first
    expect(commits[0].subject).toBe('add c')
    expect(commits[1].subject).toBe('tweak b')
    expect(typeof commits[0].author).toBe('string')
    expect(commits[0].author).toBe('Fixture')
    expect(typeof commits[0].date).toBe('string')
  })

  it('limit larger than history returns the whole branch', async () => {
    const commits = await recentCommits(fx.dir, 'main', 50)
    expect(commits.length).toBeGreaterThanOrEqual(1)
    // oldest (and only) commit of main is the root commit with subject 'base'
    expect(commits[commits.length - 1].subject).toBe('base')
  })
})

describe('repoRoot', () => {
  it('returns the toplevel for a path inside the repo', async () => {
    const sub = path.join(fx.dir, 'src')
    fs.mkdirSync(sub, { recursive: true })
    expect(await repoRoot(sub)).toBe(fs.realpathSync(fx.dir))
  })

  it('returns null outside any git repo', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-notgit-'))
    expect(await repoRoot(tmp)).toBeNull()
  })
})

describe('driftSummary', () => {
  // Each test gets its own fixture so working-tree edits stay isolated. `feature`
  // is the checked-out branch (workdir === dir); shas.firstFeature precedes the
  // two trailing commits (tweak b, add c).
  let dir: string
  let shas: FixtureRepo['shas']
  let head: string
  beforeEach(() => {
    const f = makeFixtureRepo()
    dir = f.dir; shas = f.shas
    head = shas.head
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('counts new commits and the committed line delta since a SHA (clean tree)', async () => {
    // firstFeature → head: tweak b (return 42→43: +1 −1), add c (new file: +1)
    const d = await driftSummary(dir, 'feature', shas.firstFeature, dir)
    expect(d).toEqual({ headSha: head, commits: 2, files: 2, add: 2, del: 1, dirty: false })
  })

  it('reports zero drift when the SHA is the branch head and the tree is clean', async () => {
    const d = await driftSummary(dir, 'feature', head, dir)
    expect(d).toEqual({ headSha: head, commits: 0, files: 0, add: 0, del: 0, dirty: false })
  })

  it('counts uncommitted working-tree edits (dirty flag set) with no new commits', async () => {
    fixtureWrite(dir, 'src/c.ts', 'export const c = 3\nexport const d = 4\n') // +1 line, uncommitted
    const d = await driftSummary(dir, 'feature', head, dir)
    expect(d).toEqual({ headSha: head, commits: 0, files: 1, add: 1, del: 0, dirty: true })
  })

  it('reports dirty for untracked working-tree changes even when numstat is empty', async () => {
    fixtureWrite(dir, 'src/untracked.ts', 'export const u = 1\n')
    const d = await driftSummary(dir, 'feature', head, dir)
    expect(d).toEqual({ headSha: head, commits: 0, files: 0, add: 0, del: 0, dirty: true })
  })

  it('combines committed commits and uncommitted edits since the SHA', async () => {
    fixtureWrite(dir, 'src/a.ts', ['export function a() {', '  return 2', '}', 'export const K = 10', 'export const J = 20', 'export const Z = 99', ''].join('\n')) // +1 uncommitted line on a.ts
    const d = await driftSummary(dir, 'feature', shas.firstFeature, dir)
    expect(d.headSha).toBe(head)
    expect(d.commits).toBe(2)              // tweak b, add c
    expect(d.files).toBe(3)                // a.ts (dirty) + b.ts + c.ts (committed)
    expect(d.add).toBe(3)                  // b.ts +1, c.ts +1, a.ts +1
    expect(d.del).toBe(1)                  // b.ts −1
    expect(d.dirty).toBe(true)             // a.ts is an uncommitted edit
  })

  it('falls back to a committed-only delta (dirty false) when checked out nowhere', async () => {
    // workdir null → no working tree to read; uncommitted edits are invisible.
    fixtureGit(dir, 'checkout', '-q', '--detach') // free the branch from any worktree
    fixtureWrite(dir, 'src/c.ts', 'export const c = 3\nexport const dirty = 1\n') // ignored (no worktree)
    const d = await driftSummary(dir, 'feature', shas.firstFeature, null)
    expect(d).toEqual({ headSha: head, commits: 2, files: 2, add: 2, del: 1, dirty: false })
  })
})
