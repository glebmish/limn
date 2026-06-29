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

  it('shows each stop note inline, always visible (no help toggle)', () => {
    const out = renderToStaticMarkup(<ActionChips actions={[tour]} />)
    // the note is an always-on in-flow block under the stop…
    expect(out).toContain('role="note"')
    expect(out).toContain('class="lt-note"')
    expect(out).toContain('first')
    expect(out).toContain('second')
    // …and the old "?" help control is gone entirely
    expect(out).not.toContain('lt-help')
    expect(out).not.toContain('aria-expanded')
  })
})
