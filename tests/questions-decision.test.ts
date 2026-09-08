import { describe, expect, it } from 'vitest'
import type { LoadedReview } from '../src/shared/ipc'

;(globalThis as unknown as { window: unknown }).window = { api: {} }

import type { OpState } from '../src/renderer/store'
import { decisionThreadId, decisionTurn } from '../src/renderer/components/Questions'

const op = (over: Partial<OpState>): OpState => ({
  running: true, opId: 'op', kind: 'chat', threadId: 5, log: [], error: null,
  startedAt: 0, outcome: null, errorCode: null, answeredApprovals: new Set(), exclusive: true, ...over
})
const opsOf = (...list: OpState[]): Record<string, OpState> => Object.fromEntries(list.map((o, i) => [o.opId ?? `op${i}`, o]))

// one review thread (id 5) — the thread `sendAnswers` targets and the answer batch
// registers its op on
const loaded = ({ state: { chats: [{ id: 5, kind: 'review' }] } } as unknown as LoadedReview)

const turn = (ops: Record<string, OpState>, over: Partial<Parameters<typeof decisionTurn>[0]> = {}) => decisionTurn({
  ops, loaded, adding: false, activeCount: 1, openCount: 1, answeredCount: 1, ...over
})

// The answer turn is a CHAT op on the review thread (sendAnswers → sendBatch →
// startOp('chat', …)), not a 'review' generation: watching only review-kind ops left
// the progress card unreachable and the submit button live mid-turn (finding 102).
describe('Questions — the decision card watches the answer turn it actually started', () => {
  it('a streaming answer batch on the review thread disables submit and shows the progress card', () => {
    const t = turn(opsOf(op({ opId: 'batch', kind: 'chat', threadId: 5 })))
    expect(t.running).toBe(true)
    expect(t.runningThisTurn).toBe(true)
    expect(t.ready).toBe(false)
  })

  it('carries that op\'s log, so the progress card can step through it', () => {
    const t = turn(opsOf(op({ opId: 'batch', kind: 'chat', threadId: 5, log: [{ type: 'text', text: 'narrating' }] })))
    expect(t.log).toHaveLength(1)
  })

  it('a review generation on the review thread still counts as running', () => {
    const t = turn(opsOf(op({ opId: 'gen', kind: 'review', threadId: 5 })))
    expect(t.running).toBe(true)
    expect(t.ready).toBe(false)
  })

  it('an op on another thread never paints this card, but still blocks submit — sendBatch needs the lane', () => {
    const t = turn(opsOf(op({ opId: 'elsewhere', kind: 'chat', threadId: 9 })))
    expect(t.running).toBe(false)
    expect(t.runningThisTurn).toBe(false)
    // sendBatch early-returns while any op runs (store/chat.ts), so a live button
    // would click into a silent no-op
    expect(t.ready).toBe(false)
  })

  it('is ready once every open question is answered and nothing is running', () => {
    expect(turn({}).ready).toBe(true)
    expect(turn({}, { answeredCount: 0 }).ready).toBe(false)
    expect(turn({}, { openCount: 0, answeredCount: 0 }).ready).toBe(false)
    expect(turn({}, { adding: true }).ready).toBe(false)
  })

  it('is never ready without a review thread to send to', () => {
    expect(decisionTurn({ ops: {}, loaded: null, adding: false, activeCount: 0, openCount: 1, answeredCount: 1 }).ready).toBe(false)
  })

  it('the progress card needs the comments of this turn, not just a running op', () => {
    expect(turn(opsOf(op({ opId: 'batch' })), { activeCount: 0 }).runningThisTurn).toBe(false)
    expect(turn({}, { adding: true, activeCount: 2 }).runningThisTurn).toBe(true)
  })
})

// After an aborted regenerate the NEWEST review thread is an empty one: a generation
// mints its thread up front and only binds the engine session on success, and the
// orphan prune never removes the latest review thread. `latestIteration.sessionId`
// still names the older thread that authored the questions on screen — the thread
// `sendAnswers` targets, so the gate and the deep link must name it too (finding 105).
const aborted = ({
  state: {
    chats: [{ id: 1, kind: 'review', engineSessionId: 's1' }, { id: 2, kind: 'review' }],
    latestIteration: { sessionId: 's1' }
  }
} as unknown as LoadedReview)

describe('Questions — the gate, the send and "Open chat" name one thread', () => {
  it('picks the thread that authored the latest iteration, exactly as sendAnswers does', () => {
    expect(decisionThreadId(aborted)).toBe(1)
  })

  it('falls back to the newest review thread when no iteration names one', () => {
    const fresh = ({ state: { chats: [{ id: 1, kind: 'review' }, { id: 2, kind: 'review' }] } } as unknown as LoadedReview)
    expect(decisionThreadId(fresh)).toBe(2)
  })

  it('the thread the answers actually went to wins outright', () => {
    expect(decisionThreadId(aborted, 2)).toBe(2)
  })

  it('no chats at all: nothing to open and nothing to send to', () => {
    expect(decisionThreadId(null)).toBeUndefined()
  })

  it('the card watches the op on that same thread', () => {
    const t = decisionTurn({ ops: opsOf(op({ opId: 'batch', threadId: 1 })), loaded: aborted, adding: false, activeCount: 1, openCount: 1, answeredCount: 1 })
    expect(t.running).toBe(true)
    expect(t.runningThisTurn).toBe(true)
  })
})
