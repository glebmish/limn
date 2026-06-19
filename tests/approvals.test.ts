import { describe, it, expect, vi } from 'vitest'
import { awaitDecision, resolveDecision, clearPending, pendingCount } from '../src/main/engines/approvals'
import type { ApprovalRequest, EngineEvent } from '../src/shared/types'

const req = (id: string): ApprovalRequest => ({ id, engine: 'claude', kind: 'command', summary: `run ${id}` })

describe('approvals registry', () => {
  it('emits the request and resolves the awaited promise with the decision', async () => {
    const emit = vi.fn()
    const p = awaitDecision('op1', req('a'), emit)
    expect(emit).toHaveBeenCalledWith<[EngineEvent]>({ type: 'approval_request', request: req('a') })
    expect(pendingCount('op1')).toBe(1)
    resolveDecision('op1', 'a', 'allow')
    expect(await p).toBe('allow')
    expect(pendingCount('op1')).toBe(0)
  })

  it('routes deny', async () => {
    const p = awaitDecision('op1', req('b'), vi.fn())
    resolveDecision('op1', 'b', 'deny')
    expect(await p).toBe('deny')
  })

  it('correlates by (opId, requestId) — a wrong key does not resolve', async () => {
    const p = awaitDecision('op1', req('c'), vi.fn())
    resolveDecision('op2', 'c', 'allow') // wrong op
    resolveDecision('op1', 'x', 'allow') // wrong id
    expect(pendingCount('op1')).toBe(1)
    resolveDecision('op1', 'c', 'allow')
    expect(await p).toBe('allow')
  })

  it('double-resolve and unknown id are no-ops', async () => {
    const p = awaitDecision('op1', req('d'), vi.fn())
    resolveDecision('op1', 'd', 'allow')
    expect(() => resolveDecision('op1', 'd', 'deny')).not.toThrow() // already gone
    expect(() => resolveDecision('opX', 'nope', 'allow')).not.toThrow()
    expect(await p).toBe('allow')
  })

  it('clearPending denies every parked request for the op', async () => {
    const p1 = awaitDecision('op9', req('a'), vi.fn())
    const p2 = awaitDecision('op9', req('b'), vi.fn())
    expect(pendingCount('op9')).toBe(2)
    clearPending('op9')
    expect(await p1).toBe('deny')
    expect(await p2).toBe('deny')
    expect(pendingCount('op9')).toBe(0)
  })
})
