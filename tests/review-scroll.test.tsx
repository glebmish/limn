import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cancelled = vi.fn()
// the seam: useReviewScroll's own import of the focus module
vi.mock('../src/renderer/lib/focusScroll', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/lib/focusScroll')>()),
  cancelFocusJump: (): void => { cancelled() }
}))

const { useReviewScroll } = await import('../src/renderer/lib/useReviewScroll')

type Nav = ReturnType<typeof useReviewScroll>

/** Drive the hook through SSR (no jsdom in this suite) and keep the navigation
 *  functions it returns: they are plain closures, callable after the render. */
function nav(over: Partial<Parameters<typeof useReviewScroll>[0]> = {}): Nav {
  let out: Nav | null = null
  function Probe(): null {
    out = useReviewScroll({
      loaded: null,
      docPath: null,
      sections: [],
      filesFor: () => [],
      openDoc: () => {},
      closeDoc: () => {},
      openSection: () => {},
      ...over
    })
    return null
  }
  renderToStaticMarkup(<Probe />)
  if (!out) throw new Error('hook did not run')
  return out
}

beforeEach(() => {
  cancelled.mockClear()
  // the jumps schedule their retry loop on rAF; a no-op stub keeps the scroll work
  // (which needs a real container) out of a node-env test without swallowing it
  globalThis.requestAnimationFrame = (() => 0) as typeof globalThis.requestAnimationFrame
})

// #19: sidebar navigation drives the same `.gmain` the focus loop drives, and the
// focus loop now re-scrolls for up to ~800ms. A jump that doesn't cancel the one in
// flight gets overridden by it — the user's click is discarded.
describe('sidebar jumps cancel a focus jump in flight', () => {
  it('jumpTo (section) cancels first', () => {
    nav().jumpTo('s1')
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('jumpToFile cancels first', () => {
    nav().jumpToFile('s1', 'src/a.ts')
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('jumpToRawFile cancels first', () => {
    nav().jumpToRawFile('src/a.ts')
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('cancels before leaving an open doc, too (the doc path also scrolls .gmain)', () => {
    const order: string[] = []
    cancelled.mockImplementation(() => order.push('cancel'))
    const n = nav({ docPath: 'spec.md', closeDoc: () => order.push('closeDoc') })
    n.jumpToFile('s1', 'src/a.ts')
    expect(order).toEqual(['cancel', 'closeDoc'])
  })
})
