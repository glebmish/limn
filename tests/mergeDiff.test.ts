import { describe, it, expect } from 'vitest'
import { tagOrigins } from '../src/main/mergeDiff'
import { mergedWorkingDiff } from '../src/main/git'
import { makeFixtureRepo, fixtureWrite } from './helpers/fixtureRepo'
import type { DiffLine, FileDiff } from '../src/shared/types'

/** Build a one-hunk FileDiff from compact line specs. */
function file(path: string, lines: DiffLine[]): FileDiff {
  return {
    path, status: 'modified', binary: false,
    add: lines.filter((l) => l.kind === 'add').length,
    del: lines.filter((l) => l.kind === 'del').length,
    hunks: [{ range: '@@', header: '', lines }]
  }
}
const ctx = (old: number, nw: number, text: string): DiffLine => ({ old, new: nw, kind: '', text })
const add = (nw: number, text: string): DiffLine => ({ old: null, new: nw, kind: 'add', text })
const del = (old: number, text: string): DiffLine => ({ old, new: null, kind: 'del', text })

describe('tagOrigins', () => {
  it('attributes adds and dels to committed vs uncommitted by exact line-number join', () => {
    // base: a,b,c   HEAD: a,B,c (commit changed b->B)   worktree: a,B,X,c (dirty added X)
    const skeleton = file('f.ts', [ctx(1, 1, 'a'), del(2, 'b'), add(2, 'B'), ctx(3, 3, 'c')])
    const volatile = file('f.ts', [ctx(1, 1, 'a'), ctx(2, 2, 'B'), add(3, 'X'), ctx(3, 4, 'c')])
    // base->worktree (what git diff <mergeBase> against the working tree produces)
    const merged = file('f.ts', [ctx(1, 1, 'a'), del(2, 'b'), add(2, 'B'), add(3, 'X'), ctx(3, 4, 'c')])

    tagOrigins([merged], [skeleton], [volatile])

    const byText = Object.fromEntries(merged.hunks[0].lines.map((l) => [l.text + (l.kind || 'ctx'), l.origin]))
    expect(byText['badel']).toBe(undefined)      // 'a' is context — no origin
    expect(byText['bdel']).toBe('committed')      // 'b' removed by the commit
    expect(byText['Badd']).toBe('committed')      // 'B' added by the commit
    expect(byText['Xadd']).toBe('uncommitted')    // 'X' added in the working tree
    expect(byText['cctx']).toBe(undefined)        // context — no origin
  })

  it('a base line deleted only in the working tree is an uncommitted deletion', () => {
    // base: a,b,c   HEAD: a,b,c (no commit change)   worktree: a,c (dirty deleted b)
    const skeleton = file('f.ts', []) // nothing committed
    const volatile = file('f.ts', [ctx(1, 1, 'a'), del(2, 'b'), ctx(3, 2, 'c')])
    const merged = file('f.ts', [ctx(1, 1, 'a'), del(2, 'b'), ctx(3, 2, 'c')])

    tagOrigins([merged], [skeleton], [volatile])

    expect(merged.hunks[0].lines.find((l) => l.kind === 'del')!.origin).toBe('uncommitted')
  })

  it('an untracked file with no committed counterpart is all uncommitted', () => {
    const volatile = file('new.ts', [add(1, 'x'), add(2, 'y')])
    const merged = file('new.ts', [add(1, 'x'), add(2, 'y')])

    tagOrigins([merged], [], [volatile])

    expect(merged.hunks[0].lines.every((l) => l.origin === 'uncommitted')).toBe(true)
  })
})

describe('mergedWorkingDiff (base→working-tree, origin-tagged)', () => {
  it('interleaves committed and uncommitted lines with exact attribution', async () => {
    const fx = makeFixtureRepo() // on feature; b.ts committed as return 43
    // dirty edit: bump return 43 -> 44 and add a brand-new line
    fixtureWrite(fx.dir, 'src/b.ts', ['export function b() {', '  return 44', '}', 'export const extra = 1', ''].join('\n'))

    const files = await mergedWorkingDiff(fx.dir, 'main', 'feature')
    const b = files.find((f) => f.path === 'src/b.ts')!
    const lines = b.hunks.flatMap((h) => h.lines)

    // b.ts is wholly new on the branch (added in a commit), so the committed body
    // lines are 'committed' and the dirty edits are 'uncommitted'.
    const committed = lines.filter((l) => l.origin === 'committed').map((l) => l.text)
    const uncommitted = lines.filter((l) => l.origin === 'uncommitted').map((l) => l.text)
    expect(committed).toContain('export function b() {')
    expect(uncommitted).toContain('  return 44')
    expect(uncommitted).toContain('export const extra = 1')
    expect(committed).not.toContain('  return 44')
  })
})
