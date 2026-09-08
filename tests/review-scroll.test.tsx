import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FocusTarget } from '../src/shared/types'

const focused = vi.fn<(t: FocusTarget, o?: { quiet?: boolean }) => void>()
// the seam: useReviewScroll's own import of the focus pipeline
vi.mock('../src/renderer/lib/focus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/lib/focus')>()),
  focusAnchor: (t: FocusTarget, o?: { quiet?: boolean }): void => { focused(t, o) }
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
      ...over
    })
    return null
  }
  renderToStaticMarkup(<Probe />)
  if (!out) throw new Error('hook did not run')
  return out
}

beforeEach(() => {
  focused.mockClear()
  globalThis.requestAnimationFrame = (() => 0) as typeof globalThis.requestAnimationFrame
})

// Every sidebar navigation is a focus jump with the flash turned off. That is what
// gives a sidebar click the same landing every other jump gets: it clears the pinned
// page header, measures the file block (not its sticky header), force-shows a
// viewed/collapsed file, waits for content-visibility bodies to lay out, and cancels
// the jump in flight (#19). The one-shot scrolls this replaced landed a viewed file
// behind the header with the next section's title at the top.
describe('sidebar jumps are quiet focus jumps', () => {
  it('jumpTo (section) focuses the section', () => {
    nav().jumpTo('s1')
    expect(focused).toHaveBeenCalledWith({ kind: 'section', sectionId: 's1' }, { quiet: true })
  })

  it('jumpToFile focuses the file (the pipeline opens its section itself)', () => {
    nav().jumpToFile('src/a.ts')
    expect(focused).toHaveBeenCalledWith({ kind: 'file', file: 'src/a.ts' }, { quiet: true })
  })

  it('never lands with the flash + FOCUS chip — the reader asked to go there', () => {
    const n = nav()
    n.jumpTo('s1'); n.jumpToFile('src/a.ts')
    for (const call of focused.mock.calls) expect(call[1]).toEqual({ quiet: true })
  })
})
