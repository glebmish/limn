import { describe, it, expect } from 'vitest'
import { tagOrigins } from '../src/main/mergeDiff'
import { mergedWorkingDiff, parseUnifiedDiff } from '../src/main/git'
import { makeFixtureRepo, fixtureWrite } from './helpers/fixtureRepo'
import { execGit } from '../src/main/exec'
import type { DiffLine, FileDiff } from '../src/shared/types'

/** Build a one-hunk FileDiff from compact line specs. */
function file(path: string, lines: DiffLine[], extra: Partial<FileDiff> = {}): FileDiff {
  return {
    path, status: 'modified', binary: false,
    add: lines.filter((l) => l.kind === 'add').length,
    del: lines.filter((l) => l.kind === 'del').length,
    hunks: [{ range: '@@', header: '', lines }],
    ...extra
  }
}
const ctx = (old: number, nw: number, text: string): DiffLine => ({ old, new: nw, kind: '', text })
const add = (nw: number, text: string): DiffLine => ({ old: null, new: nw, kind: 'add', text })
const del = (old: number, text: string): DiffLine => ({ old, new: null, kind: 'del', text })

describe('tagOrigins', () => {
  it('splits committed / staged / unstaged adds by line-number join', () => {
    // base: a,c   HEAD: a,B,c (commit added B)   index: a,B,S,c (staged add S)
    // worktree: a,B,S,U,c (further unstaged add U)
    const skeleton = file('f.ts', [ctx(1, 1, 'a'), add(2, 'B'), ctx(2, 3, 'c')])
    // volatile = HEAD->worktree: both S and U are uncommitted adds
    const volatile = file('f.ts', [ctx(1, 1, 'a'), ctx(2, 2, 'B'), add(3, 'S'), add(4, 'U'), ctx(3, 5, 'c')])
    // unstaged = index->worktree: only U is new vs the index (worktree new-number 4)
    const unstaged = file('f.ts', [ctx(1, 1, 'a'), ctx(2, 2, 'B'), ctx(3, 3, 'S'), add(4, 'U'), ctx(4, 5, 'c')])
    // merged = base->worktree
    const merged = file('f.ts', [ctx(1, 1, 'a'), add(2, 'B'), add(3, 'S'), add(4, 'U'), ctx(3, 5, 'c')])

    tagOrigins([merged], [skeleton], [volatile], [unstaged], [])

    const byText = Object.fromEntries(merged.hunks[0].lines.filter((l) => l.kind === 'add').map((l) => [l.text, l.origin]))
    expect(byText['B']).toBe('committed')   // added by the commit
    expect(byText['S']).toBe('staged')      // in the index, not yet committed
    expect(byText['U']).toBe('unstaged')    // working-tree only
  })

  it('a base line deleted only in the working tree is an unstaged deletion', () => {
    // base: a,b,c   HEAD: a,b,c (no commit change)   worktree: a,c (unstaged delete b)
    const skeleton = file('f.ts', [])
    const volatile = file('f.ts', [ctx(1, 1, 'a'), del(2, 'b'), ctx(3, 2, 'c')])
    const unstaged = file('f.ts', [ctx(1, 1, 'a'), del(2, 'b'), ctx(3, 2, 'c')])
    const merged = file('f.ts', [ctx(1, 1, 'a'), del(2, 'b'), ctx(3, 2, 'c')])

    tagOrigins([merged], [skeleton], [volatile], [unstaged], [])

    expect(merged.hunks[0].lines.find((l) => l.kind === 'del')!.origin).toBe('unstaged')
  })

  it('a deletion staged in the index reads as staged', () => {
    // base/HEAD: a,b,c   index: a,c (staged delete b)   worktree: a,c
    const skeleton = file('f.ts', [])
    const volatile = file('f.ts', [ctx(1, 1, 'a'), del(2, 'b'), ctx(3, 2, 'c')])
    const unstaged = file('f.ts', []) // index == worktree, nothing unstaged
    const staged = file('f.ts', [ctx(1, 1, 'a'), del(2, 'b'), ctx(3, 2, 'c')])
    const merged = file('f.ts', [ctx(1, 1, 'a'), del(2, 'b'), ctx(3, 2, 'c')])

    tagOrigins([merged], [skeleton], [volatile], [unstaged], [staged])

    expect(merged.hunks[0].lines.find((l) => l.kind === 'del')!.origin).toBe('staged')
  })

  it('an untracked file is all unstaged regardless of the index pivots', () => {
    const volatile = file('new.ts', [add(1, 'x'), add(2, 'y')])
    const merged = file('new.ts', [add(1, 'x'), add(2, 'y')], { untracked: true })

    tagOrigins([merged], [], [volatile], [], [])

    expect(merged.hunks[0].lines.every((l) => l.origin === 'unstaged')).toBe(true)
  })
})

describe('parseUnifiedDiff mode-only change', () => {
  it('captures the old→new mode of a chmod with no content hunks', () => {
    const raw = ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755'].join('\n')
    const files = parseUnifiedDiff(raw)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('run.sh')
    expect(files[0].modeChange).toEqual({ from: '100644', to: '100755' })
    expect(files[0].hunks).toHaveLength(0)
  })
})

describe('mergedWorkingDiff (base→working-tree, origin-tagged)', () => {
  it('attributes committed vs unstaged lines from a plain on-disk edit', async () => {
    const fx = makeFixtureRepo() // on feature; b.ts committed as return 43
    // dirty edit (not staged): bump return 43 -> 44 and add a brand-new line
    fixtureWrite(fx.dir, 'src/b.ts', ['export function b() {', '  return 44', '}', 'export const extra = 1', ''].join('\n'))

    const files = await mergedWorkingDiff(fx.dir, 'main', 'feature')
    const b = files.find((f) => f.path === 'src/b.ts')!
    const lines = b.hunks.flatMap((h) => h.lines)

    const committed = lines.filter((l) => l.origin === 'committed').map((l) => l.text)
    const unstaged = lines.filter((l) => l.origin === 'unstaged').map((l) => l.text)
    expect(committed).toContain('export function b() {')
    expect(unstaged).toContain('  return 44')
    expect(unstaged).toContain('export const extra = 1')
    expect(committed).not.toContain('  return 44')
  })

  it('separates a staged edit from a later unstaged edit in the same file', async () => {
    const fx = makeFixtureRepo()
    // stage one new line, then add another unstaged line on top of it
    fixtureWrite(fx.dir, 'src/b.ts', ['export function b() {', '  return 43', '}', 'export const staged = 1', ''].join('\n'))
    await execGit(fx.dir, ['add', 'src/b.ts'])
    fixtureWrite(fx.dir, 'src/b.ts', ['export function b() {', '  return 43', '}', 'export const staged = 1', 'export const loose = 2', ''].join('\n'))

    const files = await mergedWorkingDiff(fx.dir, 'main', 'feature')
    const b = files.find((f) => f.path === 'src/b.ts')!
    const lines = b.hunks.flatMap((h) => h.lines)
    const origin = (text: string) => lines.find((l) => l.text === text)?.origin

    expect(origin('export const staged = 1')).toBe('staged')
    expect(origin('export const loose = 2')).toBe('unstaged')
  })
})
