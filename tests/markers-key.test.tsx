import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkersKey } from '../src/renderer/components/MarkersKey'

/** Final review, finding 3: the legend explained committed / staged / unstaged and
 *  stopped there — but the amber `.since` rail is now the ONLY signal that a line
 *  landed after you approved or viewed (the hunk-level "· changed since approval"
 *  label is gone), and it used to be drawn in exactly the same solid amber as
 *  `staged`. The legend has to name it, and the swatch has to be the mark the reader
 *  actually sees on the row. */
describe('MarkersKey legend', () => {
  const out = renderToStaticMarkup(<MarkersKey />)

  it('lists all four rails, since included', () => {
    expect(out).toContain('rail-sw com')
    expect(out).toContain('rail-sw staged')
    expect(out).toContain('rail-sw unstaged')
    expect(out).toContain('rail-sw since')
  })

  it('says what the since rail means in the language of the Since tabs', () => {
    expect(out).toMatch(/since you approved|since you viewed/)
  })

  it('keeps one swatch per row', () => {
    const rows = out.match(/class="rail-row"/g) ?? []
    const swatches = out.match(/class="rail-sw /g) ?? []
    expect(rows).toHaveLength(4)
    expect(swatches).toHaveLength(4)
  })
})
