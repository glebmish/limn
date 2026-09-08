import { describe, expect, it } from 'vitest'
import type { Hunk } from '../src/shared/types'
import { hunkGaps } from '../src/renderer/lib/expand'

// @@ -12,4 +12,5 @@ : one add at new 14 (old runs 12..15, new runs 12..16)
const h1: Hunk = {
  range: '@@ -12,4 +12,5 @@', header: '', lines: [
    { old: 12, new: 12, kind: '', text: 'a' },
    { old: 13, new: 13, kind: '', text: 'b' },
    { old: null, new: 14, kind: 'add', text: 'NEW' },
    { old: 14, new: 15, kind: '', text: 'c' },
    { old: 15, new: 16, kind: '', text: 'd' }
  ]
}
// @@ -30,3 +31,3 @@ : pure replace at 32
const h2: Hunk = {
  range: '@@ -30,3 +31,3 @@', header: '', lines: [
    { old: 30, new: 31, kind: '', text: 'e' },
    { old: 31, new: null, kind: 'del', text: 'OLD' },
    { old: null, new: 32, kind: 'add', text: 'NEWER' },
    { old: 32, new: 33, kind: '', text: 'f' }
  ]
}

describe('hunkGaps', () => {
  it('computes before/between/after gaps with old-side offsets', () => {
    const gaps = hunkGaps([h1, h2])
    expect(gaps).toEqual([
      { key: 'g1', from: 1, to: 11, oldOffset: 0 },    // before h1: old = new - (12-12)
      { key: 'g17', from: 17, to: 30, oldOffset: 1 },  // between: old = new - (31-30)
      { key: 'g34', from: 34, to: null, oldOffset: 1 } // after h2: old = new - (33-32)
    ])
  })

  it('no leading gap when the first hunk starts at line 1', () => {
    const h: Hunk = { range: '@@ -1,2 +1,2 @@', header: '', lines: [
      { old: 1, new: 1, kind: '', text: 'x' }, { old: 2, new: 2, kind: '', text: 'y' }
    ] }
    expect(hunkGaps([h])).toEqual([{ key: 'g3', from: 3, to: null, oldOffset: 0 }])
  })

  it('returns a single EOF gap for an empty hunk list', () => {
    expect(hunkGaps([])).toEqual([{ key: 'g1', from: 1, to: null, oldOffset: 0 }])
  })
})
