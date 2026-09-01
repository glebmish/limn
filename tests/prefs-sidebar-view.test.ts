import { describe, it, expect, beforeEach, vi } from 'vitest'

// Fake window.api BEFORE the store module is imported (same shape as
// store-boot-ticket.test.ts / other prefs consumers).
const getPrefs = vi.fn(async () => ({}) as Record<string, string>)
const setPref = vi.fn(async () => {})
;(globalThis as unknown as { window: unknown }).window = { api: { getPrefs, setPref } }

import { useStore } from '../src/renderer/store'

beforeEach(() => {
  getPrefs.mockReset(); getPrefs.mockResolvedValue({})
  setPref.mockClear()
  useStore.setState({ sidebarView: 'sections' })
})

describe('sidebarView pref', () => {
  it('defaults to sections', () => {
    expect(useStore.getState().sidebarView).toBe('sections')
  })

  it('loadPrefs hydrates from a fake getPrefs', async () => {
    getPrefs.mockResolvedValueOnce({ sidebarView: '"tree"' })
    await useStore.getState().loadPrefs()
    expect(useStore.getState().sidebarView).toBe('tree')
  })

  it('an unknown stored value falls back to sections', async () => {
    getPrefs.mockResolvedValueOnce({ sidebarView: '"bogus"' })
    await useStore.getState().loadPrefs()
    expect(useStore.getState().sidebarView).toBe('sections')
  })

  it('setSidebarView writes through setPref and updates state', () => {
    useStore.getState().setSidebarView('tree')
    expect(setPref).toHaveBeenCalledWith('sidebarView', '"tree"')
    expect(useStore.getState().sidebarView).toBe('tree')
  })
})
