import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileDiff } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'

;(globalThis as unknown as { window: unknown }).window = { api: {} }

import { useStore } from '../src/renderer/store'
import { DiffView } from '../src/renderer/components/DiffView'
import { lineKeyIgnored } from '../src/renderer/components/DiffBody'
import { makeLoaded } from './helpers/loaded'
import { initialStateOf } from './helpers/store'

const initial = () => initialStateOf(useStore)

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

describe('the line-selection keys yield to whatever has focus (#8)', () => {
  // a stand-in for an element: `closest` answers whether it sits inside `inside`
  const el = (inside: string | null) => ({
    closest: (sel: string) => (inside != null && sel.split(',').includes(inside) ? {} : null)
  })
  it('handles a key pressed on the page itself', () => {
    expect(lineKeyIgnored({ defaultPrevented: false, target: el(null) })).toBe(false)
    expect(lineKeyIgnored({ defaultPrevented: false, target: null })).toBe(false)
  })
  it('leaves Enter on a focused control to that control — no edit frame opens under it', () => {
    for (const inside of ['button', 'a', 'input', 'textarea', 'select', '[role=button]', '[role=dialog]', '[contenteditable="true"]']) {
      expect(lineKeyIgnored({ defaultPrevented: false, target: el(inside) })).toBe(true)
    }
  })
  it('leaves a key someone already handled alone', () => {
    expect(lineKeyIgnored({ defaultPrevented: true, target: el(null) })).toBe(true)
  })
})
