import { describe, expect, it } from 'vitest'
import type { FileDiff, Hunk } from '../src/shared/types'
import { UNIFIED, type Stack } from '../src/shared/diffStack'
import {
  close, columnsFor, describeStack, effectiveStack, layoutFor, midHunksFor, nextPull, pickerOptions, pop, pull,
  replace, sameStack, setAgainst, sheetCaption, sheetsFor, sinceLabel, sliceFor
} from '../src/renderer/lib/stack'

const hunk = (tag: string): Hunk => ({ range: '@@', header: tag, lines: [] })
const file = (over: Partial<FileDiff> = {}): FileDiff => ({
  path: 'f.ts', status: 'modified', binary: false, add: 1, del: 0, hunks: [hunk('full')], ...over
})
const all = file({ sinceReviewHunks: [hunk('r')], sinceHunks: [hunk('a')], sinceViewedHunks: [hunk('v')] })
const approvedOnly = file({ sinceHunks: [hunk('a')] })
const st = (out: Stack['out'], against: Stack['against'] = 'base'): Stack => ({ out, against })

describe('sheetsFor', () => {
  it('offers base always and a checkpoint only where the file has its slice', () => {
    expect(sheetsFor(file())).toEqual(['base'])
    expect(sheetsFor(approvedOnly)).toEqual(['base', 'approved'])
    expect(sheetsFor(all)).toEqual(['base', 'review', 'approved', 'viewed'])
  })
})

describe('effectiveStack', () => {
  it('drops sheets the file lacks and keeps the base invariant', () => {
    expect(effectiveStack(st(['approved', 'base', 'viewed']), approvedOnly)).toEqual(st(['approved', 'base']))
    expect(effectiveStack(st(['approved', 'base', 'viewed']), file())).toEqual(st(['base']))
    expect(effectiveStack(st(['review', 'approved', 'base']), approvedOnly)).toEqual(st(['approved', 'base']))
  })
  it('falls a missing Unified baseline back to the full diff', () => {
    expect(effectiveStack(st([], 'approved'), file())).toEqual(UNIFIED)
    expect(effectiveStack(st([], 'approved'), approvedOnly)).toEqual(st([], 'approved'))
  })
})

describe('layout and columns', () => {
  it('follow the sheet count, columns in display order', () => {
    expect(layoutFor(UNIFIED)).toBe('unified')
    expect(layoutFor(st(['approved']))).toBe('split')
    expect(layoutFor(st(['approved', 'base']))).toBe('multi')
    expect(columnsFor(st(['viewed', 'base', 'review']))).toEqual(['base', 'review', 'viewed'])
  })
})

describe('nextPull', () => {
  const avail = sheetsFor(all)
  it('pulls the Unified baseline first, then a checkpoint, then base, then the rest oldest first', () => {
    expect(nextPull(UNIFIED, avail)).toBe('base')
    expect(nextPull(st([], 'viewed'), avail)).toBe('viewed')
    expect(nextPull(st(['base']), avail)).toBe('approved')     // the drift basis
    expect(nextPull(st(['approved']), avail)).toBe('base')
    expect(nextPull(st(['approved', 'base']), avail)).toBe('review')
    expect(nextPull(st(['approved', 'base', 'review']), avail)).toBe('viewed')
    expect(nextPull(st(['approved', 'base', 'review', 'viewed']), avail)).toBeNull()
  })
  it('prefers the review run when nobody approved, and the view mark when that is all there is', () => {
    expect(nextPull(st(['base']), ['base', 'review', 'viewed'])).toBe('review')
    expect(nextPull(st(['base']), ['base', 'viewed'])).toBe('viewed')
  })
  it('a file with no checkpoint pulls the base and then nothing', () => {
    expect(nextPull(UNIFIED, ['base'])).toBe('base')
    expect(nextPull(st(['base']), ['base'])).toBeNull()
  })
  it('a Unified baseline the file lacks pulls the base', () => {
    expect(nextPull(st([], 'approved'), ['base'])).toBe('base')
  })
})

describe('pull / pop / close / replace / setAgainst', () => {
  it('pull appends in pull order and ignores a sheet already out', () => {
    expect(pull(st(['approved']), 'base')).toEqual(st(['approved', 'base']))
    expect(pull(st(['approved']), 'approved')).toEqual(st(['approved']))
  })
  it('pop puts the last pull back; the last checkpoint folds under as the Unified baseline', () => {
    expect(pop(st(['approved', 'base', 'review']))).toEqual(st(['approved', 'base']))
    expect(pop(st(['approved', 'base']))).toEqual(st(['approved']))
    expect(pop(st(['approved']))).toEqual(st([], 'approved'))
    expect(pop(st(['base'], 'approved'))).toEqual(st([], 'approved'))
    expect(pop(UNIFIED)).toEqual(UNIFIED)
  })
  it('close removes one column and folds the last checkpoint under too', () => {
    expect(close(st(['approved', 'base', 'review']), 'approved')).toEqual(st(['base', 'review']))
    expect(close(st(['viewed']), 'viewed')).toEqual(st([], 'viewed'))
    expect(close(st(['base']), 'base')).toEqual(UNIFIED)
  })
  it('replace keeps the position and refuses a sheet already out', () => {
    expect(replace(st(['approved', 'base']), 'approved', 'review')).toEqual(st(['review', 'base']))
    expect(replace(st(['approved', 'base']), 'approved', 'base')).toEqual(st(['approved', 'base']))
    expect(replace(st(['approved']), 'approved', 'base')).toEqual(st(['base']))
  })
  it('setAgainst changes only the Unified baseline', () => {
    expect(setAgainst(UNIFIED, 'review')).toEqual(st([], 'review'))
  })
})

describe('pickerOptions', () => {
  const avail = sheetsFor(all)
  it('offers everything, base included, in Unified and with one sheet out', () => {
    expect(pickerOptions(UNIFIED, avail, 'base').map((o) => o.sheet)).toEqual(['base', 'review', 'approved', 'viewed'])
    expect(pickerOptions(st(['approved']), avail, 'approved').every((o) => !o.disabled)).toBe(true)
  })
  it('offers checkpoints only from two sheets on, disabling one already out elsewhere', () => {
    expect(pickerOptions(st(['approved', 'base', 'viewed']), avail, 'approved')).toEqual([
      { sheet: 'review', disabled: false }, { sheet: 'approved', disabled: false }, { sheet: 'viewed', disabled: true }
    ])
  })
  it('offers only what the file has', () => {
    expect(pickerOptions(UNIFIED, ['base', 'approved'], 'base').map((o) => o.sheet)).toEqual(['base', 'approved'])
  })
})

describe('sameStack', () => {
  it('compares the sheets as a set, and the baseline only while none is out', () => {
    expect(sameStack(st(['approved', 'base']), st(['base', 'approved']))).toBe(true)
    expect(sameStack(st(['approved'], 'base'), st(['approved'], 'viewed'))).toBe(true)
    expect(sameStack(st([], 'base'), st([], 'viewed'))).toBe(false)
    expect(sameStack(st(['base']), UNIFIED)).toBe(false)
  })
})

describe('words', () => {
  it("are the board's", () => {
    expect(sheetCaption('base')).toBe('base · main')
    expect(sheetCaption('base', { unified: true })).toBe('main')
    expect(['review', 'approved', 'viewed', 'current'].map((s) => sheetCaption(s as never))).toEqual(['agent review', 'approval', 'file view', 'current'])
    expect(['base', 'review', 'approved', 'viewed'].map((s) => sinceLabel(s as never))).toEqual(['Full diff', 'Since agent review', 'Since approval', 'Since file view'])
  })
  it('describe names what a stack shows', () => {
    expect(describeStack(UNIFIED)).toBe('Unified · main · current')
    expect(describeStack(st([], 'approved'))).toBe('Unified · approval · current')
    expect(describeStack(st(['base']))).toBe('Split · full diff')
    expect(describeStack(st(['viewed']))).toBe('Split · since file view')
    expect(describeStack(st(['viewed', 'base', 'approved']))).toBe('Multi · base · approval · file view')
  })
})

describe('sliceFor / midHunksFor', () => {
  it('base shows the full diff; a checkpoint its slice, or nothing when the file has none', () => {
    expect(sliceFor(all, 'base').map((h) => h.header)).toEqual(['full'])
    expect(sliceFor(all, 'review').map((h) => h.header)).toEqual(['r'])
    expect(sliceFor(all, 'approved').map((h) => h.header)).toEqual(['a'])
    expect(sliceFor(all, 'viewed').map((h) => h.header)).toEqual(['v'])
    expect(sliceFor(file(), 'approved')).toEqual([])
  })
  it('an untracked file is wholly new — its since-diff IS its full diff', () => {
    expect(sliceFor(file({ untracked: true, status: 'added' }), 'viewed').map((h) => h.header)).toEqual(['full'])
  })
  it('the middle column is the base→checkpoint slice, empty when untouched', () => {
    const f = file({ baseToApprovedHunks: [hunk('ba')], baseToReviewHunks: [] })
    expect(midHunksFor(f, 'approved').map((h) => h.header)).toEqual(['ba'])
    expect(midHunksFor(f, 'review')).toEqual([])
    expect(midHunksFor(f, 'base')).toEqual([])
  })
})
