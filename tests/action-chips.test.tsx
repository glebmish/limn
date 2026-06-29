import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ActionChips, nextTourIndex } from '../src/renderer/components/ActionChips'
import type { AgentAction } from '../src/shared/types'

const tour: AgentAction = {
  kind: 'tour',
  stops: [
    { target: { kind: 'section', sectionId: 's1' }, note: 'first' },
    { target: { kind: 'section', sectionId: 's2' }, note: 'second' }
  ]
}

describe('tour action controls', () => {
  it('wraps prev/next around the stop list', () => {
    expect(nextTourIndex(0, -1, 2)).toBe(1)
    expect(nextTourIndex(1, 1, 2)).toBe(0)
  })

  it('keeps prev and next enabled so walkthroughs are circular', () => {
    const out = renderToStaticMarkup(<ActionChips actions={[tour]} />)
    expect(out).not.toContain('disabled=""')
  })

  it('shows a single live note that follows the active stop, with a "Stop N." lead', () => {
    const out = renderToStaticMarkup(<ActionChips actions={[tour]} />)
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
