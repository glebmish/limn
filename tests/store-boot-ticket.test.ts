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
  location: { pathname: '/', search: '?open=tkt', href: 'http://limn.localhost:5466/?open=tkt' },
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
  win.location.search = '?open=tkt'; win.location.href = 'http://limn.localhost:5466/?open=tkt'
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
    win.location.search = ''; win.location.href = 'http://limn.localhost:5466/'
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
  })

  it('a failed redeem also falls through to the URL route', async () => {
    win.location.pathname = '/review/12'
    takeCliOpen.mockRejectedValueOnce(new Error('fetch failed'))
    await useStore.getState().boot()
    expect(useStore.getState().resumeExisting).toHaveBeenCalledWith(12)
  })
})
