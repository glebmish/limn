import type { ChatThread, Comment } from '../../shared/types'
import type { OpState } from '../store/derive'
import { runFindings } from '../../shared/actions'
import { runsOf } from './runs'
import { fmtDuration } from './runs'

// The Chat button's pill (design board 14 R2, v3): the one place every running thing
// reports with the drawer closed — a count of what runs and waits, amber when an
// approval waits on the reviewer, dashed when a run finished with proposals the
// reviewer has not looked at. The hover list breaks the count down.

export interface RunRow {
  key: string
  opId: string | null
  threadId: number | null
  /** "Generating the review" · "Simplify · run 2" */
  title: string
  /** "Claude · 2 findings so far" · "needs the lane · starts when Generating the review ends" */
  sub: string
  /** elapsed / "2nd" / "3 min ago" */
  time: string
  position?: number
}

export interface PillModel {
  running: RunRow[]
  queued: RunRow[]
  unseen: RunRow[]
  pill: { kind: 'run' | 'amber' | 'new'; text: string } | null
}

function threadTitle(t: ChatThread | undefined, all: readonly ChatThread[]): string {
  if (!t) return 'Chat'
  if (t.action) return t.action.name
  if (t.kind === 'review') {
    const reviews = all.filter((x) => x.kind === 'review')
    return t.id === reviews[reviews.length - 1]?.id ? 'Review chat' : 'Review chat · old'
  }
  return t.title ?? 'Chat'
}

const engineName = (t: ChatThread | undefined): string => (t?.agent.engine === 'codex' ? 'Codex' : 'Claude')

export function pillModel(opts: {
  ops: Record<string, OpState>
  chats: readonly ChatThread[]
  comments: readonly Comment[]
  /** ISO time the reviewer last had each thread open in the drawer */
  seenThreadAt: Record<number, string>
  /** the thread showing in the drawer right now, if it is open */
  shownThreadId: number | null
  approvalsPending: number
  now?: number
}): PillModel {
  const now = opts.now ?? Date.now()
  const running: RunRow[] = []
  const queued: RunRow[] = []
  for (const op of Object.values(opts.ops)) {
    if (!op.running) continue
    const thread = op.threadId != null ? opts.chats.find((c) => c.id === op.threadId) : undefined
    const latest = thread ? runsOf(thread).at(-1) ?? null : null
    const isRun = latest != null && latest.result == null
    const title = op.kind === 'review' ? 'Generating the review' : isRun ? `${latest.run.name} · run ${latest.run.n}` : threadTitle(thread, opts.chats)
    const findings = isRun ? runFindings(opts.comments, latest.run.runId).length : 0
    const elapsed = op.startedAt != null ? fmtDuration(now - op.startedAt) : ''
    if (op.queued) {
      queued.push({
        key: op.opId ?? title, opId: op.opId, threadId: op.threadId, title,
        sub: op.queued.behind ? `needs the lane · starts when ${op.queued.behind} ends` : 'waiting for the lane',
        time: ordinalShort(op.queued.position), position: op.queued.position
      })
    } else {
      running.push({
        key: op.opId ?? title, opId: op.opId, threadId: op.threadId, title,
        sub: op.kind === 'review' ? `${engineName(thread)} · exploring the branch` : `${engineName(thread)}${isRun ? ` · ${findings} finding${findings === 1 ? '' : 's'} so far` : ''}`,
        time: elapsed
      })
    }
  }
  queued.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))

  // finished runs with open proposals the reviewer has not opened since they ended
  const unseen: RunRow[] = []
  for (const t of opts.chats) {
    if (t.id === opts.shownThreadId) continue
    for (const v of runsOf(t)) {
      if (!v.result || v.result.outcome !== 'finished' || !v.endedAt) continue
      const seenAt = opts.seenThreadAt[t.id]
      if (seenAt && seenAt >= v.endedAt) continue
      const open = runFindings(opts.comments, v.run.runId).filter((c) => c.status === 'proposed').length
      if (open === 0) continue
      unseen.push({ key: v.run.runId, opId: null, threadId: t.id, title: `${v.run.name} · run ${v.run.n}`, sub: `${engineName(t)} · ${open} finding${open === 1 ? '' : 's'} proposed`, time: agoShort(v.endedAt, now) })
    }
  }

  let pill: PillModel['pill'] = null
  const live = running.length + queued.length
  if (opts.approvalsPending > 0) pill = { kind: 'amber', text: `approval${live > 0 ? ` · ${running.length} running` : ''}` }
  else if (live > 0) pill = { kind: 'run', text: `${running.length} running${queued.length ? ` · ${queued.length} queued` : ''}` }
  else {
    const proposed = unseen.reduce((n, r) => n + Number(/(\d+) finding/.exec(r.sub)?.[1] ?? 0), 0)
    if (proposed > 0) pill = { kind: 'new', text: `${proposed} proposed` }
  }
  return { running, queued, unseen, pill }
}

function ordinalShort(n: number): string {
  const rem = n % 100
  if (rem >= 11 && rem <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

function agoShort(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000))
  if (Number.isNaN(s) || s < 60) return 'just now'
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`
}
