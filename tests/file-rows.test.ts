import { describe, expect, it } from 'vitest'
import type { Hunk } from '../src/shared/types'
import { hunkGaps } from '../src/renderer/lib/expand'
import { buildFileRows, fnLabel, lineRow, rowKey } from '../src/renderer/lib/rows'

// @@ -12,4 +12,5 @@ : one add at new 14
const h1: Hunk = {
  range: '@@ -12,4 +12,5 @@', header: 'export function updateSessionMeta(meta: Meta) {', lines: [
    { old: 12, new: 12, kind: '', text: 'a' },
    { old: 13, new: 13, kind: '', text: 'b' },
    { old: null, new: 14, kind: 'add', text: 'NEW' },
    { old: 14, new: 15, kind: '', text: 'c' },
    { old: 15, new: 16, kind: '', text: 'd' }
  ]
}
// @@ -30,3 +31,3 @@ : pure replace at 32
const h2: Hunk = {
  range: '@@ -30,3 +31,3 @@', header: 'class Session {', lines: [
    { old: 30, new: 31, kind: '', text: 'const a = 1' },
    { old: 31, new: null, kind: 'del', text: 'const b = 1' },
    { old: null, new: 32, kind: 'add', text: 'const b = 2' },
    { old: 32, new: 33, kind: '', text: 'f' }
  ]
}

describe('rowKey', () => {
  it('keys working-tree rows on the new side and deletions on the old side', () => {
    expect(rowKey({ old: 12, new: 12, kind: '', text: 'a' })).toBe('new:12')
    expect(rowKey({ old: null, new: 14, kind: 'add', text: 'x' })).toBe('new:14')
    expect(rowKey({ old: 31, new: null, kind: 'del', text: 'y' })).toBe('old:31')
  })

  it('never collides between a deletion and a working-tree row of the same number', () => {
    expect(rowKey({ old: 31, new: null, kind: 'del', text: 'y' }))
      .not.toBe(rowKey({ old: 20, new: 31, kind: '', text: 'z' }))
  })

  // a line with neither side has no address; keying it `old:undefined` would emit a
  // `data-limn-line` target the focus/anchor machinery could resolve to the wrong row
  it('has no key for a line with neither side, and such a row is dropped', () => {
    const sideless = { old: null, new: null, kind: '' as const, text: 'nowhere' }
    expect(rowKey(sideless)).toBeNull()
    expect(lineRow([sideless], 0, { hunkRange: '@@', fromHunk: true })).toBeNull()
    const h: Hunk = { range: '@@ -1,1 +1,1 @@', header: '', lines: [
      { old: 1, new: 1, kind: '', text: 'a' }, sideless
    ] }
    const built = buildFileRows([h], [])
    expect(built.map((r) => r.key)).toEqual(['new:1'])
    expect(built.every((r) => !String(r.key).includes('undefined'))).toBe(true)
  })
})

describe('fnLabel', () => {
  it('names the function from a git hunk context', () => {
    expect(fnLabel('export function updateSessionMeta(meta: Meta) {')).toBe('updateSessionMeta')
    expect(fnLabel('  async doThing(x: number): Promise<void> {')).toBe('doThing')
    expect(fnLabel('def parse(self, raw):')).toBe('parse')
  })

  it('names a type declaration when there is no call-shaped name', () => {
    expect(fnLabel('class Session {')).toBe('Session')
    expect(fnLabel('export interface FileDiff {')).toBe('FileDiff')
  })

  it('returns nothing for empty or control-flow context', () => {
    expect(fnLabel('')).toBe('')
    expect(fnLabel('   ')).toBe('')
    expect(fnLabel('if (cond) {')).toBe('')
    expect(fnLabel('} else {')).toBe('')
  })
})

describe('buildFileRows', () => {
  const rows = buildFileRows([h1, h2], hunkGaps([h1, h2]))

  it('produces ONE continuous row list: gap, hunk rows, gap, hunk rows, trailing gap', () => {
    expect(rows.map((r) => r.type)).toEqual([
      'gap', 'line', 'line', 'line', 'line', 'line',
      'gap', 'line', 'line', 'line', 'line',
      'gap'
    ])
  })

  it('keys every row on its file line, in one flat key space', () => {
    expect(rows.map((r) => r.key)).toEqual([
      'gap:g1', 'new:12', 'new:13', 'new:14', 'new:15', 'new:16',
      'gap:g17', 'new:31', 'old:31', 'new:32', 'new:33',
      'gap:g34'
    ])
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })

  it('labels the leading and trailing gaps, and names the function the run leads into', () => {
    const gaps = rows.filter((r) => r.type === 'gap')
    expect(gaps.map((g) => (g.type === 'gap' ? g.where : ''))).toEqual(['above', '', 'below'])
    // the gap before h1/h2 is labelled from the hunk it leads into; the trailing gap
    // has no following hunk, so no label
    expect(gaps.map((g) => (g.type === 'gap' ? g.fn : ''))).toEqual(['updateSessionMeta', 'Session', ''])
  })

  it('carries each row hunk range for the comment anchor, but never renders it', () => {
    const line = rows.find((r) => r.type === 'line' && r.key === 'new:32')
    expect(line?.type === 'line' && line.hunkRange).toBe('@@ -30,3 +31,3 @@')
  })

  it('word-marks the del/add pair within a hunk', () => {
    const del = rows.find((r) => r.type === 'line' && r.key === 'old:31')
    const add = rows.find((r) => r.type === 'line' && r.key === 'new:32')
    expect(del?.type === 'line' && del.marks?.length).toBeTruthy()
    expect(add?.type === 'line' && add.marks?.length).toBeTruthy()
    // unchanged neighbours carry none
    const ctx = rows.find((r) => r.type === 'line' && r.key === 'new:31')
    expect(ctx?.type === 'line' && ctx.marks).toBeUndefined()
  })

  it('gives each row its own hunk run for discard spans / sliver lookups', () => {
    const add = rows.find((r) => r.type === 'line' && r.key === 'new:32')
    expect(add?.type === 'line' && add.run).toBe(h2.lines)
    expect(add?.type === 'line' && add.runIdx).toBe(2)
  })

  it('emits no gap rows when given no gaps (a binary file — the only caller case)', () => {
    expect(buildFileRows([h1, h2], []).every((r) => r.type === 'line')).toBe(true)
  })

  it('emits nothing for a file with no hunks', () => {
    expect(buildFileRows([], hunkGaps([]))).toEqual([])
  })
})

// #7: cross-line-aware highlighting wired through the row model — the tokenizer
// correctness itself is pinned in tests/highlight.test.ts; this covers that
// buildFileRows/linesForRun actually threads `lang` through to each row's `html`,
// on the correct side (old-side pass for a deletion, new-side pass for everything
// else), rather than the tokenizer logic itself.
describe('buildFileRows / linesForRun highlighting (#7)', () => {
  it('attaches highlighted html per row when a language is given', () => {
    const rows = buildFileRows([h1], hunkGaps([h1]), 'typescript')
    const add = rows.find((r) => r.type === 'line' && r.key === 'new:14')
    expect(add?.type === 'line' && add.html).toContain('hljs-variable')
  })

  it('keeps a block comment spanning two lines of the same hunk comment-styled on both', () => {
    const h: Hunk = {
      range: '@@ -1,4 +1,5 @@', header: '', lines: [
        { old: 1, new: 1, kind: '', text: 'const x = 1' },
        { old: null, new: 2, kind: 'add', text: '/** Parse a persisted JSON blob' },
        { old: null, new: 3, kind: 'add', text: ' * never returns null' },
        { old: 2, new: 4, kind: '', text: ' */' },
        { old: 3, new: 5, kind: '', text: 'function f() {}' }
      ]
    }
    const rows = buildFileRows([h], [], 'typescript')
    const line2 = rows.find((r) => r.type === 'line' && r.key === 'new:2')
    const line3 = rows.find((r) => r.type === 'line' && r.key === 'new:3')
    expect(line2?.type === 'line' && line2.html).toContain('hljs-comment')
    expect(line3?.type === 'line' && line3.html).toContain('hljs-comment')
    expect(line3?.type === 'line' && line3.html).not.toContain('hljs-built_in')
  })

  it('highlights a deletion from the old-side pass (the pre-change text)', () => {
    const rows = buildFileRows([h2], hunkGaps([h2]), 'typescript')
    const del = rows.find((r) => r.type === 'line' && r.key === 'old:31')
    expect(del?.type === 'line' && del.side).toBe('old')
    expect(del?.type === 'line' && del.html).toContain('hljs-number')
  })

  it('falls back to escaped plain text (no hljs classes) with no language', () => {
    const rows = buildFileRows([h1], hunkGaps([h1]))
    const add = rows.find((r) => r.type === 'line' && r.key === 'new:14')
    expect(add?.type === 'line' && add.html).toBe('NEW')
    expect(add?.type === 'line' && add.html).not.toContain('hljs-')
  })
})
