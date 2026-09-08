import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeLoaded } from './helpers/loaded'
import type { ActiveOpSnapshot, LoadedReview } from '../src/shared/ipc'
import type { EngineEvent } from '../src/shared/types'

const loadSession = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
const repoState = vi.fn(async () => ({}))
const listRepoSessions = vi.fn(async () => [])
;(globalThis as unknown as { window: unknown }).window = { api: { loadSession, repoState, listRepoSessions } }

import { useStore } from '../src/renderer/store'
import { handleOpEvent, handleOpResult } from '../src/renderer/store/bridge'
import { clearOrphans, ORPHAN_CAP, ORPHAN_TTL_MS } from '../src/renderer/store/orphans'

const flush = () => new Promise((r) => setTimeout(r))
const ev = (n: number): EngineEvent => ({ type: 'token', text: `t${n}` } as unknown as EngineEvent)
const op = (id: string) => useStore.getState().ops[id]
const snap = (over: Partial<ActiveOpSnapshot> & { opId: string }): ActiveOpSnapshot => ({
  kind: 'chat', threadId: 7, exclusive: false, label: 'Chat', startedAt: new Date().toISOString(), events: [], nextSeq: 0, ...over
})

describe('bridge orphan buffer (events that beat the load snapshot)', () => {
  beforeEach(() => {
    clearOrphans()
    loadSession.mockClear()
    loadSession.mockResolvedValue(makeLoaded())
    useStore.setState({ ops: {}, sessionId: 1, loaded: makeLoaded() })
  })
  afterEach(() => { vi.useRealTimers() })

  it('buffers an op:event for an unknown op and drains it AFTER the snapshot events', () => {
    handleOpEvent({ opId: 'op-race', event: ev(2), seq: 1 })
    handleOpEvent({ opId: 'op-race', event: ev(3), seq: 2 })
    expect(op('op-race')).toBeUndefined() // still nothing in the store
    useStore.getState().adoptOps([snap({ opId: 'op-race', events: [ev(1)], nextSeq: 1 })])
    expect(op('op-race').log).toEqual([ev(1), ev(2), ev(3)]) // snapshot first, then arrival order
    expect(op('op-race').nextSeq).toBe(3)
  })

  it('drops a drained event the snapshot already replayed (seq < nextSeq)', () => {
    handleOpEvent({ opId: 'op-dup', event: ev(1), seq: 0 }) // already inside the snapshot
    handleOpEvent({ opId: 'op-dup', event: ev(2), seq: 1 })
    useStore.getState().adoptOps([snap({ opId: 'op-dup', events: [ev(1)], nextSeq: 1 })])
    expect(op('op-dup').log).toEqual([ev(1), ev(2)])
  })

  it('drains a buffered event that carries no seq', () => {
    handleOpEvent({ opId: 'op-noseq', event: ev(9) })
    useStore.getState().adoptOps([snap({ opId: 'op-noseq', nextSeq: 4 })])
    expect(op('op-noseq').log).toEqual([ev(9)])
  })

  it('applies the buffered op:result after the buffered events (the op finishes)', async () => {
    handleOpEvent({ opId: 'op-fin', event: ev(2), seq: 1 })
    handleOpResult({ opId: 'op-fin', kind: 'chat', status: 'succeeded' })
    useStore.getState().adoptOps([snap({ opId: 'op-fin', events: [ev(1)], nextSeq: 1 })])
    await flush()
    expect(op('op-fin').log).toEqual([ev(1), ev(2)])
    expect(op('op-fin').running).toBe(false)
    expect(op('op-fin').outcome).toBe('succeeded')
    expect(loadSession).toHaveBeenCalledWith(1) // a succeeded result still reloads
  })

  it('corrects the lane from a buffered envelope on drain', () => {
    handleOpEvent({ opId: 'op-lane', event: ev(1), seq: 0, exclusive: true })
    useStore.getState().adoptOps([snap({ opId: 'op-lane', exclusive: false, nextSeq: 0 })])
    expect(op('op-lane').exclusive).toBe(true)
  })

  it('drains only the adopted op — another op’s buffered events stay put', () => {
    handleOpEvent({ opId: 'op-a', event: ev(1), seq: 0 })
    handleOpEvent({ opId: 'op-b', event: ev(2), seq: 0 })
    useStore.getState().adoptOps([snap({ opId: 'op-a', nextSeq: 0 })])
    expect(op('op-a').log).toEqual([ev(1)])
    expect(op('op-b')).toBeUndefined()
    useStore.getState().adoptOps([snap({ opId: 'op-b', nextSeq: 0 })])
    expect(op('op-b').log).toEqual([ev(2)])
  })

  it('holds at most ORPHAN_CAP entries across ops — the oldest are dropped', () => {
    handleOpEvent({ opId: 'op-oldest', event: ev(0), seq: 0 })
    for (let i = 0; i < ORPHAN_CAP; i++) handleOpEvent({ opId: 'op-flood', event: ev(i), seq: i })
    useStore.getState().adoptOps([snap({ opId: 'op-oldest', nextSeq: 0 })])
    expect(op('op-oldest').log).toEqual([]) // evicted by the flood
    useStore.getState().adoptOps([snap({ opId: 'op-flood', nextSeq: 0 })])
    expect(op('op-flood').log.length).toBeGreaterThan(0)
  })

  it('forgets buffered entries older than the TTL', () => {
    vi.useFakeTimers()
    handleOpEvent({ opId: 'op-stale', event: ev(1), seq: 0 })
    vi.advanceTimersByTime(ORPHAN_TTL_MS + 1)
    useStore.getState().adoptOps([snap({ opId: 'op-stale', nextSeq: 0 })])
    expect(op('op-stale').log).toEqual([])
  })

  it('keeps a buffered entry that is still inside the TTL', () => {
    vi.useFakeTimers()
    handleOpEvent({ opId: 'op-fresh', event: ev(1), seq: 0 })
    vi.advanceTimersByTime(ORPHAN_TTL_MS - 1)
    useStore.getState().adoptOps([snap({ opId: 'op-fresh', nextSeq: 0 })])
    expect(op('op-fresh').log).toEqual([ev(1)])
  })
})
