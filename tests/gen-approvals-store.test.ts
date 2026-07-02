import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ApprovalRequest, EngineEvent } from '../src/shared/types'

// The store reads window.api lazily inside actions, so a minimal stub is enough.
const respondApproval = vi.fn()
;(globalThis as unknown as { window: unknown }).window = { api: { respondApproval } }

import { pendingApprovals, useStore } from '../src/renderer/store'
import type { GenState } from '../src/renderer/store'

const req = (id: string): ApprovalRequest => ({
  id, engine: 'claude', kind: 'command', summary: `run ${id}`,
})
const approvalEvent = (id: string): EngineEvent => ({ type: 'approval_request', request: req(id) })
const statusEvent: EngineEvent = { type: 'status', text: 'thinking' }

const gen = (over: Partial<GenState> = {}): GenState => ({
  running: true, opId: 'op1', kind: 'chat', threadId: 1, log: [], error: null,
  startedAt: 0, outcome: null, errorCode: null, answeredApprovals: new Set<string>(),
  exclusive: false,
  ...over,
})

describe('pendingApprovals derivation', () => {
  it('returns [] when the op is not running', () => {
    expect(pendingApprovals(gen({ running: false, log: [approvalEvent('a')] }))).toEqual([])
  })

  it('returns the requests from approval_request events (ignoring other events)', () => {
    const out = pendingApprovals(gen({ log: [statusEvent, approvalEvent('a'), approvalEvent('b')] }))
    expect(out.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('filters out ids already recorded in answeredApprovals', () => {
    const out = pendingApprovals(gen({
      log: [approvalEvent('a'), approvalEvent('b')],
      answeredApprovals: new Set(['a']),
    }))
    expect(out.map((r) => r.id)).toEqual(['b'])
  })

  it('returns [] when there are no approval requests', () => {
    expect(pendingApprovals(gen({ log: [statusEvent] }))).toEqual([])
  })
})

describe('ops slice answered-approval tracking', () => {
  beforeEach(() => {
    respondApproval.mockClear()
    useStore.setState({ ops: { op1: gen({ answeredApprovals: new Set(['stale']) }) } })
  })

  it('startOp resets answeredApprovals to an empty set', () => {
    useStore.getState().startOp('review', 'op2', 2)
    expect(useStore.getState().ops.op2.answeredApprovals.size).toBe(0)
  })

  it('respondApproval records the id before the IPC call', () => {
    let recordedBeforeIpc = false
    respondApproval.mockImplementation(() => {
      recordedBeforeIpc = useStore.getState().ops.op1.answeredApprovals.has('a')
    })
    useStore.getState().respondApproval('op1', 'a', 'allow')
    expect(recordedBeforeIpc).toBe(true)
    expect(useStore.getState().ops.op1.answeredApprovals.has('a')).toBe(true)
    expect(respondApproval).toHaveBeenCalledWith('op1', 'a', 'allow')
  })
})
