import { describe, expect, it } from 'vitest'
import type { Hunk } from '../src/shared/types'
import { hunkGaps } from '../src/renderer/lib/expand'
import { buildFileRows, asAligned, viewAlignedRows } from '../src/renderer/lib/rows'
import { FOLD_ROW_PX, LINE_ROW_PX, THREAD_PX, estimateDiffHeight } from '../src/renderer/lib/diffHeight'

const hunk = (start: number, n: number): Hunk => ({
  range: `@@ -${start},${n} +${start},${n} @@`, header: '',
  lines: Array.from({ length: n }, (_, i) => ({ old: null, new: start + i, kind: 'add' as const, text: `l${i}` }))
})

const viewOf = (hunks: Hunk[]) =>
  viewAlignedRows(buildFileRows(hunks, hunkGaps(hunks), null).map((r) => (r.type === 'gap' ? r : asAligned(r))), {}, 'unified', null)

describe('estimateDiffHeight', () => {
  // a hunk always trails a fold to EOF, so expectations count the view's own rows
  const expected = (view: ReturnType<typeof viewOf>) => {
    const folds = view.filter((r) => r.type === 'gap').length
    return Math.round((view.length - folds) * LINE_ROW_PX + folds * FOLD_ROW_PX)
  }

  it('sizes a body by its rows, not by a flat constant — a long file reserves a long box', () => {
    const short = viewOf([hunk(1, 5)])
    const long = viewOf([hunk(1, 300)])
    expect(estimateDiffHeight(short, 0)).toBe(expected(short))
    expect(estimateDiffHeight(long, 0)).toBe(expected(long))
    expect(estimateDiffHeight(long, 0) - estimateDiffHeight(short, 0)).toBe(Math.round(295 * LINE_ROW_PX))
  })

  it('counts a fold row at its own height', () => {
    const view = viewOf([hunk(1, 3), hunk(100, 3)])
    const folds = view.filter((r) => r.type === 'gap').length
    expect(folds).toBeGreaterThan(0)
    expect(view.length - folds).toBe(6)
    expect(estimateDiffHeight(view, 0)).toBe(Math.round(6 * LINE_ROW_PX + folds * FOLD_ROW_PX))
  })

  it('reserves room for each inline thread', () => {
    const view = viewOf([hunk(1, 10)])
    expect(estimateDiffHeight(view, 3) - estimateDiffHeight(view, 0)).toBe(3 * THREAD_PX)
  })

  it('never reserves less than one row, so an empty body still has a box to observe', () => {
    expect(estimateDiffHeight([], 0)).toBeGreaterThanOrEqual(Math.round(LINE_ROW_PX))
  })
})
