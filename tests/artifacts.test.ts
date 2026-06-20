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

  it('prefers spec/plan markdown that is part of the branch diff', async () => {
    fixtureWrite(fx.dir, 'notes/branch-spec.md', '# Branch spec\n\nWritten alongside this change.\n')
    fixtureGit(fx.dir, 'add', '-A')
    fixtureGit(fx.dir, 'commit', '-m', 'spec written on the branch')
    // docs/spec.md mentions the branch (+3, name +2) = 5; the in-diff spec gets +6 +2 = 8
    const found = await detectArtifacts(fx.dir, 'feature', ['notes/branch-spec.md', 'src/a.ts'])
    expect(found.find((a) => a.role === 'spec')?.path).toBe('notes/branch-spec.md')
  })

  it('returns every spec/plan markdown that is part of the branch diff', async () => {
    fixtureWrite(fx.dir, 'docs/feature-a-spec.md', '# Feature A spec\n\nDesign for A.\n')
    fixtureWrite(fx.dir, 'docs/feature-a-plan.md', '# Feature A plan\n\n1. step one\n')
    fixtureWrite(fx.dir, 'docs/feature-b-design.md', '# Feature B design\n\nDesign for B.\n')
    fixtureGit(fx.dir, 'add', '-A')
    fixtureGit(fx.dir, 'commit', '-m', 'multi-feature artifacts on the branch')
    const changed = ['docs/feature-a-spec.md', 'docs/feature-a-plan.md', 'docs/feature-b-design.md', 'src/a.ts']
    const found = await detectArtifacts(fx.dir, 'feature', changed)
    const paths = found.map((a) => a.path)
    // all three in-diff artifacts surface — not just one spec + one plan
    expect(paths).toContain('docs/feature-a-spec.md')
    expect(paths).toContain('docs/feature-a-plan.md')
    expect(paths).toContain('docs/feature-b-design.md')
  })

  it('classifies an artifact as a plan by its plans/ directory even when the filename lacks "plan"', async () => {
    fixtureWrite(fx.dir, 'docs/superpowers/plans/2026-06-19-tool-call-log.md', '# Tool-call log\n\n1. step one\n2. step two\n')
    fixtureGit(fx.dir, 'add', '-A')
    fixtureGit(fx.dir, 'commit', '-m', 'plan living in a plans/ directory')
    const found = await detectArtifacts(fx.dir, 'feature', ['docs/superpowers/plans/2026-06-19-tool-call-log.md'])
    expect(found.find((a) => a.path === 'docs/superpowers/plans/2026-06-19-tool-call-log.md')?.role).toBe('plan')
  })

  it('falls back to the best-per-role heuristic when no artifact is in the diff', async () => {
    // no changedPaths → heuristic mode: one spec (mentions branch), one plan (by name)
    const found = await detectArtifacts(fx.dir, 'feature')
    expect(found.filter((a) => a.role === 'spec')).toHaveLength(1)
    expect(found.filter((a) => a.role === 'plan')).toHaveLength(1)
    expect(found.find((a) => a.role === 'spec')?.path).toBe('docs/spec.md')
  })

  it('loads artifact lines and title', () => {
    const art = loadArtifact(fx.dir, 'docs/spec.md', 'spec')
    expect(art.title).toBe('Rate limiting spec')
    expect(art.lines.length).toBeGreaterThan(3)
    expect(art.lines[0]).toBe('# Rate limiting spec')
  })
})
