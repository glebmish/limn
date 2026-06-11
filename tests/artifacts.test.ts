import { describe, it, expect, beforeAll } from 'vitest'
import { makeFixtureRepo, fixtureWrite, fixtureGit, type FixtureRepo } from './helpers/fixtureRepo'
import { detectArtifacts, loadArtifact } from '../src/main/artifacts'

let fx: FixtureRepo
beforeAll(() => {
  fx = makeFixtureRepo()
})

describe('artifacts', () => {
  it('detects spec doc mentioning the branch', async () => {
    const found = await detectArtifacts(fx.dir, 'feature')
    const spec = found.find((a) => a.role === 'spec')
    expect(spec?.path).toBe('docs/spec.md')
  })

  it('classifies plan docs by filename', async () => {
    fixtureWrite(fx.dir, 'docs/plan.md', '# Plan for feature\n\n1. step one\n2. step two\n')
    fixtureGit(fx.dir, 'add', '-A')
    fixtureGit(fx.dir, 'commit', '-m', 'plan doc')
    const found = await detectArtifacts(fx.dir, 'feature')
    expect(found.find((a) => a.role === 'plan')?.path).toBe('docs/plan.md')
    expect(found.find((a) => a.role === 'spec')?.path).toBe('docs/spec.md')
  })

  it('loads artifact lines and title', () => {
    const art = loadArtifact(fx.dir, 'docs/spec.md', 'spec')
    expect(art.title).toBe('Rate limiting spec')
    expect(art.lines.length).toBeGreaterThan(3)
    expect(art.lines[0]).toBe('# Rate limiting spec')
  })
})
