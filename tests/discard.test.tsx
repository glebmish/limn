import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileDiff } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'

;(globalThis as unknown as { window: unknown }).window = { api: {} }

import { UNIFIED } from '../src/shared/diffStack'
import { useStore } from '../src/renderer/store'
import { DiffView } from '../src/renderer/components/DiffView'
import { makeLoaded } from './helpers/loaded'

type State = ReturnType<typeof useStore.getState>
const initial = () => (useStore as unknown as { getInitialState: () => State }).getInitialState()

// merged-diff file: one committed add, one staged add, one unstaged −/+ pair
const file: FileDiff = {
  path: 'src/a.ts', status: 'modified', binary: false, add: 3, del: 1,
  hunks: [{
    range: '@@ -10,4 +10,5 @@', header: '', lines: [
      { old: 10, new: 10, kind: '', text: 'ctx' },
      { old: null, new: 11, kind: 'add', text: 'committed add' },
      { old: null, new: 12, kind: 'add', text: 'staged add', origin: 'staged' },
      { old: 11, new: 13, kind: '', text: 'ctx between' },
      { old: 12, new: null, kind: 'del', text: 'was here', origin: 'unstaged' },
      { old: null, new: 14, kind: 'add', text: 'my in-place tweak', origin: 'unstaged' },
      { old: 13, new: 15, kind: '', text: 'ctx2' }
    ]
  }]
}

function seed(writable: boolean) {
  const loaded = makeLoaded({ files: [file] })
  ;(loaded as { writeCapability?: unknown }).writeCapability = {
    enabled: writable, reason: writable ? 'available' : 'not-checked-out', branch: 'feat', workdir: writable ? '/wt' : null
  }
  ;(initial() as { loaded: LoadedReview | null }).loaded = loaded
}

afterEach(() => {
  ;(initial() as { loaded: LoadedReview | null }).loaded = null
  ;(initial() as { diffStack: unknown }).diffStack = UNIFIED
  useStore.setState({ diffStack: UNIFIED })
})

describe('rail ↺ discard', () => {
  it('unstaged rows with a working-tree anchor carry the discard dot; others never do', () => {
    seed(true)
    const out = renderToStaticMarkup(<DiffView f={file} />)
    // every row of the unstaged span hosts the dot (hover shows one at a time);
    // staged/committed rows are never discardable
    expect(out).toContain('aria-label="Discard uncommitted change at line 14"') // the + row
    expect(out).toContain('aria-label="Discard uncommitted change at line 12"') // the − row of the same span
    expect((out.match(/limn-line-discard/g) ?? []).length).toBe(2)
  })

  it('rides the row model into Split too — one dot, on the row the ↺ renders from', () => {
    seed(true)
    useStore.setState({ diffStack: { out: ['base'], against: 'base' } })
    ;(initial() as { diffStack: unknown }).diffStack = { out: ['base'], against: 'base' }
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).toContain('layout-split')
    // the del and the add pair into ONE row there, and the ↺ sits on its anchor cell
    expect(out).toContain('aria-label="Discard uncommitted change at line 14"')
    expect((out.match(/limn-line-discard/g) ?? []).length).toBe(1)
  })

  it('read-only review renders no discard affordance', () => {
    seed(false)
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).not.toContain('limn-line-discard')
  })
})
