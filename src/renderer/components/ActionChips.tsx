import { useState } from 'react'
import type { AgentAction, CommentAnchor, EngineId, FocusTarget } from '../../shared/types'
import { I, EngineGlyph } from '../kit'
import { effectiveSections, useStore } from '../store'
import { focusAnchor } from '../lib/focus'

const VERDICT_ICON = { addressed: '✓', reworked: '↻', skipped: '✗' } as const

function base(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

function focusLabel(a: FocusTarget): string {
  switch (a.kind) {
    case 'summary': return 'the summary'
    case 'section': return 'a section'
    case 'file': return base(a.file)
    case 'diff': return `${base(a.file)}:${a.line}`
  }
}

/** The CommentAnchor kinds focusAnchor can resolve (the FocusTarget subset). */
function asFocusTarget(a: CommentAnchor): FocusTarget | null {
  return a.kind === 'diff' || a.kind === 'file' || a.kind === 'section' || a.kind === 'summary' ? a : null
}

function anchorShort(a: CommentAnchor): string {
  switch (a.kind) {
    case 'diff': return `${base(a.file)}:${a.line}`
    case 'file': return base(a.file)
    case 'section': return 'a section'
    case 'summary': return 'the summary'
    case 'artifact': return `${base(a.path)}:${a.line}`
    case 'plan-step': return `plan step ${a.stepN}`
    case 'question': return 'a question'
    case 'title': return 'the title'
    case 'acceptance': return `criterion ${a.index + 1}`
    case 'deviation': return `deviation ${a.index + 1}`
    case 'selection': return `“${a.quote.length > 24 ? a.quote.slice(0, 23) + '…' : a.quote}”`
  }
}

function CommentChip({ anchor, verb, badge }: { anchor: CommentAnchor; verb: string; badge?: React.ReactNode }) {
  const ft = asFocusTarget(anchor)
  return (
    <button className="limn-chip" title={ft ? 'Show in the review' : undefined} disabled={!ft} onClick={() => ft && focusAnchor(ft)}>
      <I.bubble style={{ width: 11, height: 11 }} />{verb} {anchorShort(anchor)}{badge}
    </button>
  )
}

/** suggest_mark_viewed renders as a button — nothing happens until the reviewer
 *  confirms, at which point the files (and every file of a suggested section) get
 *  their viewed mark; a section is "viewed" exactly when all its files are. */
function SuggestCard({ action }: { action: Extract<AgentAction, { kind: 'suggest_viewed' }> }) {
  const { toggleViewed, setSectionViewed, loaded } = useStore()
  const [state, setState] = useState<'idle' | 'done' | 'dismissed'>('idle')
  const files = action.files ?? []
  const sectionIds = action.sectionIds ?? []
  const count = files.length + sectionIds.length
  const targets = [...files.map(base), ...sectionIds.map(() => 'section')].join(', ')

  if (state === 'done') {
    return <div className="limn-suggest done"><I.check style={{ width: 12, height: 12 }} />Marked {count === 1 ? targets : `${count} viewed`}</div>
  }
  if (state === 'dismissed') {
    return <div className="limn-suggest dismissed">Suggestion dismissed</div>
  }
  return (
    <div className="limn-suggest">
      <div className="ls-head"><I.eye style={{ width: 12, height: 12 }} />Mark viewed?<span className="ls-targets" title={targets}>{targets}</span></div>
      {action.note && <div className="ls-note">{action.note}</div>}
      <div className="ls-sub">A suggestion only — nothing changes until you confirm.</div>
      <div className="ls-act">
        <button className="btn btn-sm btn-primary" onClick={() => {
          for (const f of files) toggleViewed(f, false)
          if (sectionIds.length) {
            const secs = effectiveSections(loaded)
            for (const sid of sectionIds) {
              const sec = secs.find((s) => s.id === sid)
              if (sec) setSectionViewed(sec.id, sec.files, true)
            }
          }
          setState('done')
        }}><I.check style={{ width: 11, height: 11 }} />Mark viewed</button>
        <button className="btn btn-sm btn-ghost" onClick={() => setState('dismissed')}>Dismiss</button>
      </div>
    </div>
  )
}

function Chip({ action, engine }: { action: AgentAction; engine?: EngineId }) {
  switch (action.kind) {
    case 'focus':
      return (
        <button className="limn-chip" title="Re-focus this in the review" onClick={() => focusAnchor(action.anchor)}>
          <I.eye style={{ width: 11, height: 11 }} />jumped to {focusLabel(action.anchor)}
        </button>
      )
    case 'suggest_viewed':
      return <SuggestCard action={action} />
    case 'comment_added':
      return <CommentChip anchor={action.comment.anchor} verb="commented on" />
    case 'comment_replied':
      return <CommentChip anchor={action.anchor} verb="replied to" />
    case 'comment_resolved':
      return <CommentChip anchor={action.anchor} verb="resolved"
        badge={<span className={'limn-verdict ' + action.verdict}>{VERDICT_ICON[action.verdict]} {action.verdict}</span>} />
    case 'review_edited': {
      const target: FocusTarget = action.sectionId ? { kind: 'section', sectionId: action.sectionId } : { kind: 'summary' }
      const what = action.field === 'title' ? 'the title'
        : action.field === 'summary' ? 'the summary'
          : 'a section'
      return (
        <button className="limn-chip" title="Show in the review" onClick={() => focusAnchor(target)}>
          <EngineGlyph engine={engine} style={{ width: 11, height: 11 }} />edited {what}
        </button>
      )
    }
    case 'code_committed':
      return (
        <span className="limn-chip committed" title={action.message}>
          <I.changed style={{ width: 11, height: 11 }} />committed {action.sha} · {action.files.length} file{action.files.length === 1 ? '' : 's'}
        </span>
      )
    default:
      return null
  }
}

/** The action chips for one turn (live or settled). */
export function ActionChips({ actions, engine }: { actions: AgentAction[]; engine?: EngineId }) {
  if (!actions.length) return null
  return (
    <div className="limn-chips">
      {actions.map((a, i) => <Chip key={i} action={a} engine={engine} />)}
    </div>
  )
}
