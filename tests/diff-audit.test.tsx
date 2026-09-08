import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileDiff } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'

;(globalThis as unknown as { window: unknown }).window = { api: {} }

import { useStore } from '../src/renderer/store'
import { DiffView, foldsStillOpen } from '../src/renderer/components/DiffView'
import { latchFileRead } from '../src/renderer/components/DiffBody'
import { makeLoaded } from './helpers/loaded'
import { UNIFIED, type Stack } from '../src/shared/diffStack'
import type { FileAt } from '../src/shared/types'

type State = ReturnType<typeof useStore.getState>
const initial = (): State => (useStore as unknown as { getInitialState: () => State }).getInitialState()

const file: FileDiff = {
  path: 'src/a.ts', status: 'modified', binary: false, add: 2, del: 1,
  hunks: [{ range: '@@ -1,3 +1,4 @@', header: '', lines: [
    { old: 1, new: 1, kind: '', text: 'ctx' },
    { old: 2, new: null, kind: 'del', text: 'old line' },
    { old: null, new: 2, kind: 'add', text: 'new line' },
    { old: 3, new: 3, kind: '', text: 'end' }
  ] }]
}

/** the rows only — the caption row above them has a markers key of its own whose
 *  legend swatches carry the same words the rails do */
const diffBody = (html: string): string => html.slice(html.indexOf('class="gfile-diff'))

function seed(stack: Stack, f: FileDiff = file): void {
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = makeLoaded({ files: [f] })
  ;(init as { diffStack: Stack }).diffStack = stack
  ;(init as { fileStack: Record<string, Stack> }).fileStack = {}
}

afterEach(() => {
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = null
  ;(init as { diffStack: Stack }).diffStack = UNIFIED
})

describe('a closed caption picker (#96)', () => {
  it('leaves no option button behind for the keyboard to walk into', () => {
    seed(UNIFIED)
    const out = renderToStaticMarkup(<DiffView f={file} />)
    // the trigger is there and honestly says the listbox is closed…
    expect(out).toContain('aria-expanded="false"')
    // …so the listbox and its options are not in the document at all
    expect(out).not.toContain('role="listbox"')
    expect(out).not.toContain('role="option"')
    expect(out).not.toContain('fh-dd-item')
  })

  it('leaves none behind in Split either, where every column caption is a picker', () => {
    seed({ out: ['base'], against: 'base' })
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).toContain('layout-split')
    expect(out).not.toContain('role="option"')
  })
})

describe('a file read that lands after the file was refreshed (#98)', () => {
  /** what the component's two setters would have been called with */
  class Spy {
    got: string[][] = []
    failed = 0
    sink = { lines: (l: string[]): void => { this.got.push(l) }, failed: (): void => { this.failed++ } }
  }
  const spy = (): Spy => new Spy()

  it('latches the text while the read is still the current one', async () => {
    const s = spy()
    const out = await latchFileRead(Promise.resolve<FileAt>({ ok: true, lines: ['a', 'b'] }), () => true, s.sink)
    expect(out).toEqual(['a', 'b'])
    expect(s.got).toEqual([['a', 'b']])
  })

  it('drops pre-refresh text rather than painting it under post-refresh line numbers', async () => {
    const s = spy()
    const out = await latchFileRead(Promise.resolve<FileAt>({ ok: true, lines: ['stale'] }), () => false, s.sink)
    expect(out).toBeNull()
    expect(s.got).toEqual([])
  })

  it('latches a failure only for the current read — a superseded one leaves the folds live', async () => {
    const cur = spy()
    await latchFileRead(Promise.resolve<FileAt>({ ok: false, reason: 'absent' }), () => true, cur.sink)
    expect(cur.failed).toBe(1)
    const stale = spy()
    await latchFileRead(Promise.resolve<FileAt>({ ok: false, reason: 'absent' }), () => false, stale.sink)
    expect(stale.failed).toBe(0)
  })

  it('treats a rejected read as a failed one, under the same guard', async () => {
    const cur = spy()
    expect(await latchFileRead(Promise.reject(new Error('boom')), () => true, cur.sink)).toBeNull()
    expect(cur.failed).toBe(1)
    const stale = spy()
    expect(await latchFileRead(Promise.reject(new Error('boom')), () => false, stale.sink)).toBeNull()
    expect(stale.failed).toBe(0)
  })
})

describe('the header\'s fold label after a refresh (#99)', () => {
  // a refresh (save, pull, re-generate) mints a new FileDiff for the same path, and
  // the body's fold state resets with it — the header must not go on saying "Collapse"
  const refreshed: FileDiff = { ...file, hunks: [...file.hunks] }

  it('holds while the file object and the stack are the ones it was opened on', () => {
    expect(foldsStillOpen({ f: file, stackKey: 'k' }, file, 'k')).toBe(true)
  })

  it('lapses when the file is refreshed under it — the folds shut, so the label follows', () => {
    expect(refreshed).toEqual(file)                       // same file, same lines…
    expect(foldsStillOpen({ f: file, stackKey: 'k' }, refreshed, 'k')).toBe(false) // …new object
  })

  it('lapses on a stack change, as it always did', () => {
    expect(foldsStillOpen({ f: file, stackKey: 'k' }, file, 'other')).toBe(false)
  })

  it('is closed when nothing opened it', () => {
    expect(foldsStillOpen(null, file, 'k')).toBe(false)
  })

  it('starts closed, offering Expand all', () => {
    seed(UNIFIED)
    expect(renderToStaticMarkup(<DiffView f={file} />)).toContain('aria-label="Expand all folds"')
  })
})

describe('the drift-rail hover strip (#100)', () => {
  // both sides of the replacement drifted since the checkpoint
  const drifted: FileDiff = { ...file, hunks: [{ ...file.hunks[0], lines: [
    { old: 1, new: 1, kind: '', text: 'ctx' },
    { old: 2, new: null, kind: 'del', text: 'old line', since: true },
    { old: null, new: 2, kind: 'add', text: 'new line', since: true },
    { old: 3, new: 3, kind: '', text: 'end' }
  ] }] }

  it('sits only on the cell that draws the rail — Split paints it on current, not on base', () => {
    seed({ out: ['base'], against: 'base' }, drifted)
    const body = diffBody(renderToStaticMarkup(<DiffView f={drifted} />))
    // the now cell carries the mark, and with it the explanation
    expect(body).toMatch(/class="dcell add since"[^>]*><span class="rail-hit"/)
    // the base cell draws no rail (`originCls` gates it on the now column) — so it
    // must offer nothing to hover either
    expect(body).toMatch(/class="dcell del" data-limn-line="src\/a\.ts:old:2"><span class="gut"/)
    expect((body.match(/rail-hit/g) ?? []).length).toBe(1)
  })

  it('offers none in Multi, where the drift rail is not drawn at all', () => {
    const withMid: FileDiff = { ...drifted, sinceHunks: drifted.hunks, baseToApprovedHunks: [{
      range: '@@ -1,3 +1,3 @@', header: '', lines: [
        { old: 1, new: 1, kind: '', text: 'ctx' },
        { old: 2, new: null, kind: 'del', text: 'old line' },
        { old: null, new: 2, kind: 'add', text: 'new line' },
        { old: 3, new: 3, kind: '', text: 'end' }
      ]
    }] }
    seed({ out: ['approved', 'base'], against: 'base' }, withMid)
    const body = diffBody(renderToStaticMarkup(<DiffView f={withMid} />))
    expect(body).toContain('layout-multi')
    expect(body).not.toContain('since')  // no drift rail is painted in Multi…
    expect(body).not.toContain('attr-')  // …and nothing here drifted from the checkpoint
    expect(body).not.toContain('rail-hit')
  })

  it('keeps the working-tree rails explained on every cell — those are painted there', () => {
    const dirty: FileDiff = { ...file, hunks: [{ ...file.hunks[0], lines: [
      { old: 2, new: null, kind: 'del', text: 'old line', origin: 'unstaged' },
      { old: null, new: 2, kind: 'add', text: 'new line', origin: 'unstaged' }
    ] }] }
    seed({ out: ['base'], against: 'base' }, dirty)
    const body = diffBody(renderToStaticMarkup(<DiffView f={dirty} />))
    expect((body.match(/rail-hit/g) ?? []).length).toBe(2)
  })
})
