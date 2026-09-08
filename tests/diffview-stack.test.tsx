import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, beforeEach } from 'vitest'

;(globalThis as unknown as { window: unknown }).window = { api: {} }

import { useStore } from '../src/renderer/store'
import { DiffView } from '../src/renderer/components/DiffView'
import { makeLoaded, makeFile } from './helpers/loaded'
import type { FileDiff } from '../src/shared/types'
import { UNIFIED, type Stack } from '../src/shared/diffStack'
import { pickerOptions, sheetsFor, sinceLabel } from '../src/renderer/lib/stack'

// zustand v5's bare `useStore()` reads getInitialState() for the SSR snapshot (see
// review-sidebar.test.tsx) — seed both that object and the live state so the
// component sees the same review either way it reads.
type State = ReturnType<typeof useStore.getState>
const initial = (): State => (useStore as unknown as { getInitialState: () => State }).getInitialState()
function seed(patch: Partial<State>): void {
  Object.assign(initial(), patch)
  useStore.setState(patch)
}

const hunk = (text: string) => ({
  range: '@@ -1,1 +1,1 @@', header: '', lines: [{ old: null, new: 1, kind: 'add', text }]
})
const f: FileDiff = makeFile({
  path: 'src/a.ts',
  hunks: [hunk('whole branch line')],
  sinceViewedHunks: [hunk('only since you viewed')],
  baseToViewedHunks: []
} as never)
const two: FileDiff = makeFile({
  path: 'src/b.ts',
  hunks: [hunk('whole branch line')],
  sinceReviewHunks: [hunk('since the agent review')], baseToReviewHunks: [],
  sinceHunks: [hunk('since approval')], baseToApprovedHunks: [],
  sinceViewedHunks: [hunk('since file view')], baseToViewedHunks: []
} as never)
const captions = (html: string): string => html.slice(html.indexOf('class="dcols"'), html.indexOf('class="gfile-diff'))
const st = (out: Stack['out'], against: Stack['against'] = 'base'): Stack => ({ out, against })

describe('a file is read against its own stack', () => {
  beforeEach(() => {
    seed({
      // a view mark whose hash no longer matches: the file is 'changed since viewed', so it stays open
      loaded: makeLoaded({ files: [f, two], headSha: 'head', viewedAt: { 'src/a.ts': { sha: 'abc1234def', hash: 'old' } } }),
      diffStack: UNIFIED, fileStack: {}, viewedAt: { 'src/a.ts': { sha: 'abc1234def', hash: 'old' } }, focusTarget: null
    })
  })

  it('follows the default when the file has no override — Unified, main · current', () => {
    const html = renderToStaticMarkup(<DiffView f={f} />)
    expect(html).toContain('whole branch line')
    expect(html).not.toContain('only since you viewed')
    expect(captions(html)).toMatch(/class="cl">main<\/span>/)
    expect(html).not.toContain('stk-ok')
  })

  it("renders the file's own stack when it has one, leaving the default alone, and lights the ✓", () => {
    seed({ fileStack: { 'src/a.ts': st([], 'viewed') } })
    const html = renderToStaticMarkup(<DiffView f={f} />)
    expect(html).toContain('only since you viewed')
    expect(html).not.toContain('whole branch line')
    expect(captions(html)).toMatch(/class="cl">file view<\/span>/)
    expect(html).toMatch(/class="stk-ok live" title="Use for all 2 files — every other file shows Unified · main · current"/)
    expect(useStore.getState().diffStack).toEqual(UNIFIED)
  })

  it('offers a ↺ beside the ✓ that names the default it would go back to; neither shows on a file that matches', () => {
    let html = renderToStaticMarkup(<DiffView f={f} />)
    expect(html).not.toContain('stk-reset')
    seed({ fileStack: { 'src/a.ts': st([], 'viewed') } })
    html = renderToStaticMarkup(<DiffView f={f} />)
    expect(html).toMatch(/class="stk-reset live" title="Back to the review&#x27;s default — Unified · main · current"/)
    // the ✓ comes first, the ↺ right under it
    expect(html.indexOf('stk-ok')).toBeLessThan(html.indexOf('stk-reset'))
  })

  // The menu itself only exists while the picker is open (#96), and a static render
  // can't open one — so the trigger is asserted on the markup and the options it
  // would list on the pure helper the trigger hands its state to.
  it("Unified's caption picker offers everything the file has, naming the checkpoint's commit", () => {
    const html = captions(renderToStaticMarkup(<DiffView f={f} />))
    expect(html).toContain('aria-label="Diff baseline for src/a.ts"')
    expect(html).not.toContain('role="option"')
    expect(pickerOptions(UNIFIED, sheetsFor(f), 'base').map((o) => sinceLabel(o.sheet)))
      .toEqual(['Full diff', 'Since file view'])
    seed({ fileStack: { 'src/a.ts': st([], 'viewed') } })
    expect(captions(renderToStaticMarkup(<DiffView f={f} />))).toContain('title="Since file view · abc1234"')
  })

  it('offers only the review window on a review nobody approved', () => {
    const unapproved = makeFile({ path: 'src/c.ts', hunks: [hunk('x')], sinceReviewHunks: [hunk('r')] } as never)
    seed({ loaded: makeLoaded({ files: [unapproved], headSha: 'head' }) })
    expect(captions(renderToStaticMarkup(<DiffView f={unapproved} />))).toContain('aria-label="Diff baseline for src/c.ts"')
    const labels = pickerOptions(UNIFIED, sheetsFor(unapproved), 'base').map((o) => sinceLabel(o.sheet))
    expect(labels).toContain('Since agent review')
    expect(labels).not.toContain('Since approval')
  })
})

describe('the strip', () => {
  beforeEach(() => {
    seed({ loaded: makeLoaded({ files: [f, two], headSha: 'head' }), diffStack: UNIFIED, fileStack: {}, viewedAt: {}, focusTarget: null })
  })

  it('shows the tab with the count while something is left to pull, and the − only once a sheet is out', () => {
    let html = renderToStaticMarkup(<DiffView f={two} />)
    expect(html).toContain('title="Sheets · 0 of 4 out · click to pull the next"')
    expect(html).not.toContain('stk-pop')
    seed({ fileStack: { 'src/b.ts': st(['approved', 'base']) } })
    html = renderToStaticMarkup(<DiffView f={two} />)
    expect(html).toContain('title="Sheets · 2 of 4 out · click to pull the next"')
    expect(html).toContain('title="Put base · main back"')
    seed({ fileStack: { 'src/b.ts': st(['approved', 'base', 'review', 'viewed']) } })
    html = renderToStaticMarkup(<DiffView f={two} />)
    // the strip keeps its colour: the tab stays, only its icon leaves
    expect(html).toMatch(/class="stk-tab" disabled=""[^>]*title="Sheets · every one of 4 out"[^>]*><\/button>/)
    expect(html).toContain('title="Put file view back"')
  })

  it('names the sheets it would spread and what the others show', () => {
    seed({ diffStack: st(['base']), fileStack: { 'src/b.ts': st(['approved', 'base']) } })
    const html = renderToStaticMarkup(<DiffView f={two} />)
    expect(html).toContain('title="Use for all 2 files — every other file shows Split · full diff"')
  })

  it('a file whose override equals the default after narrowing still differs only if the override does', () => {
    // the default asks for a checkpoint a.ts lacks: a.ts shows base · current and no ✓
    seed({ diffStack: st(['approved', 'base']) })
    const html = renderToStaticMarkup(<DiffView f={f} />)
    expect(html).toContain('layout-split')
    expect(html).not.toContain('stk-ok')
  })

  it('base is fixed and plain from two sheets on; every checkpoint keeps its picker and ×', () => {
    seed({ fileStack: { 'src/b.ts': st(['approved', 'base', 'review']) } })
    const caps = captions(renderToStaticMarkup(<DiffView f={two} />))
    expect(caps).toMatch(/^class="dcols"[^>]*><span class="stk-col"><span class="cl">base · main<\/span><\/span>/)
    expect((caps.match(/class="cx"/g) ?? []).length).toBe(2)
    // a checkpoint already out is offered but disabled in the other picker, and base
    // is not offered at all (the options list is the helper's — see the note above)
    expect(pickerOptions(st(['approved', 'base', 'review']), sheetsFor(two), 'review')).toContainEqual(
      { sheet: 'approved', disabled: true }
    )
    expect(pickerOptions(st(['approved', 'base', 'review']), sheetsFor(two), 'review').map((o) => o.sheet))
      .not.toContain('base')
  })

  it('carries the key at the end of its caption row, describing this file', () => {
    let caps = captions(renderToStaticMarkup(<DiffView f={two} />))
    expect(caps).toContain('aria-label="What the diff marks mean"')
    expect(caps).not.toContain('Between sheets')
    seed({ fileStack: { 'src/b.ts': st(['approved', 'base']) } })
    caps = captions(renderToStaticMarkup(<DiffView f={two} />))
    expect(caps).toContain('Between sheets')
  })

  it('four and five columns carry their count for the width floor', () => {
    seed({ fileStack: { 'src/b.ts': st(['approved', 'base', 'review']) } })
    expect(renderToStaticMarkup(<DiffView f={two} />)).toContain('data-cols="4"')
    seed({ fileStack: { 'src/b.ts': st(['approved', 'base', 'review', 'viewed']) } })
    const html = renderToStaticMarkup(<DiffView f={two} />)
    expect(html).toContain('data-cols="5"')
    expect((html.match(/class="dcell/g) ?? []).length).toBe(5)
  })
})
