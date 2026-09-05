import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MergeRecord, SessionListItem } from '../src/shared/types'
import { SessionRow } from '../src/renderer/components/SessionRow'
import { ReviewSummary } from '../src/renderer/components/ReviewSummary'

function makeItem(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: 1, baseSymbol: 'main', compareSymbol: 'feature', compareKind: 'branch',
    title: 'Changes on feature', hasReview: true, approved: true, archived: false,
    unresolved: 0, updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    ...over
  }
}

function makeRecord(over: Partial<MergeRecord> = {}): MergeRecord {
  return {
    strategy: 'squash', mergedSha: 'abcdef1234567890'.repeat(2) + 'abcdef12',
    reviewedTipSha: 'f'.repeat(40), baseSymbol: 'main', baseShaBefore: 'a'.repeat(40),
    mergedAt: '2026-07-05T12:00:00.000Z', message: 'Land it',
    overrides: [], dependents: [],
    cleanup: { archived: true, branchDeleted: true, worktreeRemoved: '/wt/feature', retargeted: [], failures: [] },
    ...over
  }
}

describe('SessionRow — merged badge (spec §7)', () => {
  const rowHtml = (s: SessionListItem): string =>
    renderToStaticMarkup(<SessionRow s={s} onOpen={() => {}} />)

  it('renders a green "Merged · <sha7>" badge, first-checked over approved', () => {
    const html = rowHtml(makeItem({ merged: { sha: '4c6d295e1e9b7443ee14a59d0dde97f311f835cf' } }))
    expect(html).toContain('Merged · 4c6d295')
    expect(html).toContain('limn-sess-st merged')
    expect(html).not.toContain('>approved<')
  })

  it('falls back to approved when not merged', () => {
    const html = rowHtml(makeItem())
    expect(html).toContain('>approved<')
    expect(html).not.toContain('Merged ·')
  })
})

describe('ReviewSummary — merged band (spec §7)', () => {
  // annotations undefined → only the merged band renders (no title/summary threads,
  // no store-reading children), so renderToStaticMarkup is safe.
  const bandHtml = (merged: MergeRecord, branch?: string): string =>
    renderToStaticMarkup(
      <ReviewSummary
        annotations={undefined} titleComments={[]} titleCommenting={false}
        setTitleCommenting={() => {}} summaryComments={[]} sinceTagged={false}
        lastIteration={undefined} approvedBaseline={undefined} guidedBy={{ engine: 'claude' }}
        merged={merged} mergedBranch={branch}
      />
    )

  it('states where/how it landed, the cleanup, and the read-only close', () => {
    const html = bandHtml(makeRecord({ mergedSha: '4c6d295e1e9b7443ee14a59d0dde97f311f835cf' }), 'feature')
    expect(html).toContain('Merged into main')
    expect(html).toContain('4c6d295')
    expect(html).toContain('(squash)')
    expect(html).toContain('feature was deleted and its worktree removed')
    expect(html).toContain('This review is now a read-only record')
  })

  it('notes override gates (S13) and external merges', () => {
    const html = bandHtml(makeRecord({
      external: true,
      overrides: [{ gate: 'stale-approval', detail: '2 commits after c7e0d44' }]
    }), 'feature')
    expect(html).toContain('Recorded from a merge made outside Limn')
    expect(html).toContain('Landed over 1 acknowledged gate')
    expect(html).toContain('2 commits after c7e0d44')
  })

  it('surfaces partial cleanup failures', () => {
    const html = bandHtml(makeRecord({
      cleanup: { archived: true, branchDeleted: false, worktreeRemoved: false, retargeted: [], failures: ['delete branch: checked out'] }
    }), 'feature')
    expect(html).toContain('Some cleanup did not complete')
    expect(html).toContain('delete branch: checked out')
  })
})
