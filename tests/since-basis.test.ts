import { describe, expect, it } from 'vitest'
import { approvedShaList, baselineLabel, commitBaselines, sinceBasis, sinceModeLabel } from '../src/shared/sinceBasis'

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
  it('names each of the four baselines for the checkpoint it measures from', () => {
    expect(baselineLabel('branch')).toBe('Full diff')
    expect(baselineLabel('review')).toBe('Since the review ran')
    expect(baselineLabel('approved')).toBe('Since approved')
    expect(baselineLabel('viewed')).toBe('Since viewed')
  })
})

describe('commitBaselines — the review-wide baselines a reader can switch to', () => {
  it('offers the approval and the generation sha as two independent baselines', () => {
    expect(commitBaselines({ approvedSha: OLD, reviewedAtSha: GEN }, HEAD))
      .toEqual([{ mode: 'review', sha: GEN }, { mode: 'approved', sha: OLD }])
  })

  it('collapses them into one when the review was generated at the sha you approved', () => {
    expect(commitBaselines({ approvedSha: OLD, reviewedAtSha: OLD }, HEAD))
      .toEqual([{ mode: 'approved', sha: OLD }])
  })

  it('drops a baseline that IS the head — there is nothing since it', () => {
    expect(commitBaselines({ approvedShas: [HEAD], approvedSha: HEAD, reviewedAtSha: GEN }, HEAD))
      .toEqual([{ mode: 'review', sha: GEN }])
    expect(commitBaselines({ reviewedAtSha: HEAD }, HEAD)).toEqual([])
  })

  it('is empty for a review with no approval and no generated baseline', () => {
    expect(commitBaselines({}, HEAD)).toEqual([])
  })

  it('keeps a head-equal baseline when asked — a dirty tree still has a delta since it', () => {
    // approve the commit, then edit the working tree: "since approved" is exactly
    // those uncommitted lines, so the working-tree pass must not drop this baseline
    expect(commitBaselines({ approvedShas: [HEAD], approvedSha: HEAD }, HEAD, { includeHead: true }))
      .toEqual([{ mode: 'approved', sha: HEAD }])
  })
})
