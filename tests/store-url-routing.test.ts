import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeLoaded } from './helpers/loaded'
import type { LoadedReview } from '../src/shared/ipc'

// The router talks to window.location / window.history / popstate, none of which
// exist in the node test env — so a fake window is installed BEFORE the store is
// imported, the same trick store-boot-ticket.test.ts uses.
//
// `dev` snapshots window.limnDev at module-evaluation time, i.e. during the (hoisted)
// imports below — too early for the fake window to reach it — so the dev hooks are
// mocked instead. `openSession` is armed on purpose: it lets this file assert the
// boot precedence, that a route in the URL outranks the dev hooks.
vi.mock('../src/renderer/dev', () => ({ dev: { openSession: 3 } }))

const getPrefs = vi.fn(async () => ({}) as Record<string, string>)
const dashboard = vi.fn(async () => ({ repos: [], recents: [], notices: [] }))
const loadSession = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
const pushState = vi.fn()
const replaceState = vi.fn()
let popstate: (() => void) | null = null
const win = {
  api: { getPrefs, dashboard, loadSession },
  location: { pathname: '/', search: '', href: 'http://limn.localhost:5466/' },
  history: { pushState, replaceState },
  addEventListener: (type: string, fn: () => void) => { if (type === 'popstate') popstate = fn }
}
;(globalThis as unknown as { window: unknown }).window = win

import { useStore, __resetBootOnce } from '../src/renderer/store'
import { installRouter } from '../src/renderer/router'

// installed once per module, exactly as main.tsx does it at module scope
installRouter(useStore, win)

const flush = () => new Promise((r) => setTimeout(r))

const REAL = {
  resumeExisting: useStore.getState().resumeExisting,
  enterHub: useStore.getState().enterHub,
  openReview: useStore.getState().openReview
}

beforeEach(() => {
  __resetBootOnce()
  win.location.pathname = '/'; win.location.search = ''
  useStore.setState({
    screen: 'dashboard', sessionId: null, repo: null, branch: '', base: '', error: null,
    resumeExisting: vi.fn(async () => {}) as never,
    enterHub: vi.fn(async () => {}) as never,
    openReview: vi.fn(async () => {}) as never
  })
  // the reset above syncs the router's remembered route — clear after it
  pushState.mockClear(); replaceState.mockClear()
})
afterEach(() => { useStore.setState(REAL) })

describe('boot() applies the URL route exactly once', () => {
  it('a /review/<id> URL resumes that session, ahead of the dev hooks, and only on the first boot', async () => {
    win.location.pathname = '/review/12'
    await useStore.getState().boot()
    expect(useStore.getState().resumeExisting).toHaveBeenCalledWith(12)
    expect(useStore.getState().resumeExisting).toHaveBeenCalledTimes(1)
    // a re-mounted Dashboard (or Back to dashboard) boots again: prefs + dashboard
    // reload, but the deep link must not yank the user back to review 12.
    await useStore.getState().boot()
    expect(useStore.getState().resumeExisting).toHaveBeenCalledTimes(1)
  })

  it('a live deep link costs ZERO history entries — the URL is already right', async () => {
    win.location.pathname = '/review/12'
    useStore.setState({
      resumeExisting: vi.fn(async (id: number) => {
        useStore.setState({ screen: 'review', sessionId: id, repo: '/r' })
      }) as never
    })
    await useStore.getState().boot()
    expect(useStore.getState().screen).toBe('review')
    expect(pushState).not.toHaveBeenCalled()
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('a dead /review/<id> stays on the dashboard and rewrites the URL to /', async () => {
    win.location.pathname = '/review/12'
    // exactly what review.ts's resumeExisting does when loadSession throws: surface the
    // error, leave the screen alone. The address bar is then the only thing out of step.
    useStore.setState({
      resumeExisting: vi.fn(async () => { useStore.setState({ error: 'no such session' }) }) as never
    })
    await useStore.getState().boot()
    expect(useStore.getState().screen).toBe('dashboard')
    expect(useStore.getState().error).toBe('no such session')
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
    expect(pushState).not.toHaveBeenCalled()
  })

  it('falls through to the dev hooks when the URL carries no route', async () => {
    await useStore.getState().boot()
    expect(useStore.getState().resumeExisting).toHaveBeenCalledWith(3)
  })
})

describe('store → address bar', () => {
  it('landing on a review pushes /review/<id>, and re-setting the same state pushes nothing', () => {
    useStore.setState({ screen: 'review', sessionId: 5, repo: '/r' })
    expect(pushState).toHaveBeenCalledWith(null, '', '/review/5')
    pushState.mockClear()
    useStore.setState({ screen: 'review', sessionId: 5, repo: '/r' })
    expect(pushState).not.toHaveBeenCalled()
  })

  it('materialize (transient → session, same repo) replaces the entry instead of pushing', () => {
    useStore.setState({ screen: 'review', sessionId: null, repo: '/r', base: 'main', branch: 'feat' })
    expect(pushState).toHaveBeenCalledWith(null, '', '/review?repo=%2Fr&base=main&compare=feat')
    pushState.mockClear(); replaceState.mockClear()
    useStore.setState({ sessionId: 5 })
    expect(replaceState).toHaveBeenCalledWith(null, '', '/review/5')
    expect(pushState).not.toHaveBeenCalled()
  })

  it('carries ?token through the pushed URL', () => {
    win.location.search = '?token=abc'
    useStore.setState({ screen: 'hub', repo: '/r' })
    expect(pushState).toHaveBeenCalledWith(null, '', '/hub?repo=%2Fr&token=abc')
  })
})

describe('popstate', () => {
  it('dispatches the URL it landed on and never pushes while doing it', async () => {
    useStore.setState({ screen: 'review', sessionId: 5, repo: '/r' })
    useStore.setState({
      enterHub: vi.fn(async (repoPath?: string) => {
        useStore.setState({ screen: 'hub', repo: repoPath ?? null, sessionId: null })
      }) as never
    })
    pushState.mockClear(); replaceState.mockClear()

    win.location.pathname = '/hub'; win.location.search = '?repo=%2Fr'
    popstate!()
    await flush()

    expect(useStore.getState().enterHub).toHaveBeenCalledWith('/r')
    expect(useStore.getState().screen).toBe('hub')
    expect(pushState).not.toHaveBeenCalled()
    // the store landed exactly where the URL said → nothing to reconcile
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('two Back presses inside one round trip still push nothing', async () => {
    useStore.setState({ screen: 'review', sessionId: 5, repo: '/r' })
    // the first dispatch is held open so the second starts while it is still in flight
    let releaseFirst: () => void = () => {}
    const held = new Promise<void>((r) => { releaseFirst = r })
    useStore.setState({
      resumeExisting: vi.fn(async (id: number) => {
        await held
        useStore.setState({ screen: 'review', sessionId: id, repo: '/r' })
      }) as never,
      enterHub: vi.fn(async (repoPath?: string) => {
        useStore.setState({ screen: 'hub', repo: repoPath ?? null, sessionId: null })
      }) as never
    })
    pushState.mockClear(); replaceState.mockClear()

    win.location.pathname = '/review/7'; win.location.search = ''
    popstate!()
    win.location.pathname = '/hub'; win.location.search = '?repo=%2Fr'
    popstate!()
    await flush()
    // the FIRST dispatch lands last — with a boolean flag the second one's `finally`
    // would already have un-suppressed the subscription, pushing a history entry the
    // user never asked for (and needing an extra Back press to undo).
    releaseFirst()
    await flush()

    expect(pushState).not.toHaveBeenCalled()
    // the superseded dispatch must not reconcile either — it would rewrite the URL to
    // a page the user navigated away from.
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('an unknown path is treated as the dashboard', async () => {
    useStore.setState({ screen: 'review', sessionId: 5, repo: '/r' })
    pushState.mockClear(); replaceState.mockClear()

    win.location.pathname = '/nope'; win.location.search = ''
    popstate!()
    await flush()

    expect(useStore.getState().screen).toBe('dashboard')
    expect(pushState).not.toHaveBeenCalled()
    // an unparseable URL is never the store's route → rewrite it to the dashboard
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
  })
})
