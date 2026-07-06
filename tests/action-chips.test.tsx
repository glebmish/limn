import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ActionChips, nextStopIndex } from '../src/renderer/components/ActionChips'
import type { AgentAction } from '../src/shared/types'

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
