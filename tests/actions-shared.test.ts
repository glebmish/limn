import { describe, expect, it } from 'vitest'
import type { Comment } from '../src/shared/types'
import {
  ACTIONS_PREF_KEY, CHAT_ACTION_ID, REVIEW_ACTION_ID, actionFindings, actionPrompt, isProposal, newActionId,
  parseActions, runFindings, serializeActions, skillPrompt, touched
} from '../src/shared/actions'

const base = (over: Partial<Comment>): Comment => ({
  id: 'c1', anchor: { kind: 'summary' }, author: 'agent', text: 't', status: 'proposed', replies: [], createdAt: 'now', iteration: 1, ...over
})

describe('actions config', () => {
  it('has a stable pref key', () => {
    expect(ACTIONS_PREF_KEY).toBe('actions')
  })

  it('parses a serialized list back, dropping malformed entries', () => {
    const list = [
      { id: 'a', kind: 'skill' as const, name: 'Simplify', body: 'simplify' },
      { id: 'b', kind: 'prompt' as const, name: 'Rebase', body: 'Rebase onto main' }
    ]
    const json = serializeActions(list)
    expect(parseActions(json)).toEqual(list)
    expect(parseActions(undefined)).toEqual([])
    expect(parseActions('not json')).toEqual([])
    expect(parseActions(JSON.stringify([{ id: 'x' }, ...list, { id: 'y', kind: 'shell', name: 'n', body: 'b' }]))).toEqual(list)
  })

  it('keeps the Collect findings switch, drops a non-boolean one, and defaults by kind', () => {
    const list = [
      { id: 'a', kind: 'skill' as const, name: 'Simplify', body: 'simplify', findings: false },
      { id: 'b', kind: 'prompt' as const, name: 'Security', body: 'Look for injection', findings: true }
    ]
    expect(parseActions(serializeActions(list))).toEqual(list)
    expect(parseActions(JSON.stringify([{ id: 'a', kind: 'skill', name: 'n', body: 'b', findings: 'yes' }]))).toEqual([])
    expect(actionFindings({ kind: 'skill' })).toBe(true)
    expect(actionFindings({ kind: 'prompt' })).toBe(false)
    expect(actionFindings({ kind: 'skill', findings: false })).toBe(false)
    expect(actionFindings({ kind: 'prompt', findings: true })).toBe(true)
  })

  it('mints unique ids', () => {
    expect(newActionId()).not.toBe(newActionId())
  })
})

describe('prompts', () => {
  it('spells a skill per engine', () => {
    expect(skillPrompt('claude', 'simplify')).toBe('/simplify')
    expect(skillPrompt('codex', 'simplify')).toBe('$simplify')
    // a stored name that already carries a prefix is normalized
    expect(skillPrompt('codex', '/security-review')).toBe('$security-review')
    expect(skillPrompt('claude', '$security-review')).toBe('/security-review')
  })

  it('an action prompt is the spelling or the text alone — Limn appends nothing', () => {
    expect(actionPrompt({ id: 'a', kind: 'skill', name: 'Simplify', body: 'simplify' }, 'claude')).toBe('/simplify')
    expect(actionPrompt({ id: 'b', kind: 'prompt', name: 'Rebase', body: 'Rebase onto main' }, 'codex')).toBe('Rebase onto main')
    expect(CHAT_ACTION_ID).toBe('chat')
  })
})

describe('proposals', () => {
  it('knows the review action id and what a proposal is', () => {
    expect(REVIEW_ACTION_ID).toBe('review')
    expect(isProposal(base({ status: 'proposed' }))).toBe(true)
    expect(isProposal(base({ status: 'dismissed' }))).toBe(true)
    expect(isProposal(base({ status: 'queued' }))).toBe(false)
    expect(touched(base({}))).toBe(false)
    expect(touched(base({ replies: [{ author: 'user', text: 'hm', at: 'now' }] }))).toBe(true)
  })

  it('filters a run\'s findings by source', () => {
    const a = base({ id: 'a', source: { actionId: 'x', runId: 'r1' } })
    const b = base({ id: 'b', source: { actionId: 'x', runId: 'r2' } })
    const c = base({ id: 'c' })
    expect(runFindings([a, b, c], 'r1')).toEqual([a])
  })
})
