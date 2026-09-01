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

const file: FileDiff = {
  path: 'src/a.ts', status: 'modified', binary: false, add: 1, del: 0,
  hunks: [{
    range: '@@ -1,2 +1,3 @@', header: '', lines: [
      { old: 1, new: 1, kind: '', text: 'one' },
      { old: null, new: 2, kind: 'add', text: 'two', origin: 'unstaged' },
      { old: 2, new: 3, kind: '', text: 'three' }
    ]
  }]
}

function seed(over: { sel?: { file: string; line: number } | null; frame?: { file: string; start: number; end: number } | null }) {
  const loaded = makeLoaded({ files: [file] })
  ;(loaded as { writeCapability?: unknown }).writeCapability = { enabled: true, reason: 'available', branch: 'feat', workdir: '/wt' }
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = loaded
  ;(init as { lineSelect: unknown }).lineSelect = over.sel ?? null
  ;(init as { editFrame: unknown }).editFrame = over.frame ? { ...over.frame, frameId: 'test-frame' } : null
}

afterEach(() => {
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = null
  ;(init as { lineSelect: unknown }).lineSelect = null
  ;(init as { editFrame: unknown }).editFrame = null
})

describe('post-save line selection', () => {
  it('highlights exactly the selected line', () => {
    seed({ sel: { file: 'src/a.ts', line: 2 } })
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).toContain('line-selected')
    expect((out.match(/line-selected/g) ?? []).length).toBe(1)
    expect(out).toMatch(/line-selected[^>]*data-limn-line="src\/a\.ts:new:2"/)
  })

  it('no highlight for another file, and an open frame suppresses it', () => {
    seed({ sel: { file: 'src/other.ts', line: 2 } })
    expect(renderToStaticMarkup(<DiffView f={file} />)).not.toContain('line-selected')
    seed({ sel: { file: 'src/a.ts', line: 2 }, frame: { file: 'src/a.ts', start: 3, end: 3 } })
    expect(renderToStaticMarkup(<DiffView f={file} />)).not.toContain('line-selected')
  })
})
