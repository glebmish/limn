import { describe, it, expect } from 'vitest'
import { wtName, branchLocation, reviewsForBranch } from '../src/renderer/lib/workspace'
import type { WorktreeInfo, SessionListItem } from '../src/shared/types'

const wt = (p: string, branch: string | null, primary = false, dirty = false): WorktreeInfo =>
  ({ path: p, branch, head: 'h', primary, locked: false, dirty })

describe('wtName', () => {
  it('names the primary worktree "primary"', () => {
    expect(wtName('/repo/app', true, 'app')).toBe('primary')
  })
  it('strips the <repoBase>-- prefix from linked worktrees', () => {
    expect(wtName('/repo/app--feature', false, 'app')).toBe('feature')
  })
  it('falls back to the leaf when there is no prefix', () => {
    expect(wtName('/somewhere/else', false, 'app')).toBe('else')
  })
})

describe('branchLocation', () => {
  const wts = [wt('/r/app', 'main', true, false), wt('/r/app--feat', 'feat', false, true)]
  it('finds the host worktree and its dirty bit', () => {
    expect(branchLocation('feat', wts)).toEqual({ host: wts[1], detached: false, dirty: true })
  })
  it('reports detached when the branch is in no worktree', () => {
    expect(branchLocation('other', wts)).toEqual({ host: null, detached: true, dirty: false })
  })
})

describe('reviewsForBranch', () => {
  const s = (id: number, compareSymbol: string, archived = false): SessionListItem =>
    ({ id, baseSymbol: 'main', compareSymbol, compareKind: 'branch', hasReview: false, approved: false, archived, unresolved: 0, updatedAt: `2026-06-2${id}`, createdAt: 'x' })
  it('keeps only non-archived branch-compare sessions for the branch, newest first', () => {
    const out = reviewsForBranch([s(1, 'feat'), s(2, 'feat'), s(3, 'other'), s(4, 'feat', true)], 'feat')
    expect(out.map((x) => x.id)).toEqual([2, 1])
  })
})
