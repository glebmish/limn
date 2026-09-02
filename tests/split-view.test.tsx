import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileDiff } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'
;(globalThis as unknown as { window: unknown }).window = { api: {} }
import { useStore } from '../src/renderer/store'
import { DiffView } from '../src/renderer/components/DiffView'
import { makeLoaded } from './helpers/loaded'

type State = ReturnType<typeof useStore.getState>
const initial = () => (useStore as unknown as { getInitialState: () => State }).getInitialState()
export const file: FileDiff = {
  path: 'src/a.ts', status: 'modified', binary: false, add: 2, del: 1,
  hunks: [{ range: '@@ -1,3 +1,4 @@', header: '', lines: [
    { old: 1, new: 1, kind: '', text: 'ctx' },
    { old: 2, new: null, kind: 'del', text: 'old line', origin: 'unstaged' },
    { old: null, new: 2, kind: 'add', text: 'new line', origin: 'unstaged' },
    { old: null, new: 3, kind: 'add', text: 'second', origin: 'unstaged' },
    { old: 3, new: 4, kind: '', text: 'end' }
  ] }]
}
export function seed(layout: 'unified' | 'split' | 'multi', over: Partial<State> = {}, writable = false) {
  const init = initial()
  const loaded = makeLoaded({ files: [file] })
  ;(loaded as { writeCapability?: unknown }).writeCapability = {
    enabled: writable, reason: writable ? 'available' : 'not-checked-out', branch: 'feat', workdir: writable ? '/wt' : null
  }
  ;(init as { loaded: LoadedReview | null }).loaded = loaded
  ;(init as { diffLayout: string }).diffLayout = layout
  Object.assign(init, over)
}
afterEach(() => {
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = null
  ;(init as { diffLayout: string }).diffLayout = 'unified'
  ;(init as { diffMode: string }).diffMode = 'branch'
  ;(init as { editFrame: unknown }).editFrame = null
})

describe('split layout', () => {
  it('renders two cells per row under an Old · Now strip, addressing each side', () => {
    seed('split')
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).toContain('layout-split')
    expect(out).toMatch(/dcols"><span>Old<\/span><span>Now<\/span>/)
    expect(out).toContain('data-limn-line="src/a.ts:old:2"')
    expect(out).toContain('data-limn-line="src/a.ts:new:2"')
    expect((out.match(/class="dline split"/g) ?? []).length).toBe(4) // ctx, pair, padded add, ctx
    // the padded old cell of the second add carries no address
    expect(out).toMatch(/<div class="dcell "><span class="gut"><span><\/span><\/span><span class="sign"><\/span><span class="code"><\/span><\/div><div class="dcell add unstaged"[^>]*src\/a\.ts:new:3/)
  })

  it('puts exactly one comment button per row, on the anchor side', () => {
    seed('split')
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect((out.match(/gutter-add/g) ?? []).length).toBe(4)
    // the paired del/add row anchors on the now line
    const row2 = out.slice(out.indexOf('src/a.ts:old:2'), out.indexOf('src/a.ts:new:3'))
    expect((row2.match(/gutter-add/g) ?? []).length).toBe(1)
    expect(row2.indexOf('gutter-add')).toBeGreaterThan(row2.indexOf('src/a.ts:new:2'))
  })

  it('keeps the drift and origin rails on the now cell, none on the old cell', () => {
    seed('split')
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).toContain('class="dcell add unstaged"')
    expect(out).toContain('class="dcell del unstaged"') // the deletion is an unstaged edit too
  })

  it('unified markup is untouched', () => {
    seed('unified')
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).not.toContain('dcell')
    expect(out).not.toContain('dcols')
    expect(out).toContain('class="dline add unstaged"')
  })

  it('the flow frame occupies the now cell and stacks the old lines beside it', () => {
    seed('split', { editFrame: { file: 'src/a.ts', start: 2, end: 3, frameId: 'x' } } as Partial<State>, true)
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).toContain('dmerged')
    expect(out).toContain('data-limn-frame="src/a.ts"')
    expect(out).toMatch(/dstack[^]*old line/)
    expect(out).not.toContain('data-limn-line="src/a.ts:new:2"')
    expect(out).not.toContain('data-limn-line="src/a.ts:new:3"')
    expect((out.match(/dmerged/g) ?? []).length).toBe(1)
    // the rows outside the frame are still there
    expect(out).toContain('data-limn-line="src/a.ts:new:4"')
  })

  it('highlights the selected line on the now cell only', () => {
    seed('split', { lineSelect: { file: 'src/a.ts', line: 4 } } as Partial<State>, true)
    const out = renderToStaticMarkup(<DiffView f={file} />)
    const sel = [...out.matchAll(/class="dcell[^"]*line-selected"[^>]*data-limn-line="([^"]+)"/g)].map((m) => m[1])
    expect(sel).toEqual(['src/a.ts:new:4'])
  })
})
