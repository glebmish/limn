import { describe, it, expect, beforeEach, vi } from 'vitest'

// The store reads window.api lazily inside actions, so a minimal stub is enough.
const setChatMode = vi.fn(async () => [])
const createChat = vi.fn(async () => [])
;(globalThis as unknown as { window: unknown }).window = { api: { setChatMode, createChat } }

import { useStore, DRAFT_CHAT_ID } from '../src/renderer/store'
import type { ChatThread } from '../src/shared/types'

const draft = (executionMode: ChatThread['executionMode'] = 'ask') => ({
  kind: 'user' as const, agent: { engine: 'claude' as const }, messages: [],
  createdAt: '2026-01-01T00:00:00Z', executionMode,
})

describe('setChatMode on a draft chat', () => {
  beforeEach(() => {
    setChatMode.mockClear()
    createChat.mockClear()
    useStore.setState({ draftChat: draft('ask'), activeChatId: DRAFT_CHAT_ID })
  })

  it('updates the local draft instead of calling IPC (no "chat thread not found")', async () => {
    await useStore.getState().setChatMode(DRAFT_CHAT_ID, 'auto')
    expect(useStore.getState().draftChat?.executionMode).toBe('auto')
    expect(setChatMode).not.toHaveBeenCalled()
  })

  it('calls IPC for a real (persisted) thread id', async () => {
    await useStore.getState().setChatMode(42, 'full')
    expect(setChatMode).toHaveBeenCalledWith(42, 'full')
  })
})
