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
    expect(dirty).toContain('rail-sw staged')
    expect(dirty).toContain('rail-sw unstaged')

    const clean = render({ dirty: false, since: 'approved' })
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
    expect(generated).not.toContain('approval')

    expect(render({ dirty: false, since: 'approved' })).toContain('since your approval')
  })

  it('says when the left-rail group applies — a dirty tree — and drops the old committed row', () => {
    const dirty = render({ dirty: true, since: null })
    expect(dirty).toContain('this branch has uncommitted work')
    expect(dirty).not.toContain('rail-sw com')
    expect(render({ dirty: false, since: 'approved' })).not.toContain('key-when')
  })

  it('explains the colours too — the added/removed tint and the word-level highlight', () => {
    const html = render({ dirty: false, since: null })
    expect(html).toContain('key-sw add')
    expect(html).toContain('key-sw del')
    expect(html).toContain('key-sw word')
  })

  it('carries the +/− sign in the swatch — the tint alone is too pale to tell apart at this size', () => {
    const html = render({ dirty: false, since: null })
    expect(html).toMatch(/class="key-sw add"[^>]*>\+</)
    expect(html).toMatch(/class="key-sw del"[^>]*>\u2212</)
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

  it('explains the between-sheets marks only while some file has a checkpoint sheet out, and counts them', () => {
    const one = renderToStaticMarkup(<MarkersKey dirty={false} since={null} sheetsOut={1} />)
    expect(one).toContain('Between sheets')
    expect(one).toContain('1 file has a checkpoint sheet out')
    expect(one).toContain('rail-sw gone')
    expect(one).toContain('current differs from the checkpoint beside it')
    expect(one).toContain('the checkpoint had it, current does not')
    expect(renderToStaticMarkup(<MarkersKey dirty={false} since={null} sheetsOut={2} />)).toContain('2 files have a checkpoint sheet out')
    expect(renderToStaticMarkup(<MarkersKey dirty={false} since={null} />)).not.toContain('Between sheets')
  })

  it('lists the colours first', () => {
    const html = render({ dirty: true, since: 'approved' })
    expect(html.indexOf('Colour')).toBeLessThan(html.indexOf('Left rail'))
  })
})
