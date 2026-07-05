import type { MergePreflight } from '../../src/shared/types'

/** MergePreflight fixture — the design's board-1 numbers by default; override per board. */
export function makePreflight(over: Partial<MergePreflight> = {}): MergePreflight {
  return {
    ok: true,
    gates: [],
    strategies: { ff: true, squash: true, merge: true },
    commits: [
      { sha: 'c7e0d44' + '0'.repeat(33), subject: 'invoice PDF rendering + snapshot tests' },
      { sha: '9f3ab21' + '0'.repeat(33), subject: 'Stripe webhook idempotent dedupe' },
    ],
    draftMessage:
      'Billing system overhaul\n\nSubscription lifecycle state machine, proration math.\n\n' +
      'Reviewed-with: Limn (approved c7e0d44, base main @ 7c1d04e)',
    counts: { commits: 9, files: 54, add: 3114, del: 902 },
    baseHead: 'b'.repeat(40),
    tipSha: 'c7e0d44' + '0'.repeat(33),
    baseSymbol: 'main',
    branch: 'feature/billing-overhaul',
    cleanup: { worktreePath: '.worktrees/billing-overhaul', dependents: [] },
    ...over,
  }
}
