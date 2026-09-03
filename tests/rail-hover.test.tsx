import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

;(globalThis as unknown as { window: unknown }).window = { api: {} }

import { useStore } from '../src/renderer/store'
import { DiffView } from '../src/renderer/components/DiffView'
import { railExplanation } from '../src/renderer/lib/railExplanation'
import { makeLoaded, makeFile } from './helpers/loaded'
import type { DiffLine, FileDiff } from '../src/shared/types'

const line = (over: Partial<DiffLine> = {}): DiffLine => ({ old: null, new: 1, kind: 'add', text: 'x', ...over })

describe('what a rail says when you point at it', () => {
  it('names the baseline the drift rail measures from', () => {
    expect(railExplanation(line({ since: true }), 'approved')).toBe('Changed since your approval')
    expect(railExplanation(line({ since: true }), 'generated')).toBe('Changed since the review ran')
  })

  it('names the per-file viewed rail for the file, not the review', () => {
    expect(railExplanation(line({ sinceViewed: true }), 'approved')).toBe('Changed since your file view')
  })

  it('explains the working-tree rails', () => {
    expect(railExplanation(line({ origin: 'staged' }), 'approved')).toBe('Staged — in the index, not yet committed')
    expect(railExplanation(line({ origin: 'unstaged' }), 'approved')).toBe('Unstaged — a working-tree edit')
  })

  it('prefers the checkpoint rail over the view mark when a line carries both', () => {
    expect(railExplanation(line({ since: true, sinceViewed: true }), 'approved'))
      .toBe('Changed since your approval')
  })

  it('says nothing for a line with no rail', () => {
    expect(railExplanation(line(), 'approved')).toBeNull()
  })
})

// zustand v5's bare `useStore()` reads getInitialState() for the SSR snapshot.
type State = ReturnType<typeof useStore.getState>
const initial = (): State => (useStore as unknown as { getInitialState: () => State }).getInitialState()

function render(l: DiffLine): string {
  const f: FileDiff = makeFile({
    path: 'src/a.ts', hunks: [{ range: '@@ -1,1 +1,1 @@', header: '', lines: [l] }]
  } as never)
  const patch = {
    loaded: makeLoaded({ files: [f], headSha: 'head' }),
    diffStack: { out: [], against: 'base' as const }, fileStack: {}, viewedAt: {}, focusTarget: null
  }
  Object.assign(initial(), patch)
  useStore.setState(patch)
  return renderToStaticMarkup(<DiffView f={f} />)
}

describe('the rail hover target', () => {
  it('covers a marked rail with a hit strip — the 3px rail itself cannot be hovered', () => {
    expect(render(line({ since: true }))).toContain('class="rail-hit"')
  })

  it('adds nothing to a line that carries no rail', () => {
    expect(render(line())).not.toContain('rail-hit')
  })

  it('leaves no native title behind — the delayed browser tooltip is what it replaces', () => {
    expect(render(line({ since: true }))).not.toMatch(/class="rail-hit"[^>]*title=/)
  })
})
