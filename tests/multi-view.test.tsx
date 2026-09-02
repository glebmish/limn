import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileDiff } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'
;(globalThis as unknown as { window: unknown }).window = { api: {} }
import { useStore } from '../src/renderer/store'
import { DiffView } from '../src/renderer/components/DiffView'
import { makeLoaded } from './helpers/loaded'
import { attributionExplanation } from '../src/renderer/lib/railExplanation'

type State = ReturnType<typeof useStore.getState>
const initial = () => (useStore as unknown as { getInitialState: () => State }).getInitialState()
const file: FileDiff = {
  path: 'src/a.ts', status: 'modified', binary: false, add: 2, del: 1,
  hunks: [{ range: '@@ -1,3 +1,4 @@', header: '', lines: [
    { old: 1, new: 1, kind: '', text: 'ctx' },
    { old: 2, new: null, kind: 'del', text: 'old line' },
    { old: null, new: 2, kind: 'add', text: 'new line', since: true },
    { old: null, new: 3, kind: 'add', text: 'second', since: true },
    { old: 3, new: 4, kind: '', text: 'end' }
  ] }]
}
// the approval already had the replacement, not the second insert
const withMid: FileDiff = { ...file, baseToApprovedHunks: [{ range: '@@ -1,3 +1,3 @@', header: '', lines: [
  { old: 1, new: 1, kind: '', text: 'ctx' },
  { old: 2, new: null, kind: 'del', text: 'old line' },
  { old: null, new: 2, kind: 'add', text: 'new line' },
  { old: 3, new: 3, kind: '', text: 'end' }
] }] }
function seed(layout: 'unified' | 'split' | 'multi', f: FileDiff, over: Partial<State> = {}) {
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = makeLoaded({ files: [f] })
  ;(init as { diffLayout: string }).diffLayout = layout
  Object.assign(init, over)
}
afterEach(() => {
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = null
  ;(init as { diffLayout: string }).diffLayout = 'unified'
  ;(init as { diffMode: string }).diffMode = 'branch'
})

describe('multi layout', () => {
  it('renders three columns named after the checkpoint, attributing the drift', () => {
    seed('multi', withMid, { diffMode: 'approved' } as Partial<State>)
    const out = renderToStaticMarkup(<DiffView f={withMid} />)
    expect(out).toContain('layout-multi')
    expect(out).toMatch(/dcols"><span>Base<\/span><span>Approved<\/span><span>Now<\/span>/)
    // ctx, base 2 (deleted in both), the replacement row, `second` inserted, end
    expect((out.match(/class="dline split"/g) ?? []).length).toBe(5)
    expect((out.match(/attr-since/g) ?? []).length).toBe(1)          // only `second` is new since approval
    expect(out).toMatch(/dcell add attr-since[^>]*src\/a\.ts:new:3/)
    // its rail tooltip (the floating tip mounts on hover, so pin the wording itself)
    expect(attributionExplanation('since', 'approved')).toBe('Changed since you approved this')
    expect(out).not.toContain('data-limn-line="src/a.ts:mid:')       // the middle column is never an anchor
    // the replacement is plain in both side columns: the review covered it
    const rep = out.slice(out.indexOf('src/a.ts:old:2'), out.indexOf('src/a.ts:new:2'))
    expect(rep).not.toContain('attr-')
    expect(rep).toContain('class="dcell add"')
    // the drift rail is not drawn in Multi — attribution replaces it
    expect(rep).not.toContain('dcell add since')
  })

  it('falls back to Split for a file with no checkpoint and says so', () => {
    seed('multi', withMid, { diffMode: 'branch' } as Partial<State>)
    const out = renderToStaticMarkup(<DiffView f={withMid} />)
    expect(out).toContain('layout-split')
    expect(out).toContain('no checkpoint for this file')
    expect(out).not.toContain('dcols')
  })

  it('a checkpoint that exists but did not touch the file still gives three columns', () => {
    seed('multi', { ...file, baseToApprovedHunks: [] }, { diffMode: 'approved' } as Partial<State>)
    const out = renderToStaticMarkup(<DiffView f={{ ...file, baseToApprovedHunks: [] }} />)
    expect(out).toContain('layout-multi')
    expect((out.match(/attr-since/g) ?? []).length).toBe(3) // both adds and the deletion are new since the checkpoint
    expect(out).toContain('del-slot')
  })

  it('a base line the checkpoint deleted but the tree restored is marked gone on the checkpoint cell', () => {
    const restored: FileDiff = { ...file, hunks: [{ range: '@@ -1,3 +1,3 @@', header: '', lines: [
      { old: 1, new: 1, kind: '', text: 'ctx' }, { old: 2, new: 2, kind: '', text: 'old line' }, { old: 3, new: 3, kind: '', text: 'end' }
    ] }], baseToApprovedHunks: [{ range: '@@ -1,3 +1,2 @@', header: '', lines: [
      { old: 1, new: 1, kind: '', text: 'ctx' }, { old: 2, new: null, kind: 'del', text: 'old line' }, { old: 3, new: 2, kind: '', text: 'end' }
    ] }] }
    seed('multi', restored, { diffMode: 'approved' } as Partial<State>)
    const out = renderToStaticMarkup(<DiffView f={restored} />)
    expect(out).toContain('class="dcell del-slot attr-gone"')
    expect(out).toContain('rail-hit') // the strip that carries the explanation on hover
    expect(attributionExplanation('gone', 'approved')).toBe('Was here when you approved this — gone now')
    expect(attributionExplanation('since', 'review')).toBe('Changed since the review ran')
    expect(attributionExplanation('gone', 'viewed')).toBe('Was here when you viewed this file — gone now')
  })
})
