import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

;(globalThis as unknown as { window: unknown }).window = { api: {} }

import { useStore } from '../src/renderer/store'
import { DiffView } from '../src/renderer/components/DiffView'
import { makeLoaded, makeFile } from './helpers/loaded'
import type { DiffLine, FileDiff } from '../src/shared/types'

type State = ReturnType<typeof useStore.getState>
const initial = (): State => (useStore as unknown as { getInitialState: () => State }).getInitialState()

const line = (text: string, over: Partial<DiffLine> = {}): DiffLine =>
  ({ old: null, new: 1, kind: 'add', text, ...over })

/** Render one file whose single row carries the given rail flags. */
function render(l: DiffLine, state: Record<string, unknown> = {}): string {
  const f: FileDiff = makeFile({
    path: 'src/a.ts', hunks: [{ range: '@@ -1,1 +1,1 @@', header: '', lines: [l] }]
  } as never)
  const loaded = makeLoaded({ files: [f], headSha: 'head' })
  Object.assign(loaded.state, state)
  const patch = { loaded, diffMode: 'branch' as const, fileDiffMode: {}, viewedAt: {}, focusTarget: null }
  Object.assign(initial(), patch)
  useStore.setState(patch)
  return renderToStaticMarkup(<DiffView f={f} />)
}

const titleOf = (html: string): string | null =>
  html.match(/class="rail-hit" title="([^"]*)"/)?.[1] ?? null

describe('the diff rails explain themselves on hover', () => {
  it('says what the drift rail measures from — an approval', () => {
    expect(titleOf(render(line('x', { since: true }), { approvedSha: 'old' })))
      .toBe('Changed since you approved this')
  })

  it('… or the sha the review was generated at, when nobody approved', () => {
    expect(titleOf(render(line('x', { since: true }), { reviewedAtSha: 'gen' })))
      .toBe('Changed since the review ran')
  })

  it('names the per-file viewed rail for the file, not the review', () => {
    expect(titleOf(render(line('x', { sinceViewed: true }))))
      .toBe('Changed since you viewed this file')
  })

  it('explains the working-tree rails', () => {
    expect(titleOf(render(line('x', { origin: 'staged' })))).toBe('Staged — in the index, not yet committed')
    expect(titleOf(render(line('x', { origin: 'unstaged' })))).toBe('Unstaged — a working-tree edit')
  })

  it('puts no hover target on a line that carries no rail', () => {
    expect(titleOf(render(line('x')))).toBeNull()
  })
})
