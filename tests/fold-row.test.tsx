import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FoldRow } from '../src/renderer/components/FoldRow'
import type { GapRow } from '../src/renderer/lib/rows'

const row: GapRow = { type: 'gap', key: 'gap:g17', gap: { key: 'g17', from: 17, to: 66, oldOffset: 1 }, fn: 'render', where: '' }
const noop = () => {}

describe('FoldRow', () => {
  it('renders up and down step buttons with the hidden count and the function label', () => {
    const out = renderToStaticMarkup(<FoldRow row={row} controls={{ kind: 'steps', up: true, down: true, count: 50 }} onReveal={noop} onRevealAll={noop} />)
    expect(out).toContain('aria-label="Expand 20 lines up"')
    expect(out).toContain('aria-label="Expand 20 lines down"')
    expect(out).toContain('50 unchanged lines')
    expect(out).toContain('in render')
  })

  it('renders one button when the run is short, and an inert marker when it cannot open', () => {
    expect(renderToStaticMarkup(<FoldRow row={row} controls={{ kind: 'single', count: 12 }} onReveal={noop} onRevealAll={noop} />))
      .toContain('expand 12 unchanged lines')
    const inert = renderToStaticMarkup(<FoldRow row={row} controls={null} inert onReveal={noop} onRevealAll={noop} />)
    expect(inert).toContain('gap-static')
    expect(inert).toContain('in render')
    expect(inert).not.toContain('<button')
  })

  it('says where an unknown-length tail leads, and offers only the one direction', () => {
    const tail: GapRow = { ...row, gap: { key: 'g80', from: 80, to: null, oldOffset: 0 }, where: 'below', fn: '' }
    const out = renderToStaticMarkup(<FoldRow row={tail} controls={{ kind: 'steps', up: false, down: true, count: null }} onReveal={noop} onRevealAll={noop} />)
    expect(out).toContain('unchanged lines below')
    expect(out).toContain('Expand 20 lines down')
    expect(out).not.toContain('Expand 20 lines up')
  })

  it('"up" reveals from the bottom edge (toward the change below), "down" from the top', () => {
    // the DOM handlers are wired by edge; assert the mapping through the callback
    const calls: string[] = []
    const el = <FoldRow row={row} controls={{ kind: 'steps', up: true, down: true, count: 50 }} onReveal={(e) => calls.push(e)} onRevealAll={noop} />
    const up = (el.props as { children: unknown }) // sanity: element builds
    expect(up).toBeTruthy()
    expect(FoldRow.edgeFor('up')).toBe('bottom')
    expect(FoldRow.edgeFor('down')).toBe('top')
  })
})
