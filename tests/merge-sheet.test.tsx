import { describe, expect, it } from 'vitest'
import type { MergeGate, MergeGateId } from '../src/shared/types'
import {
  ctaLabel, deleteBranchBlockers, gateFooterNote, mergeBlocked, pickStrategy
} from '../src/renderer/components/MergeSheet'

const amber = (id: MergeGateId): MergeGate => ({ id, severity: 'amber', detail: 'd' })
const red = (id: MergeGateId): MergeGate => ({ id, severity: 'red', detail: 'd' })
const info = (id: MergeGateId): MergeGate => ({ id, severity: 'info', detail: 'd' })
const none: ReadonlySet<MergeGateId> = new Set()

describe('pickStrategy (spec resolution 6: squash default, ladder squash→merge→ff)', () => {
  it('falls to squash, then merge, then ff', () => {
    expect(pickStrategy(undefined, { ff: true, squash: true, merge: true })).toBe('squash')
    expect(pickStrategy(undefined, { ff: true, squash: false, merge: true })).toBe('merge')
    expect(pickStrategy(undefined, { ff: true, squash: false, merge: false })).toBe('ff')
  })
  it('honors a remembered choice only while it is available', () => {
    expect(pickStrategy('ff', { ff: true, squash: true, merge: true })).toBe('ff')
    expect(pickStrategy('ff', { ff: false, squash: true, merge: true })).toBe('squash')
  })
})

describe('ctaLabel (design board 1 CTA labels)', () => {
  it('follows the strategy', () => {
    expect(ctaLabel('ff', 'main')).toBe('Fast-forward main')
    expect(ctaLabel('squash', 'main')).toBe('Squash & merge')
    expect(ctaLabel('merge', 'main')).toBe('Merge into main')
  })
})

describe('mergeBlocked (red always; amber until acked; info never)', () => {
  it('red gates block regardless of acks', () => {
    expect(mergeBlocked([red('conflicts')], new Set<MergeGateId>(['conflicts']))).toBe(true)
  })
  it('amber gates block until acked', () => {
    expect(mergeBlocked([amber('stale-approval')], none)).toBe(true)
    expect(mergeBlocked([amber('stale-approval')], new Set<MergeGateId>(['stale-approval']))).toBe(false)
  })
  it('info gates never block', () => {
    expect(mergeBlocked([info('probe-unavailable')], none)).toBe(false)
  })
})

describe('deleteBranchBlockers (spec §4: deletion refused while a dependent still bases here)', () => {
  const dep = (sessionId: number, rebasable: boolean) =>
    ({ sessionId, branch: `dep-${sessionId}`, commits: 4, rebasable })
  it('an unselected or non-rebasable dependent blocks deletion', () => {
    expect(deleteBranchBlockers([dep(1, true)], new Set())).toHaveLength(1)
    expect(deleteBranchBlockers([dep(1, false)], new Set([1]))).toHaveLength(1)
  })
  it('a selected rebasable dependent does not', () => {
    expect(deleteBranchBlockers([dep(1, true)], new Set([1]))).toHaveLength(0)
  })
})

describe('gateFooterNote', () => {
  it('busy lane wins: "Waiting for the running iteration."', () => {
    expect(gateFooterNote([], none, true)).toBe('Waiting for the running iteration.')
  })
  it('conflicts → "Gated until the probe is clean."', () => {
    expect(gateFooterNote([red('conflicts')], none, false)).toBe('Gated until the probe is clean.')
  })
  it('stale approval (un-acked) → "Gated until approval covers HEAD."', () => {
    expect(gateFooterNote([amber('stale-approval')], none, false)).toBe('Gated until approval covers HEAD.')
    expect(gateFooterNote([amber('stale-approval')], new Set<MergeGateId>(['stale-approval']), false)).toBeNull()
  })
  it('dirty trees → "Gated until the worktree is clean."', () => {
    expect(gateFooterNote([red('base-site-dirty')], none, false)).toBe('Gated until the worktree is clean.')
    expect(gateFooterNote([red('branch-dirty')], none, false)).toBe('Gated until the worktree is clean.')
  })
  it('green board → no note', () => {
    expect(gateFooterNote([], none, false)).toBeNull()
  })
})
