import type { ActionRunDelta, ActionRunRef, ActionRunResult, ChatThread, Comment } from '../../shared/types'
import { runFindings } from '../../shared/actions'
import type { OpState } from '../store/derive'

// Pure derivations behind the action-thread surfaces (design board 14 R1/R3): the
// run bar under the drawer head and the result card after a run's last turn. Both
// read the thread's persisted messages — the launching user message carries `run`,
// the ending agent message carries `runResult` — plus the thread's live op.

/** One run as the thread records it. */
export interface RunView {
  run: ActionRunRef
  /** index of the launching user message */
  launchIndex: number
  startedAt: string
  /** the ending agent message's result, null while the run is still going */
  result: ActionRunResult | null
  endedAt: string | null
  /** a later run of the same action exists in this thread */
  superseded: boolean
}

export function runsOf(thread: Pick<ChatThread, 'messages'>): RunView[] {
  const out: RunView[] = []
  thread.messages.forEach((m, i) => {
    if (m.role !== 'user' || !m.run) return
    // the Attach findings follow-up re-uses the run: fold it into the existing view
    const existing = out.find((v) => v.run.runId === m.run!.runId)
    if (existing) { existing.result = null; existing.endedAt = null; return }
    out.push({ run: m.run, launchIndex: i, startedAt: m.at, result: null, endedAt: null, superseded: false })
  })
  thread.messages.forEach((m) => {
    if (m.role !== 'agent' || !m.runResult) return
    const v = out.find((x) => x.run.runId === m.runResult!.runId)
    if (v) { v.result = m.runResult; v.endedAt = m.at }
  })
  for (const v of out) v.superseded = out.some((o) => o.run.actionId === v.run.actionId && o.run.n > v.run.n)
  return out
}

export function latestRun(thread: Pick<ChatThread, 'messages'>): RunView | null {
  const runs = runsOf(thread)
  return runs.length ? runs[runs.length - 1] : null
}

/** "1 m 12 s" / "42 s" for a run's duration. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, '0')} s`
}

export type RunBarState =
  | { kind: 'queued'; position: number; behind: string }
  | { kind: 'running'; spelled: string; collects: boolean }
  | { kind: 'finished'; collects: boolean; count: number; delta: ActionRunDelta | null; duration: string; availabilityFrom?: string }
  | { kind: 'refused'; error: string }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled' }

/** What the run bar says for a thread's latest run. Null when the thread has no run.
 *  While the run's op is live the bar follows the op (queued → running); afterwards
 *  it follows the persisted result. `spelled` is the prompt's first line — the skill
 *  as it was actually invoked, or the prompt action's name. */
export function runBarState(thread: Pick<ChatThread, 'messages'>, op: OpState, comments: readonly Comment[]): RunBarState | null {
  const v = latestRun(thread)
  if (!v) return null
  const launch = thread.messages[v.launchIndex]
  if (op.running) {
    if (op.queued) return { kind: 'queued', position: op.queued.position, behind: op.queued.behind }
    return { kind: 'running', spelled: v.run.kind === 'skill' ? launch.text.split('\n')[0] : v.run.name, collects: runCollects(v.run) }
  }
  if (!v.result) {
    // no persisted result and no live op: the run ended without a record (a tab that
    // missed the end, a crash) — read it as finished with whatever landed
    return { kind: 'finished', collects: runCollects(v.run), count: runFindings(comments, v.run.runId).length, delta: null, duration: '' }
  }
  switch (v.result.outcome) {
    case 'finished': {
      const ms = v.endedAt ? Date.parse(v.endedAt) - Date.parse(v.startedAt) : NaN
      return { kind: 'finished', collects: runCollects(v.run), count: runFindings(comments, v.run.runId).length, delta: v.result.delta ?? null, duration: Number.isNaN(ms) ? '' : fmtDuration(ms), ...(v.result.availabilityFrom ? { availabilityFrom: v.result.availabilityFrom } : {}) }
    }
    case 'refused': return { kind: 'refused', error: v.result.error ?? 'Nothing was sent.' }
    case 'failed': return { kind: 'failed', error: v.result.error ?? 'The run failed.' }
    case 'cancelled': return { kind: 'cancelled' }
  }
}

/** A run recorded before the switch existed always collected findings. */
export function runCollects(run: Pick<ActionRunRef, 'findings'>): boolean {
  return run.findings ?? true
}

/** "branch unchanged" / "2 commits · 11 files" / "uncommitted changes" — the
 *  receipt's branch half; null when the delta could not be measured. */
export function deltaLabel(delta: ActionRunDelta | null): string | null {
  if (!delta) return null
  if (delta.commits === 0 && delta.files === 0 && !delta.dirty) return 'branch unchanged'
  const parts: string[] = []
  if (delta.commits > 0) parts.push(`${delta.commits} commit${delta.commits === 1 ? '' : 's'}`)
  if (delta.files > 0) parts.push(`${delta.files} file${delta.files === 1 ? '' : 's'}`)
  if (delta.dirty) parts.push('uncommitted changes')
  return parts.join(' · ')
}

export type ResultCardState =
  | {
      kind: 'receipt'; runId: string
      /** the run collected findings (its count is meaningful, the triage pair shows) */
      collects: boolean
      open: number; dismissed: number; total: number; first: Comment | null
      delta: ActionRunDelta | null
      /** the findings pass could not read the report (or predates the pass) and the
       *  run wrote prose: offer the manual Attach findings, unless kept as prose */
      attachOffer: boolean
    }
  | { kind: 'superseded'; by: number; kept: number }

/** The receipt that follows a finished run's last turn (spec agent-actions-intent
 *  §2.6): findings when collected, the branch delta always; `superseded` once a
 *  later run of the same action replaced its untouched proposals. Null for a run
 *  still going or one that did not finish. */
export function resultCardState(v: RunView, comments: readonly Comment[], agentText: string): ResultCardState | null {
  if (!v.result || v.result.outcome !== 'finished') return null
  const mine = runFindings(comments, v.run.runId)
  if (v.superseded) {
    // proposals the reviewer took (accepted, kept, replied to) survive a re-run
    const kept = mine.filter((c) => c.status !== 'proposed' && c.status !== 'dismissed').length + mine.filter((c) => (c.status === 'proposed' || c.status === 'dismissed') && c.replies.length > 0).length
    return { kind: 'superseded', by: v.run.n + 1, kept }
  }
  const open = mine.filter((c) => c.status === 'proposed')
  const dismissed = mine.filter((c) => c.status === 'dismissed').length
  const collects = runCollects(v.run)
  const passMissed = v.result.extraction === 'failed' || (v.result.extraction === undefined && v.run.kind === 'skill')
  const attachOffer = collects && mine.length === 0 && passMissed && agentText.trim().length > 0 && !v.result.keepProse
  return { kind: 'receipt', runId: v.run.runId, collects, open: open.length, dismissed, total: mine.length, first: open[0] ?? mine[0] ?? null, delta: v.result.delta ?? null, attachOffer }
}
