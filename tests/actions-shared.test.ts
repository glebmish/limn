import { describe, expect, it } from 'vitest'
import type { Comment } from '../src/shared/types'
import {
  ACTIONS_PREF_KEY, FINDING_HARNESS, REVIEW_ACTION_ID, actionPrompt, isProposal, newActionId,
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

  it('appends the finding harness to both kinds', () => {
    const skill = actionPrompt({ id: 'a', kind: 'skill', name: 'Simplify', body: 'simplify' }, 'claude')
    expect(skill.startsWith('/simplify\n\n')).toBe(true)
    expect(skill.endsWith(FINDING_HARNESS)).toBe(true)
    const prompt = actionPrompt({ id: 'b', kind: 'prompt', name: 'Rebase', body: 'Rebase onto main' }, 'codex')
    expect(prompt).toBe('Rebase onto main\n\n' + FINDING_HARNESS)
    expect(FINDING_HARNESS).toContain('add_finding')
    expect(FINDING_HARNESS.toLowerCase()).not.toContain('do not edit')
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
