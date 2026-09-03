import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileDiff } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'

;(globalThis as unknown as { window: unknown }).window = { api: {} }

import { useStore } from '../src/renderer/store'
import { DiffView } from '../src/renderer/components/DiffView'
import { makeLoaded } from './helpers/loaded'

type State = ReturnType<typeof useStore.getState>
const initial = () => (useStore as unknown as { getInitialState: () => State }).getInitialState()

const file: FileDiff = {
  path: 'src/a.ts', status: 'modified', binary: false, add: 1, del: 0,
  hunks: [
    {
      range: '@@ -12,2 +12,3 @@', header: '', lines: [
        { old: 12, new: 12, kind: '', text: 'a' },
        { old: null, new: 13, kind: 'add', text: 'b' },
        { old: 13, new: 14, kind: '', text: 'c' }
      ]
    },
    {
      range: '@@ -30,1 +31,1 @@', header: '', lines: [
        { old: 30, new: 31, kind: '', text: 'd' }
      ]
    }
  ]
}

function seed(writable: boolean, f: FileDiff = file, against: 'base' | 'approved' | 'viewed' = 'base') {
  const loaded = makeLoaded({ files: [f] })
  ;(loaded as { writeCapability?: unknown }).writeCapability = {
    enabled: writable, reason: writable ? 'available' : 'not-checked-out', branch: 'feat', workdir: writable ? '/wt' : null
  }
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = loaded
  ;(init as { diffStack: unknown }).diffStack = { out: [], against }
}

afterEach(() => {
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = null
  ;(init as { diffStack: unknown }).diffStack = { out: [], against: 'base' }
})

describe('expand-context rows', () => {
  it('renders above / between / below expanders with counts where known', () => {
    seed(true)
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).toContain('expand 11 unchanged lines above')
    expect(out).toContain('expand 16 unchanged lines') // between: 15..30
    // EOF unknown before fetch: a step control down, no count yet
    expect(out).toContain('unchanged lines below')
    expect(out).toContain('aria-label="Expand 20 lines down"')
    expect(out).not.toContain('aria-label="Expand 20 lines up"') // ≤20 runs get the single control
  })

  // final review, finding 4: a hunk's leading gap block is returned straight into the
  // hunk's flattened row array, so the expander needs its own key like every other row
  // there — otherwise React warns once per hunk with a collapsed gap above it.
  // ...and #11 put every row of the file — folds included — into ONE keyed array, so
  // a duplicate key would now be a whole-file hazard rather than a within-hunk one.
  it('renders without a missing- or duplicate-key warning', () => {
    seed(true)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderToStaticMarkup(<DiffView f={file} />)
      const warnings = spy.mock.calls.map((c) => c.map(String).join(' '))
        .filter((m) => /unique "key"|same key/.test(m))
      expect(warnings).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('renders a del row and a same-numbered context row under distinct keys', () => {
    // old:12 (a deletion) and new:12 (a context row) coexist; keyed by side they
    // cannot collide, which is what makes one flat key space per file safe
    const withDel: FileDiff = {
      ...file,
      hunks: [{
        range: '@@ -12,2 +12,2 @@', header: '', lines: [
          { old: 12, new: null, kind: 'del', text: 'gone' },
          { old: 13, new: 12, kind: '', text: 'kept' }
        ]
      }]
    }
    const loaded = makeLoaded({ files: [withDel] })
    ;(loaded as { writeCapability?: unknown }).writeCapability = { enabled: true, reason: 'available', branch: 'feat', workdir: '/wt' }
    ;(initial() as { loaded: LoadedReview | null }).loaded = loaded
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const out = renderToStaticMarkup(<DiffView f={withDel} />)
      expect(out).toContain('data-limn-line="src/a.ts:old:12"')
      expect(out).toContain('data-limn-line="src/a.ts:new:12"')
      expect(spy.mock.calls.map((c) => c.map(String).join(' ')).filter((m) => /key/.test(m))).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  // the fold reads its text through `readFileAt`, which needs no worktree: a
  // read-only (ref vs ref, or checked-out-nowhere) review folds like any other
  it('folds open in a read-only review too', () => {
    seed(false)
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).toContain('<button class="expander-row"')
    expect(out).toContain('expand 11 unchanged lines above')
    expect(out).not.toContain('gap-static')
  })
})

// Fix round 1, Important: with the `@@` head gone, the collapsed run is the ONLY
// thing marking a discontinuity — and `.dline` has no top border, so dropping it made
// hunks at 12–16 and 31–33 render as eight adjacent rows with the gutter silently
// jumping 16 → 31. The run is always modelled — and, since the layouts landed, always
// openable: the text comes from `readFileAt`, in every baseline, worktree or not.
describe('folds in every baseline', () => {
  it('"Since approved" / "Since viewed" fold the runs too, and keep the fn label', () => {
    const sinceHunks = [
      { range: '@@ -12,2 +12,3 @@', header: 'def alpha(x):', lines: [
        { old: 12, new: 12, kind: '', text: 'a' },
        { old: null, new: 13, kind: 'add', text: 'b' },
        { old: 13, new: 14, kind: '', text: 'c' }
      ] },
      { range: '@@ -30,1 +31,1 @@', header: 'class Beta:', lines: [{ old: 30, new: 31, kind: '', text: 'd' }] }
    ]
    // 'approved' reads sinceHunks, 'viewed' reads sinceViewedHunks (store/derive.ts)
    const since = { ...file, sinceHunks, sinceViewedHunks: sinceHunks } as unknown as FileDiff
    for (const mode of ['approved', 'viewed'] as const) {
      for (const writable of [true, false]) {
        seed(writable, since, mode)
        const out = renderToStaticMarkup(<DiffView f={since} />)
        expect(out).toContain('expand 11 unchanged lines above')
        expect(out).toContain('in alpha')
        expect(out).toContain('in Beta')
        expect(out).not.toContain('gap-static')
        expect(out).not.toContain('@@')
        // and the fold sits between the two runs of rows, not after them
        expect(out.indexOf('src/a.ts:new:14')).toBeLessThan(out.indexOf('16 unchanged lines'))
        expect(out.indexOf('16 unchanged lines')).toBeLessThan(out.indexOf('src/a.ts:new:31'))
      }
    }
  })

  it('branch mode on a writable review renders the clickable fold', () => {
    seed(true)
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).toContain('<button class="expander-row"')
    expect(out).toContain('aria-label="Expand 11 hidden lines"')
    expect(out).not.toContain('gap-static')
  })

  it('a binary file gets no runs at all', () => {
    const bin = { ...file, binary: true, hunks: [] } as unknown as FileDiff
    seed(true, bin)
    const out = renderToStaticMarkup(<DiffView f={bin} />)
    expect(out).toContain('Binary file')
    expect(out).not.toContain('expander-row')
  })

  // final review, finding 2: a wholly-new or wholly-deleted file has no file below
  // its last shown row, so the to-EOF run is a phantom — it was asserted for every
  // file with hunks regardless.
  it('an added file gets no trailing run — the hunk is the whole file', () => {
    const added: FileDiff = {
      ...file, status: 'added', add: 3, del: 0,
      hunks: [{ range: '@@ -0,0 +1,3 @@', header: '', lines: [
        { old: null, new: 1, kind: 'add', text: 'one' },
        { old: null, new: 2, kind: 'add', text: 'two' },
        { old: null, new: 3, kind: 'add', text: 'three' }
      ] }]
    }
    for (const writable of [true, false]) {
      seed(writable, added)
      const out = renderToStaticMarkup(<DiffView f={added} />)
      expect(out).not.toContain('unchanged lines below')
      expect(out).not.toContain('expander-row')
    }
  })

  it('a deleted file gets no trailing run — nothing remains on the new side', () => {
    const deleted: FileDiff = {
      ...file, status: 'deleted', add: 0, del: 3,
      hunks: [{ range: '@@ -1,3 +0,0 @@', header: '', lines: [
        { old: 1, new: null, kind: 'del', text: 'one' },
        { old: 2, new: null, kind: 'del', text: 'two' },
        { old: 3, new: null, kind: 'del', text: 'three' }
      ] }]
    }
    for (const writable of [true, false]) {
      seed(writable, deleted)
      const out = renderToStaticMarkup(<DiffView f={deleted} />)
      expect(out).not.toContain('unchanged lines below')
      expect(out).not.toContain('expander-row')
    }
  })

  // #11: the collapsed runs are the ONLY break in the body — the hunk boxes and their
  // `@@` heads are gone, so the two changed runs and the fold between them are
  // siblings in one continuous list.
  it('interleaves folds and rows in one continuous body', () => {
    seed(true)
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).not.toContain('@@')
    expect(out).not.toContain('hunk-head')
    const at = (s: string) => out.indexOf(s)
    expect(at('expand 11 unchanged lines above')).toBeLessThan(at('src/a.ts:new:12'))
    expect(at('src/a.ts:new:14')).toBeLessThan(at('expand 16 unchanged lines'))
    expect(at('expand 16 unchanged lines')).toBeLessThan(at('src/a.ts:new:31'))
    expect(at('src/a.ts:new:31')).toBeLessThan(at('unchanged lines below'))
  })
})
