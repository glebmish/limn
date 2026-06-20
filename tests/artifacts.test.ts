import { describe, it, expect, beforeAll } from 'vitest'
import { makeFixtureRepo, fixtureWrite, fixtureGit, type FixtureRepo } from './helpers/fixtureRepo'
import { detectArtifacts, loadArtifact, classify } from '../src/main/artifacts'

let fx: FixtureRepo
beforeAll(() => {
  fx = makeFixtureRepo()
  // recognized-format artifacts living in their conventional locations
  fixtureWrite(fx.dir, 'docs/superpowers/specs/2026-06-20-feature-design.md', '# Feature spec\n\nGoal: protect the API on branch feature.\n')
  fixtureWrite(fx.dir, 'docs/superpowers/plans/2026-06-20-feature.md', '# Feature plan\n\n1. step one\n2. step two\n')
  fixtureWrite(fx.dir, 'specs/012-auth/spec.md', '# Auth spec\n\nSpec Kit spec.\n')
  fixtureWrite(fx.dir, 'specs/012-auth/plan.md', '# Auth plan\n\nSpec Kit plan.\n')
  fixtureWrite(fx.dir, 'specs/012-auth/tasks.md', '# Auth tasks\n\n- [ ] task one\n')
  fixtureWrite(fx.dir, 'specs/012-auth/research.md', '# Auth research\n\nSupporting doc, not an artifact.\n')
  // decoys that must NOT be recognized — right words, wrong location
  fixtureWrite(fx.dir, 'docs/spec.md', '# A spec-ish note on branch feature\n\nNot in a recognized format.\n')
  fixtureWrite(fx.dir, 'docs/plan.md', '# A plan-ish note\n\nNot in a recognized format.\n')
  fixtureGit(fx.dir, 'add', '-A')
  fixtureGit(fx.dir, 'commit', '-m', 'artifacts + decoys')
})

describe('classify', () => {
  it('recognizes superpowers spec/plan by directory', () => {
    expect(classify('docs/superpowers/specs/2026-06-20-x-design.md')).toEqual({ role: 'spec', format: 'superpowers' })
    expect(classify('docs/superpowers/plans/2026-06-20-x.md')).toEqual({ role: 'plan', format: 'superpowers' })
  })

  it('recognizes Spec Kit spec/plan/tasks, folding tasks into plan', () => {
    expect(classify('specs/012-auth/spec.md')).toEqual({ role: 'spec', format: 'sdd' })
    expect(classify('specs/012-auth/plan.md')).toEqual({ role: 'plan', format: 'sdd' })
    expect(classify('specs/012-auth/tasks.md')).toEqual({ role: 'plan', format: 'sdd' })
  })

  it('rejects files outside any recognized convention', () => {
    expect(classify('docs/spec.md')).toBeNull()
    expect(classify('docs/plan.md')).toBeNull()
    expect(classify('specs/012-auth/research.md')).toBeNull()
    expect(classify('README.md')).toBeNull()
  })
})

describe('detectArtifacts', () => {
  it('surfaces every recognized artifact in the branch diff, with its format', async () => {
    const changed = [
      'docs/superpowers/specs/2026-06-20-feature-design.md',
      'docs/superpowers/plans/2026-06-20-feature.md',
      'specs/012-auth/spec.md',
      'specs/012-auth/tasks.md',
      'docs/spec.md',      // decoy — must be dropped
      'src/a.ts'
    ]
    const found = await detectArtifacts(fx.dir, 'feature', changed)
    const paths = found.map((a) => a.path)
    expect(paths).toContain('docs/superpowers/specs/2026-06-20-feature-design.md')
    expect(paths).toContain('docs/superpowers/plans/2026-06-20-feature.md')
    expect(paths).toContain('specs/012-auth/spec.md')
    expect(paths).toContain('specs/012-auth/tasks.md')
    // decoys and non-markdown never surface
    expect(paths).not.toContain('docs/spec.md')
    expect(paths).not.toContain('src/a.ts')
    // formats are attached
    expect(found.find((a) => a.path === 'specs/012-auth/tasks.md')).toMatchObject({ role: 'plan', format: 'sdd' })
    expect(found.find((a) => a.path.includes('superpowers/specs'))).toMatchObject({ role: 'spec', format: 'superpowers' })
  })

  it('falls back to best-per-role when nothing recognized is in the diff', async () => {
    const found = await detectArtifacts(fx.dir, 'feature')
    expect(found.filter((a) => a.role === 'spec').length).toBe(1)
    expect(found.filter((a) => a.role === 'plan').length).toBe(1)
    // every returned ref is a recognized artifact, never a decoy
    for (const a of found) expect(classify(a.path)).not.toBeNull()
  })

  it('never surfaces a decoy even when only non-artifacts changed', async () => {
    // src/a.ts is the only change and is not an artifact; the no-diff fallback
    // may surface a recognized artifact, but never a decoy or a non-artifact
    const found = await detectArtifacts(fx.dir, 'feature', ['src/a.ts'])
    for (const a of found) expect(classify(a.path)).not.toBeNull()
    expect(found.map((a) => a.path)).not.toContain('docs/spec.md')
  })
})

describe('loadArtifact', () => {
  it('loads lines, title, and derives the format from the path', () => {
    const art = loadArtifact(fx.dir, 'specs/012-auth/plan.md', 'plan')
    expect(art.title).toBe('Auth plan')
    expect(art.format).toBe('sdd')
    expect(art.role).toBe('plan')
    expect(art.lines[0]).toBe('# Auth plan')
  })
})
