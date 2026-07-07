import { describe, expect, it } from 'vitest'
import type { MergeGate, MergeGateId } from '../src/shared/types'
import {
  ctaLabel, deleteBranchBlockers, gateFooterNote, mergeBlocked, pickStrategy,
  readStrategyPref, strategyPrefKey
} from '../src/renderer/components/MergeSheet'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MergeSheetActions } from '../src/renderer/components/MergeSheet'
import { MergeSheetPanel } from '../src/renderer/components/MergeSheet'
import { makePreflight } from './helpers/merge'
import type { MergePreflight, MergeStrategy } from '../src/shared/types'

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

describe('readStrategyPref (per-repo strategy memory, resolution 6)', () => {
  const repo = '/repos/api'
  it('reads a valid remembered strategy for the repo', () => {
    expect(readStrategyPref({ [strategyPrefKey(repo)]: JSON.stringify('merge') }, repo)).toBe('merge')
  })
  it('is per-repo — another repo\'s choice does not leak', () => {
    const prefs = { [strategyPrefKey('/repos/other')]: JSON.stringify('ff') }
    expect(readStrategyPref(prefs, repo)).toBeUndefined()
  })
  it('tolerates missing / unparseable / invalid values → undefined (falls back to squash)', () => {
    expect(readStrategyPref({}, repo)).toBeUndefined()
    expect(readStrategyPref({ [strategyPrefKey(repo)]: 'not json' }, repo)).toBeUndefined()
    expect(readStrategyPref({ [strategyPrefKey(repo)]: JSON.stringify('bogus') }, repo)).toBeUndefined()
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

const noop: MergeSheetActions = {
  onClose: () => {}, onRecheck: () => {}, onReviewCommits: () => {},
  onRebaseWithAgent: () => {}, onExecute: () => {},
}

function panel(pf: MergePreflight, over: { busy?: boolean; executing?: boolean; strategy?: MergeStrategy } = {}): string {
  return renderToStaticMarkup(
    <MergeSheetPanel pf={pf} repo="/repo" busy={over.busy ?? false} executing={over.executing ?? false}
      initialStrategy={over.strategy ?? 'squash'} actions={noop} />
  )
}
const foot = (out: string): string => out.slice(out.indexOf('msh-foot'))

describe('MergeSheetPanel — green board (design 08 board 1)', () => {
  it('header: branch → base, counts, approved sha, close', () => {
    const out = panel(makePreflight())
    expect(out).toContain('feature/billing-overhaul')
    expect(out).toContain('9 commits · 54 files · +3114 / −902 · approved at c7e0d44')
    expect(out).toContain('aria-label="Close"')
  })
  it('collapses preflight to the single green line', () => {
    const out = panel(makePreflight())
    expect(out).toContain('msh-gate good')
    expect(out).toContain('Clear to merge.')
    expect(out).toContain('No gates tripped.')
  })
  it('squash mode: message textarea seeded with the draft + meta line; CTA enabled', () => {
    const out = panel(makePreflight())
    expect(out).toContain('Reviewed-with: Limn (approved c7e0d44, base main @ 7c1d04e)')
    expect(out).toContain('Drafted from the review summary — click to edit.')
    expect(out).toContain('Squash &amp; merge')
    expect(foot(out)).not.toContain('disabled')
  })
  it('ff mode: commit list with the tip tag, no textarea, ff CTA label + hint', () => {
    const out = panel(makePreflight(), { strategy: 'ff' })
    expect(out).toContain('msh-clist')
    expect(out).toContain('invoice PDF rendering + snapshot tests')
    expect(out).toContain('cr-tag')
    expect(out).not.toContain('<textarea')
    expect(out).toContain('Fast-forward main')
    expect(out).toContain('no new commit is created.')
  })
  it('merge mode: merge hint + CTA label', () => {
    const out = panel(makePreflight(), { strategy: 'merge' })
    expect(out).toContain('keeping all 9 commits reachable.')
    expect(out).toContain('Merge into main')
  })
  it('cleanup checkboxes default on; worktree row shows its path', () => {
    const out = panel(makePreflight())
    expect(out).toContain('Archive this review session')
    expect(out).toContain('Delete <span class="mono">feature/billing-overhaul</span>')
    expect(out).toContain('.worktrees/billing-overhaul')
    expect(out).not.toContain('msh-chk off') // all default checked
  })
  it('hides the worktree row when the branch has no linked worktree', () => {
    const out = panel(makePreflight({ cleanup: { dependents: [] } }))
    expect(out).not.toContain('Remove worktree')
  })
  it('all strategies available: static descriptions render, not disabled reasons', () => {
    const out = panel(makePreflight())
    expect(out).toContain('History exactly as reviewed')
    expect(out).toContain('Flatten the branch')
    expect(out).toContain('Keeps the branch shape')
    expect(out).not.toContain('Not possible')
  })
})

describe('MergeSheetPanel — G1 stale approval (amber)', () => {
  const pf = makePreflight({
    ok: false,
    gates: [{
      id: 'stale-approval', severity: 'amber',
      detail: 'Approval is behind the branch. 2 commits since c7e0d44 (+26 −16) aren’t covered — re-review the delta, or merge anyway.',
      commits: 2, add: 26, del: 16,
    }],
  })
  it('renders the gate band with the action row and gates the CTA', () => {
    const out = panel(pf)
    expect(out).toContain('Approval is behind the branch.')
    expect(out).toContain('Review the 2 commits')
    expect(out).toContain('Merge anyway')
    expect(foot(out)).toContain('disabled')
    expect(out).toContain('Gated until approval covers HEAD.')
  })
})

describe('MergeSheetPanel — G2 base moved (amber, ff off the table)', () => {
  const pf = makePreflight({
    ok: false,
    strategies: { ff: false, squash: true, merge: true },
    gates: [{
      id: 'base-moved', severity: 'amber',
      detail: 'main moved 4 commits since your review base (7c1d04e → 3b9dd02) — what merges ≠ what you approved. Rebase onto main, or merge anyway (probe is conflict-free).',
      commits: 4,
    }],
  })
  it('offers the agent rebase and Merge anyway (probe clean)', () => {
    const out = panel(pf)
    expect(out).toContain('Rebase onto main — with agent')
    expect(out).toContain('Merge anyway')
  })
  it('disables fast-forward with the reason sub-label', () => {
    const out = panel(pf)
    expect(out).toContain('Not possible — main diverged')
    const ffOpt = out.slice(out.indexOf('msh-strat'), out.indexOf('Squash'))
    expect(ffOpt).toContain('disabled')
  })
})

describe('MergeSheetPanel — C1 conflicts (red)', () => {
  const pf = makePreflight({
    ok: false,
    strategies: { ff: false, squash: false, merge: false },
    gates: [{
      id: 'conflicts', severity: 'red',
      detail: 'Merging would conflict in 3 files. main’s new rate-limit middleware overlaps the webhook handler and the schema migration ordering.',
      files: ['src/billing/subscription.ts', 'src/api/invoices.ts', 'db/schema.sql'],
    }],
  })
  it('lists the conflict files and offers agent resolve + copy commands; no Merge anyway', () => {
    const out = panel(pf)
    expect(out).toContain('src/billing/subscription.ts')
    expect(out).toContain('db/schema.sql')
    expect(out).toContain('Resolve with agent')
    expect(out).toContain('Copy git commands')
    expect(out).not.toContain('Merge anyway')
  })
  it('CTA disabled with "Gated until the probe is clean."', () => {
    const out = panel(pf)
    expect(foot(out)).toContain('disabled')
    expect(out).toContain('Gated until the probe is clean.')
  })
  it('squash and merge sub-labels carry the disabled reason, not the static description', () => {
    const out = panel(pf)
    expect(out).not.toContain('Flatten the branch')
    expect(out).not.toContain('Keeps the branch shape')
    expect(out.match(/Not possible — merging would conflict/g)?.length).toBe(2)
  })
})

describe('MergeSheetPanel — G3 dirty merge site (red)', () => {
  const pf = makePreflight({
    ok: false,
    gates: [{
      id: 'base-site-dirty', severity: 'red',
      detail: 'Blocked — uncommitted changes where main is checked out. 3 modified files in ~/code/acme-api. Commit or stash first — Limn won’t touch uncommitted work.',
      workdir: '~/code/acme-api',
    }],
  })
  it('renders the red band with Re-check and a disabled CTA', () => {
    const out = panel(pf)
    expect(out).toContain('msh-gate bad')
    expect(out).toContain('Re-check')
    expect(foot(out)).toContain('disabled')
  })
})

describe('MergeSheetPanel — dependents + delete-branch coupling (spec §5)', () => {
  it('a rebasable dependent renders the highlighted retarget checkbox, checked', () => {
    const out = panel(makePreflight({
      cleanup: {
        worktreePath: '.worktrees/billing-overhaul',
        dependents: [{ sessionId: 5, branch: 'feature/billing-ui', commits: 4, rebasable: true }],
      },
    }))
    expect(out).toContain('Retarget dependent review')
    expect(out).toContain('feature/billing-ui')
    expect(out).toContain('is stacked on this branch. Repoint its base to')
    expect(out).toContain('rebase its 4 commits — comes back as amber drift to skim.')
    expect(out).not.toContain('kept —')
  })
  it('a non-rebasable dependent is unchecked+disabled with its reason, and delete-branch auto-unchecks with a note', () => {
    const out = panel(makePreflight({
      cleanup: {
        worktreePath: '.worktrees/billing-overhaul',
        dependents: [{ sessionId: 5, branch: 'feature/billing-ui', commits: 4, rebasable: false, blockedReason: 'dirty worktree' }],
      },
    }))
    expect(out).toContain('can’t retarget — dirty worktree')
    expect(out).toContain('kept — feature/billing-ui still bases on it')
    // both the dependent row and the delete row render unchecked
    expect(out.match(/msh-chk off/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

describe('MergeSheetPanel — reduced Mark-merged mode (S12)', () => {
  const external = (pf: MergePreflight): string => renderToStaticMarkup(
    <MergeSheetPanel pf={pf} repo="/repo" busy={false} executing={false}
      external initialStrategy="squash" actions={noop} />
  )

  it('drops strategy + message, keeps cleanup, CTA reads Mark merged', () => {
    const out = external(makePreflight())
    expect(out).not.toContain('How it merges')
    expect(out).not.toContain('<textarea')
    expect(out).toContain('Archive this review session')
    expect(out).toContain('Mark merged')
  })

  it('merge gates do not block recording an external merge (base-moved is expected there)', () => {
    // a --no-ff external merge leaves baseHead ≠ tip, so the amber base-moved gate
    // trips — but the merge already happened; only the bookkeeping is ours.
    const out = external(makePreflight({
      ok: false,
      gates: [{ id: 'base-moved', severity: 'amber', detail: 'main moved ahead.' }],
    }))
    expect(foot(out)).not.toContain('disabled')
    // no rebase/override theater for a branch that already landed
    expect(out).not.toContain('Rebase onto')
    expect(out).not.toContain('Merge anyway')
    expect(out).not.toContain('Gated until')
  })
})

describe('MergeSheetPanel — lane busy / executing', () => {
  it('anyExclusiveRunning disables the CTA with the waiting note', () => {
    const out = panel(makePreflight(), { busy: true })
    expect(foot(out)).toContain('disabled')
    expect(out).toContain('Waiting for the running iteration.')
  })
  it('executing disables the CTA and spins', () => {
    const out = panel(makePreflight(), { executing: true })
    expect(foot(out)).toContain('disabled')
    expect(foot(out)).toContain('gen-spinner')
  })
})
