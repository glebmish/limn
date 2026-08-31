import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ActionChips, nextStopIndex } from '../src/renderer/components/ActionChips'
import { useStore } from '../src/renderer/store'
import type { AgentAction } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'

// zustand v5's bare `useStore()` reads getInitialState() for the SSR snapshot, so a
// component's store reads are seeded by mutating that object (same helper shape as
// diffview-characterization.test.tsx).
type State = ReturnType<typeof useStore.getState>
const initialState = (): State => (useStore as unknown as { getInitialState: () => State }).getInitialState()
function seedLoaded(loaded: LoadedReview | null): void {
  ;(initialState() as { loaded: LoadedReview | null }).loaded = loaded
}

const point: AgentAction = {
  kind: 'point',
  stops: [
    { target: { kind: 'section', sectionId: 's1' }, note: 'first' },
    { target: { kind: 'section', sectionId: 's2' }, note: 'second' }
  ]
}

describe('point action controls — multi-stop walkthrough', () => {
  it('wraps prev/next around the stop list', () => {
    expect(nextStopIndex(0, -1, 2)).toBe(1)
    expect(nextStopIndex(1, 1, 2)).toBe(0)
  })

  it('keeps prev and next enabled so walkthroughs are circular', () => {
    const out = renderToStaticMarkup(<ActionChips actions={[point]} />)
    expect(out).not.toContain('disabled=""')
  })

  it('shows a single live note that follows the active stop, with a "Stop N." lead', () => {
    const out = renderToStaticMarkup(<ActionChips actions={[point]} />)
    // one note block for the active stop (the first, on initial render)…
    expect(out).toContain('role="note"')
    expect(out).toContain('class="lt-note"')
    expect(out).toContain('ltn-lead')
    expect(out).toContain('Stop 1.')
    expect(out).toContain('first')
    // …and only the active stop's note — not every stop's
    expect(out).not.toContain('second')
    // …and the old "?" help control is gone entirely
    expect(out).not.toContain('lt-help')
    expect(out).not.toContain('aria-expanded')
  })

  it('renders 8 stops (the max)', () => {
    const eight: AgentAction = {
      kind: 'point',
      stops: Array.from({ length: 8 }, (_, i) => ({ target: { kind: 'section' as const, sectionId: `s${i}` } }))
    }
    const out = renderToStaticMarkup(<ActionChips actions={[eight]} />)
    expect(out).toContain('Stop 1 of 8')
  })

  it('renders comment action cards as clickable focus targets when their anchor is focusable', () => {
    const action: AgentAction = {
      kind: 'comment_replied',
      commentId: 'c1',
      anchor: { kind: 'section', sectionId: 'contracts' },
      reply: { author: 'agent', text: 'Answered in place.', at: 'T1' }
    }

    const out = renderToStaticMarkup(<ActionChips actions={[action]} />)

    expect(out).toContain('<button')
    expect(out).toContain('class="limn-act cmt"')
    expect(out).toContain('Show in the review')
  })
})

describe('point action controls — single stop', () => {
  it('renders the compact jump chip, not the walkthrough', () => {
    const single: AgentAction = { kind: 'point', stops: [{ target: { kind: 'file', file: 'src/a.ts' } }] }
    const out = renderToStaticMarkup(<ActionChips actions={[single]} />)
    expect(out).toContain('class="limn-act focus"')
    expect(out).toContain('Jump to')
    expect(out).not.toContain('Stop 1 of')
    expect(out).not.toContain('class="limn-act tour"')
  })

  it('shows a diff stop\'s endLine as a file:line–endLine range (en dash)', () => {
    const ranged: AgentAction = {
      kind: 'point',
      stops: [{ target: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 3, endLine: 9, hunkRange: '', lineContent: '' } }]
    }
    const out = renderToStaticMarkup(<ActionChips actions={[ranged]} />)
    expect(out).toContain('a.ts:3–9')
  })
})

// #18: the re-anchor pass flags a stop it could not place on the current surface.
// The card must stop claiming a line number that no longer means anything.
describe('point stops the re-anchor pass flagged stale', () => {
  const stop = (stale?: 'lost' | 'off-surface'): AgentAction => ({
    kind: 'point',
    stops: [{ target: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 14, hunkRange: '', lineContent: 'x', ...(stale ? { stale } : {}) } }]
  })

  it('drops the line number of a `lost` stop and explains the degraded jump', () => {
    const out = renderToStaticMarkup(<ActionChips actions={[stop('lost')]} />)
    expect(out).not.toContain('a.ts:14')
    expect(out).toContain('a.ts')
    expect(out).toContain('no longer in the review')
  })

  it('keeps an `off-surface` stop\'s line (still correct in the file) but says it is not shown', () => {
    const out = renderToStaticMarkup(<ActionChips actions={[stop('off-surface')]} />)
    expect(out).toContain('a.ts:14')
    expect(out).toContain('not shown in this diff')
  })

  it('an unflagged stop keeps its line and the plain re-focus title', () => {
    const out = renderToStaticMarkup(<ActionChips actions={[stop()]} />)
    expect(out).toContain('a.ts:14')
    expect(out).toContain('Re-focus this in the review')
  })
})

// The action's anchor is a snapshot frozen at tool-call time; the comment it names
// re-anchors on every load. The card's label and its jump must follow the live one,
// or they disagree with the quote right below them.
describe('comment action cards follow the live comment anchor', () => {
  const action: AgentAction = {
    kind: 'comment_replied',
    commentId: 'c1',
    anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 14, hunkRange: '', lineContent: 'old' },
    reply: { author: 'agent', text: 'Answered in place.', at: 'T1' }
  }

  it('renders the re-anchored line in the header, not the frozen one', () => {
    seedLoaded({
      state: {
        comments: [{
          id: 'c1', author: 'user', text: 'q', status: 'resolved', replies: [], createdAt: 'now', iteration: 0,
          anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 16, hunkRange: '', lineContent: 'new' }
        }],
        chats: []
      }
    } as unknown as LoadedReview)
    try {
      const out = renderToStaticMarkup(<ActionChips actions={[action]} />)
      expect(out).toContain('on a.ts:16')  // the card header, re-anchored
      expect(out).not.toContain('a.ts:14') // …never the frozen snapshot
    } finally {
      seedLoaded(null)
    }
  })

  it('falls back to the frozen snapshot when the comment is gone', () => {
    const out = renderToStaticMarkup(<ActionChips actions={[action]} />)
    expect(out).toContain('a.ts:14')
  })
})
