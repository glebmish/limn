// Pure decision core for the branch-watcher poll loop (see ipc.ts `startWatch`).
// The live timer/singleton stays in ipc.ts; only the failure-counting and
// interval-retune DECISION lives here so it can be unit-tested without timers.

/** Live poll cadence: fast enough to feel instant when the branch moves. */
export const LIVE_INTERVAL_MS = 500
/** Backoff cadence once the watch is down: one cheap probe every 10 s. */
export const PROBE_INTERVAL_MS = 10_000
/** A watch is treated as down only after this many CONSECUTIVE failures, so a
 *  single `git status` racing an index.lock during a rebase doesn't kill it. */
export const FAILURE_THRESHOLD = 3

export interface WatchDecisionState {
  /** consecutive poll failures; any success resets to 0. */
  failures: number
  /** whether the watch is currently down (probing at the backoff cadence). */
  stopped: boolean
}

export const initialWatchDecision: WatchDecisionState = { failures: 0, stopped: false }

export type PollResult =
  | { ok: true }
  | { ok: false; reason: string }

export interface WatchDecision {
  /** the next persisted decision state. */
  next: WatchDecisionState
  /** retune the interval to this many ms, or null to leave it unchanged. */
  retuneTo: number | null
  /** what the poll should broadcast: nothing, the stopped state, or a recovery. */
  emit: 'none' | 'stopped' | 'recovered'
  /** first-line git reason, only set when `emit === 'stopped'`. */
  reason?: string
}

/** Fold one poll result into the watcher's decision state.
 *  - success while live: reset the counter, keep the live cadence, emit nothing
 *    (the poll's own signature check still governs the normal repo:changed).
 *  - success while stopped: self-heal — reset, restore the live cadence, and tell
 *    the poll to broadcast a fresh (normal) repo:changed to clear the paused pill.
 *  - failure while live: count it; only the Nth consecutive failure enters stopped,
 *    broadcasts the paused state (with reason), and retunes to the probe cadence.
 *  - failure while stopped: stay down and keep probing — no re-broadcast/retune. */
export function decideWatch(state: WatchDecisionState, result: PollResult): WatchDecision {
  if (result.ok) {
    if (state.stopped) {
      return { next: { failures: 0, stopped: false }, retuneTo: LIVE_INTERVAL_MS, emit: 'recovered' }
    }
    return { next: { failures: 0, stopped: false }, retuneTo: null, emit: 'none' }
  }
  const failures = state.failures + 1
  if (state.stopped) {
    return { next: { failures, stopped: true }, retuneTo: null, emit: 'none' }
  }
  if (failures >= FAILURE_THRESHOLD) {
    return { next: { failures, stopped: true }, retuneTo: PROBE_INTERVAL_MS, emit: 'stopped', reason: result.reason }
  }
  return { next: { failures, stopped: false }, retuneTo: null, emit: 'none' }
}
