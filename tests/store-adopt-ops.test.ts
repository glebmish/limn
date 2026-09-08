import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeLoaded } from './helpers/loaded'
import type { ActiveOpSnapshot, LoadedReview } from '../src/shared/ipc'
import type { ApprovalRequest, EngineEvent } from '../src/shared/types'

const loadSession = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
const previewReview = vi.fn(async (): Promise<LoadedReview> => makeLoaded())
const startSession = vi.fn(async () => ({ sessionId: 9 }))
const findSession = vi.fn(async () => null)
const openRepo = vi.fn(async () => ({ defaultBase: 'main', current: 'feat', branches: ['feat'] }))
const repoState = vi.fn(async () => ({ defaultBase: 'main', current: 'feat', branches: ['feat'] }))
const listRepoSessions = vi.fn(async () => [])
;(globalThis as unknown as { window: unknown }).window = {
  api: { loadSession, previewReview, startSession, findSession, openRepo, repoState, listRepoSessions }
}

import { pendingApprovals, useStore } from '../src/renderer/store'

const flush = () => new Promise((r) => setTimeout(r))
const ev = (n: number): EngineEvent => ({ type: 'token', text: `t${n}` } as unknown as EngineEvent)
const approvalEv = (id: string): EngineEvent => ({ type: 'approval_request', request: { id, engine: 'claude', kind: 'command', summary: `run ${id}` } as ApprovalRequest })
const op = (id: string) => useStore.getState().ops[id]

const snap = (over: Partial<ActiveOpSnapshot> & { opId: string }): ActiveOpSnapshot => ({
  kind: 'chat',
  threadId: 7,
  exclusive: false,
  label: 'Chat',
  startedAt: new Date(1_700_000_000_000).toISOString(),
  events: [],
  nextSeq: 0,
  ...over
})

/** A LoadedReview whose load-time snapshot reports these live ops. */
const loadedWith = (activeOps: ActiveOpSnapshot[]): LoadedReview => ({ ...makeLoaded(), activeOps })

describe('adoptOps', () => {
  beforeEach(() => {
    loadSession.mockClear(); startSession.mockClear(); previewReview.mockClear()
    loadSession.mockResolvedValue(makeLoaded())
    previewReview.mockResolvedValue(makeLoaded())
    useStore.setState({ ops: {}, sessionId: 1, loaded: makeLoaded() })
  })

  it('registers an unknown op with the snapshot kind / thread / lane / start / nextSeq', () => {
    useStore.getState().adoptOps([snap({ opId: 'op-live', kind: 'review', threadId: 3, exclusive: true, nextSeq: 12 })])
    const g = op('op-live')
    expect(g.running).toBe(true)
    expect(g.opId).toBe('op-live')
    expect(g.kind).toBe('review')
    expect(g.threadId).toBe(3)
    expect(g.exclusive).toBe(true)
    expect(g.nextSeq).toBe(12)
    expect(g.startedAt).toBe(1_700_000_000_000)
    expect(g.outcome).toBeNull()
    expect(g.answeredApprovals.size).toBe(0)
  })

  it('replays the snapshot events into the op log', () => {
    useStore.getState().adoptOps([snap({ opId: 'op-replay', events: [ev(1), ev(2), ev(3)], nextSeq: 3 })])
    expect(op('op-replay').log).toEqual([ev(1), ev(2), ev(3)])
  })

  it('replays through the capped log, carrying an unanswered approval_request forward', () => {
    // the server sends the trailing window PLUS still-pending approvals, so the replay
    // can exceed LOG_CAP — it must go through the same carry rule as the live path.
    const events = [approvalEv('req-1'), ...Array.from({ length: 250 }, (_, i) => ev(i))]
    useStore.getState().adoptOps([snap({ opId: 'op-cap', events, nextSeq: 251 })])
    const g = op('op-cap')
    expect(g.log.length).toBe(201) // 200-event window + the carried request
    expect(g.log[0]).toEqual(approvalEv('req-1'))
    expect(pendingApprovals(g).map((r) => r.id)).toEqual(['req-1'])
  })

  it('is a no-op for a known RUNNING op (a reload must not restart the tab’s own stream)', () => {
    useStore.getState().startOp('chat', 'op-mine', 7, false)
    useStore.getState().pushOpEvent('op-mine', ev(1))
    const before = op('op-mine')
    useStore.getState().adoptOps([snap({ opId: 'op-mine', events: [ev(8), ev(9)], nextSeq: 40 })])
    expect(op('op-mine')).toBe(before) // identical state object — untouched
    expect(op('op-mine').log).toHaveLength(1)
  })

  it('is a no-op for a known FINISHED op (never resurrects it)', () => {
    useStore.getState().startOp('chat', 'op-done', 7, false)
    useStore.getState().finishOp('op-done', 'succeeded')
    useStore.getState().adoptOps([snap({ opId: 'op-done' })])
    expect(op('op-done').running).toBe(false)
    expect(op('op-done').outcome).toBe('succeeded')
  })

  it('leaves the ops map alone for an empty snapshot list', () => {
    useStore.getState().startOp('chat', 'op-keep', 7, false)
    const before = useStore.getState().ops
    useStore.getState().adoptOps([])
    expect(useStore.getState().ops).toBe(before)
  })
})

describe('pushOpEvent sequence filtering', () => {
  beforeEach(() => { useStore.setState({ ops: {}, sessionId: 1, loaded: makeLoaded() }) })

  it('drops an event whose seq is below the adopted nextSeq (already replayed)', () => {
    useStore.getState().adoptOps([snap({ opId: 'op-seq', events: [ev(1)], nextSeq: 5 })])
    useStore.getState().pushOpEvent('op-seq', ev(2), 4)
    expect(op('op-seq').log).toEqual([ev(1)])
    expect(op('op-seq').nextSeq).toBe(5)
  })

  it('appends an event at or above nextSeq and advances nextSeq past it', () => {
    useStore.getState().adoptOps([snap({ opId: 'op-seq2', nextSeq: 5 })])
    useStore.getState().pushOpEvent('op-seq2', ev(5), 5)
    expect(op('op-seq2').nextSeq).toBe(6)
    useStore.getState().pushOpEvent('op-seq2', ev(9), 9) // a gap still advances
    expect(op('op-seq2').log).toEqual([ev(5), ev(9)])
    expect(op('op-seq2').nextSeq).toBe(10)
  })

  it('appends an event with no seq (a tab that was present for the whole op)', () => {
    useStore.getState().startOp('chat', 'op-noseq', 1)
    useStore.getState().pushOpEvent('op-noseq', ev(1))
    expect(op('op-noseq').log).toEqual([ev(1)])
    expect(op('op-noseq').nextSeq).toBeUndefined()
    // a seq on a never-adopted op still starts tracking, so later replays dedupe
    useStore.getState().pushOpEvent('op-noseq', ev(2), 3)
    expect(op('op-noseq').nextSeq).toBe(4)
  })
})

describe('review slice adopts the load snapshot', () => {
  beforeEach(() => {
    loadSession.mockClear(); startSession.mockClear(); previewReview.mockClear()
    loadSession.mockResolvedValue(makeLoaded())
    previewReview.mockResolvedValue(makeLoaded())
    useStore.setState({ ops: {}, sessionId: 1, repo: '/repo', repoState: null, loaded: makeLoaded() })
  })

  it('resumeExisting adopts activeOps AFTER the ops reset (the adopted op survives)', async () => {
    useStore.getState().startOp('chat', 'op-previous', 4, true) // a stream from the session we are leaving
    loadSession.mockResolvedValue(loadedWith([snap({ opId: 'op-joined', kind: 'review', threadId: 2, exclusive: true, events: [ev(1)], nextSeq: 1 })]))
    await useStore.getState().resumeExisting(1)
    expect(op('op-previous')).toBeUndefined() // wiped by the ops reset
    expect(op('op-joined').running).toBe(true)
    expect(op('op-joined').log).toEqual([ev(1)])
  })

  it('reload adopts an op that started in another tab while this one sat idle', async () => {
    loadSession.mockResolvedValue(loadedWith([snap({ opId: 'op-other-tab', events: [ev(1), ev(2)], nextSeq: 2 })]))
    await useStore.getState().reload()
    expect(op('op-other-tab').running).toBe(true)
    expect(op('op-other-tab').nextSeq).toBe(2)
  })

  it('materialize adopts the ops the persisted shell reports', async () => {
    useStore.setState({ sessionId: null, loaded: makeLoaded() })
    loadSession.mockResolvedValue(loadedWith([snap({ opId: 'op-materialized' })]))
    await useStore.getState().materialize()
    expect(op('op-materialized').running).toBe(true)
  })

  it('does NOT adopt on openReview’s transient path (no session, nothing to rejoin)', async () => {
    previewReview.mockResolvedValue(loadedWith([snap({ opId: 'op-transient' })]))
    await useStore.getState().openReview('/repo', undefined, { fresh: true })
    await flush()
    expect(op('op-transient')).toBeUndefined()
  })
})
