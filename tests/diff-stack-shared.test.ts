import { describe, expect, it } from 'vitest'
import { normalizeStack, parseStack, UNIFIED } from '../src/shared/diffStack'

describe('parseStack', () => {
  it('round-trips a stored stack', () => {
    expect(parseStack(JSON.stringify({ out: ['approved', 'base'], against: 'base' }))).toEqual({ out: ['approved', 'base'], against: 'base' })
  })
  it('reads nothing, garbage and the wrong shape as Unified', () => {
    expect(parseStack(null)).toEqual(UNIFIED)
    expect(parseStack(undefined)).toEqual(UNIFIED)
    expect(parseStack('not json')).toEqual(UNIFIED)
    expect(parseStack('42')).toEqual(UNIFIED)
    expect(parseStack('{"out":"approved"}')).toEqual(UNIFIED)
  })
  it('drops unknown sheet names and duplicates', () => {
    expect(parseStack('{"out":["approved","sideways","approved"],"against":"nope"}')).toEqual({ out: ['approved'], against: 'base' })
  })
})

describe('normalizeStack', () => {
  it('keeps only the first sheet when two or more are out without base', () => {
    expect(normalizeStack({ out: ['review', 'approved'], against: 'base' })).toEqual({ out: ['review'], against: 'base' })
    expect(normalizeStack({ out: ['approved', 'base', 'viewed'], against: 'viewed' })).toEqual({ out: ['approved', 'base', 'viewed'], against: 'viewed' })
  })
})
