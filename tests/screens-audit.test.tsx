import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoadedReview } from '../src/shared/ipc'
import type { RepoIndexEntry } from '../src/shared/types'
import { initialStateOf } from './helpers/store'

// The header's two ref pickers are the seam under test: React props are the only
// place an onChange handler exists without a DOM, so the picker is replaced by a
// prop recorder and the recorded handler is called the way a click would call it.
const { pickers } = vi.hoisted(() => ({ pickers: [] as Record<string, unknown>[] }))
vi.mock('../src/renderer/components/RefPicker', () => ({
  RefPicker: (props: Record<string, unknown>) => { pickers.push(props); return null }
}))

// A static render never runs effects, and Dashboard restores the keyboard cursor in
// one. Collecting the real callbacks (the closure the component actually built) and
// running them after the render exercises that code without a DOM.
const { effects } = vi.hoisted(() => ({ effects: [] as (() => unknown)[] }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useEffect: (fn: () => unknown) => { effects.push(fn) } }
})
function runEffects(): void {
  const queued = effects.splice(0)
  for (const fn of queued) fn()
}

// Dashboard's shortcuts live on a window keydown listener; capturing it is how a key
// press gets delivered without a DOM.
const keys: ((e: { key: string; preventDefault(): void }) => void)[] = []
;(globalThis as unknown as { window: unknown; document: unknown }).window = {
  api: {},
  addEventListener: (type: string, fn: unknown) => {
    if (type === 'keydown') keys.push(fn as (e: { key: string; preventDefault(): void }) => void)
  },
  removeEventListener: () => {}
}
;(globalThis as unknown as { document: unknown }).document = { activeElement: null }
// the handler's "is the reviewer typing?" guard instanceof-checks these
Object.assign(globalThis, { HTMLInputElement: class {}, HTMLTextAreaElement: class {} })
const press = (key: string): void => { keys[keys.length - 1]({ key, preventDefault: () => {} }) }

const { useStore } = await import('../src/renderer/store')
const { default: Review } = await import('../src/renderer/screens/Review')
const { default: Dashboard } = await import('../src/renderer/screens/Dashboard')
const { makeLoaded } = await import('./helpers/loaded')

type State = ReturnType<typeof useStore.getState>
const initial = (): State => initialStateOf(useStore)

function seed(over: { base?: string; compare?: string; annotated?: boolean; dirty?: boolean } = {}): { openReview: ReturnType<typeof vi.fn> } {
  const loaded = makeLoaded({
    base: over.base ?? 'main', compare: over.compare ?? 'feat',
    dirty: over.dirty ?? false, ...(over.annotated ? { sections: [] } : {})
  })
  Object.assign(loaded as unknown as Record<string, unknown>, { volatile: [], commits: [], branchHash: 'bh' })
  Object.assign(loaded.skeleton as unknown as Record<string, unknown>, { mergeBase: 'mb00000' })
  const openReview = vi.fn(async () => {})
  Object.assign(initial() as unknown as Record<string, unknown>, {
    loaded, branch: loaded.state.branch, base: loaded.state.base, repo: loaded.state.repo,
    screen: 'review', openReview
  })
  return { openReview }
}

const render = (): string => renderToStaticMarkup(<Review />)
const picker = (label: string): Record<string, unknown> =>
  pickers.find((p) => p.label === label) ?? {}

afterEach(() => {
  pickers.length = 0
  effects.length = 0
  keys.length = 0
  Object.assign(initial() as unknown as Record<string, unknown>, { loaded: null as LoadedReview | null })
})

const repoEntry = (path: string): RepoIndexEntry => ({
  path, current: 'main', defaultBase: 'main', worktrees: [], sessionCount: 0,
  lastActivity: '2026-06-12T10:00:00Z'
})

/** Seed the dashboard the way a return from a repo does: the index reloaded, the
 *  filter box still holding what the reviewer typed, `repo` still on the repo they
 *  drilled into. */
function seedDashboard(repos: string[], filter: string, repo: string | null): void {
  Object.assign(initial() as unknown as Record<string, unknown>, {
    dashboard: { repos: repos.map(repoEntry), recents: [], recentSessions: [], notices: [] },
    filter, repo, sel: 0, booting: false, error: null, screen: 'dashboard',
    boot: vi.fn(async () => {})
  })
  useStore.setState({ sel: 0 })
}

describe('dashboard cursor restore (finding 113)', () => {
  const REPOS = ['/w/alpha', '/w/beta', '/w/gamma']

  it('indexes the list on screen, not the unfiltered one', () => {
    seedDashboard(REPOS, 'gam', '/w/gamma')

    renderToStaticMarkup(<Dashboard />)
    runEffects()

    // 'gamma' is the only row rendered, so the cursor belongs on row 0; 2 (its place
    // in the unfiltered index) points past the end — nothing highlighted, ⏎ dead.
    expect(useStore.getState().sel).toBe(0)
  })

  it('highlights the restored row', () => {
    seedDashboard(REPOS, 'gam', '/w/gamma')
    renderToStaticMarkup(<Dashboard />)
    runEffects()

    // the static render reads the store's INITIAL state, so hand the restored cursor
    // back the way a live re-render would receive it
    Object.assign(initial() as unknown as Record<string, unknown>, { sel: useStore.getState().sel })
    const html = renderToStaticMarkup(<Dashboard />)

    expect(html.match(/limn-repo-row sel/g)).toHaveLength(1)
    expect(html).toContain('<div class="limn-repo-row sel"')
    expect(html).toContain('gamma')
  })

  it('counts rows in the filtered list, not from the top of it', () => {
    // 'ta' keeps beta and zeta, dropping the two rows in between: the remembered repo
    // sits at 1 in the list on screen and at 3 in the unfiltered index — so this
    // pins the computation, not a coincidence with 0.
    seedDashboard(['/w/one', '/w/beta', '/w/two', '/w/zeta'], 'ta', '/w/zeta')

    renderToStaticMarkup(<Dashboard />)
    runEffects()

    expect(useStore.getState().sel).toBe(1)
  })

  it('still restores the row with no filter typed', () => {
    seedDashboard(REPOS, '', '/w/gamma')

    renderToStaticMarkup(<Dashboard />)
    runEffects()

    expect(useStore.getState().sel).toBe(2)
  })

  it('falls back to the top row when the remembered repo is filtered out', () => {
    seedDashboard(REPOS, 'alp', '/w/gamma')

    renderToStaticMarkup(<Dashboard />)
    runEffects()

    expect(useStore.getState().sel).toBe(0)
  })
})

// Pins the filter box across the "one source of truth" refactor (finding 114): the
// box shows the store's filter, and Escape clears it through the store action.
describe('dashboard filter box (finding 114)', () => {
  const REPOS = ['/w/alpha', '/w/beta', '/w/gamma']

  it('shows the store filter in the box', () => {
    seedDashboard(REPOS, 'gam', null)

    const html = renderToStaticMarkup(<Dashboard />)

    expect(html).toContain('<input placeholder="Filter repositories…" aria-label="Filter repositories" value="gam"/>')
    // and the list it filters is the one the box says it is
    expect(html.match(/limn-repo-row/g)).toHaveLength(1)
    expect(html).toContain('<span class="rr-name">gamma</span>')
  })

  it('clears the filter on Escape through the store', () => {
    seedDashboard(REPOS, 'gam', null)
    const setFilter = vi.fn()
    Object.assign(initial() as unknown as Record<string, unknown>, { setFilter })
    renderToStaticMarkup(<Dashboard />)
    runEffects()

    press('Escape')

    expect(setFilter).toHaveBeenCalledWith('')
  })

  it('renders an empty box when nothing is typed', () => {
    seedDashboard(REPOS, '', null)

    const html = renderToStaticMarkup(<Dashboard />)

    expect(html).toContain('<input placeholder="Filter repositories…" aria-label="Filter repositories" value=""/>')
  })
})

describe('review header ref pickers (finding 112)', () => {
  it('carries the reviewer’s base through a compare switch', () => {
    const { openReview } = seed({ base: 'v1.2.0', compare: 'feat' })
    render()

    ;(picker('compare ref').onChange as (v: string) => void)('feat2')

    // NOT { compare: 'feat2' } alone: openReview falls back to the repo's default
    // base for a missing one, which silently moves the review off v1.2.0 — a
    // different diff, a different URL, possibly a different persisted session.
    expect(openReview).toHaveBeenCalledWith('/repo', { base: 'v1.2.0', compare: 'feat2' })
  })

  it('keeps the compare side when the base is switched', () => {
    seed({ base: 'v1.2.0', compare: 'feat' })
    const setSessionBase = vi.fn(async () => {})
    Object.assign(initial() as unknown as Record<string, unknown>, { setSessionBase })
    render()

    ;(picker('base ref').onChange as (v: string) => void)('main')

    // the base side already routes through the store action that keeps the pair whole
    expect(setSessionBase).toHaveBeenCalledWith('main')
  })
})

// Pins the "No changes between" empty state across the de-duplication (finding 115):
// it says the same sentence, once, in the same place, in both review modes.
describe('review empty state (finding 115)', () => {
  const SENTENCE = '<div class="limn-empty">No changes between <b>feat</b> and <b>main</b>.</div>'

  it('renders once in flat (un-narrated) mode, after the file list', () => {
    seed()

    const html = render()

    expect(html.match(/limn-empty/g)).toHaveLength(1)
    expect(html).toContain(SENTENCE)
    expect(html.indexOf('flat-files')).toBeLessThan(html.indexOf('limn-empty'))
  })

  it('renders once in narrated mode too', () => {
    seed({ annotated: true })

    const html = render()

    expect(html.match(/limn-empty/g)).toHaveLength(1)
    expect(html).toContain(SENTENCE)
  })

  it('shortens a base that is a sha', () => {
    seed({ base: '0badc0ffee0badc0ffee0badc0ffee0badc0ffee' })

    expect(render()).toContain('No changes between <b>feat</b> and <b>0badc0f</b>.')
  })

  it('stays away while the working tree is dirty', () => {
    seed({ dirty: true })

    expect(render()).not.toContain('limn-empty')
  })
})
