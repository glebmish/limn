import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixtureRepo'
import { loadState, saveState, statePath, defaultState, ensureExcluded } from '../src/main/state'

let fx: FixtureRepo
beforeAll(() => {
  fx = makeFixtureRepo()
})

describe('state store', () => {
  it('returns fresh default when absent', () => {
    const st = loadState(fx.dir, 'feature', 'main')
    expect(st.comments).toEqual([])
    expect(st.branch).toBe('feature')
    expect(st.iterations).toEqual([])
  })

  it('roundtrips and slugs branch names', () => {
    const st = defaultState(fx.dir, 'feat/x-1', 'main')
    st.viewedFiles = ['src/a.ts']
    saveState(st)
    const p = statePath(fx.dir, 'feat/x-1')
    expect(p.endsWith('review-feat-x-1.json')).toBe(true)
    expect(fs.existsSync(p)).toBe(true)
    const back = loadState(fx.dir, 'feat/x-1', 'main')
    expect(back.viewedFiles).toEqual(['src/a.ts'])
    // no temp leftovers
    const dir = path.dirname(p)
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([])
  })

  it('ensureExcluded appends once', () => {
    ensureExcluded(fx.dir)
    ensureExcluded(fx.dir)
    const ex = fs.readFileSync(path.join(fx.dir, '.git/info/exclude'), 'utf8')
    expect(ex.match(/\.local-review\//g)?.length).toBe(1)
  })
})
