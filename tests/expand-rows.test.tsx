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

function seed(writable: boolean) {
  const loaded = makeLoaded({ files: [file] })
  ;(loaded as { writeCapability?: unknown }).writeCapability = {
    enabled: writable, reason: writable ? 'available' : 'not-checked-out', branch: 'feat', workdir: writable ? '/wt' : null
  }
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = loaded
}

afterEach(() => {
  ;(initial() as { loaded: LoadedReview | null }).loaded = null
})

describe('expand-context rows', () => {
  it('renders above / between / below expanders with counts where known', () => {
    seed(true)
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).toContain('expand 11 unchanged lines above')
    expect(out).toContain('expand 16 unchanged lines') // between: 15..30
    expect(out).toContain('expand unchanged lines below') // EOF unknown before fetch
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

  it('no expanders when the worktree is not available (read-only review)', () => {
    seed(false)
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).not.toContain('expander-row')
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
    expect(at('src/a.ts:new:31')).toBeLessThan(at('expand unchanged lines below'))
  })
})
