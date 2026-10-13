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

/** A since-checkpoint slice's old side is the CHECKPOINT's line space, while every
 *  stored side:'old' anchor is base space (the server stamps it at the merge base).
 *  The two must never meet: no old-side commenting or matching inside a slice, and
 *  whatever the slice does not show is listed, not silently dropped. */
const drifted: FileDiff = {
  ...file,
  hunks: [...file.hunks, { range: '@@ -9,2 +10,2 @@', header: '', lines: [
    { old: 9, new: 10, kind: '', text: 'x' },
    { old: 10, new: null, kind: 'del', text: 'cp line' },
    { old: null, new: 11, kind: 'add', text: 'now line' }
  ] }],
  // checkpoint → now: its old numbers (1, 2) are the checkpoint's, and collide with base's
  sinceHunks: [{ range: '@@ -1,2 +10,2 @@', header: '', lines: [
    { old: 1, new: 10, kind: '', text: 'x' },
    { old: 2, new: null, kind: 'del', text: 'cp line' },
    { old: null, new: 11, kind: 'add', text: 'now line' }
  ] }]
}
const SINCE_UNIFIED: Stack = { out: [], against: 'approved' }
const SINCE_SPLIT: Stack = { out: ['approved'], against: 'base' }
const sliceComments = [comment('b2', 'old', 2), comment('n2', 'new', 2), comment('n11', 'new', 11)]

describe.each([['Unified', SINCE_UNIFIED], ['Split', SINCE_SPLIT]] as const)('a since-checkpoint slice in %s (#10)', (_name, stack) => {
  it('offers no old-side address: no comment button on the checkpoint deletion, no old-side jump target', () => {
    seed(stack, drifted, [])
    const out = renderToStaticMarkup(<DiffView f={drifted} />)
    expect(out).toContain('cp line')
    expect(out).not.toMatch(/data-limn-line(-old)?="src\/a\.ts:old:/)
    expect(out).not.toContain('aria-label="Comment on line 2"')
    expect((out.match(/gutter-add/g) ?? []).length).toBe(2) // the context row and the addition
  })

  it('never shows a base-numbered old-side comment on the checkpoint row that shares its number', () => {
    seed(stack, drifted, sliceComments)
    const out = renderToStaticMarkup(<DiffView f={drifted} />)
    expect(count(out, 'b2')).toBe(1)
    expect(count(out, 'n2')).toBe(1)
    expect(count(out, 'n11')).toBe(1)
    const footer = out.indexOf('outside this view')
    expect(footer).toBeGreaterThan(-1)
    expect(out).toContain('2 comments on lines outside this view')
    // n11 sits inline on its row; b2 and n2 only in the footer
    expect(out.indexOf('data-comment-id="n11"')).toBeLessThan(footer)
    expect(out.indexOf('data-comment-id="b2"')).toBeGreaterThan(footer)
    expect(out.indexOf('data-comment-id="n2"')).toBeGreaterThan(footer)
  })
})

describe('the full diff of the same file', () => {
  it('still hosts base old-side comments inline, with no outside footer', () => {
    seed(UNIFIED, drifted, sliceComments)
    const out = renderToStaticMarkup(<DiffView f={drifted} />)
    expect(out).not.toContain('outside this view')
    expect(out.indexOf('data-comment-id="b2"')).toBeLessThan(out.indexOf('src/a.ts:new:3'))
  })
})
