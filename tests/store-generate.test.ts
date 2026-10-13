import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeLoaded } from './helpers/loaded'
import type { AgentRef } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'

// The store reads window.api lazily inside actions, so a minimal stub is enough.
const beginReview = vi.fn(async () => 7)
const generate = vi.fn(async () => {})
const loadSession = vi.fn(async (): Promise<LoadedReview> => makeLoaded({ chats: [{ id: 7, kind: 'review', messages: [] }] }))
const repoState = vi.fn(async () => ({}))
const listRepoSessions = vi.fn(async () => [])
;(globalThis as unknown as { window: unknown }).window = {
  api: { beginReview, generate, loadSession, repoState, listRepoSessions },
}

import { startGenerate, startGenerateNow, useStore } from '../src/renderer/store'

const flush = () => new Promise((r) => setTimeout(r))
const agent = { engine: 'claude' } as unknown as AgentRef

describe('startGenerate failure handling', () => {
  beforeEach(() => {
    beginReview.mockReset(); generate.mockReset(); loadSession.mockReset()
    beginReview.mockResolvedValue(7)
    generate.mockResolvedValue(undefined)
    loadSession.mockResolvedValue(makeLoaded({ chats: [{ id: 7, kind: 'review', messages: [] }] }))
    useStore.setState({ sessionId: 1, repo: '/repo', loaded: makeLoaded(), ops: {}, error: null, activeChatId: null })
  })

  it('registers a running exclusive op and fires the generate call', async () => {
    await startGenerate(1, agent, 'op-ok')
    expect(generate).toHaveBeenCalledWith(1, agent, 'op-ok', 7, undefined, undefined)
    const op = useStore.getState().ops['op-ok']
    expect(op.running).toBe(true)
    expect(op.exclusive).toBe(true)
    expect(useStore.getState().activeChatId).toBe(7)
  })

  it('a rejecting beginReview reports the failure instead of being a silent no-op', async () => {
    beginReview.mockRejectedValueOnce(new Error('session is merged'))
    await expect(startGenerate(1, agent, 'op-begin')).resolves.toBeUndefined()
    expect(useStore.getState().error).toBe('session is merged')
    expect(useStore.getState().ops['op-begin']).toBeUndefined()
    expect(generate).not.toHaveBeenCalled()
  })

  it('a rejecting generate retires the op instead of stranding the exclusive lane', async () => {
    // the server rejected before liveOps.start, so no op:result will ever arrive —
    // without a terminal handler the strip spins forever and blocks every other op.
    generate.mockRejectedValueOnce(new Error('generate: 500'))
    await startGenerate(1, agent, 'op-gen')
    await flush()
    const op = useStore.getState().ops['op-gen']
    expect(op.running).toBe(false)
    expect(op.outcome).toBe('failed')
    expect(op.error).toBe('generate: 500')
  })
})

describe('startGenerateNow single flight', () => {
  beforeEach(() => {
    beginReview.mockReset(); generate.mockReset(); loadSession.mockReset()
    generate.mockResolvedValue(undefined)
    loadSession.mockResolvedValue(makeLoaded({ chats: [{ id: 7, kind: 'review', messages: [] }] }))
    useStore.setState({ sessionId: 1, repo: '/repo', loaded: makeLoaded(), ops: {}, error: null, activeChatId: null, generateStarting: false })
  })

  it('a double click starts ONE paid run — the guard holds across the pre-startOp awaits', async () => {
    let release!: (id: number) => void
    beginReview.mockImplementationOnce(() => new Promise<number>((r) => { release = r }))
    const first = startGenerateNow()
    expect(useStore.getState().generateStarting).toBe(true) // set before the first await
    const second = startGenerateNow()
    await flush()
    release(7)
    await Promise.all([first, second])
    expect(beginReview).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(useStore.getState().generateStarting).toBe(false)
  })

  it('clears the flag when the start fails', async () => {
    beginReview.mockRejectedValueOnce(new Error('nope'))
    await startGenerateNow()
    expect(useStore.getState().generateStarting).toBe(false)
    expect(useStore.getState().error).toBe('nope')
  })
})
