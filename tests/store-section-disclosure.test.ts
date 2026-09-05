import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeLoaded, makeFile } from './helpers/loaded'
import type { Section } from '../src/shared/types'

const saveUiState = vi.fn(async () => {})
const repoState = vi.fn(async () => ({}))
const listRepoSessions = vi.fn(async () => [])
;(globalThis as unknown as { window: unknown }).window = { api: { saveUiState, repoState, listRepoSessions } }

import { useStore } from '../src/renderer/store'

const section = (id: string, files: string[]): Section => ({ id, name: id, files } as unknown as Section)

function reset(): void {
  useStore.setState({
    sessionId: 1, loaded: null, viewedAt: {},
    collapsed: new Set(), expanded: new Set(), cur: null, curFile: null,
  })
}

describe('section disclosure auto-collapse', () => {
  beforeEach(() => { saveUiState.mockClear(); reset() })

  it('toggleViewed collapses a section once its last file becomes viewed', () => {
    useStore.setState({
      loaded: makeLoaded({ headSha: 'HEAD', files: [makeFile({ path: 'a.ts', fileHash: 'h' })], sections: [section('s1', ['a.ts'])] }),
      expanded: new Set(['s1']),
    })
    useStore.getState().toggleViewed('a.ts', false) // marks a.ts viewed → section fully viewed
    expect(useStore.getState().expanded.has('s1')).toBe(false)
  })

  // A sidebar click on a file leaves it the focus target until the NEXT jump, and a
  // focused file force-shows its body (and force-opens its section). So the tick on
  // the very file you navigated to did nothing visible: no fold, no accent, and the
  // section it completed stayed open. The tick releases the hold.
  it('toggleViewed releases the focus hold on the file it ticks', () => {
    useStore.setState({
      loaded: makeLoaded({ headSha: 'HEAD', files: [makeFile({ path: 'a.ts', fileHash: 'h' })], sections: [section('s1', ['a.ts'])] }),
      focusTarget: { file: 'a.ts', sectionId: 's1' },
    })
    useStore.getState().toggleViewed('a.ts', false)
    expect(useStore.getState().focusTarget).toBeNull()
  })

  it('toggleViewed leaves a focus hold on a DIFFERENT file alone', () => {
    useStore.setState({
      loaded: makeLoaded({ headSha: 'HEAD', files: [makeFile({ path: 'a.ts', fileHash: 'h' }), makeFile({ path: 'b.ts', fileHash: 'h' })] }),
      focusTarget: { file: 'b.ts' },
    })
    useStore.getState().toggleViewed('a.ts', false)
    expect(useStore.getState().focusTarget).toEqual({ file: 'b.ts' })
  })

  it('setSectionViewed drops the force-open override when marking the section viewed', () => {
    useStore.setState({
      loaded: makeLoaded({ headSha: 'HEAD', files: [makeFile({ path: 'a.ts', fileHash: 'h' })], sections: [section('s1', ['a.ts'])] }),
      expanded: new Set(['s1']),
    })
    useStore.getState().setSectionViewed('s1', ['a.ts'], true)
    expect(useStore.getState().viewedAt['a.ts']).toEqual({ sha: 'HEAD', hash: 'h' })
    expect(useStore.getState().expanded.has('s1')).toBe(false)
  })

  it('setSectionViewed(viewed=false) clears the marks without touching expanded', () => {
    useStore.setState({
      loaded: makeLoaded({ headSha: 'HEAD', files: [makeFile({ path: 'a.ts', fileHash: 'h' })] }),
      viewedAt: { 'a.ts': { sha: 'HEAD', hash: 'h' } as never },
      expanded: new Set(['s1']),
    })
    useStore.getState().setSectionViewed('s1', ['a.ts'], false)
    expect(useStore.getState().viewedAt['a.ts']).toBeUndefined()
    expect(useStore.getState().expanded.has('s1')).toBe(true)
  })
})

describe('openSection / toggleSection set interplay', () => {
  beforeEach(reset)

  it('openSection force-opens: removes from collapsed, adds to expanded, sets cur', () => {
    useStore.setState({ collapsed: new Set(['s1']), expanded: new Set(), cur: null })
    useStore.getState().openSection('s1')
    const s = useStore.getState()
    expect(s.collapsed.has('s1')).toBe(false)
    expect(s.expanded.has('s1')).toBe(true)
    expect(s.cur).toBe('s1')
  })

  it('toggleSection(currentlyOpen=true) collapses without setting cur', () => {
    useStore.setState({ collapsed: new Set(), expanded: new Set(['s1']), cur: 'other' })
    useStore.getState().toggleSection('s1', true)
    const s = useStore.getState()
    expect(s.collapsed.has('s1')).toBe(true)
    expect(s.expanded.has('s1')).toBe(false)
    expect(s.cur).toBe('other') // unchanged on collapse
  })

  it('toggleSection(currentlyOpen=false) opens and sets cur', () => {
    useStore.setState({ collapsed: new Set(['s1']), expanded: new Set(), cur: null })
    useStore.getState().toggleSection('s1', false)
    const s = useStore.getState()
    expect(s.collapsed.has('s1')).toBe(false)
    expect(s.expanded.has('s1')).toBe(true)
    expect(s.cur).toBe('s1')
  })
})

describe('setCur / setCurFile identity short-circuit', () => {
  beforeEach(reset)

  it('setCur does not touch state when the id is unchanged', () => {
    useStore.setState({ cur: 'x' })
    const before = useStore.getState()
    useStore.getState().setCur('x')
    expect(useStore.getState()).toBe(before) // no set() → same state reference
    useStore.getState().setCur('y')
    expect(useStore.getState()).not.toBe(before)
    expect(useStore.getState().cur).toBe('y')
  })

  it('setCurFile does not touch state when the file is unchanged', () => {
    useStore.setState({ curFile: 'a.ts' })
    const before = useStore.getState()
    useStore.getState().setCurFile('a.ts')
    expect(useStore.getState()).toBe(before)
    useStore.getState().setCurFile('b.ts')
    expect(useStore.getState().curFile).toBe('b.ts')
  })
})
