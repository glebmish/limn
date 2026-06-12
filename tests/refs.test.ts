import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixtureRepo'
import { resolveRefInput, describeSide, headSha } from '../src/main/git'

let fx: FixtureRepo
beforeAll(() => { fx = makeFixtureRepo() })
afterAll(() => { fs.rmSync(fx.dir, { recursive: true, force: true }) })

describe('resolveRefInput', () => {
  it('resolves a branch name to kind=branch with tip sha', async () => {
    const r = await resolveRefInput(fx.dir, 'main')
    expect(r.kind).toBe('branch')
    expect(r.symbol).toBe('main')
    expect(r.sha).toBe(await headSha(fx.dir, 'main'))
  })

  it('resolves HEAD~1 to kind=commit with the parent sha', async () => {
    // fixture leaves feature checked out; HEAD~1 is the second-to-last feature commit
    const r = await resolveRefInput(fx.dir, 'HEAD~1')
    expect(r.kind).toBe('commit')
    expect(r.sha).toBe(await headSha(fx.dir, 'HEAD~1'))
    expect(r.symbol).toBe('HEAD~1')
  })

  it('resolves a full sha to kind=commit', async () => {
    const sha = await headSha(fx.dir, 'HEAD')
    const r = await resolveRefInput(fx.dir, sha)
    expect(r.kind).toBe('commit')
    expect(r.sha).toBe(sha)
  })

  it('rejects garbage with a friendly error', async () => {
    await expect(resolveRefInput(fx.dir, 'no-such-thing-xyz')).rejects.toThrow(/not a branch or commit/)
  })
})

describe('describeSide', () => {
  it('branch side at tip: plain tip label', async () => {
    // main has 1 commit; anchor = its tip sha → no drift
    const tip = await headSha(fx.dir, 'main')
    const text = await describeSide(fx.dir, { kind: 'branch', symbol: 'main', anchorSha: tip })
    expect(text).toBe('main — branch tip')
  })

  it('branch side with drift: shows anchor and +N since', async () => {
    // fixture leaves feature checked out; feature has 3 commits above base
    // anchor = feature~1 (one behind tip) → drift = 1
    const anchor = await headSha(fx.dir, 'feature~1')
    const text = await describeSide(fx.dir, { kind: 'branch', symbol: 'feature', anchorSha: anchor })
    expect(text).toMatch(/^feature — branch tip, follows new commits \(anchor [0-9a-f]{7}, \+1 since\)$/)
  })

  it('commit side: subject plus branch-relative position', async () => {
    // HEAD~1 on feature is "tweak b", 1 behind feature tip
    // describeSide prefers the current branch (feature) among containing branches
    const sha = await headSha(fx.dir, 'feature~1')
    const text = await describeSide(fx.dir, { kind: 'commit', symbol: 'feature~1', anchorSha: sha })
    expect(text).toMatch(/^[0-9a-f]{7} ".+" — on \S+, 1 behind tip$/)
  })

  it('commit side at branch tip: says at tip, not 0 behind', async () => {
    const sha = await headSha(fx.dir, 'feature')
    const text = await describeSide(fx.dir, { kind: 'commit', symbol: sha, anchorSha: sha })
    expect(text).toMatch(/^[0-9a-f]{7} ".+" — on feature, at tip$/)
  })
})
