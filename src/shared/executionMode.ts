import type { ExecutionMode, ExecutionTier } from './types.js'

/** The ladder, in order, with the reviewer-facing copy (wireframe J3). */
export const EXECUTION_TIERS: ExecutionTier[] = [
  { key: 'ask', label: 'Ask for approval', desc: "Asks before anything the agent doesn't already run read-only." },
  { key: 'edits', label: 'Accept edits', desc: 'Auto-applies most edits; asks when the agent flags one, or for other actions.' },
  { key: 'auto', label: 'Auto mode', desc: 'Asks only when the agent itself flags something as risky.' },
  { key: 'full', label: 'Full access', desc: 'Unrestricted — network and any file.' },
]

export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'auto'

/** Threads created before the `execution_mode` column existed carry a NULL value in
 *  the DB; on read they keep the tier those chats always ran with rather than
 *  inheriting the new-thread default — "existing user choices respected" means
 *  exactly this: a pre-column thread was, in effect, always on `ask`. */
export const LEGACY_EXECUTION_MODE: ExecutionMode = 'ask'

export function isExecutionMode(v: unknown): v is ExecutionMode {
  return v === 'ask' || v === 'edits' || v === 'auto' || v === 'full'
}
