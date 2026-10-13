import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeLoaded } from './helpers/loaded'
import type { ActiveOpSnapshot, LoadedReview } from '../src/shared/ipc'
import type { ApprovalRequest, EngineEvent } from '../src/shared/types'

// After an SSE gap the page refetches its review (the resync). adoptOps alone skips
// every op the tab already knows, so an op that FINISHED during the gap kept spinning
// forever, and an approval raised during the gap never rendered — its card was only
// ever in the dropped stream. The resync now reconciles the ops it already knows.

const loadSession = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
const repoState = vi.fn(async () => ({}))
const listRepoSessions = vi.fn(async () => [])
;(globalThis as unknown as { window: unknown }).window = { api: { loadSession, repoState, listRepoSessions } }

import { pendingApprovals, useStore } from '../src/renderer/store'

const ev = (n: number): EngineEvent => ({ type: 'token', text: `t${n}` } as unknown as EngineEvent)
const approvalEv = (id: string): EngineEvent => ({ type: 'approval_request', request: { id, engine: 'claude', kind: 'command', summary: `run ${id}` } as ApprovalRequest })
const op = (id: string) => useStore.getState().ops[id]
const snap = (over: Partial<ActiveOpSnapshot> & { opId: string }): ActiveOpSnapshot => ({
  kind: 'chat', threadId: 7, exclusive: true, label: 'Chat', startedAt: new Date().toISOString(), events: [], nextSeq: 0, ...over
})
const loadedWith = (activeOps: ActiveOpSnapshot[]): LoadedReview => ({ ...makeLoaded(), activeOps })

/** a tab-known running op that has streamed `n` sequenced events */
function known(opId: string, n: number) {
  useStore.getState().startOp('chat', opId, 7, true)
  for (let i = 0; i < n; i++) useStore.getState().pushOpEvent(opId, ev(i), i)
}

describe('resync reconciles known ops', () => {
  beforeEach(() => {
    loadSession.mockReset()
    useStore.setState({ ops: {}, sessionId: 1, loaded: makeLoaded(), queuedTurnByThread: {} })
  })

  it('finishes a known running op the server no longer reports', async () => {
    known('op-gone', 2)
    loadSession.mockResolvedValueOnce(loadedWith([]))
    await useStore.getState().refreshLoaded({ resync: true })
    expect(op('op-gone').running).toBe(false)
  })

  it('a plain reload leaves it alone (only a resync closes a gap)', async () => {
    known('op-mine', 2)
    loadSession.mockResolvedValueOnce(loadedWith([]))
    await useStore.getState().reload()
    expect(op('op-mine').running).toBe(true)
  })

  it('does not finish an op this tab just started that the server has not registered yet', async () => {
    useStore.getState().startOp('chat', 'op-fresh', 7, true) // no events yet, started now
    loadSession.mockResolvedValueOnce(loadedWith([]))
    await useStore.getState().refreshLoaded({ resync: true })
    expect(op('op-fresh').running).toBe(true)
  })

  it('appends the events a known op emitted during the gap, without duplicating', async () => {
    known('op-live', 2) // seq 0,1 seen → nextSeq 2
    loadSession.mockResolvedValueOnce(loadedWith([snap({ opId: 'op-live', events: [ev(0), ev(1), ev(2), ev(3)], nextSeq: 4 })]))
    await useStore.getState().refreshLoaded({ resync: true })
    expect(op('op-live').log).toEqual([ev(0), ev(1), ev(2), ev(3)])
    expect(op('op-live').nextSeq).toBe(4)
    expect(op('op-live').running).toBe(true)
    // the live stream resumes at seq 4; a replayed seq 3 is still dropped
    useStore.getState().pushOpEvent('op-live', ev(3), 3)
    useStore.getState().pushOpEvent('op-live', ev(4), 4)
    expect(op('op-live').log).toEqual([ev(0), ev(1), ev(2), ev(3), ev(4)])
  })

  it('renders an approval raised during the gap', async () => {
    known('op-ask', 1)
    loadSession.mockResolvedValueOnce(loadedWith([snap({ opId: 'op-ask', events: [ev(0), approvalEv('req-1')], nextSeq: 2 })]))
    await useStore.getState().refreshLoaded({ resync: true })
    expect(pendingApprovals(op('op-ask')).map((r) => r.id)).toEqual(['req-1'])
  })

  it('keeps a still-parked approval that fell out of the trailing window, once', async () => {
    known('op-old', 1)
    useStore.getState().pushOpEvent('op-old', approvalEv('req-0'), 1) // already in our log
    // snapshot: carried req-0 + req-9 (older than the window), then the window
    const events = [approvalEv('req-0'), approvalEv('req-9'), ev(50), ev(51)]
    loadSession.mockResolvedValueOnce(loadedWith([snap({ opId: 'op-old', events, nextSeq: 52 })]))
    await useStore.getState().refreshLoaded({ resync: true })
    expect(pendingApprovals(op('op-old')).map((r) => r.id).sort()).toEqual(['req-0', 'req-9'])
  })

  it('replays the gap even when live events arrived before the resync snapshot', async () => {
    known('op-race', 2) // seq 0,1 seen; 2,3 lost in the gap
    // the stream reconnects and seq 4,5 arrive live while the load is out
    useStore.getState().pushOpEvent('op-race', ev(4), 4)
    useStore.getState().pushOpEvent('op-race', ev(5), 5)
    expect(op('op-race').nextSeq).toBe(2) // the hole holds the watermark
    // the snapshot was read after seq 4 went out but before 5
    loadSession.mockResolvedValueOnce(loadedWith([snap({ opId: 'op-race', events: [ev(0), ev(1), ev(2), ev(3), ev(4)], nextSeq: 5 })]))
    await useStore.getState().refreshLoaded({ resync: true })
    expect(op('op-race').log).toEqual([ev(0), ev(1), ev(2), ev(3), ev(4), ev(5)])
    expect(op('op-race').nextSeq).toBe(6)
    useStore.getState().pushOpEvent('op-race', ev(5), 5) // still deduped
    useStore.getState().pushOpEvent('op-race', ev(6), 6)
    expect(op('op-race').log).toEqual([ev(0), ev(1), ev(2), ev(3), ev(4), ev(5), ev(6)])
  })

  it('an answered approval missing from the snapshot does not shift the replay', async () => {
    known('op-ans', 2) // seq 0,1 seen
    // seq 2 was an approval answered (in another tab) during the gap, so the server
    // leaves it out of the replay; seq 3,4 are the gap's other events
    const events = [ev(0), ev(1), ev(3), ev(4)]
    loadSession.mockResolvedValueOnce(loadedWith([snap({ opId: 'op-ans', events, seqs: [0, 1, 3, 4], nextSeq: 5 })]))
    await useStore.getState().refreshLoaded({ resync: true })
    expect(op('op-ans').log).toEqual([ev(0), ev(1), ev(3), ev(4)]) // ev(1) not duplicated
    expect(op('op-ans').nextSeq).toBe(5)
  })

  it('reports whether the refresh landed, so the caller can retry', async () => {
    loadSession.mockRejectedValueOnce(new Error('down'))
    expect(await useStore.getState().refreshLoaded({ resync: true })).toBe(false)
    loadSession.mockResolvedValueOnce(loadedWith([]))
    expect(await useStore.getState().refreshLoaded({ resync: true })).toBe(true)
  })
})
