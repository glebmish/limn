import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeLoaded } from './helpers/loaded'
import { useStore, DRAFT_CHAT_ID } from '../src/renderer/store'
import type { ChatThread } from '../src/shared/types'

const sendChat = vi.fn(async () => {})
const sendBatch = vi.fn(async () => {})
const createChat = vi.fn(async (): Promise<Partial<ChatThread>[]> => [])
;(globalThis as unknown as { window: unknown }).window = { api: { sendChat, sendBatch, createChat } }

const flush = () => new Promise((r) => setTimeout(r))
// a running exclusive op streaming into `threadId`, for the "target thread is busy" guards.
const runningOp = (threadId: number) => ({ 'op-run': { running: true, opId: 'op-run', kind: 'chat' as const, threadId, log: [], error: null, startedAt: 0, outcome: null, errorCode: null, answeredApprovals: new Set<string>(), exclusive: true } })
const anyOpRunning = () => Object.values(useStore.getState().ops).some((o) => o.running)
const chat = (id: number, kind: 'user' | 'review', messages: unknown[] = []): Partial<ChatThread> =>
  ({ id, kind, agent: { engine: 'claude' }, messages: messages as never, createdAt: 'now', executionMode: 'ask' })

function chatsOf() { return useStore.getState().loaded?.state.chats ?? [] }

describe('sendChat', () => {
  beforeEach(() => {
    sendChat.mockClear(); sendBatch.mockClear(); createChat.mockClear()
    useStore.setState({ sessionId: 1, ops: {}, activeChatId: null, draftChat: null })
  })

  it('is a no-op while the target thread already has a running op', async () => {
    useStore.setState({ ops: runningOp(1) as never, loaded: makeLoaded({ chats: [chat(1, 'user')] }), activeChatId: 1 })
    useStore.getState().sendChat('hi')
    await flush()
    expect(createChat).not.toHaveBeenCalled()
    expect(sendChat).not.toHaveBeenCalled()
  })

  it('mints a draft chat then lands the message (with an optimistic user msg) in the minted thread', async () => {
    useStore.setState({
      loaded: makeLoaded({ chats: [chat(1, 'review')] }),
      activeChatId: DRAFT_CHAT_ID,
      draftChat: { kind: 'user', agent: { engine: 'claude' }, messages: [], createdAt: 'now', executionMode: 'auto' } as never,
    })
    // createChat persists the draft → new thread id 77 in the returned list
    createChat.mockResolvedValueOnce([chat(1, 'review'), chat(77, 'user')])
    useStore.getState().sendChat('hello agent')
    await flush()
    expect(createChat).toHaveBeenCalledWith(1, { engine: 'claude' }, 'auto')
    const minted = chatsOf().find((c) => c.id === 77)
    expect(minted?.messages.at(-1)).toMatchObject({ role: 'user', text: 'hello agent' })
    expect(sendChat).toHaveBeenCalledWith(77, 'hello agent', expect.any(String), undefined)
    expect(anyOpRunning()).toBe(true) // startOp fired
    expect(useStore.getState().activeChatId).toBe(77)
    expect(useStore.getState().draftChat).toBeNull()
  })
})

describe('followUp', () => {
  beforeEach(() => {
    sendChat.mockClear(); createChat.mockClear()
    useStore.setState({ sessionId: 1, ops: {}, chatOpen: false })
  })

  it('targets the latest review thread and opens the drawer', async () => {
    useStore.setState({ loaded: makeLoaded({ chats: [chat(1, 'review'), chat(2, 'user'), chat(3, 'review')] }) })
    useStore.getState().followUp('continue please')
    await flush()
    expect(createChat).not.toHaveBeenCalled()
    const review = chatsOf().find((c) => c.id === 3)
    expect(review?.messages.at(-1)).toMatchObject({ role: 'user', text: 'continue please' })
    expect(sendChat).toHaveBeenCalledWith(3, 'continue please', expect.any(String), undefined)
    expect(useStore.getState().chatOpen).toBe(true)
  })

  it('creates a chat with the review agent when no review thread exists', async () => {
    useStore.setState({ loaded: makeLoaded({ chats: [chat(1, 'user')] }) })
    createChat.mockResolvedValueOnce([chat(1, 'user'), chat(88, 'user')])
    useStore.getState().followUp('hey')
    await flush()
    expect(createChat).toHaveBeenCalledWith(1, { engine: 'claude' })
    expect(sendChat).toHaveBeenCalledWith(88, 'hey', expect.any(String), undefined)
  })
})

describe('sendBatch', () => {
  beforeEach(() => {
    sendBatch.mockClear()
    useStore.setState({ sessionId: 1, ops: {}, chatOpen: false })
  })

  it('writes the batchUserPreview text and commentRefs onto the target thread, then dispatches', () => {
    useStore.setState({
      loaded: makeLoaded({
        chats: [chat(5, 'user')],
        comments: [
          { id: 'c1', status: 'queued', anchor: { kind: 'summary' } },
          { id: 'c2', status: 'queued', anchor: { kind: 'summary' } },
        ],
      }),
    })
    useStore.getState().sendBatch(5, ['c1', 'c2'])
    const msg = chatsOf().find((c) => c.id === 5)?.messages.at(-1) as { text: string; commentRefs: string[] }
    expect(msg.text).toBe('Handle 2 comment(s).')
    expect(msg.commentRefs).toEqual(['c1', 'c2'])
    expect(sendBatch).toHaveBeenCalledWith(5, ['c1', 'c2'], undefined, expect.any(String), undefined)
    expect(anyOpRunning()).toBe(true)
    expect(useStore.getState().chatOpen).toBe(true)
  })

  it('is a no-op with no comments and no steer text', () => {
    useStore.setState({ loaded: makeLoaded({ chats: [chat(5, 'user')] }) })
    useStore.getState().sendBatch(5, [])
    expect(sendBatch).not.toHaveBeenCalled()
  })
})
