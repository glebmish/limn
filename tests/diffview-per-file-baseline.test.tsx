import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, beforeEach } from 'vitest'

;(globalThis as unknown as { window: unknown }).window = { api: {} }

import { useStore } from '../src/renderer/store'
import { DiffView } from '../src/renderer/components/DiffView'
import { makeLoaded, makeFile } from './helpers/loaded'
import type { FileDiff } from '../src/shared/types'

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
  sinceViewedHunks: [hunk('only since you viewed')]
} as never)

describe('a file is read against its own baseline', () => {
  beforeEach(() => {
    seed({
      loaded: makeLoaded({ files: [f], headSha: 'head' }),
      diffMode: 'branch', fileDiffMode: {}, viewedAt: {}, focusTarget: null
    })
  })

  it('follows the global baseline when the file has no override', () => {
    const html = renderToStaticMarkup(<DiffView f={f} />)
    expect(html).toContain('whole branch line')
    expect(html).not.toContain('only since you viewed')
  })

  it('renders the file\'s own baseline when it has one, leaving the global default alone', () => {
    useStore.getState().setFileDiffMode('src/a.ts', 'viewed')
    seed({ fileDiffMode: useStore.getState().fileDiffMode })

    const html = renderToStaticMarkup(<DiffView f={f} />)

    expect(html).toContain('only since you viewed')
    expect(html).not.toContain('whole branch line')
    expect(useStore.getState().diffMode).toBe('branch')
  })

  it('puts the baseline picker in the file header, where the file is', () => {
    const html = renderToStaticMarkup(<DiffView f={f} />)
    expect(html).toContain('aria-label="Diff baseline for src/a.ts"')
  })

  it('offers only the review window on a review nobody approved', () => {
    // no approval → the server attaches the review slice and no approved slice
    const unapproved = { ...f, sinceReviewHunks: [hunk('since the review ran')] } as FileDiff
    seed({ loaded: makeLoaded({ files: [unapproved], headSha: 'head' }), fileDiffMode: {} })

    const html = renderToStaticMarkup(<DiffView f={unapproved} />)

    expect(html).toContain('Since the review ran')
    expect(html).not.toContain('Since approved')
  })

  it('reads the review window from its own slice, not the approval\'s', () => {
    const both = {
      ...f,
      sinceReviewHunks: [hunk('landed after the review ran')],
      sinceHunks: [hunk('landed after you approved')]
    } as FileDiff
    seed({ loaded: makeLoaded({ files: [both], headSha: 'head' }), fileDiffMode: { 'src/a.ts': 'review' } })

    const html = renderToStaticMarkup(<DiffView f={both} />)

    expect(html).toContain('landed after the review ran')
    expect(html).not.toContain('landed after you approved')
  })
})
