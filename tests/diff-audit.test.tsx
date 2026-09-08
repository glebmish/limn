import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileDiff } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'

;(globalThis as unknown as { window: unknown }).window = { api: {} }

import { useStore } from '../src/renderer/store'
import { DiffView } from '../src/renderer/components/DiffView'
import { makeLoaded } from './helpers/loaded'
import { UNIFIED, type Stack } from '../src/shared/diffStack'

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
