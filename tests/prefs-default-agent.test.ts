import { describe, it, expect, beforeEach, vi } from 'vitest'

// Fake window.api BEFORE the store module is imported (same shape as
// tests/prefs-sidebar-view.test.ts).
const getPrefs = vi.fn(async () => ({}) as Record<string, string>)
const setPref = vi.fn(async () => {})
;(globalThis as unknown as { window: unknown }).window = { api: { getPrefs, setPref } }

import { useStore } from '../src/renderer/store'
import { defaultAgent } from '../src/shared/agents'

beforeEach(() => {
  getPrefs.mockReset(); getPrefs.mockResolvedValue({})
  setPref.mockReset(); setPref.mockResolvedValue(undefined)
  useStore.setState({ agent: defaultAgent('claude'), defaultAgent: defaultAgent('claude'), agentSeeded: false, loaded: undefined })
})

describe('defaultAgent pref', () => {
  it('loadPrefs hydrates defaultAgent and seeds agent from a valid defaultAgent pref', async () => {
    getPrefs.mockResolvedValueOnce({ defaultAgent: '{"engine":"codex","model":"gpt-5.5"}' })
    await useStore.getState().loadPrefs()
    expect(useStore.getState().defaultAgent).toEqual({ engine: 'codex', model: 'gpt-5.5' })
    expect(useStore.getState().agent).toEqual({ engine: 'codex', model: 'gpt-5.5' })
  })

  it('loadPrefs falls back to the legacy agent pref and does not write it back', async () => {
    getPrefs.mockResolvedValueOnce({ agent: '{"engine":"codex"}' })
    await useStore.getState().loadPrefs()
    expect(useStore.getState().defaultAgent).toEqual({ engine: 'codex' })
    expect(useStore.getState().agent).toEqual({ engine: 'codex' })
    expect(setPref).not.toHaveBeenCalled()
  })

  it('setAgent updates agent in memory only, without writing a pref', () => {
    useStore.getState().setAgent({ engine: 'codex' })
    expect(useStore.getState().agent).toEqual({ engine: 'codex' })
    expect(setPref).not.toHaveBeenCalled()
  })

  it('setDefaultAgent writes the pref and updates both defaultAgent and agent', async () => {
    await useStore.getState().setDefaultAgent({ engine: 'codex' })
    expect(setPref).toHaveBeenCalledWith('defaultAgent', '{"engine":"codex"}')
    expect(useStore.getState().defaultAgent).toEqual({ engine: 'codex' })
    expect(useStore.getState().agent).toEqual({ engine: 'codex' })
  })

  it('a second loadPrefs with a changed stored default updates defaultAgent but leaves the in-session agent pick alone', async () => {
    getPrefs.mockResolvedValueOnce({ defaultAgent: '{"engine":"claude"}' })
    await useStore.getState().loadPrefs()
    expect(useStore.getState().agent).toEqual({ engine: 'claude' })

    useStore.getState().setAgent({ engine: 'codex', model: 'gpt-5.5' })

    getPrefs.mockResolvedValueOnce({ defaultAgent: '{"engine":"codex","model":"gpt-5.4"}' })
    await useStore.getState().loadPrefs()
    expect(useStore.getState().defaultAgent).toEqual({ engine: 'codex', model: 'gpt-5.4' })
    expect(useStore.getState().agent).toEqual({ engine: 'codex', model: 'gpt-5.5' })
  })

  it('setDefaultAgent rejects with the server message and leaves state unchanged on failure', async () => {
    setPref.mockRejectedValueOnce(new Error('unknown engine "bogus" (claude, codex)'))
    const before = useStore.getState()
    await expect(useStore.getState().setDefaultAgent({ engine: 'bogus' } as never))
      .rejects.toThrow('unknown engine "bogus" (claude, codex)')
    expect(useStore.getState().defaultAgent).toEqual(before.defaultAgent)
    expect(useStore.getState().agent).toEqual(before.agent)
  })
})
