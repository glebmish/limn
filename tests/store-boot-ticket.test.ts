import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// boot() runs against window.api + window.location; both are faked here, in the
// same shape store-routing.test.ts uses (set BEFORE the store module is imported).
const order: string[] = []
const getPrefs = vi.fn(async () => ({}) as Record<string, string>)
const dashboard = vi.fn(async () => { order.push('dashboard'); return { recents: [], notices: [] } })
const takeCliOpen = vi.fn(async (_ticket: string): Promise<unknown> => { order.push('takeCliOpen'); return { repo: '/r', hub: true } })
const replaceState = vi.fn()
const win = {
  api: { getPrefs, dashboard, takeCliOpen },
  location: { search: '?open=tkt', href: 'http://limn.localhost:5466/?open=tkt' },
  history: { replaceState }
}
;(globalThis as unknown as { window: unknown }).window = win

import { useStore } from '../src/renderer/store'

const REAL = { enterHub: useStore.getState().enterHub }
beforeEach(() => {
  order.length = 0
  takeCliOpen.mockClear(); replaceState.mockClear()
  win.location.search = '?open=tkt'; win.location.href = 'http://limn.localhost:5466/?open=tkt'
  useStore.setState({ error: null, enterHub: vi.fn(async () => {}) as never })
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
})
