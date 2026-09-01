import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeLoaded } from './helpers/loaded'
import type { ChatThread } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'

const sendChat = vi.fn(async () => {})
const loadSession = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
const repoState = vi.fn(async () => ({}))
const listRepoSessions = vi.fn(async () => [])
;(globalThis as unknown as { window: unknown }).window = { api: { sendChat, loadSession, repoState, listRepoSessions } }

import { useStore } from '../src/renderer/store'
import { handleOpResult } from '../src/renderer/store/bridge'

const flush = () => new Promise((r) => setTimeout(r))
const chat = (id: number, kind: 'user' | 'review' = 'user'): Partial<ChatThread> =>
  ({ id, kind, agent: { engine: 'claude' }, messages: [], createdAt: 'now', executionMode: 'ask' })
/** A running op streaming into `threadId` — the "this thread is mid-turn" state. */
const runningOp = (threadId: number, exclusive = true) => ({
  [`op-${threadId}`]: { running: true, opId: `op-${threadId}`, kind: 'chat' as const, threadId, log: [], error: null, startedAt: 0, outcome: null, errorCode: null, answeredApprovals: new Set<string>(), exclusive }
})
const queuedOf = (threadId: number) => useStore.getState().queuedTurnByThread[threadId]

describe('queueTurn / dequeueTurn', () => {
  beforeEach(() => {
    sendChat.mockClear(); loadSession.mockClear()
    loadSession.mockResolvedValue(makeLoaded({ chats: [chat(1)] }))
    useStore.setState({ sessionId: 1, ops: {}, activeChatId: 1, draftChat: null, queuedTurnByThread: {}, loaded: makeLoaded({ chats: [chat(1)] }) })
  })

  it('queues (never sends) while the thread has a running turn', () => {
    useStore.setState({ ops: runningOp(1) as never })
    useStore.getState().queueTurn(1, '  and check the tests  ')
    expect(sendChat).not.toHaveBeenCalled()
    expect(queuedOf(1)).toBe('and check the tests') // trimmed
  })

  it('joins a second queued follow-up with a blank line', () => {
    useStore.setState({ ops: runningOp(1) as never })
    useStore.getState().queueTurn(1, 'first')
    useStore.getState().queueTurn(1, 'second')
    expect(queuedOf(1)).toBe('first\n\nsecond')
    expect(sendChat).not.toHaveBeenCalled()
  })

  it('ignores empty/whitespace-only text', () => {
    useStore.getState().queueTurn(1, '   \n ')
    expect(queuedOf(1)).toBeUndefined()
  })

  it('dequeueTurn returns the queued text and clears the entry (empty string when none)', () => {
    useStore.getState().queueTurn(1, 'edit me')
    expect(useStore.getState().dequeueTurn(1)).toBe('edit me')
    expect(queuedOf(1)).toBeUndefined()
    expect(useStore.getState().dequeueTurn(1)).toBe('')
  })
})

describe('flushQueuedTurn (the turn ended)', () => {
  beforeEach(() => {
    sendChat.mockClear(); loadSession.mockClear()
    loadSession.mockResolvedValue(makeLoaded({ chats: [chat(1)] }))
    useStore.setState({ sessionId: 1, ops: {}, activeChatId: 1, draftChat: null, queuedTurnByThread: {}, loaded: makeLoaded({ chats: [chat(1)] }) })
  })

  it('sends the queued text once when the thread\'s op succeeds, and drops the entry', async () => {
    useStore.getState().startOp('chat', 'op-a', 1)
    useStore.getState().queueTurn(1, 'now do the docs')
    handleOpResult({ opId: 'op-a', kind: 'chat', status: 'succeeded' })
    await flush()
    expect(sendChat).toHaveBeenCalledTimes(1)
    expect(sendChat).toHaveBeenCalledWith(1, 'now do the docs', expect.any(String), undefined)
    expect(queuedOf(1)).toBeUndefined()
    // the follow-up's optimistic user message survives the reload that runs with it
    expect(useStore.getState().loaded?.state.chats.find((c) => c.id === 1)?.messages.at(-1))
      .toMatchObject({ role: 'user', text: 'now do the docs' })
  })

  for (const status of ['failed', 'cancelled'] as const) {
    it(`keeps the text queued when the turn ends ${status} (the chip offers Send)`, async () => {
      useStore.getState().startOp('chat', 'op-b', 1)
      useStore.getState().queueTurn(1, 'still pending')
      handleOpResult({ opId: 'op-b', kind: 'chat', status, error: status === 'failed' ? 'boom' : undefined })
      await flush()
      expect(sendChat).not.toHaveBeenCalled()
      expect(queuedOf(1)).toBe('still pending')
    })
  }

  it('leaves the text queued when the lane is full (another chat is still running)', () => {
    useStore.getState().queueTurn(1, 'later')
    useStore.setState({ ops: { ...runningOp(2, true), ...runningOp(3, false) } as never })
    useStore.getState().flushQueuedTurn(1, 'succeeded')
    expect(sendChat).not.toHaveBeenCalled()
    expect(queuedOf(1)).toBe('later')
  })

  it('is a no-op for a thread with nothing queued', () => {
    useStore.getState().flushQueuedTurn(1, 'succeeded')
    expect(sendChat).not.toHaveBeenCalled()
  })
})
