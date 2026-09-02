import { describe, expect, it } from 'vitest'
import type { Hunk } from '../src/shared/types'
import { buildMultiRows, multiGaps } from '../src/renderer/lib/rowsMulti'
import type { AlignedRow } from '../src/renderer/lib/rows'

const aligned = (rows: ReturnType<typeof buildMultiRows>) => rows.filter((r): r is AlignedRow => r.type === 'aligned')
// base: l1..l6. checkpoint: replaced l3 with X, added `const y = 1` after l4.
// now: replaced l3 with X, added `const y = 2` after l4, deleted l6.
const mid: Hunk[] = [{ range: '@@ -1,6 +1,7 @@', header: '', lines: [
  { old: 1, new: 1, kind: '', text: 'l1' }, { old: 2, new: 2, kind: '', text: 'l2' },
  { old: 3, new: null, kind: 'del', text: 'l3' }, { old: null, new: 3, kind: 'add', text: 'X' },
  { old: 4, new: 4, kind: '', text: 'l4' }, { old: null, new: 5, kind: 'add', text: 'const y = 1' },
  { old: 5, new: 6, kind: '', text: 'l5' }, { old: 6, new: 7, kind: '', text: 'l6' }
] }]
const now: Hunk[] = [{ range: '@@ -1,6 +1,6 @@', header: '', lines: [
  { old: 1, new: 1, kind: '', text: 'l1' }, { old: 2, new: 2, kind: '', text: 'l2' },
  { old: 3, new: null, kind: 'del', text: 'l3' }, { old: null, new: 3, kind: 'add', text: 'X', since: true },
  { old: 4, new: 4, kind: '', text: 'l4' }, { old: null, new: 5, kind: 'add', text: 'const y = 2', origin: 'unstaged' },
  { old: 5, new: 6, kind: '', text: 'l5' }, { old: 6, new: null, kind: 'del', text: 'l6' }
] }]

describe('buildMultiRows', () => {
  it('aligns on base lines with one cell per column', () => {
    const rows = aligned(buildMultiRows(mid, now, null))
    expect(rows.map((r) => r.key)).toEqual(['old:1', 'old:2', 'old:3', 'new:3', 'old:4', 'new:5', 'old:5', 'old:6'])
    expect(rows[0].cells.map((c) => c.lineNo)).toEqual([1, 1, 1])
    expect(rows[0].cells.map((c) => c.side)).toEqual(['old', 'mid', 'new'])
    expect(rows[6].cells.map((c) => c.lineNo)).toEqual([5, 6, 6]) // mid shifted by its insert, now by its own
  })

  it('a replacement covered by the checkpoint is plain; a divergent insertion is `since`, the checkpoint\'s own is `gone`', () => {
    const rows = aligned(buildMultiRows(mid, now, null))
    const x = rows.find((r) => r.key === 'new:3')!
    expect(x.cells[0]).toMatchObject({ l: null, side: 'old', lineNo: null })
    expect(x.cells[1]).toMatchObject({ l: { text: 'X' }, side: 'mid', lineNo: 3, kind: 'add' })
    expect(x.cells[2]).toMatchObject({ l: { text: 'X' }, side: 'new', lineNo: 3, kind: 'add' })
    expect(x.cells[2].attribution).toBeUndefined()
    expect(x.cells[1].attribution).toBeUndefined()
    const yz = rows.find((r) => r.key === 'new:5')!
    expect(yz.cells[1]).toMatchObject({ l: { text: 'const y = 1' }, attribution: 'gone' })
    expect(yz.cells[2]).toMatchObject({ l: { text: 'const y = 2', origin: 'unstaged' }, attribution: 'since' })
    expect(yz.cells[2].marks).toEqual([{ start: 10, len: 1 }])
    expect(yz.now).toEqual({ run: now[0].lines, idx: 5 })
    expect(yz.anchor).toEqual({ side: 'new', lineNo: 5 })
  })

  it('a base line deleted in one column is an empty deleted slot there', () => {
    const rows = aligned(buildMultiRows(mid, now, null))
    const six = rows.find((r) => r.key === 'old:6')!
    expect(six.cells[0]).toMatchObject({ side: 'old', lineNo: 6, kind: 'del' })
    expect(six.cells[1]).toMatchObject({ side: 'mid', lineNo: 7, kind: '', l: { text: 'l6' } })
    expect(six.cells[2]).toMatchObject({ l: null, deleted: true, attribution: 'since' })
    expect(six.anchor).toEqual({ side: 'old', lineNo: 6 })
    expect(six.now).toBeNull()
    const three = rows.find((r) => r.key === 'old:3')!
    expect(three.cells[0]).toMatchObject({ kind: 'del' })
    expect(three.cells[1]).toMatchObject({ deleted: true })
    expect(three.cells[1].attribution).toBeUndefined()
    expect(three.cells[2]).toMatchObject({ deleted: true })
    expect(three.cells[2].attribution).toBeUndefined()
  })

  it('anchors a kept line on its now number and carries the now run for discard', () => {
    const rows = aligned(buildMultiRows(mid, now, null))
    const four = rows.find((r) => r.key === 'old:4')!
    expect(four.anchor).toEqual({ side: 'new', lineNo: 4 })
    expect(four.now).toEqual({ run: now[0].lines, idx: 4 })
    expect(four.cells[2].l).toMatchObject({ old: 4, new: 4 })
  })

  it('a base line only the checkpoint touched still gets a now cell numbered in now space', () => {
    // mid deletes base 20 inside its own hunk; now never touched that region (one insert at 5)
    const midB: Hunk[] = [{ range: '@@ -18,5 +18,4 @@', header: '', lines: [
      { old: 18, new: 18, kind: '', text: 'p' }, { old: 19, new: 19, kind: '', text: 'q' },
      { old: 20, new: null, kind: 'del', text: 'r' }, { old: 21, new: 20, kind: '', text: 's' }, { old: 22, new: 21, kind: '', text: 't' }
    ] }]
    const nowB: Hunk[] = [{ range: '@@ -4,2 +4,3 @@', header: '', lines: [
      { old: 4, new: 4, kind: '', text: 'a' }, { old: null, new: 5, kind: 'add', text: 'N' }, { old: 5, new: 6, kind: '', text: 'b' }
    ] }]
    const rows = aligned(buildMultiRows(midB, nowB, null))
    const r = rows.find((x) => x.key === 'old:20')!
    expect(r.cells[1]).toMatchObject({ deleted: true, attribution: 'gone' })
    expect(r.cells[2]).toMatchObject({ lineNo: 21, kind: '', l: { text: 'r', new: 21 } })
    // not inside a now hunk: real content, but no anchor payload to hand the pipeline
    expect(r.anchor).toBeNull()
    expect(r.now).toBeNull()
  })

  it('lays gaps between covered segments in now coordinates with both offsets', () => {
    const midB: Hunk[] = [{ range: '@@ -10,3 +10,4 @@', header: '', lines: [
      { old: 10, new: 10, kind: '', text: 'a' }, { old: null, new: 11, kind: 'add', text: 'M' },
      { old: 11, new: 12, kind: '', text: 'b' }, { old: 12, new: 13, kind: '', text: 'c' }
    ] }]
    const nowB: Hunk[] = [{ range: '@@ -30,2 +30,3 @@', header: 'fn g()', lines: [
      { old: 30, new: 30, kind: '', text: 'p' }, { old: null, new: 31, kind: 'add', text: 'N' }, { old: 31, new: 32, kind: '', text: 'q' }
    ] }]
    expect(multiGaps(midB, nowB)).toEqual([
      { key: 'g1', from: 1, to: 9, oldOffset: 0, midOffset: 0 },
      { key: 'g13', from: 13, to: 29, oldOffset: 0, midOffset: -1 },
      { key: 'g33', from: 33, to: null, oldOffset: 1, midOffset: 0 }
    ])
    const rows = buildMultiRows(midB, nowB, null)
    expect(rows.filter((r) => r.type === 'gap').map((r) => r.key)).toEqual(['gap:g1', 'gap:g13', 'gap:g33'])
    expect(rows.filter((r) => r.type === 'gap').map((r) => (r as { fn: string }).fn)).toEqual(['', 'g', ''])
    const seg2 = rows.find((r) => r.type === 'aligned' && r.key === 'old:30') as AlignedRow
    expect(seg2.cells.map((c) => c.lineNo)).toEqual([30, 31, 30]) // mid kept the line, one insertion above it
    expect(buildMultiRows(midB, nowB, null, { trailing: false }).filter((r) => r.type === 'gap').map((r) => r.key)).toEqual(['gap:g1', 'gap:g13'])
  })

  it('insertions at end of file land after the last base line', () => {
    const midE: Hunk[] = []
    const nowE: Hunk[] = [{ range: '@@ -3,1 +3,2 @@', header: '', lines: [
      { old: 3, new: 3, kind: '', text: 'last' }, { old: null, new: 4, kind: 'add', text: 'tail' }
    ] }]
    const rows = aligned(buildMultiRows(midE, nowE, null))
    expect(rows.map((r) => r.key)).toEqual(['old:3', 'new:4'])
    expect(rows[1].cells[2]).toMatchObject({ attribution: 'since', lineNo: 4 })
    expect(rows[1].cells[1]).toMatchObject({ l: null })
  })
})
