import { describe, expect, it } from 'vitest'
import { reviewTimelineGroups } from '../src/renderer/lib/reviewTimeline'

describe('reviewTimelineGroups', () => {
  it('does not render saved generated/approved shas that are outside the selected branch range', () => {
    const groups = reviewTimelineGroups({
      headSha: '9c3a532',
      commits: [{ sha: 'aaaaaaa' }, { sha: 'bbbbbbb' }],
      generatedSha: '0063004',
      approvedSha: '0063004',
      commitApproved: false
    })

    expect(groups).toEqual([{ sha: '9c3a532', roles: ['head'], pos: 0 }])
  })

  it('keeps generated and approved markers when their sha is in the selected range', () => {
    const groups = reviewTimelineGroups({
      headSha: 'head',
      commits: [{ sha: 'head' }, { sha: 'reviewed' }, { sha: 'base' }],
      generatedSha: 'reviewed',
      approvedSha: 'reviewed',
      commitApproved: false
    })

    expect(groups).toEqual([
      { sha: 'reviewed', roles: ['generated', 'approved'], pos: 1 },
      { sha: 'head', roles: ['head'], pos: 0 }
    ])
  })

  it('uses the nearest approved sha that is actually in the selected range', () => {
    const groups = reviewTimelineGroups({
      headSha: 'head',
      commits: [{ sha: 'head' }, { sha: 'near' }, { sha: 'far' }, { sha: 'base' }],
      generatedSha: 'old-off-tree',
      approvedSha: 'old-off-tree',
      approvedShas: ['old-off-tree', 'far', 'near'],
      commitApproved: false
    })

    expect(groups).toEqual([
      { sha: 'near', roles: ['approved'], pos: 1 },
      { sha: 'head', roles: ['head'], pos: 0 }
    ])
  })

  it('shows approval on head when the current commit surface was approved before', () => {
    const groups = reviewTimelineGroups({
      headSha: 'head',
      commits: [{ sha: 'head' }, { sha: 'old' }],
      generatedSha: 'old',
      approvedSha: 'old',
      commitApproved: true
    })

    expect(groups.find((group) => group.sha === 'head')?.roles).toEqual(['approved', 'head'])
  })
})
