import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Comment } from '../src/shared/types'
import { InlineThread } from '../src/renderer/components/Threads'

function hotspotComment(over: Partial<Comment> = {}): Comment {
  return {
    id: 'hs-1',
    anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '', lineContent: '' },
    author: 'agent',
    text: 'This branch is unreachable if input is empty.',
    severity: 'risk',
    status: 'resolved',
    replies: [],
    createdAt: 'now',
    iteration: 1,
    ...over
  }
}

const html = (c: Comment): string => renderToStaticMarkup(<InlineThread c={c} locLabel="src/a.ts:2" />)

describe('InlineThread — hotspot severity badge (A4)', () => {
  it('renders the severity badge for a risk hotspot', () => {
    const out = html(hotspotComment())
    expect(out).toContain('sev-badge')
    expect(out).toContain('sev-risk')
    expect(out).toContain('risk')
  })

  it('renders the severity badge for a note hotspot', () => {
    const out = html(hotspotComment({ severity: 'note' }))
    expect(out).toContain('sev-note')
    expect(out).toContain('note')
  })

  it('renders no badge when severity is absent', () => {
    const out = html(hotspotComment({ severity: undefined }))
    expect(out).not.toContain('sev-badge')
  })
})

describe('InlineThread — resolved comments keep a re-queue control (spec Decision 19)', () => {
  it('shows Re-queue for a resolved agent (hotspot) comment', () => {
    const out = html(hotspotComment())
    expect(out).toContain('requeue')
    expect(out).toContain('Re-queue')
  })

  it('shows Re-queue for a resolved reviewer-authored comment too', () => {
    const out = html(hotspotComment({
      author: 'user',
      severity: undefined,
      resolution: { verdict: 'addressed', note: 'Fixed in a follow-up commit.' }
    }))
    expect(out).toContain('requeue')
    expect(out).toContain('Re-queue')
  })

  it('does not show Re-queue for a queued comment', () => {
    const out = html(hotspotComment({ author: 'user', severity: undefined, status: 'queued' }))
    expect(out).not.toContain('Re-queue')
  })
})
