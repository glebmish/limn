import { describe, expect, it } from 'vitest'
import { batchTurnLabel, rebaseTurnLabel } from '../src/shared/turnLabels'
import type { AgentQuestion, Comment } from '../src/shared/types'

const c = (over: Partial<Comment>): Comment => ({
  id: 'c1', author: 'user', text: 'fix it', status: 'sent', replies: [], iteration: 1,
  createdAt: new Date().toISOString(), anchor: { kind: 'summary' }, ...over
})

describe('batchTurnLabel (one builder for main persist + renderer preview)', () => {
  it('plain batch counts the comments, with optional steer', () => {
    expect(batchTurnLabel([c({})], [])).toBe('Handle 1 comment(s).')
    expect(batchTurnLabel([c({})], [], false, ' push back ')).toBe('Handle 1 comment(s) - push back')
  })

  it('refine lists each answered question by its text', () => {
    const q: AgentQuestion = { id: 'q1', text: 'Keep the default?' }
    const answer = c({ anchor: { kind: 'question', questionId: 'q1' }, text: 'yes' })
    expect(batchTurnLabel([answer], [q], true))
      .toBe('Answered 1 open question:\n- Keep the default?\n  Answer: yes')
  })
})

describe('rebaseTurnLabel', () => {
  it('names the branches, and the conflict count when resolving', () => {
    expect(rebaseTurnLabel('main', 'feat')).toBe('Rebase feat onto main.')
    expect(rebaseTurnLabel('main', 'feat', ['a.ts', 'b.ts']))
      .toBe('Rebase feat onto main — resolve 2 conflicted files.')
  })
})
