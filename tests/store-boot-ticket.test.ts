import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// boot() runs against window.api + window.location; both are faked here, in the
// same shape store-routing.test.ts uses (set BEFORE the store module is imported).
const order: string[] = []
const getPrefs = vi.fn(async () => ({}) as Record<string, string>)
const dashboard = vi.fn(async () => { order.push('dashboard'); return { recents: [], notices: [] } })
const takeCliOpen = vi.fn(async (_ticket: string): Promise<unknown> => { order.push('takeCliOpen'); return { repo: '/r', hub: true } })
const replaceState = vi.fn()
const pushState = vi.fn()
const win = {
  api: { getPrefs, dashboard, takeCliOpen },
  limnDev: {},
  // href is DERIVED, not a third field to keep in step: stripQuery() rebuilds the URL
  // from it, so a stale href would silently hide whether the deep-link pathname survives.
  location: {
    pathname: '/',
    search: '?open=tkt',
    get href() { return `http://limn.localhost:5466${this.pathname}${this.search}` }
  },
  history: { replaceState, pushState },
  addEventListener: (_type: string, _fn: () => void) => {}
}
;(globalThis as unknown as { window: unknown }).window = win

import { useStore, __resetBootOnce } from '../src/renderer/store'
import { installRouter } from '../src/renderer/router'

installRouter(useStore, win)

const REAL = { enterHub: useStore.getState().enterHub, resumeExisting: useStore.getState().resumeExisting }
beforeEach(() => {
  order.length = 0
  __resetBootOnce()
  takeCliOpen.mockClear(); replaceState.mockClear(); pushState.mockClear()
  win.location.pathname = '/'
  win.location.search = '?open=tkt'
  useStore.setState({
    screen: 'dashboard', sessionId: null, repo: null, error: null,
    enterHub: vi.fn(async () => {}) as never,
    resumeExisting: vi.fn(async () => {}) as never
  })
})
afterEach(() => { useStore.setState(REAL) })

describe('boot() with a cli:open ticket in the URL', () => {
  it('loads the dashboard first, strips ?open=, redeems the ticket once, and applies the message', async () => {
    await useStore.getState().boot()
    expect(order).toEqual(['dashboard', 'takeCliOpen'])
    expect(takeCliOpen).toHaveBeenCalledWith('tkt')
    expect(takeCliOpen).toHaveBeenCalledTimes(1)
    // a reload must not replay the ticket
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
    expect(useStore.getState().enterHub).toHaveBeenCalledWith('/r')
  })

  it('an expired / unknown ticket (null) lands on the dashboard with no error', async () => {
    takeCliOpen.mockResolvedValueOnce(null)
    await useStore.getState().boot()
    expect(useStore.getState().enterHub).not.toHaveBeenCalled()
    expect(useStore.getState().error).toBeNull()
  })

  it('a failing redeem (server gone) is swallowed — the dashboard still shows', async () => {
    takeCliOpen.mockRejectedValueOnce(new Error('fetch failed'))
    await expect(useStore.getState().boot()).resolves.toBeUndefined()
    expect(useStore.getState().enterHub).not.toHaveBeenCalled()
  })

  it('no ticket → no redeem and history untouched', async () => {
    win.location.search = ''
    await useStore.getState().boot()
    expect(takeCliOpen).not.toHaveBeenCalled()
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('a REDEEMED ticket outranks a route in the URL — the deep link is not dispatched', async () => {
    win.location.pathname = '/review/12'
    await useStore.getState().boot()
    expect(takeCliOpen).toHaveBeenCalledWith('tkt')
    expect(useStore.getState().resumeExisting).not.toHaveBeenCalled()
  })

  it('a spent ticket hands the boot back to the URL rather than stranding the address bar', async () => {
    win.location.pathname = '/review/12'
    takeCliOpen.mockResolvedValueOnce(null)
    await useStore.getState().boot()
    expect(useStore.getState().resumeExisting).toHaveBeenCalledWith(12)
    // stripping the spent ?open= keeps the deep-link path — the bar still says /review/12
    expect(replaceState).toHaveBeenCalledWith(null, '', '/review/12')
  })

  it('keeps `booting` set until the ticket’s navigation lands (no dashboard flash)', async () => {
    // `limn open` redeems its ticket on `/`, with the dashboard already mounted — so
    // clearing `booting` before enterHub/openReview finishes paints the repo index
    // for the length of the navigation's round trips, which is what the flag exists
    // to prevent.
    let arrive!: () => void
    const navigation = new Promise<void>((r) => { arrive = r })
    let bootingDuringNavigation: boolean | null = null
    useStore.setState({
      booting: true,
      enterHub: vi.fn(async () => {
        bootingDuringNavigation = useStore.getState().booting
        await navigation
      }) as never
    })
    let settled = false
    const booted = useStore.getState().boot().then(() => { settled = true })
    await new Promise((r) => setTimeout(r))
    expect(bootingDuringNavigation).toBe(true)
    expect(settled).toBe(false)
    expect(useStore.getState().booting).toBe(true)
    arrive()
    await booted
    expect(useStore.getState().booting).toBe(false)
  })

  it('a failed redeem also falls through to the URL route', async () => {
    win.location.pathname = '/review/12'
    takeCliOpen.mockRejectedValueOnce(new Error('fetch failed'))
    await useStore.getState().boot()
    expect(useStore.getState().resumeExisting).toHaveBeenCalledWith(12)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/review/12')
  })
})
