import { describe, expect, it } from 'vitest'
import { approvedShaList, baselineLabel, sinceBasis, sinceModeLabel } from '../src/shared/sinceBasis'

const HEAD = 'h'.repeat(40)
const OLD = 'o'.repeat(40)
const GEN = 'g'.repeat(40)

describe('sinceBasis — which baseline the "since" slice is measured from', () => {
  it('is the approval when one was recorded', () => {
    expect(sinceBasis({ approvedSha: OLD, reviewedAtSha: GEN }, HEAD))
      .toEqual({ sha: OLD, basis: 'approved' })
  })

  it('falls back to the generation sha when nothing was ever approved', () => {
    expect(sinceBasis({ reviewedAtSha: GEN }, HEAD))
      .toEqual({ sha: GEN, basis: 'generated' })
  })

  it('prefers the current head when it is itself approved — there is nothing since it', () => {
    expect(sinceBasis({ approvedShas: [OLD, HEAD], approvedSha: OLD, reviewedAtSha: GEN }, HEAD))
      .toEqual({ sha: HEAD, basis: 'approved' })
  })

  it('is null when the review has neither an approval nor a generated baseline', () => {
    expect(sinceBasis({}, HEAD)).toBeNull()
  })
})

describe('sinceModeLabel — what the baseline is called in the UI', () => {
  it('says "approved" only for a real approval', () => {
    expect(sinceModeLabel('approved')).toBe('Since approved')
  })

  it('names the generation baseline for its own truth, never "approved"', () => {
    expect(sinceModeLabel('generated')).toBe('Since the review ran')
  })
})

describe('approvedShaList — the one normalization of the approval history', () => {
  it('prefers the recorded list', () => {
    expect(approvedShaList({ approvedShas: [OLD, HEAD], approvedSha: OLD })).toEqual([OLD, HEAD])
  })

  it('falls back to the single legacy sha, and to nothing at all', () => {
    expect(approvedShaList({ approvedSha: OLD })).toEqual([OLD])
    expect(approvedShaList({})).toEqual([])
  })
})

describe('baselineLabel — one naming for the header switch and the per-file picker', () => {
  it('names the full diff and the viewed baseline the same either way', () => {
    expect(baselineLabel('branch', 'generated')).toBe('Full diff')
    expect(baselineLabel('viewed', 'generated')).toBe('Since viewed')
  })

  it('bends the since-baseline name to what it actually is', () => {
    expect(baselineLabel('approved', 'approved')).toBe('Since approved')
    expect(baselineLabel('approved', 'generated')).toBe('Since the review ran')
  })
})
