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

  it('renders tour stop notes as visible hover descriptions', () => {
    const out = renderToStaticMarkup(<ActionChips actions={[tour]} />)
    expect(out).toContain('aria-describedby="tour-stop-note-0"')
    expect(out).toContain('class="lt-note"')
    expect(out).toContain('first')
  })

  it('exposes the note help as an interactive toggle, not a bare label', () => {
    const out = renderToStaticMarkup(<ActionChips actions={[tour]} />)
    // a real (keyboard-reachable) toggle that opens the note on click, collapsed by default
    expect(out).toContain('role="button"')
    expect(out).toContain('aria-expanded="false"')
    // the note is an in-flow block (not an absolute popover the card would clip)
    expect(out).toContain('role="note"')
    expect(out).toContain('class="lt-note"')
  })
})
