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

  it('no expanders when the worktree is not available (read-only review)', () => {
    seed(false)
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).not.toContain('expander-row')
  })
})
