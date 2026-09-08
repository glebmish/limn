import { describe, it, expect, beforeEach, vi } from 'vitest'

// Fake window.api BEFORE the store module is imported (same shape as
// tests/prefs-sidebar-view.test.ts).
const getPrefs = vi.fn(async () => ({}) as Record<string, string>)
const setPref = vi.fn(async () => {})
;(globalThis as unknown as { window: unknown }).window = { api: { getPrefs, setPref } }

import { useStore } from '../src/renderer/store'

beforeEach(() => {
  getPrefs.mockReset(); getPrefs.mockResolvedValue({})
  setPref.mockClear()
  useStore.setState({ sidebarWidth: 286, chatWidth: 320 })
})

describe('panel width prefs', () => {
  it('defaults to the panel specs', () => {
    expect(useStore.getState().sidebarWidth).toBe(286)
    expect(useStore.getState().chatWidth).toBe(320)
  })

  it('loadPrefs hydrates from a fake getPrefs', async () => {
    getPrefs.mockResolvedValueOnce({ sidebarWidth: '400', chatWidth: '500' })
    await useStore.getState().loadPrefs()
    expect(useStore.getState().sidebarWidth).toBe(400)
    expect(useStore.getState().chatWidth).toBe(500)
  })

  it('loadPrefs clamps an out-of-range stored width', async () => {
    getPrefs.mockResolvedValueOnce({ sidebarWidth: '9999' })
    await useStore.getState().loadPrefs()
    expect(useStore.getState().sidebarWidth).toBe(520)
  })

  it('loadPrefs falls back to the default on an unparseable stored value', async () => {
    getPrefs.mockResolvedValueOnce({ sidebarWidth: '"x"' })
    await useStore.getState().loadPrefs()
    expect(useStore.getState().sidebarWidth).toBe(286)
  })

  it('setPanelWidth updates state and always persists', () => {
    useStore.getState().setPanelWidth('chat', 444)
    expect(useStore.getState().chatWidth).toBe(444)
    expect(setPref).toHaveBeenCalledWith('chatWidth', '444')
  })

  it('setPanelWidth stores the value as given, unclamped', () => {
    useStore.getState().setPanelWidth('sidebar', 9999)
    expect(useStore.getState().sidebarWidth).toBe(9999)
  })
})
