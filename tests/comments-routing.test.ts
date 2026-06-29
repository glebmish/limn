import { describe, it, expect, beforeEach, vi } from 'vitest'

// The store reads window.api lazily inside actions, so a minimal stub is enough.
const sendBatch = vi.fn(async () => {})
const createChat = vi.fn(async (): Promise<unknown[]> => [])
;(globalThis as unknown as { window: unknown }).window = { api: { sendBatch, createChat } }

import { useStore, DRAFT_CHAT_ID } from '../src/renderer/store'
import type { LoadedReview } from '../src/shared/ipc'

const flush = () => new Promise((r) => setTimeout(r))
const IDLE_GEN = { running: false, opId: null, kind: null, threadId: null, log: [], error: null, startedAt: null, outcome: null }

const chat = (id: number, engine: 'claude' | 'codex', kind: 'user' | 'review' = 'user') =>
  ({ id, kind, agent: { engine }, messages: [], createdAt: '2026-01-01T00:00:00Z', executionMode: 'ask' as const })

function load(chats: ReturnType<typeof chat>[]) {
  const comments = [{ id: 'c1', status: 'queued', anchor: { kind: 'line' } }]
  useStore.setState({
    loaded: { state: { chats, comments, agent: { engine: 'codex' } } } as unknown as LoadedReview,
    sessionId: 1, gen: IDLE_GEN as never,
  })
}

describe('sendQueuedComments routes to the active chat agent', () => {
  beforeEach(() => { sendBatch.mockClear(); createChat.mockClear() })

  it('sends to the active (non-review) chat — not the review chat', async () => {
    load([chat(1, 'codex', 'review'), chat(7, 'claude')])
    useStore.setState({ activeChatId: 7, draftChat: null })
    useStore.getState().sendQueuedComments(['c1'])
    await flush()
    expect(createChat).not.toHaveBeenCalled()
    expect(sendBatch).toHaveBeenCalledWith(7, ['c1'], undefined, expect.any(String), undefined)
  })

  it('materializes a draft active chat (carrying its mode) before sending', async () => {
    createChat.mockResolvedValueOnce([chat(1, 'codex', 'review'), chat(9, 'claude')])
    load([chat(1, 'codex', 'review')])
    useStore.setState({
      activeChatId: DRAFT_CHAT_ID,
      draftChat: { kind: 'user', agent: { engine: 'claude' }, messages: [], createdAt: '2026-01-01T00:00:00Z', executionMode: 'auto' },
    })
    useStore.getState().sendQueuedComments(['c1'])
    await flush()
    expect(createChat).toHaveBeenCalledWith(1, { engine: 'claude' }, 'auto')
    expect(sendBatch).toHaveBeenCalledWith(9, ['c1'], undefined, expect.any(String), undefined)
  })
})
