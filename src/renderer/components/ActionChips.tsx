import { Fragment, useMemo, useState, type ReactNode } from 'react'
import type { AgentAction, CommentAnchor, EngineId, FocusTarget } from '../../shared/types'
import { I, EngineGlyph, Ava } from '../kit'
import { effectiveSections, fileViewed, sectionViewState, useStore } from '../store'
import { focusAnchor } from '../lib/focus'
import { agentLabel } from '../../shared/agents'

const VERDICT_ICON = { addressed: '✓', reworked: '↻', skipped: '✗' } as const

function base(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

/** Tour notes sometimes begin with a circled index (①②③…) that just duplicates the
 *  stop's number badge — strip a leading circled number and any separator/space. */
function stripLeadingMarker(note: string): string {
  return note.replace(/^[①-⑳⓪❶-❿⓵-⓾]\s*[.):·–—-]?\s*/u, '')
}

function focusKind(a: FocusTarget): string {
  switch (a.kind) {
    case 'summary': return 'Summary'
    case 'section': return 'Section'
    case 'file': return 'File'
    case 'diff': return 'File'
  }
}

function focusTarget(a: FocusTarget): { text: string; mono: boolean } {
  switch (a.kind) {
    case 'summary': return { text: 'Review summary', mono: false }
    case 'section': {
      const sec = effectiveSections(useStore.getState().loaded).find((s) => s.id === a.sectionId)
      return { text: sec?.name ?? 'Review section', mono: false }
    }
    case 'file': return { text: base(a.file), mono: true }
    case 'diff': return { text: `${base(a.file)}:${a.line}`, mono: true }
  }
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

function FocusCard({ action }: { action: Extract<AgentAction, { kind: 'focus' }> }) {
  const target = focusTarget(action.anchor)
  return (
    <button className="limn-act focus" title="Re-focus this in the review" onClick={() => focusAnchor(action.anchor)}>
      <div className="limn-act-head">
        <I.eye className="ah-ic" />
        <span className="ah-verb">Jump to</span>
      </div>
      <div className="limn-peek">
        <span className="pk-rail"></span>
        <div className="pk-body">
          <span className="pk-kind">{focusKind(action.anchor)}</span>
          <div className={'pk-target' + (target.mono ? ' mono' : '')}>{target.text}</div>
        </div>
      </div>
    </button>
  )
}

export function nextTourIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return ((current + delta) % count + count) % count
}

function TourCard({ action }: { action: Extract<AgentAction, { kind: 'tour' }> }) {
  const [cur, setCur] = useState(0)
  const stopCount = action.stops.length
  const go = (next: number): void => {
    const bounded = nextTourIndex(cur, next - cur, stopCount)
    setCur(bounded)
    const stop = action.stops[bounded]
    if (stop) focusAnchor(stop.target)
  }
  if (stopCount === 0) return null

  return (
    <div className="limn-act tour">
      <div className="limn-act-head">
        <I.tour className="ah-ic" />
        <span className="ah-verb">Walkthrough</span>
        <span className="ah-anchor">{stopCount} stops{action.loop ? ' · loops' : ''}</span>
      </div>
      <div className="limn-tour-stops">
        {action.stops.map((stop, i) => {
          const label = focusTarget(stop.target)
          return (
            <Fragment key={i}>
              <button
                type="button"
                className={'lt-stop' + (i === cur ? ' on' : '')}
                onClick={() => go(i)}
              >
                <span className="lt-n">{i + 1}</span>
                <span className={'lt-name' + (label.mono ? ' mono' : '')}>{label.text}</span>
              </button>
              {stop.note && (
                <div role="note" className="lt-note">{stripLeadingMarker(stop.note)}</div>
              )}
            </Fragment>
          )
        })}
      </div>
      <div className="limn-tour-bar">
        <button className="lt-ctl" onClick={() => go(cur - 1)}>
          <I.chevR style={{ width: 10, height: 10, transform: 'rotate(180deg)' }} />Prev
        </button>
        <span className="lt-pos">Stop {cur + 1} of {stopCount}</span>
        <button className="lt-ctl" onClick={() => go(cur + 1)}>
          Next<I.chevR style={{ width: 10, height: 10 }} />
        </button>
      </div>
    </div>
  )
}

function Quote({ commentId }: { commentId?: string }) {
  const comment = useStore((s) => s.loaded?.state.comments.find((c) => c.id === commentId))
  if (!comment) return null
  return (
    <div className="limn-quote">
      <div className="q-who"><Ava ai={comment.author === 'agent'}>{comment.author === 'agent' ? 'AI' : 'me'}</Ava>{comment.author === 'agent' ? 'Agent' : 'You'} · {anchorShort(comment.anchor)}</div>
      <div className="q-text">{comment.text}</div>
    </div>
  )
}

function CommentActionCard({ action, engine }: {
  action: Extract<AgentAction, { kind: 'comment_added' | 'comment_replied' | 'comment_resolved' }>
  engine?: EngineId
}) {
  const added = action.kind === 'comment_added'
  const resolved = action.kind === 'comment_resolved'
  const anchor = added ? action.comment.anchor : action.anchor
  const body = added ? action.comment.text : action.kind === 'comment_replied' ? action.reply.text : action.note
  const title = added ? 'Commented' : action.kind === 'comment_replied' ? 'Replied' : 'Resolved'
  const Icon = added ? I.bubble : resolved ? I.check : I.arrow
  return (
    <div className="limn-act cmt">
      <div className="limn-act-head">
        <Icon className="ah-ic" />
        <span className="ah-verb">{title}</span>
        {resolved
          ? <span className={'ah-verdict ' + action.verdict}>{VERDICT_ICON[action.verdict]} {action.verdict}</span>
          : <span className="ah-anchor">on {anchorShort(anchor)}</span>}
      </div>
      {!added && <Quote commentId={action.commentId} />}
      <div className="limn-cmtbody">
        <div className="cb-who"><Ava ai>AI</Ava>{engine ? agentLabel({ engine }) : 'Agent'}</div>
        <div className="cb-text">{body}</div>
      </div>
    </div>
  )
}

/** The resolved state to show on mount: an explicit dismissal is persisted; the
 *  "marked" outcome is derived from the real viewed marks (every suggested file
 *  viewed, and every suggested section fully viewed). Anything unresolvable counts
 *  as not-viewed, so the card stays actionable. */
function suggestResolved(action: Extract<AgentAction, { kind: 'suggest_viewed' }>): 'idle' | 'done' | 'dismissed' {
  if (action.resolution === 'dismissed') return 'dismissed'
  const files = action.files ?? []
  const sectionIds = action.sectionIds ?? []
  if (files.length === 0 && sectionIds.length === 0) return 'idle'
  const { loaded, viewedAt } = useStore.getState()
  const diffFiles = loaded ? (loaded.dirty && loaded.merged ? loaded.merged : loaded.skeleton.files) : []
  const sections = effectiveSections(loaded)
  const filesViewed = files.every((p) => {
    const fd = diffFiles.find((f) => f.path === p)
    return fd ? fileViewed(fd, viewedAt) : false
  })
  const sectionsViewed = sectionIds.every((id) => {
    const sec = sections.find((s) => s.id === id)
    if (!sec) return false
    return sectionViewState(diffFiles.filter((f) => sec.files.includes(f.path)), viewedAt) === 'all'
  })
  return filesViewed && sectionsViewed ? 'done' : 'idle'
}

/** suggest_mark_viewed renders as a button — nothing happens until the reviewer
 *  confirms, at which point the files (and every file of a suggested section) get
 *  their viewed mark; a section is "viewed" exactly when all its files are. The
 *  resolution survives chat re-entry: a dismissal is persisted, and the "marked"
 *  outcome is re-derived from the real viewed marks on mount. */
function SuggestCard({ action, threadId }: { action: Extract<AgentAction, { kind: 'suggest_viewed' }>; threadId?: number }) {
  const { toggleViewed, setSectionViewed, dismissSuggestion, loaded } = useStore()
  const [state, setState] = useState<'idle' | 'done' | 'dismissed'>(() => suggestResolved(action))
  const sections = effectiveSections(loaded)
  const items = useMemo(() => {
    const files = action.files ?? []
    const sectionIds = action.sectionIds ?? []
    return [
      ...files.map((path) => ({ key: `file:${path}`, kind: 'file' as const, id: path, name: base(path) })),
      ...sectionIds.map((id) => ({ key: `section:${id}`, kind: 'section' as const, id, name: sections.find((s) => s.id === id)?.name ?? 'section' }))
    ]
  }, [action.files, action.sectionIds, sections])
  const [selected, setSelected] = useState<Set<string>>(() => new Set(items.map((i) => i.key)))
  const selectedCount = selected.size
  const targets = items.map((i) => i.name).join(', ')

  if (state === 'done') {
    return <div className="limn-suggest done"><I.check style={{ width: 12, height: 12 }} />Marked {selectedCount} item{selectedCount === 1 ? '' : 's'} viewed</div>
  }
  if (state === 'dismissed') {
    return <div className="limn-suggest dismissed">Suggestion dismissed</div>
  }
  const allSelected = selectedCount === items.length
  return (
    <div className="limn-suggest">
      <div className="ls-head"><I.eye style={{ width: 12, height: 12 }} />Mark viewed?<span className="ls-targets" title={targets}>{targets}</span></div>
      {action.note && <div className="ls-note">{action.note}</div>}
      <div className="ls-selall">
        <button className="ls-selall-btn" onClick={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.key)))}>{allSelected ? 'Clear all' : 'Select all'}</button>
        <span className="ls-count">{selectedCount} of {items.length} selected</span>
      </div>
      <div className="ls-items">
        {items.map((item) => (
          <label key={item.key} className={'ls-item' + (selected.has(item.key) ? ' on' : '')}>
            <span className="ls-box"><I.check style={{ width: 10, height: 10 }} /></span>
            <input
              type="checkbox"
              checked={selected.has(item.key)}
              onChange={() => setSelected((prev) => {
                const next = new Set(prev)
                if (next.has(item.key)) next.delete(item.key)
                else next.add(item.key)
                return next
              })}
              style={{ display: 'none' }}
            />
            <span className="ls-name">{item.name}</span>
            <span className="ls-kind">{item.kind}</span>
          </label>
        ))}
      </div>
      <div className="ls-sub">A suggestion only — nothing changes until you confirm.</div>
      <div className="ls-act">
        <button className="btn btn-sm btn-primary" disabled={selectedCount === 0} onClick={() => {
          for (const item of items) {
            if (!selected.has(item.key)) continue
            if (item.kind === 'file') toggleViewed(item.id, false)
            else {
              const sec = sections.find((s) => s.id === item.id)
              if (sec) setSectionViewed(sec.id, sec.files, true)
            }
          }
          setState('done')
        }}><I.check style={{ width: 11, height: 11 }} />Mark {selectedCount} viewed</button>
        <button className="btn btn-sm btn-ghost" onClick={() => {
          setState('dismissed')
          if (threadId != null && action.id) void dismissSuggestion(threadId, action.id)
        }}>Dismiss</button>
      </div>
    </div>
  )
}

function renderAction(action: AgentAction, engine?: EngineId, threadId?: number): { kind: 'chip' | 'card'; node: ReactNode } | null {
  switch (action.kind) {
    case 'focus':
      return { kind: 'card', node: <FocusCard action={action} /> }
    case 'tour':
      return { kind: 'card', node: <TourCard action={action} /> }
    case 'suggest_viewed':
      return { kind: 'card', node: <SuggestCard action={action} threadId={threadId} /> }
    case 'comment_added':
    case 'comment_replied':
      return { kind: 'card', node: <CommentActionCard action={action} engine={engine} /> }
    case 'comment_resolved':
      return { kind: 'card', node: <CommentActionCard action={action} engine={engine} /> }
    case 'review_edited': {
      const target: FocusTarget = action.sectionId ? { kind: 'section', sectionId: action.sectionId } : { kind: 'summary' }
      const what = action.field === 'title' ? 'the title'
        : action.field === 'summary' ? 'the summary'
          : 'a section'
      return { kind: 'chip', node: (
        <button className="limn-chip" title="Show in the review" onClick={() => focusAnchor(target)}>
          <EngineGlyph engine={engine} style={{ width: 11, height: 11 }} />edited {what}
        </button>
      ) }
    }
    default:
      return null
  }
}

/** The action chips for one turn (live or settled). */
export function ActionChips({ actions, engine, threadId }: { actions: AgentAction[]; engine?: EngineId; threadId?: number }) {
  if (!actions.length) return null
  const rendered = actions.map((a) => renderAction(a, engine, threadId)).filter((n): n is { kind: 'chip' | 'card'; node: ReactNode } => Boolean(n))
  const chips = rendered.filter((r) => r.kind === 'chip')
  const cards = rendered.filter((r) => r.kind === 'card')
  return (
    <>
      {chips.length > 0 && <div className="limn-chips">{chips.map((r, i) => <span key={i}>{r.node}</span>)}</div>}
      {cards.length > 0 && <div className="limn-acts">{cards.map((r, i) => <div key={i}>{r.node}</div>)}</div>}
    </>
  )
}
