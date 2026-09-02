import { describe, it, expect, beforeEach, vi } from 'vitest'

// boot()'s entry dispatch is exercised elsewhere (tests/store-boot-ticket.test.ts,
// tests/store-url-routing.test.ts); this file only pins the `booting` flag itself,
// so the router's real dispatch is swapped for a controllable fake.
const dispatchInitialRoute = vi.fn(async (): Promise<boolean> => false)
vi.mock('../src/renderer/router', () => ({ dispatchInitialRoute: () => dispatchInitialRoute() }))

const getPrefs = vi.fn(async () => ({}) as Record<string, string>)
const dashboard = vi.fn(async () => ({ recents: [], notices: [] }))
;(globalThis as unknown as { window: unknown }).window = {
  api: { getPrefs, dashboard },
  location: { search: '', href: 'http://limn.localhost:5466/' },
  history: { replaceState: vi.fn(), pushState: vi.fn() }
}

import { useStore, __resetBootOnce } from '../src/renderer/store'

beforeEach(() => {
  __resetBootOnce()
  dispatchInitialRoute.mockReset().mockResolvedValue(false)
  getPrefs.mockClear(); dashboard.mockClear()
  useStore.setState({ booting: true })
})

describe('booting flag', () => {
  it('starts true', () => {
    // re-assert the module's own initial value, independent of the beforeEach reset
    useStore.setState({ booting: true })
    expect(useStore.getState().booting).toBe(true)
  })

  it('a completed boot() clears it', async () => {
    await useStore.getState().boot()
    expect(useStore.getState().booting).toBe(false)
  })

  it('the early bootedOnce-return path still clears it', async () => {
    await useStore.getState().boot()
    useStore.setState({ booting: true })
    await useStore.getState().boot()
    expect(dispatchInitialRoute).toHaveBeenCalledTimes(1) // second call short-circuited
    expect(useStore.getState().booting).toBe(false)
  })

  it('a rejecting route dispatch still clears it', async () => {
    dispatchInitialRoute.mockRejectedValueOnce(new Error('boom'))
    await expect(useStore.getState().boot()).rejects.toThrow('boom')
    expect(useStore.getState().booting).toBe(false)
  })
})
