import { describe, expect, it } from 'vitest'
import { LiveOpRegistry } from '../src/server/liveOps'
import type { ApprovalRequest, EngineEvent } from '../src/shared/types'

const status = (text: string): EngineEvent => ({ type: 'status', text })

function approval(id: string): EngineEvent {
  const request: ApprovalRequest = { id, engine: 'claude', kind: 'command', summary: `run ${id}` }
  return { type: 'approval_request', request }
}

const nonePending = (): boolean => false
const allPending = (): boolean => true

describe('LiveOpRegistry', () => {
  it('round-trips a started op into a session snapshot', () => {
    const reg = new LiveOpRegistry()
    reg.start({ opId: 'op-1', sessionId: 7, kind: 'review', threadId: 3, exclusive: true })
    reg.record('op-1', status('one'))
    reg.record('op-1', status('two'))

    const [snap] = reg.forSession(7, nonePending)
    expect(snap.opId).toBe('op-1')
    expect(snap.kind).toBe('review')
    expect(snap.threadId).toBe(3)
    expect(snap.exclusive).toBe(true)
    expect(snap.events).toEqual([status('one'), status('two')])
    expect(snap.nextSeq).toBe(2)
    expect(Number.isNaN(Date.parse(snap.startedAt))).toBe(false)
    expect(reg.has('op-1')).toBe(true)
  })

  it('assigns seq from 0, incrementing per event', () => {
    const reg = new LiveOpRegistry()
    reg.start({ opId: 'op-1', sessionId: 1, kind: 'chat', threadId: null, exclusive: false })
    expect(reg.record('op-1', status('a'))).toBe(0)
    expect(reg.record('op-1', status('b'))).toBe(1)
    expect(reg.record('op-1', status('c'))).toBe(2)
  })

  it('throws when recording against an unknown op', () => {
    const reg = new LiveOpRegistry()
    expect(() => reg.record('ghost', status('a'))).toThrow(/ghost/)
  })

  it('end removes the op from snapshots and has()', () => {
    const reg = new LiveOpRegistry()
    reg.start({ opId: 'op-1', sessionId: 1, kind: 'chat', threadId: 2, exclusive: false })
    reg.end('op-1')
    expect(reg.has('op-1')).toBe(false)
    expect(reg.forSession(1, nonePending)).toEqual([])
    reg.end('op-1') // idempotent
  })

  it('setLane corrects the snapshot lane', () => {
    const reg = new LiveOpRegistry()
    reg.start({ opId: 'op-1', sessionId: 1, kind: 'chat', threadId: 2, exclusive: true })
    reg.setLane('op-1', false)
    expect(reg.forSession(1, nonePending)[0].exclusive).toBe(false)
    reg.setLane('unknown', true) // no-op, must not throw
  })

  it('filters by session', () => {
    const reg = new LiveOpRegistry()
    reg.start({ opId: 'a', sessionId: 1, kind: 'chat', threadId: 1, exclusive: false })
    reg.start({ opId: 'b', sessionId: 2, kind: 'chat', threadId: 2, exclusive: false })
    expect(reg.forSession(1, nonePending).map((s) => s.opId)).toEqual(['a'])
    expect(reg.forSession(2, nonePending).map((s) => s.opId)).toEqual(['b'])
    expect(reg.forSession(3, nonePending)).toEqual([])
  })

  it('caps events at the trailing 200 while nextSeq keeps the true count', () => {
    const reg = new LiveOpRegistry()
    reg.start({ opId: 'op-1', sessionId: 1, kind: 'review', threadId: 1, exclusive: true })
    for (let i = 0; i < 250; i++) reg.record('op-1', status(`e${i}`))

    const [snap] = reg.forSession(1, nonePending)
    expect(snap.events).toHaveLength(200)
    expect(snap.events[0]).toEqual(status('e50'))
    expect(snap.events.at(-1)).toEqual(status('e249'))
    expect(snap.nextSeq).toBe(250)
  })

  it('carries an early approval_request that is still pending, ahead of the window', () => {
    const reg = new LiveOpRegistry()
    reg.start({ opId: 'op-1', sessionId: 1, kind: 'chat', threadId: 1, exclusive: true })
    reg.record('op-1', approval('req-1'))
    for (let i = 0; i < 250; i++) reg.record('op-1', status(`e${i}`))

    const [snap] = reg.forSession(1, allPending)
    expect(snap.events).toHaveLength(201)
    expect(snap.events[0]).toEqual(approval('req-1'))
    expect(snap.events[1]).toEqual(status('e50'))
    expect(snap.nextSeq).toBe(251)
  })

  it('drops an early approval_request that is no longer pending', () => {
    const reg = new LiveOpRegistry()
    reg.start({ opId: 'op-1', sessionId: 1, kind: 'chat', threadId: 1, exclusive: true })
    reg.record('op-1', approval('req-1'))
    for (let i = 0; i < 250; i++) reg.record('op-1', status(`e${i}`))

    const [snap] = reg.forSession(1, nonePending)
    expect(snap.events).toHaveLength(200)
    expect(snap.events[0]).toEqual(status('e50'))
  })

  it('passes opId and requestId to the pending predicate', () => {
    const reg = new LiveOpRegistry()
    reg.start({ opId: 'op-1', sessionId: 1, kind: 'chat', threadId: 1, exclusive: true })
    reg.record('op-1', approval('req-1'))
    for (let i = 0; i < 250; i++) reg.record('op-1', status(`e${i}`))

    const seen: Array<[string, string]> = []
    reg.forSession(1, (opId, requestId) => { seen.push([opId, requestId]); return true })
    expect(seen).toEqual([['op-1', 'req-1']])
  })
})
