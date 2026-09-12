import { describe, expect, it } from 'vitest'
import type { ActionDef } from '../src/shared/types'
import type { CommandAvailability } from '../src/shared/actions'
import { actionDraftProblem, actionSub, defaultActionName, markFor, markTitle, markedEngines, moveAction, seenChoices, uncheckedEngines } from '../src/renderer/lib/actions'

const simplify: ActionDef = { id: 'a', kind: 'skill', name: 'Simplify', body: 'simplify' }
const rebase: ActionDef = { id: 'b', kind: 'prompt', name: 'Rebase', body: 'Rebase onto main\nresolve conflicts' }
const avail = (over: Partial<CommandAvailability>): CommandAvailability => ({ engine: 'claude', repo: '/r', names: ['simplify'], checkedAt: new Date().toISOString(), state: 'ok', ...over })

describe('marks', () => {
  it('derives ok / no / chk / unk / bad; prompt actions are always ok', () => {
    expect(markFor(simplify, avail({}))).toBe('ok')
    expect(markFor(simplify, avail({ names: ['compact'] }))).toBe('no')
    expect(markFor(simplify, avail({ names: [], state: 'empty' }))).toBe('no')
    expect(markFor(simplify, avail({ state: 'checking' }))).toBe('chk')
    expect(markFor(simplify, avail({ state: 'failed', error: 'spawn ENOENT' }))).toBe('bad')
    expect(markFor(simplify, avail({ state: 'unknown', names: [], checkedAt: '' }))).toBe('unk')
    expect(markFor(simplify, undefined)).toBe('unk')
    expect(markFor(rebase, undefined)).toBe('ok')
    // Codex spells skills with $; the stored name stays bare
    expect(markFor(simplify, avail({ engine: 'codex', names: ['review', '$simplify'] }))).toBe('ok')
  })

  it('titles say what the engine reported and when', () => {
    expect(markTitle(simplify, 'claude', avail({}), 'ok')).toBe('Claude has /simplify · checked just now')
    expect(markTitle(simplify, 'codex', avail({ engine: 'codex', names: [] }), 'no')).toBe('Codex did not report $simplify · checked just now')
    expect(markTitle(simplify, 'codex', undefined, 'chk')).toBe('Checking Codex…')
    expect(markTitle(simplify, 'codex', avail({ state: 'failed', error: 'boom' }), 'bad')).toBe('Codex could not be reached — boom')
    expect(markTitle(rebase, 'claude', undefined, 'ok')).toBe('Claude can run it')
  })

  it('shows marks only when two engines resolve', () => {
    expect(markedEngines([avail({})])).toEqual([])
    expect(markedEngines([avail({}), avail({ engine: 'codex' })])).toEqual(['claude', 'codex'])
  })
})

describe('list helpers', () => {
  it('moveAction reorders and leaves bad moves alone', () => {
    const list = [simplify, rebase, { ...simplify, id: 'c' }]
    expect(moveAction(list, 0, 2).map((a) => a.id)).toEqual(['b', 'c', 'a'])
    expect(moveAction(list, 2, 0).map((a) => a.id)).toEqual(['c', 'a', 'b'])
    expect(moveAction(list, 1, 1).map((a) => a.id)).toEqual(['a', 'b', 'c'])
    expect(moveAction(list, 5, 0).map((a) => a.id)).toEqual(['a', 'b', 'c'])
  })

  it('actionSub spells a skill neutrally and takes a prompt\'s first line', () => {
    expect(actionSub(simplify)).toBe('/simplify')
    expect(actionSub({ ...simplify, body: '$security-review' })).toBe('/security-review')
    expect(actionSub(rebase)).toBe('Rebase onto main')
    expect(actionSub({ ...rebase, body: 'x'.repeat(100) })).toHaveLength(72)
  })

  it('actionDraftProblem names what is missing', () => {
    expect(actionDraftProblem({ kind: 'skill', name: '', body: '' })).toBe('Type the skill name')
    expect(actionDraftProblem({ kind: 'skill', name: '', body: 'two words' })).toBe('A skill name has no spaces')
    expect(actionDraftProblem({ kind: 'skill', name: '', body: '/simplify' })).toBe('Give it a name')
    expect(actionDraftProblem({ kind: 'prompt', name: 'x', body: '  ' })).toBe('Type the prompt')
    expect(actionDraftProblem({ kind: 'prompt', name: 'x', body: 'go' })).toBeNull()
  })

  it('seenChoices filters by the typed prefix and flags pinned names', () => {
    const seen = [{ engine: 'claude' as const, names: ['compact', 'security-review', 'simplify'] }, { engine: 'codex' as const, names: ['security-review'] }]
    expect(seenChoices(seen, '', [simplify])).toEqual([
      { engine: 'claude', names: [{ name: 'compact', pinned: false }, { name: 'security-review', pinned: false }, { name: 'simplify', pinned: true }] },
      { engine: 'codex', names: [{ name: 'security-review', pinned: false }] }
    ])
    expect(seenChoices(seen, '/sec', [])).toEqual([
      { engine: 'claude', names: [{ name: 'security-review', pinned: false }] },
      { engine: 'codex', names: [{ name: 'security-review', pinned: false }] }
    ])
    expect(seenChoices(seen, 'zzz', [])).toEqual([])
  })
})

describe('editor defaults', () => {
  it('defaultActionName title-cases a skill\'s last segment and leaves prompts unnamed', () => {
    expect(defaultActionName('skill', 'simplify')).toBe('Simplify')
    expect(defaultActionName('skill', '/simplify')).toBe('Simplify')
    expect(defaultActionName('skill', 'pr-review-toolkit:review-pr')).toBe('Review pr')
    expect(defaultActionName('skill', 'code_review')).toBe('Code review')
    expect(defaultActionName('skill', '')).toBe('')
    expect(defaultActionName('prompt', 'Rebase onto main')).toBe('')
  })

  it('uncheckedEngines names only the never-probed engines', () => {
    const unk = avail({ state: 'unknown', names: [], checkedAt: '' })
    expect(uncheckedEngines([unk, avail({ engine: 'codex' })])).toEqual(['claude'])
    expect(uncheckedEngines([avail({ state: 'failed' }), avail({ engine: 'codex', state: 'checking' })])).toEqual([])
    expect(uncheckedEngines([])).toEqual([])
  })
})
