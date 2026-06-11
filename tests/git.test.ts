import { describe, it, expect, beforeAll } from 'vitest'
import { makeFixtureRepo, type FixtureRepo, fixtureWrite } from './helpers/fixtureRepo'
import {
  listBranches, currentBranch, defaultBase, mergeBase, headSha, isDirty, log,
  getDiff, diffSince, markSince
} from '../src/main/git'

let fx: FixtureRepo

beforeAll(() => {
  fx = makeFixtureRepo()
})

describe('branches & metadata', () => {
  it('lists branches and current', async () => {
    const branches = await listBranches(fx.dir)
    expect(branches).toContain('main')
    expect(branches).toContain('feature')
    expect(await currentBranch(fx.dir)).toBe('feature')
  })

  it('default base prefers main', async () => {
    expect(await defaultBase(fx.dir)).toBe('main')
  })

  it('merge base of main..feature is the base commit', async () => {
    expect(await mergeBase(fx.dir, 'main', 'feature')).toBe(fx.shas.base)
  })

  it('headSha and isDirty', async () => {
    expect(await headSha(fx.dir, 'feature')).toBe(fx.shas.head)
    expect(await isDirty(fx.dir)).toBe(false)
    fixtureWrite(fx.dir, 'dirty.txt', 'x')
    expect(await isDirty(fx.dir)).toBe(true)
    const fs = await import('node:fs')
    fs.rmSync(`${fx.dir}/dirty.txt`)
  })

  it('log lists feature commits newest-first', async () => {
    const commits = await log(fx.dir, 'main', 'feature')
    expect(commits.length).toBe(3)
    expect(commits[0].sha).toBe(fx.shas.head)
    expect(commits[2].subject).toBe('feature work')
  })
})

describe('getDiff skeleton', () => {
  it('captures statuses, counts, hunks', async () => {
    const sk = await getDiff(fx.dir, 'main', 'feature')
    expect(sk.mergeBase).toBe(fx.shas.base)
    expect(sk.headSha).toBe(fx.shas.head)

    const byPath = Object.fromEntries(sk.files.map((f) => [f.path, f]))

    expect(byPath['src/a.ts'].status).toBe('modified')
    expect(byPath['src/b.ts'].status).toBe('added')
    expect(byPath['src/old.ts'].status).toBe('deleted')
    expect(byPath['src/moved.ts'].status).toBe('renamed')
    expect(byPath['src/moved.ts'].oldPath).toBe('src/moveme.ts')
    expect(byPath['img.bin'].binary).toBe(true)
    expect(byPath['img.bin'].hunks.length).toBe(0)

    // counts match numstat
    expect(byPath['src/a.ts'].add).toBe(2)
    expect(byPath['src/a.ts'].del).toBe(1)
    expect(byPath['src/c.ts'].add).toBe(1)
  })

  it('line numbering walks old/new counters correctly', async () => {
    const sk = await getDiff(fx.dir, 'main', 'feature')
    const a = sk.files.find((f) => f.path === 'src/a.ts')!
    expect(a.hunks.length).toBe(1)
    const lines = a.hunks[0].lines
    // unified diff of a.ts: context "export function a() {", del "  return 1",
    // add "  return 2", context "}", context "export const K = 10", add "export const J = 20"
    expect(lines.map((l) => [l.old, l.new, l.kind, l.text])).toEqual([
      [1, 1, '', 'export function a() {'],
      [2, null, 'del', '  return 1'],
      [null, 2, 'add', '  return 2'],
      [3, 3, '', '}'],
      [4, 4, '', 'export const K = 10'],
      [null, 5, 'add', 'export const J = 20']
    ])
  })

  it('handles no-newline marker without phantom lines', async () => {
    const sk = await getDiff(fx.dir, 'main', 'feature')
    const f = sk.files.find((x) => x.path === 'noeol.txt')!
    const texts = f.hunks.flatMap((h) => h.lines.map((l) => l.text))
    expect(texts).toEqual(['no newline at end', 'still no newline at end'])
    expect(texts.some((t) => t.includes('No newline'))).toBe(false)
  })
})

describe('since tagging', () => {
  it('tags only hunks changed after the given sha', async () => {
    const full = await getDiff(fx.dir, 'main', 'feature')
    const since = await diffSince(fx.dir, fx.shas.firstFeature, 'feature')
    markSince(full, since)

    // b.ts changed after firstFeature → tagged; a.ts untouched after → not tagged
    const b = full.files.find((f) => f.path === 'src/b.ts')!
    const a = full.files.find((f) => f.path === 'src/a.ts')!
    const c = full.files.find((f) => f.path === 'src/c.ts')!
    expect(b.hunks.some((h) => h.since)).toBe(true)
    expect(a.hunks.some((h) => h.since)).toBe(false)
    expect(c.hunks.every((h) => h.since)).toBe(true)

    // tagged add-lines inside b are the ones present in the since diff
    const taggedTexts = b.hunks.flatMap((h) => h.lines.filter((l) => l.since).map((l) => l.text))
    expect(taggedTexts).toContain('  return 43')
    expect(taggedTexts).not.toContain('export function b() {')
  })
})
