import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { Comment, FileDiff } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'
;(globalThis as unknown as { window: unknown }).window = { api: {} }
import { useStore } from '../src/renderer/store'
import { DiffView } from '../src/renderer/components/DiffView'
import { makeLoaded } from './helpers/loaded'
import { UNIFIED, type Stack } from '../src/shared/diffStack'
import { initialStateOf } from './helpers/store'
import { focusSelectors } from '../src/renderer/lib/focusScroll'

/** Every (side, line) a rendered row holds is addressable: a comment or finding made
 *  on the old side of a line must render — and be jumpable to — in whichever layout
 *  shows that line, not only in the layout it was made in. */

const file: FileDiff = {
  path: 'src/a.ts', status: 'modified', binary: false, add: 2, del: 1,
  hunks: [{ range: '@@ -1,3 +1,4 @@', header: '', lines: [
    { old: 1, new: 1, kind: '', text: 'ctx' },
    { old: 2, new: null, kind: 'del', text: 'old line' },
    { old: null, new: 2, kind: 'add', text: 'new line' },
    { old: null, new: 3, kind: 'add', text: 'second' },
    { old: 3, new: 4, kind: '', text: 'end' }
  ] }]
}

const comment = (id: string, side: 'old' | 'new', line: number): Partial<Comment> => ({
  id, anchor: { kind: 'diff', file: 'src/a.ts', side, line, hunkRange: '@@ -1,3 +1,4 @@', lineContent: '' },
  author: 'user', text: `note ${id}`, status: 'queued', replies: [], createdAt: 't', iteration: 1
})

const initial = () => initialStateOf(useStore)
function seed(stack: Stack, f: FileDiff, comments: Partial<Comment>[]) {
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = makeLoaded({ files: [f], comments })
  ;(init as { diffStack: Stack }).diffStack = stack
  ;(init as { fileStack: Record<string, Stack> }).fileStack = {}
}
afterEach(() => {
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = null
  ;(init as { diffStack: Stack }).diffStack = UNIFIED
})
const SPLIT: Stack = { out: ['base'], against: 'base' }
const count = (out: string, id: string): number => out.split(`data-comment-id="${id}"`).length - 1

describe('old-side anchors render in every layout (#11)', () => {
  it('Split: a comment on a deleted line paired with an added line renders on that row', () => {
    seed(SPLIT, file, [comment('d2', 'old', 2)])
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(count(out, 'd2')).toBe(1)
    // inline, right after the paired row — not in a footer
    expect(out.indexOf('data-comment-id="d2"')).toBeGreaterThan(out.indexOf('src/a.ts:new:2'))
    expect(out.indexOf('data-comment-id="d2"')).toBeLessThan(out.indexOf('src/a.ts:new:3'))
    expect(out).not.toContain('outside this view')
  })

  it('Split: an old-side comment on a context line renders on that row', () => {
    seed(SPLIT, file, [comment('c1', 'old', 1)])
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(count(out, 'c1')).toBe(1)
    expect(out.indexOf('data-comment-id="c1"')).toBeLessThan(out.indexOf('src/a.ts:old:2'))
  })

  it('Unified: an old-side comment on a context line renders there, and the row is jumpable by its old number', () => {
    seed(UNIFIED, file, [comment('c3', 'old', 3)])
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(count(out, 'c3')).toBe(1)
    expect(out.indexOf('data-comment-id="c3"')).toBeGreaterThan(out.indexOf('src/a.ts:new:4'))
    expect(out).toContain('data-limn-line-old="src/a.ts:old:3"')
  })

  it('a comment on both sides of one row renders each once, never twice', () => {
    seed(SPLIT, file, [comment('d2', 'old', 2), comment('n2', 'new', 2)])
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(count(out, 'd2')).toBe(1)
    expect(count(out, 'n2')).toBe(1)
  })

  it('an old-side jump also resolves the old alias a context row carries', () => {
    const sels = focusSelectors({ kind: 'diff', file: 'src/a.ts', side: 'old', line: 3, hunkRange: '', lineContent: '' })
    expect(sels).toEqual(['[data-limn-line="src/a.ts:old:3"],[data-limn-line-old="src/a.ts:old:3"]'])
  })
})
