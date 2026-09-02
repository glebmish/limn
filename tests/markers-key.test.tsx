import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkersKey } from '../src/renderer/components/MarkersKey'

/** The key used to be gated on `dirty`, so a clean branch review — the common case —
 *  drew hatched amber drift rails with nothing on screen to explain them. It now
 *  renders always, listing only the marks that CAN appear in the review it is shown
 *  for, and names the drift baseline for what it actually is (an approval, or the sha
 *  the review was generated at — see src/shared/sinceBasis.ts). */
const render = (props: { dirty: boolean; since: 'approved' | 'generated' | null }): string =>
  renderToStaticMarkup(<MarkersKey {...props} />)

describe('MarkersKey legend', () => {
  it('lists the working-tree rails only when the tree is dirty', () => {
    const dirty = render({ dirty: true, since: 'approved' })
    expect(dirty).toContain('rail-sw com')
    expect(dirty).toContain('rail-sw staged')
    expect(dirty).toContain('rail-sw unstaged')

    const clean = render({ dirty: false, since: 'approved' })
    expect(clean).not.toContain('rail-sw com')
    expect(clean).not.toContain('rail-sw staged')
    expect(clean).not.toContain('rail-sw unstaged')
  })

  it('explains the drift rail whenever one can be drawn — clean tree included', () => {
    expect(render({ dirty: false, since: 'approved' })).toContain('rail-sw since')
  })

  it('drops the drift rail when the review has no since-baseline at all', () => {
    expect(render({ dirty: false, since: null })).not.toContain('rail-sw since')
  })

  it('never calls a generation baseline an approval', () => {
    const generated = render({ dirty: false, since: 'generated' })
    expect(generated).toContain('since the review ran')
    expect(generated).not.toContain('approved')

    expect(render({ dirty: false, since: 'approved' })).toContain('since you approved')
  })

  it('explains the colours too — the added/removed tint and the word-level highlight', () => {
    const html = render({ dirty: false, since: null })
    expect(html).toContain('key-sw add')
    expect(html).toContain('key-sw del')
    expect(html).toContain('key-sw word')
  })

  it('is a labelled "?" affordance, not a bare icon', () => {
    const html = render({ dirty: false, since: null })
    expect(html).toContain('aria-label="What the diff marks mean"')
    expect(html).toMatch(/class="fh-q"[^>]*>\?</)
  })

  it('keeps one swatch per row', () => {
    const html = render({ dirty: true, since: 'approved' })
    const rows = html.match(/class="rail-row"/g) ?? []
    const swatches = html.match(/class="(rail|key)-sw /g) ?? []
    expect(rows).toHaveLength(swatches.length)
  })
})
