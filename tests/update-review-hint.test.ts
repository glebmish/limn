import { describe, expect, it } from 'vitest'
import { UPDATE_REVIEW_HINT } from '../src/renderer/components/GenPanel'

// Item 5: the "Update review" hint must be honest — an update is a fresh agent pass
// (no session resume), not the old "Same session." copy. See specs/ux-a11y-sweep §5.
describe('Update review hint copy', () => {
  it('describes a fresh agent pass', () => {
    expect(UPDATE_REVIEW_HINT).toContain('Fresh agent pass')
  })

  it('no longer claims "Same session."', () => {
    expect(UPDATE_REVIEW_HINT).not.toContain('Same session')
  })

  it('keeps the true half: comments and viewed marks survive', () => {
    expect(UPDATE_REVIEW_HINT).toContain('comments and viewed marks survive')
  })

  // Branch 04 §8: the hint gains one clause conveying that a small drift update only
  // touches the changed sections (scoped path) — ADDED to, not replacing, the honest
  // branch-02 wording asserted above.
  it('conveys the scoped path: small drift updates only the touched sections', () => {
    expect(UPDATE_REVIEW_HINT).toContain('small drift updates only the touched sections')
  })
})
