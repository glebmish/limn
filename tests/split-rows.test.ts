import { describe, expect, it } from 'vitest'
import type { Hunk } from '../src/shared/types'
import { hunkGaps } from '../src/renderer/lib/expand'
import { asAligned, buildFileRows, buildSplitRows, contextRows, viewAlignedRows, type AlignedRow } from '../src/renderer/lib/rows'

// two dels then three adds, inside context
const h: Hunk = {
  range: '@@ -10,4 +10,5 @@', header: 'function f() {', lines: [
    { old: 10, new: 10, kind: '', text: 'ctx' },
    { old: 11, new: null, kind: 'del', text: 'const a = 1' },
    { old: 12, new: null, kind: 'del', text: 'gone' },
    { old: null, new: 11, kind: 'add', text: 'const a = 2' },
    { old: null, new: 12, kind: 'add', text: 'extra' },
    { old: null, new: 13, kind: 'add', text: 'more' },
    { old: 13, new: 14, kind: '', text: 'end' }
  ]
}
const aligned = (rows: ReturnType<typeof buildSplitRows>) => rows.filter((r): r is AlignedRow => r.type === 'aligned')

describe('buildSplitRows', () => {
  it('pairs the del run with the add run row by row and pads the longer run', () => {
    const rows = aligned(buildSplitRows([h], hunkGaps([h]), null))
    expect(rows.map((r) => r.key)).toEqual(['new:10', 'new:11', 'new:12', 'new:13', 'new:14'])
    expect(rows[1].cells.map((c) => c.l?.text)).toEqual(['const a = 1', 'const a = 2'])
    expect(rows[2].cells.map((c) => c.l?.text)).toEqual(['gone', 'extra'])
    expect(rows[3].cells[0]).toMatchObject({ l: null, side: 'old', lineNo: null })
    expect(rows[3].cells[1]).toMatchObject({ lineNo: 13, kind: 'add' })
    expect(rows[1].run).toEqual({ lines: h.lines, idx: 3 })
  })

  it('a pure deletion keys and anchors on the old side; everything else on new', () => {
    const del: Hunk = { range: '@@ -1,2 +1,1 @@', header: '', lines: [
      { old: 1, new: 1, kind: '', text: 'a' }, { old: 2, new: null, kind: 'del', text: 'b' }
    ] }
    const rows = aligned(buildSplitRows([del], hunkGaps([del]), null))
    expect(rows[1].key).toBe('old:2')
    expect(rows[1].anchor).toEqual({ side: 'old', lineNo: 2 })
    expect(rows[0].anchor).toEqual({ side: 'new', lineNo: 1 })
    expect(rows[1].run).toEqual({ lines: del.lines, idx: 1 }) // the deletion's own run, for discard
  })

  it('word-marks a paired del/add per cell', () => {
    const rows = aligned(buildSplitRows([h], hunkGaps([h]), null))
    expect(rows[1].cells[0].marks).toEqual([{ start: 10, len: 1 }])
    expect(rows[1].cells[1].marks).toEqual([{ start: 10, len: 1 }])
    expect(rows[2].cells[0].marks).toBeUndefined() // 'gone' vs 'extra' share nothing
  })

  it('keeps the gap rows, and the unified rows agree with the aligned adapter', () => {
    const uni = buildFileRows([h], hunkGaps([h]), null)
    const a = uni.map((r) => (r.type === 'line' ? asAligned(r) : r))
    expect(a.filter((r) => r.type === 'gap').map((r) => r.key)).toEqual(['gap:g1', 'gap:g15'])
    expect(buildSplitRows([h], hunkGaps([h]), null).filter((r) => r.type === 'gap').map((r) => r.key)).toEqual(['gap:g1', 'gap:g15'])
    const first = a.find((r) => r.type === 'aligned') as AlignedRow
    expect(first.cells).toHaveLength(1)
    expect(first.anchor).toEqual({ side: 'new', lineNo: 10 })
  })

  it('splices revealed lines into gap rows for any layout, uncommentable', () => {
    const rows = buildSplitRows([h], hunkGaps([h]), null)
    const view = viewAlignedRows(rows, { g1: { top: [{ old: 1, new: 1, kind: '', text: 'x' }], bottom: [] } }, 'split', null)
    const r0 = view[0] as AlignedRow
    expect(r0).toMatchObject({ type: 'aligned', key: 'new:1', anchor: null, fromHunk: false })
    expect(r0.cells).toHaveLength(2)
    expect(view[1].type).toBe('gap') // still hidden lines remain
    // fully revealed: the gap row is gone
    const nine = Array.from({ length: 9 }, (_, i) => ({ old: i + 1, new: i + 1, kind: '' as const, text: 'l' }))
    const full = viewAlignedRows(rows, { g1: { top: nine, bottom: [] } }, 'split', null)
    expect(full.filter((r) => r.type === 'gap').map((r) => r.key)).toEqual(['gap:g15'])
    expect(contextRows([{ old: 5, new: 5, kind: '', text: 'c' }], 'multi', null, [1])[0].cells.map((c) => [c.side, c.lineNo]))
      .toEqual([['old', 5], ['mid', 4], ['new', 5]])
  })

  // the split rows used to be matched to their hunk by counting unified line rows and
  // advancing on `runIdx === 0` — so a line the row model drops (one with neither
  // side, which `lineRow` deliberately refuses to key) shifted every later hunk onto
  // the wrong rows. Hunks are now walked directly.
  it('keeps each hunk on its own rows even when a hunk opens with an unaddressable line', () => {
    const first: Hunk = { range: '@@ -1,1 +1,1 @@', header: '', lines: [
      { old: null, new: null, kind: '', text: 'nowhere' }, { old: 1, new: 1, kind: '', text: 'one' }
    ] }
    const second: Hunk = { range: '@@ -20,1 +20,1 @@', header: '', lines: [
      { old: 20, new: 20, kind: '', text: 'twenty' }
    ] }
    const rows = aligned(buildSplitRows([first, second], hunkGaps([first, second]), null))
    expect(rows.map((r) => r.key)).toEqual(['new:1', 'new:20'])
    expect(rows.map((r) => r.hunkRange)).toEqual([first.range, second.range])
  })
})
