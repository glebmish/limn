import { useEffect } from 'react'
import type { RefObject } from 'react'
import type { LoadedReview } from '../../shared/ipc'
import type { DriftSummary, EngineEvent, ToolVerb } from '../../shared/types'
import type { GenState } from '../store'
import { useStore } from '../store'
import { startGenerateNow } from '../components/GenPanel'
import { sendComments } from './comments'
import { focusAnchor } from './focus'
import { dev } from '../dev'

// run-once guards for the dev/screenshot one-shots below. Module-level (NOT React
// state) on purpose: they must survive remounts so a scripted capture fires exactly
// once across the review's lifetime — breaking this breaks screenshot generation.
let devFlowRan = false
let devFocusRan = false
let devBatchRan = false
let devGenRan = false
let devDocRan = false
let devDriftRan = false

/** dev-only: a synthetic mid-flight review op for capturing the live gen panel. */
export function fakeGenState(): GenState {
  const tool = (id: string, verb: ToolVerb, arg: string, state: 'run' | 'ok', meta?: string): EngineEvent =>
    ({ type: 'tool', call: { id, verb, name: verb, arg, state, ...(meta ? { meta } : {}) } })
  const log: EngineEvent[] = [
    { type: 'status', text: 'grouping 58 changed files into sections…' },
    tool('g1', 'grep', 'callers of RateLimiter', 'ok', '7 hits'),
    tool('r1', 'read', 'src/limiter.ts', 'ok'),
    tool('r2', 'read', 'tests/limiter.test.ts', 'ok'),
    tool('r3', 'read', 'src/server.ts', 'ok'),
    tool('r4', 'read', 'src/middleware/auth.ts', 'ok'),
    tool('b1', 'bash', 'npm test -- limiter', 'run'),
    tool('r5', 'read', 'src/queue.ts', 'run'),
  ]
  return { running: true, opId: 'dev-fake', kind: 'review', threadId: null, log, error: null, startedAt: Date.now() - 48000, outcome: null, errorCode: null, answeredApprovals: new Set() }
}

/** The dev/screenshot one-shot effects that used to live inline in Review: the scripted
 *  generate flow, focus, batch-send, fake-gen, fake-drift, and open-doc captures. Each is
 *  gated by its module-level run-once flag so a capture fires exactly once; the effect
 *  re-runs only when `loaded` changes, exactly as before. */
export function useDevReviewHooks({
  loaded,
  gen,
  scrollRef,
  setPendingDrift,
  openDoc
}: {
  loaded: LoadedReview | null
  gen: GenState
  scrollRef: RefObject<HTMLDivElement | null>
  setPendingDrift: (d: DriftSummary) => void
  openDoc: (path: string) => void
}): void {
  // dev-only scripted flow: LIMN_FLOW=generate auto-runs the engine once
  useEffect(() => {
    if (dev.flow === 'generate' && !devFlowRan && loaded && !loaded.state.annotations && !gen.running && !gen.error) {
      devFlowRan = true
      startGenerateNow()
    }
    // dev-only: LIMN_SCROLL_BOTTOM keeps scrolling the review body to the bottom as
    // the diffs render (scrollHeight grows over a few frames) to show the volatile band
    if (dev.scrollBottom && loaded) {
      let n = 0
      const t = setInterval(() => { const b = scrollRef.current; if (b) b.scrollTo({ top: b.scrollHeight }); if (++n > 12) clearInterval(t) }, 350)
    }
    // dev-only: LIMN_FOCUS=<json FocusTarget> focuses once after the review mounts
    if (dev.focus && !devFocusRan && loaded) {
      devFocusRan = true
      try { setTimeout(() => focusAnchor(JSON.parse(dev.focus!)), 600) } catch { /* bad json */ }
    }
    // dev-only: LIMN_RUN_BATCH runs the unified batch over all queued comments once
    if (dev.runBatch && !devBatchRan && loaded && !gen.running && !gen.error) {
      const ids = loaded.state.comments.filter((c) => c.status === 'queued').map((c) => c.id)
      if (ids.length > 0) { devBatchRan = true; setTimeout(() => sendComments(ids), 400) }
    }
    // dev-only: LIMN_FAKE_GEN injects a synthetic running review op so the live
    // generation panel (activity log + phase header + counters) can be captured
    if (dev.fakeGen && !devGenRan && loaded) {
      devGenRan = true
      useStore.setState({ gen: fakeGenState() })
    }
    // dev-only: LIMN_FAKE_DRIFT seeds a synthetic "branch moved" so the titlebar
    // fetch pill can be captured without a real external commit (open it via is-open)
    if (dev.fakeDrift && !devDriftRan && loaded) {
      devDriftRan = true
      setPendingDrift({ headSha: loaded.skeleton.headSha, commits: 2, files: 1, add: 24, del: 7, dirty: true })
    }
    // dev-only: LIMN_OPEN_DOC opens a spec/plan artifact doc once after mount
    if (dev.openDoc && !devDocRan && loaded) {
      devDocRan = true
      openDoc(dev.openDoc)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])
}
