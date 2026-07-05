import { describe, expect, it } from 'vitest'
import { evaluateMergeGates, mergeOk, type MergeGateInputs } from '../src/main/merge'
import type { MergeProbe } from '../src/main/git'

const cleanProbe: MergeProbe = { status: 'clean', treeOid: 'tree000', conflictFiles: [] }
const conflictProbe: MergeProbe = { status: 'conflict', conflictFiles: ['src/a.ts', 'src/b.ts'] }
const unavailableProbe: MergeProbe = { status: 'unavailable', conflictFiles: [] }

function inputs(over: Partial<MergeGateInputs> = {}): MergeGateInputs {
  return { approvalCoversTip: true, probe: cleanProbe, ffPossible: true, ...over }
}

describe('evaluateMergeGates', () => {
  it('is empty on the green path (approved tip, clean probe, clean trees, base unmoved)', () => {
    expect(evaluateMergeGates(inputs())).toEqual([])
  })

  it('stale-approval: amber with commit/line counts when the approval misses the tip', () => {
    const gates = evaluateMergeGates(inputs({
      approvalCoversTip: false,
      staleInfo: { commits: 2, add: 14, del: 3, sinceSha: 'c7e0d44abcdef0123456789abcdef0123456789a' }
    }))
    expect(gates).toEqual([{
      id: 'stale-approval', severity: 'amber',
      detail: '2 commits since approval c7e0d44 (+14 / −3)',
      commits: 2, add: 14, del: 3
    }])
  })

  it('stale-approval: amber without counts when no approved sha exists to count from', () => {
    const gates = evaluateMergeGates(inputs({ approvalCoversTip: false }))
    expect(gates).toEqual([{
      id: 'stale-approval', severity: 'amber',
      detail: 'The approval does not cover the current tip'
    }])
  })

  it('base-moved: amber with the new-commit count', () => {
    const gates = evaluateMergeGates(inputs({
      ffPossible: false,
      baseMoved: { commits: 3, from: 'a'.repeat(40), to: 'b'.repeat(40) }
    }))
    expect(gates).toEqual([{
      id: 'base-moved', severity: 'amber',
      detail: 'The base has moved: 3 new commits since the reviewed merge-base',
      commits: 3
    }])
  })

  it('conflicts: red, carrying the conflicting file list', () => {
    const gates = evaluateMergeGates(inputs({ probe: conflictProbe, ffPossible: false }))
    expect(gates).toEqual([{
      id: 'conflicts', severity: 'red',
      detail: 'Merging would conflict in 2 files',
      files: ['src/a.ts', 'src/b.ts']
    }])
  })

  it('base-site-dirty and branch-dirty: red, each naming its worktree', () => {
    const gates = evaluateMergeGates(inputs({
      baseSiteDirty: { workdir: '/repo', count: 2 },
      branchDirty: { workdir: '/repo/.worktrees/feature', count: 1 }
    }))
    expect(gates).toEqual([
      {
        id: 'base-site-dirty', severity: 'red',
        detail: "The base branch's worktree has 2 uncommitted changes (/repo)",
        workdir: '/repo'
      },
      {
        id: 'branch-dirty', severity: 'red',
        detail: 'The branch worktree has 1 uncommitted change (/repo/.worktrees/feature)',
        workdir: '/repo/.worktrees/feature'
      }
    ])
  })

  it('probe-unavailable: info gate on old git', () => {
    const gates = evaluateMergeGates(inputs({ probe: unavailableProbe }))
    expect(gates).toEqual([{
      id: 'probe-unavailable', severity: 'info',
      detail: 'Conflict probe unavailable (git < 2.38) — conflicts are checked at confirm time'
    }])
  })

  it('orders bands red → amber → info', () => {
    const gates = evaluateMergeGates(inputs({
      approvalCoversTip: false,
      probe: { status: 'unavailable', conflictFiles: [] },
      branchDirty: { workdir: '/w', count: 1 }
    }))
    expect(gates.map((g) => g.severity)).toEqual(['red', 'amber', 'info'])
  })
})

describe('mergeOk', () => {
  it('true with no gates and no overrides', () => {
    expect(mergeOk([], [])).toBe(true)
  })

  it('false while an amber gate is not overridden; true once it is', () => {
    const gates = evaluateMergeGates(inputs({ approvalCoversTip: false }))
    expect(mergeOk(gates, [])).toBe(false)
    expect(mergeOk(gates, ['stale-approval'])).toBe(true)
  })

  it('accounts every amber independently', () => {
    const gates = evaluateMergeGates(inputs({
      approvalCoversTip: false,
      ffPossible: false,
      baseMoved: { commits: 1, from: 'a'.repeat(40), to: 'b'.repeat(40) }
    }))
    expect(mergeOk(gates, ['stale-approval'])).toBe(false)
    expect(mergeOk(gates, ['stale-approval', 'base-moved'])).toBe(true)
  })

  it('red is never overridable — even when listed in overrides', () => {
    const gates = evaluateMergeGates(inputs({ probe: conflictProbe, ffPossible: false }))
    expect(mergeOk(gates, ['conflicts'])).toBe(false)
  })

  it('info gates never block', () => {
    const gates = evaluateMergeGates(inputs({ probe: unavailableProbe }))
    expect(mergeOk(gates, [])).toBe(true)
  })
})
