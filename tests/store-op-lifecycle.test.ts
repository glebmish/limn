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
const op = (id: string) => useStore.getState().ops[id]

describe('op lifecycle', () => {
  beforeEach(() => {
    cancel.mockClear(); loadSession.mockClear()
    useStore.setState({ ops: {}, sessionId: 1, loaded: makeLoaded() })
  })

  it('startOp adds a keyed entry with reset log / outcome / startedAt and running on', () => {
    useStore.getState().startOp('review', 'op-1', 5, true)
    const g = op('op-1')
    expect(g.running).toBe(true)
    expect(g.opId).toBe('op-1')
    expect(g.kind).toBe('review')
    expect(g.threadId).toBe(5)
    expect(g.exclusive).toBe(true)
    expect(g.log).toEqual([])
    expect(g.outcome).toBeNull()
    expect(typeof g.startedAt).toBe('number')
    expect(g.answeredApprovals.size).toBe(0)
  })

  it('startOp evicts a prior (finished) op on the same thread', () => {
    useStore.getState().startOp('chat', 'op-old', 7, true)
    useStore.getState().finishOp('op-old', 'succeeded')
    useStore.getState().startOp('chat', 'op-new', 7, false)
    expect(op('op-old')).toBeUndefined()
    expect(op('op-new').running).toBe(true)
  })

  it('startOp defaults exclusive from whether an exclusive op is already running', () => {
    useStore.getState().startOp('review', 'op-excl', 1) // no exclusive running → exclusive
    expect(op('op-excl').exclusive).toBe(true)
    useStore.getState().startOp('chat', 'op-shared', 2) // an exclusive op runs → shared
    expect(op('op-shared').exclusive).toBe(false)
  })

  it('pushOpEvent is a no-op for an unknown / finished op', () => {
    useStore.getState().pushOpEvent('nope', ev(1))
    expect(op('nope')).toBeUndefined()
    useStore.getState().startOp('chat', 'op-f', 1)
    useStore.getState().finishOp('op-f', 'succeeded')
    useStore.getState().pushOpEvent('op-f', ev(1))
    expect(op('op-f').log).toEqual([])
  })

  it('pushOpEvent retains at most 201 events (slice(-200) then append)', () => {
    useStore.getState().startOp('chat', 'op-2', 1)
    for (let i = 0; i < 250; i++) useStore.getState().pushOpEvent('op-2', ev(i))
    const log = op('op-2').log
    // reality: `[...log.slice(-200), ev]` keeps the last 200 THEN appends one → 201.
    expect(log.length).toBe(201)
    expect((log[log.length - 1] as { text: string }).text).toBe('t249')
    expect((log[0] as { text: string }).text).toBe('t49')
  })

  it('two ops stream independently — one finishing leaves the other running', () => {
    useStore.getState().startOp('review', 'op-gen', 1, true)
    useStore.getState().startOp('chat', 'op-chat', 2, false)
    useStore.getState().pushOpEvent('op-gen', ev(1))
    useStore.getState().pushOpEvent('op-chat', ev(2))
    useStore.getState().finishOp('op-gen', 'succeeded')
    expect(op('op-gen').running).toBe(false)
    expect(op('op-chat').running).toBe(true)
    expect(op('op-chat').log).toHaveLength(1)
  })

  it('finishOp maps failed+error and succeeded outcomes', () => {
    useStore.getState().startOp('chat', 'op-3', 1)
    useStore.getState().finishOp('op-3', 'failed', 'boom', 'ENGINE_SESSION_LOST')
    let g = op('op-3')
    expect(g.running).toBe(false)
    expect(g.outcome).toBe('failed')
    expect(g.error).toBe('boom')
    expect(g.errorCode).toBe('ENGINE_SESSION_LOST')

    useStore.getState().startOp('chat', 'op-4', 1)
    useStore.getState().finishOp('op-4', 'succeeded')
    g = op('op-4')
    expect(g.outcome).toBe('succeeded')
    expect(g.error).toBeNull()
    expect(g.errorCode).toBeNull()
  })

  it('finishOp("failed") without an error message defaults to "unknown error"', () => {
    useStore.getState().startOp('chat', 'op-5', 1)
    useStore.getState().finishOp('op-5', 'failed')
    expect(op('op-5').error).toBe('unknown error')
  })

  it('cancelOp records the cancelled outcome optimistically and calls api.cancel', () => {
    useStore.getState().startOp('review', 'op-6', 1)
    useStore.getState().cancelOp('op-6')
    expect(cancel).toHaveBeenCalledWith('op-6')
    const g = op('op-6')
    expect(g.running).toBe(false)
    expect(g.outcome).toBe('cancelled')
  })

  it('cancelOp is a no-op for an unknown op id', () => {
    useStore.getState().cancelOp('ghost')
    expect(cancel).not.toHaveBeenCalled()
  })
})

describe('op:event / op:result bridge handlers (store/bridge.ts)', () => {
  beforeEach(() => {
    loadSession.mockClear()
    loadSession.mockResolvedValue(makeLoaded())
    useStore.setState({ ops: {}, sessionId: 1, loaded: makeLoaded() })
  })

  it('drops an op:event whose opId is not a known op', () => {
    useStore.getState().startOp('chat', 'op-A', 1)
    handleOpEvent({ opId: 'op-DIFFERENT', event: ev(1) })
    expect(op('op-A').log).toEqual([])
    handleOpEvent({ opId: 'op-A', event: ev(1) })
    expect(op('op-A').log).toHaveLength(1)
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
    expect(op('op-C').outcome).toBe('failed')
  })

  it('onOpResult(failed) WITH the reload flag does reload', async () => {
    useStore.getState().startOp('review', 'op-D', 1)
    handleOpResult({ opId: 'op-D', kind: 'review', status: 'failed', error: 'nope', reload: true })
    await flush()
    expect(loadSession).toHaveBeenCalledWith(1)
  })
})
