import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeLoaded } from './helpers/loaded'
import type { EngineEvent } from '../src/shared/types'
import type { LoadedReview } from '../src/shared/ipc'

const cancel = vi.fn(async () => {})
const loadSession = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
const repoState = vi.fn(async () => ({}))
const listRepoSessions = vi.fn(async () => [])
;(globalThis as unknown as { window: unknown }).window = { api: { cancel, loadSession, repoState, listRepoSessions } }

import { useStore } from '../src/renderer/store'
// Exercise the REAL App.tsx push-event bridge handlers (step 4 extracted them from
// App.tsx's useEffect into store/bridge.ts), so the safety net covers the live wiring.
import { handleOpEvent, handleOpResult } from '../src/renderer/store/bridge'

const flush = () => new Promise((r) => setTimeout(r))
const ev = (n: number): EngineEvent => ({ type: 'token', text: `t${n}` } as unknown as EngineEvent)

describe('op lifecycle', () => {
  beforeEach(() => {
    cancel.mockClear(); loadSession.mockClear()
    useStore.getState().finishOp('succeeded') // clear running flag
    useStore.setState({ sessionId: 1, loaded: makeLoaded() })
  })

  it('startOp resets log / outcome / startedAt and flips running on', () => {
    useStore.getState().startOp('review', 'op-1', 5)
    const g = useStore.getState().gen
    expect(g.running).toBe(true)
    expect(g.opId).toBe('op-1')
    expect(g.kind).toBe('review')
    expect(g.threadId).toBe(5)
    expect(g.log).toEqual([])
    expect(g.outcome).toBeNull()
    expect(typeof g.startedAt).toBe('number')
    expect(g.answeredApprovals.size).toBe(0)
  })

  it('pushOpEvent is a no-op when no op is running', () => {
    useStore.getState().finishOp('succeeded') // not running
    useStore.getState().pushOpEvent(ev(1))
    expect(useStore.getState().gen.log).toEqual([])
  })

  it('pushOpEvent retains at most 201 events (slice(-200) then append)', () => {
    useStore.getState().startOp('chat', 'op-2', 1)
    for (let i = 0; i < 250; i++) useStore.getState().pushOpEvent(ev(i))
    const log = useStore.getState().gen.log
    // reality: `[...log.slice(-200), ev]` keeps the last 200 THEN appends one → 201.
    expect(log.length).toBe(201)
    expect((log[log.length - 1] as { text: string }).text).toBe('t249')
    expect((log[0] as { text: string }).text).toBe('t49')
  })

  it('finishOp maps failed+error and succeeded outcomes', () => {
    useStore.getState().startOp('chat', 'op-3', 1)
    useStore.getState().finishOp('failed', 'boom', 'ENGINE_SESSION_LOST')
    let g = useStore.getState().gen
    expect(g.running).toBe(false)
    expect(g.outcome).toBe('failed')
    expect(g.error).toBe('boom')
    expect(g.errorCode).toBe('ENGINE_SESSION_LOST')

    useStore.getState().startOp('chat', 'op-4', 1)
    useStore.getState().finishOp('succeeded')
    g = useStore.getState().gen
    expect(g.outcome).toBe('succeeded')
    expect(g.error).toBeNull()
    expect(g.errorCode).toBeNull()
  })

  it('finishOp("failed") without an error message defaults to "unknown error"', () => {
    useStore.getState().startOp('chat', 'op-5', 1)
    useStore.getState().finishOp('failed')
    expect(useStore.getState().gen.error).toBe('unknown error')
  })

  it('cancelOp records the cancelled outcome optimistically and calls api.cancel', () => {
    useStore.getState().startOp('review', 'op-6', 1)
    useStore.getState().cancelOp()
    expect(cancel).toHaveBeenCalledWith('op-6')
    const g = useStore.getState().gen
    expect(g.running).toBe(false)
    expect(g.outcome).toBe('cancelled')
  })

  it('cancelOp is a no-op when there is no op id', () => {
    useStore.getState().finishOp('succeeded')
    useStore.setState({ gen: { ...useStore.getState().gen, opId: null } })
    useStore.getState().cancelOp()
    expect(cancel).not.toHaveBeenCalled()
  })
})

describe('op:event / op:result bridge handlers (store/bridge.ts)', () => {
  beforeEach(() => {
    loadSession.mockClear()
    loadSession.mockResolvedValue(makeLoaded())
    useStore.getState().finishOp('succeeded')
    useStore.setState({ sessionId: 1, loaded: makeLoaded() })
  })

  it('drops an op:event whose opId does not match the running op', () => {
    useStore.getState().startOp('chat', 'op-A', 1)
    handleOpEvent({ opId: 'op-DIFFERENT', event: ev(1) })
    expect(useStore.getState().gen.log).toEqual([])
    handleOpEvent({ opId: 'op-A', event: ev(1) })
    expect(useStore.getState().gen.log).toHaveLength(1)
  })

  it('onOpResult(succeeded) triggers a reload', async () => {
    useStore.getState().startOp('review', 'op-B', 1)
    handleOpResult({ opId: 'op-B', kind: 'review', status: 'succeeded' })
    await flush()
    expect(loadSession).toHaveBeenCalledWith(1)
  })

  it('onOpResult(failed) without the reload flag does NOT reload', async () => {
    useStore.getState().startOp('review', 'op-C', 1)
    handleOpResult({ opId: 'op-C', kind: 'review', status: 'failed', error: 'nope' })
    await flush()
    expect(loadSession).not.toHaveBeenCalled()
    expect(useStore.getState().gen.outcome).toBe('failed')
  })

  it('onOpResult(failed) WITH the reload flag does reload', async () => {
    useStore.getState().startOp('review', 'op-D', 1)
    handleOpResult({ opId: 'op-D', kind: 'review', status: 'failed', error: 'nope', reload: true })
    await flush()
    expect(loadSession).toHaveBeenCalledWith(1)
  })
})
