import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixtureRepo'
import { recentCommits, repoRoot, headSha } from '../src/main/git'

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
