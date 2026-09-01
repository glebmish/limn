import { describe, expect, it } from 'vitest'
import type { Hunk } from '../src/shared/types'
import { hunkGaps } from '../src/renderer/lib/expand'
import { buildFileRows, fnLabel, rowKey } from '../src/renderer/lib/rows'

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

  it('emits no gap rows when expand context is unavailable', () => {
    expect(buildFileRows([h1, h2], []).every((r) => r.type === 'line')).toBe(true)
  })

  it('emits nothing for a file with no hunks', () => {
    expect(buildFileRows([], hunkGaps([]))).toEqual([])
  })
})
