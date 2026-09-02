import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileDiff } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'

;(globalThis as unknown as { window: unknown }).window = { api: {} }

import { useStore } from '../src/renderer/store'
import { DiffView } from '../src/renderer/components/DiffView'
import { makeLoaded } from './helpers/loaded'
import { saveChordLabel } from '../src/renderer/lib/platform'

// zustand v5's hooks read getInitialState() for the SSR snapshot — seed by mutating
// the initial state object, exactly as diffview-characterization.test.tsx does.
type State = ReturnType<typeof useStore.getState>
const initial = () => (useStore as unknown as { getInitialState: () => State }).getInitialState()

const file: FileDiff = {
  path: 'src/a.ts', status: 'modified', binary: false, add: 1, del: 1,
  hunks: [{
    range: '@@ -10,3 +10,3 @@', header: '', lines: [
      { old: 10, new: 10, kind: '', text: 'context above' },
      { old: 11, new: null, kind: 'del', text: 'old line' },
      { old: null, new: 11, kind: 'add', text: 'new line', origin: 'unstaged' },
      { old: 12, new: 12, kind: '', text: 'context below' }
    ]
  }]
}

function seed(over: { writable: boolean; frame?: { file: string; start: number; end: number } | null }) {
  const loaded = makeLoaded({ files: [file] })
  ;(loaded as { writeCapability?: unknown }).writeCapability = {
    enabled: over.writable, reason: over.writable ? 'available' : 'not-checked-out', branch: 'feat', workdir: over.writable ? '/wt' : null
  }
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = loaded
  ;(init as { editFrame: unknown }).editFrame = over.frame ? { ...over.frame, frameId: 'test-frame' } : null
}

afterEach(() => {
  const init = initial()
  ;(init as { loaded: LoadedReview | null }).loaded = null
  ;(init as { editFrame: unknown }).editFrame = null
  vi.unstubAllGlobals()
})

describe('in-place edit affordances', () => {
  it('writable review: working-tree rows carry the pencil, − rows do not', () => {
    seed({ writable: true })
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).toContain('aria-label="Edit line 10"')
    expect(out).toContain('aria-label="Edit line 11"')
    expect((out.match(/limn-line-edit/g) ?? []).length).toBe(3) // rows 10, 11(new), 12 — never the − row
  })

  it('read-only review: the affordance is absent, not disabled', () => {
    seed({ writable: false })
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).not.toContain('limn-line-edit')
    expect(out).not.toContain('flow-frame')
    // commenting keeps working everywhere
    expect(out).toContain('limn-line-add')
  })

  it('an open frame replaces its covered rows and slivers the adjacent − row', () => {
    seed({ writable: true, frame: { file: 'src/a.ts', start: 11, end: 12 } })
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).toContain('data-limn-frame="src/a.ts"')
    expect(out).toContain('editing lines 11–12')
    // covered rows (new 11, 12) are gone from the plain diff
    expect(out).not.toContain('data-limn-line="src/a.ts:new:11"')
    expect(out).not.toContain('data-limn-line="src/a.ts:new:12"')
    // the uncovered context row above stays; the − row rides as a sliver
    expect(out).toContain('data-limn-line="src/a.ts:new:10"')
    expect(out).toContain('frame-sliver')
  })

  it('a one-line frame advertises the same keymap as a grown one (#10)', () => {
    seed({ writable: true, frame: { file: 'src/a.ts', start: 11, end: 11 } })
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).toContain('editing line 11')
    // ⏎ must never read as "save" — it inserts a newline in every frame now
    expect(out).toContain('⌘⏎ save')
    expect(out).toContain('⏎ new line')
    expect(out).not.toContain('>⏎ save')
  })

  it('a frame that has not loaded its file yet never advertises ⌫ (#8)', () => {
    // the frame mounts with empty text and a disabled textarea — an empty region is
    // only *deletable* once the file (and so the CAS snapshot) is there
    seed({ writable: true, frame: { file: 'src/a.ts', start: 11, end: 11 } })
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).toContain('⌘⏎ save · ⏎ new line · esc cancel')
    expect(out).not.toContain('⌫')
    expect(out).not.toContain('ff-emptied')
  })

  it('save hint names the chord for the current navigator.platform (#7)', () => {
    seed({ writable: true, frame: { file: 'src/a.ts', start: 11, end: 11 } })
    const out = renderToStaticMarkup(<DiffView f={file} />)
    // Whatever the host reports (this varies by OS/Node — e.g. 'MacIntel' locally,
    // 'Linux x86_64' on CI's ubuntu-latest runners), the title must name that exact
    // chord. Both branches are pinned independently, host-agnostic, below.
    expect(out).toContain(`title="Save (${saveChordLabel(navigator.platform)}) — writes the working tree"`)
  })

  it('names ⌘⏎ on an Apple platform and Ctrl+⏎ elsewhere, regardless of host (#7)', () => {
    seed({ writable: true, frame: { file: 'src/a.ts', start: 11, end: 11 } })
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(renderToStaticMarkup(<DiffView f={file} />))
      .toContain('title="Save (⌘⏎) — writes the working tree"')
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    expect(renderToStaticMarkup(<DiffView f={file} />))
      .toContain('title="Save (Ctrl+⏎) — writes the working tree"')
  })

  it('a frame for another file leaves this one untouched', () => {
    seed({ writable: true, frame: { file: 'src/other.ts', start: 1, end: 1 } })
    const out = renderToStaticMarkup(<DiffView f={file} />)
    expect(out).not.toContain('flow-frame')
    expect(out).toContain('data-limn-line="src/a.ts:new:11"')
  })
})
