import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileDiff } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'
;(globalThis as unknown as { window: unknown }).window = { api: {} }
import { useStore } from '../src/renderer/store'
import { DiffView } from '../src/renderer/components/DiffView'
import { makeLoaded } from './helpers/loaded'
import { attributionExplanation } from '../src/renderer/lib/railExplanation'
import { UNIFIED, type Stack } from '../src/shared/diffStack'

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
const withMid: FileDiff = { ...file, sinceHunks: file.hunks, baseToApprovedHunks: [{ range: '@@ -1,3 +1,3 @@', header: '', lines: [
  { old: 1, new: 1, kind: '', text: 'ctx' },
  { old: 2, new: null, kind: 'del', text: 'old line' },
  { old: null, new: 2, kind: 'add', text: 'new line' },
  { old: 3, new: 3, kind: '', text: 'end' }
] }] }
function seed(stack: Stack, f: FileDiff, over: Partial<State> = {}) {
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = makeLoaded({ files: [f] })
  ;(init as { diffStack: Stack }).diffStack = stack
  ;(init as { fileStack: Record<string, Stack> }).fileStack = {}
  Object.assign(init, over)
}
afterEach(() => {
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = null
  ;(init as { diffStack: Stack }).diffStack = UNIFIED
})
const multi: Stack = { out: ['approved', 'base'], against: 'base' }

describe('multi layout', () => {
  it('renders three columns named after the checkpoint, attributing the drift', () => {
    seed(multi, withMid)
    const out = renderToStaticMarkup(<DiffView f={withMid} />)
    expect(out).toContain('layout-multi')
    expect(out).toContain('data-cols="3"')
    // captions: base fixed and plain, the checkpoint a picker with an ×, current plain
    const caps = out.slice(out.indexOf('class="dcols"'), out.indexOf('class="gfile-diff'))
    expect(caps).toContain('base · main')
    expect(caps).toMatch(/class="cp"[^>]*>(<span class="cl">)?approval</)
    expect(caps).toContain('current')
    expect((caps.match(/class="cx"/g) ?? []).length).toBe(1)
    // ctx, base 2 (deleted in both), the replacement row, `second` inserted, end
    expect((out.match(/class="dline split"/g) ?? []).length).toBe(5)
    expect((out.match(/attr-since/g) ?? []).length).toBe(1)          // only `second` is new since approval
    expect(out).toMatch(/dcell add attr-since[^>]*src\/a\.ts:new:3/)
    // its rail tooltip (the floating tip mounts on hover, so pin the wording itself)
    expect(attributionExplanation('since', 'approved')).toBe('Current differs from your approval')
    expect(out).not.toContain('data-limn-line="src/a.ts:mid:')       // the middle column is never an anchor
    // the replacement is plain in both side columns: the review covered it
    const rep = out.slice(out.indexOf('src/a.ts:old:2'), out.indexOf('src/a.ts:new:2'))
    expect(rep).not.toContain('attr-')
    expect(rep).toContain('class="dcell add"')
    // the drift rail is not drawn in Multi — attribution replaces it
    expect(rep).not.toContain('dcell add since')
  })

  it('a file without the checkpoint sheet just shows the sheets it has — base beside current, no apology', () => {
    seed(multi, file)
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).toContain('layout-split')
    expect(out).not.toContain('no checkpoint')
    expect(out).not.toContain('stk-ok') // it does not differ from the default: nothing to spread
  })

  it('a checkpoint that exists but did not touch the file still gives three columns', () => {
    const untouched = { ...file, sinceHunks: [], baseToApprovedHunks: [] }
    seed(multi, untouched)
    const out = renderToStaticMarkup(<DiffView f={untouched} />)
    expect(out).toContain('layout-multi')
    expect((out.match(/attr-since/g) ?? []).length).toBe(3) // both adds and the deletion are new since the checkpoint
    expect(out).toContain('del-slot')
  })

  it('a base line the checkpoint deleted but the tree restored is marked since on the current cell', () => {
    const restored: FileDiff = { ...file, sinceHunks: [], hunks: [{ range: '@@ -1,3 +1,3 @@', header: '', lines: [
      { old: 1, new: 1, kind: '', text: 'ctx' }, { old: 2, new: 2, kind: '', text: 'old line' }, { old: 3, new: 3, kind: '', text: 'end' }
    ] }], baseToApprovedHunks: [{ range: '@@ -1,3 +1,2 @@', header: '', lines: [
      { old: 1, new: 1, kind: '', text: 'ctx' }, { old: 2, new: null, kind: 'del', text: 'old line' }, { old: 3, new: 2, kind: '', text: 'end' }
    ] }] }
    seed(multi, restored)
    const out = renderToStaticMarkup(<DiffView f={restored} />)
    // the checkpoint's empty slot carries no mark — it never had the line, so the only
    // true thing to say sits on the current cell, which does
    expect(out).toContain('class="dcell del-slot"')
    expect(out).not.toContain('attr-gone')
    expect(out).toMatch(/dcell\s+attr-since[^>]*src\/a\.ts:new:2/)
    expect(out).toContain('rail-hit') // the strip that carries the explanation on hover
    expect(attributionExplanation('gone', 'approved')).toBe('Your approval had this — current does not')
    expect(attributionExplanation('since', 'review')).toBe('Current differs from the agent review')
    expect(attributionExplanation('gone', 'viewed')).toBe('Your file view had this — current does not')
  })
})
