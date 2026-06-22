import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { ACCENT, checkoutGate, DENSITY, effectiveSections, GUIDANCE, useStore } from '../store'
import { I, ficonClass, shortSha, EngineGlyph, CmtPlus } from '../kit'
import type { EngineEvent, FileDiff, Section, ToolVerb } from '../../shared/types'
import { FORMAT_LABELS } from '../../shared/types'
import { SectionView } from '../components/SectionView'
import { DiffView } from '../components/DiffView'
import { GenPanel, startGenerateNow } from '../components/GenPanel'
import { Questions } from '../components/Questions'
import { ArtifactDoc } from '../components/ArtifactDoc'
import { ChatDrawer } from '../components/ChatDrawer'
import { WorkspacePicker } from '../components/WorkspacePicker'
import { RefPicker } from '../components/RefPicker'
import { addComment, queuedComments, sendComments } from '../lib/comments'
import { Composer, InlineThread } from '../components/Threads'
import { Commentable, SelectionThreads } from '../components/Commentable'
import { agentLabel } from '../../shared/agents'
import { focusAnchor } from '../lib/focus'

let devFlowRan = false
let devFocusRan = false
let devBatchRan = false
let devGenRan = false
let devDocRan = false

/** dev-only: a synthetic mid-flight review op for capturing the live gen panel. */
function fakeGenState(): { running: true; opId: string; kind: 'review'; threadId: null; log: EngineEvent[]; error: null; startedAt: number } {
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
  return { running: true, opId: 'dev-fake', kind: 'review', threadId: null, log, error: null, startedAt: Date.now() - 48000 }
}

export default function Review() {
  const store = useStore()
  const { loaded, branch, base, reviewedSections, viewedAt, cur, gen, docPath, openDoc, closeDoc } = store
  const scrollRef = useRef<HTMLDivElement>(null)
  const secRefs = useRef<Record<string, HTMLDivElement | null>>({})
  // scroll memory: the review position to return to when a doc closes, plus each
  // doc's own scroll position (per file — a different doc opens from its own top)
  const reviewScrollRef = useRef(0)
  const docScrollRef = useRef<Record<string, number>>({})
  const [verdict, setVerdict] = useState<'changes' | 'approve'>('changes')
  const [verdictOpen, setVerdictOpen] = useState(false)
  const [topFilter, setTopFilter] = useState<'changed' | 'all'>('changed')
  const [peek, setPeek] = useState<string | null>(window.limnDev?.openPeek ?? null)
  const [summaryCommenting, setSummaryCommenting] = useState(false)
  const [commentStep, setCommentStep] = useState<number | null>(null)
  const [titleCommenting, setTitleCommenting] = useState(false)
  const [commentCriterion, setCommentCriterion] = useState<number | null>(null)
  const chatOpen = store.chatOpen

  const sections = useMemo(() => effectiveSections(loaded), [loaded])
  const fileMap = useMemo(() => new Map((loaded?.skeleton.files ?? []).map((f) => [f.path, f])), [loaded])
  const filesFor = (s: Section): FileDiff[] => s.files.map((p) => fileMap.get(p)).filter((f): f is FileDiff => Boolean(f))

  // dev-only scripted flow: LIMN_FLOW=generate auto-runs the engine once
  useEffect(() => {
    if (window.limnDev?.flow === 'generate' && !devFlowRan && loaded && !loaded.state.annotations && !gen.running && !gen.error) {
      devFlowRan = true
      startGenerateNow()
    }
    if (window.limnDev?.flow === 'fix' && !devFlowRan && loaded && !gen.running && !gen.error) {
      const ids = loaded.state.comments.filter((c) => c.status === 'queued').map((c) => c.id)
      if (ids.length > 0) {
        devFlowRan = true
        sendComments(ids)
      }
    }
    // dev-only: LIMN_SCROLL_BOTTOM keeps scrolling the review body to the bottom as
    // the diffs render (scrollHeight grows over a few frames) to show the volatile band
    if (window.limnDev?.scrollBottom && loaded) {
      let n = 0
      const t = setInterval(() => { const b = scrollRef.current; if (b) b.scrollTo({ top: b.scrollHeight }); if (++n > 12) clearInterval(t) }, 350)
    }
    // dev-only: LIMN_FOCUS=<json FocusTarget> focuses once after the review mounts
    if (window.limnDev?.focus && !devFocusRan && loaded) {
      devFocusRan = true
      try { setTimeout(() => focusAnchor(JSON.parse(window.limnDev!.focus!)), 600) } catch { /* bad json */ }
    }
    // dev-only: LIMN_RUN_BATCH runs the unified batch over all queued comments once
    if (window.limnDev?.runBatch && !devBatchRan && loaded && !gen.running && !gen.error) {
      const ids = loaded.state.comments.filter((c) => c.status === 'queued').map((c) => c.id)
      if (ids.length > 0) { devBatchRan = true; setTimeout(() => sendComments(ids), 400) }
    }
    // dev-only: LIMN_FAKE_GEN injects a synthetic running review op so the live
    // generation panel (activity log + phase header + counters) can be captured
    if (window.limnDev?.fakeGen && !devGenRan && loaded) {
      devGenRan = true
      useStore.setState({ gen: fakeGenState() })
    }
    // dev-only: LIMN_OPEN_DOC opens a spec/plan artifact doc once after mount
    if (window.limnDev?.openDoc && !devDocRan && loaded) {
      devDocRan = true
      openDoc(window.limnDev.openDoc)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  // scroll-sync current section
  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const onScroll = (): void => {
      // the doc view shares this scroll container; scrolling a spec/plan must
      // not re-track the (unmounted) changes sections in the sidebar
      if (useStore.getState().docPath) return
      const baseTop = box.getBoundingClientRect().top + 90
      const reviewed = useStore.getState().reviewedSections
      const firstOpen = sections.find((s) => !reviewed.has(s.id))
      let active = firstOpen ? firstOpen.id : sections[0]?.id
      for (const s of sections) {
        if (reviewed.has(s.id)) continue
        const el = secRefs.current[s.id]
        if (el && el.getBoundingClientRect().top <= baseTop) active = s.id
      }
      if (active) useStore.getState().setCur(active)
    }
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => box.removeEventListener('scroll', onScroll)
  }, [sections])

  if (!loaded) return null
  const { skeleton, state, artifacts, commits, sinceTagged } = loaded
  const annotations = state.annotations
  // who produced THIS review — locked to the generating agent (not the regen picker)
  const guidedBy = annotations?.generatedBy ?? state.agent ?? store.agent
  const totalAdd = skeleton.files.reduce((n, f) => n + f.add, 0)
  const totalDel = skeleton.files.reduce((n, f) => n + f.del, 0)
  const reviewedCount = sections.filter((s) => reviewedSections.has(s.id)).length
  const fileCount = skeleton.files.length
  const viewedCount = skeleton.files.filter((f) => viewedAt[f.path]).length
  const queued = queuedComments()
  const summaryComments = state.comments.filter((c) => c.anchor.kind === 'summary')
  const titleComments = state.comments.filter((c) => c.anchor.kind === 'title')
  const stepComments = (n: number) => state.comments.filter((c) => c.anchor.kind === 'plan-step' && c.anchor.stepN === n)
  const criterionComments = (i: number) => state.comments.filter((c) => c.anchor.kind === 'acceptance' && c.anchor.index === i)
  const baseline = state.approvedSha ?? state.reviewedAtSha
  const driftCount = baseline ? commits.findIndex((c) => c.sha === baseline) : -1
  const lastIteration = state.iterations[state.iterations.length - 1]
  const approved = state.approvedSha === skeleton.headSha
  // detached compare branch ⇒ agent locked: sending queued comments is blocked
  // until checkout (the agent edits real files). Comments stay saved meanwhile.
  const gate = checkoutGate(loaded)

  const jumpTo = (id: string): void => {
    // Selecting a section while a spec/plan doc is open exits the doc back to
    // the changes view — the changes list then has to remount before its
    // section refs exist, so the scroll retries across a few frames.
    if (docPath) {
      if (scrollRef.current) docScrollRef.current[docPath] = scrollRef.current.scrollTop
      closeDoc()
    }
    store.openSection(id)
    let tries = 0
    const scroll = (): void => {
      const el = secRefs.current[id]
      const box = scrollRef.current
      if (!el || !box) {
        if (tries++ < 10) requestAnimationFrame(scroll)
        return
      }
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12
      // 'instant' (NOT 'auto' — auto resolves to the CSS scroll-behavior:smooth on
      // .gmain, which animates and makes the sidebar flicker through every section
      // the viewport passes). We want the section to appear in a single jump.
      box.scrollTo({ top: Math.max(0, top), behavior: 'instant' })
    }
    requestAnimationFrame(scroll)
  }

  // restore a saved scroll position after the doc/review view swaps in (its content
  // lays out over a few frames, so re-apply across them). Direct scrollTop assignment
  // is instant regardless of .gmain's scroll-behavior:smooth.
  const restoreScroll = (target: number): void => {
    let tries = 0
    const apply = (): void => {
      if (scrollRef.current) scrollRef.current.scrollTop = target
      if (tries++ < 10) requestAnimationFrame(apply)
    }
    requestAnimationFrame(apply)
  }

  // open a doc (and its sidebar dropdown), remembering where we left the prior view
  const goToDoc = (path: string): void => {
    const box = scrollRef.current
    if (box) {
      if (docPath) docScrollRef.current[docPath] = box.scrollTop
      else reviewScrollRef.current = box.scrollTop
    }
    setPeek(path)
    openDoc(path)
    restoreScroll(docScrollRef.current[path] ?? 0)
  }

  // close the open doc and land back at the same spot in the review
  const closeDocBack = (): void => {
    if (docPath && scrollRef.current) docScrollRef.current[docPath] = scrollRef.current.scrollTop
    setPeek(null)
    closeDoc()
    restoreScroll(reviewScrollRef.current)
  }

  // clicking the spec/plan name: open it (+ dropdown), or — a second click on the
  // one already open — close it and return to the review
  const toggleDoc = (path: string): void => {
    if (docPath === path) closeDocBack()
    else goToDoc(path)
  }

  const rootStyle = {
    '--accent': ACCENT[0], '--accent-ink': ACCENT[1], '--accent-soft': ACCENT[2], '--accent-line': ACCENT[3]
  } as React.CSSProperties

  return (
    <div className={`wf dz-${DENSITY} stage-code`} style={rootStyle}>
      <div className="wf-titlebar">
        <span className="rv-refs">
          <RefPicker value={base} onChange={(v) => void store.setSessionBase(v)} repo={state.repo} relativeTo={branch || 'HEAD'} label="base ref" />
          <span className="rv-arrow" title="base ← compare (changes this branch adds over the base)">←</span>
          <RefPicker value={branch} onChange={(v) => { if (state.repo) void store.openReview(state.repo, { compare: v }) }} repo={state.repo} relativeTo={base || 'HEAD'} label="compare ref" prominent />
        </span>
        <span className="grow"></span>
        {sinceTagged && baseline && (
          <span className="ctimeline" style={{ marginRight: 14 }}>
            <span className="ctnode"><I.check style={{ width: 11, height: 11, color: 'var(--accent)' }} /><span className="csha">{shortSha(baseline)}</span><span className="clab">reviewed</span></span>
            <span className="ctseg drift"><span className="ctbar"></span><span className="ctcount">{driftCount > 0 ? `${driftCount} commit${driftCount > 1 ? 's' : ''}` : 'drift'}</span><span className="ctbar"></span></span>
            <span className="ctnode"><span className="cdot dot-amber"></span><span className="csha">{shortSha(skeleton.headSha)}</span><span className="clab">current</span></span>
          </span>
        )}
        <WorkspacePicker branch={branch} />
        <button className="btn btn-sm btn-ghost rv-sessions" onClick={() => void store.enterHub(state.repo)} title="All sessions for this repo">
          <I.list style={{ width: 13, height: 13 }} />Sessions
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => (chatOpen ? store.closeChat() : store.openChat())} title="Chat with the agent">
          <I.bubble style={{ width: 13, height: 13 }} />Chat
        </button>
      </div>

      {store.error && <div className="limn-error limn-toast" style={{ marginTop: 12 }}>{store.error}</div>}

      {loaded?.refMissing && (
        <div className="limn-error" style={{ margin: '12px 24px' }}>
          The {loaded.refMissing.side} ref "{loaded.refMissing.symbol}" no longer exists in this repository.
          Review is read-only — pick a new {loaded.refMissing.side} ref from the {loaded.refMissing.side === 'base' ? 'base picker' : 'branch picker'} in the header above.
        </div>
      )}

      <div className="wf-body">
        {/* LEFT spine */}
        <div className="gside">
          {artifacts.length > 0 && (
            <div className="gside-arts">
              {(['spec', 'plan'] as const).map((role) => {
                const items = artifacts.filter((a) => a.role === role)
                if (items.length === 0) return null
                return (
                  <div key={role} className="art-group">
                    <div className="art-group-head">{role === 'spec' ? 'Specs' : 'Plans'}</div>
                    {items.map((a) => (
                <div key={a.path}>
                  <div className={'art-row' + (peek === a.path ? ' open' : '')}>
                    <span className="art-open" onClick={() => toggleDoc(a.path)} title="Open the rendered document (click again to close)">
                      <span className="art-ic">{a.role === 'plan' ? <I.plan style={{ width: 12, height: 12 }} /> : <I.doc style={{ width: 12, height: 12 }} />}</span>
                      <span className="art-name">{a.role === 'plan' ? 'Plan' : 'Spec'}</span>
                      <span className="art-fmt" title={`${FORMAT_LABELS[a.format]} format`}>{FORMAT_LABELS[a.format]}</span>
                      <span className="art-meta" title={a.title}>{a.title}</span>
                    </span>
                    {state.artifactApprovals[a.path] && (
                      <span className="art-tick"><I.check style={{ width: 10, height: 10 }} />approved</span>
                    )}
                    <button
                      className="art-expand"
                      onClick={(e) => { e.stopPropagation(); setPeek(peek === a.path ? null : a.path) }}
                      title={peek === a.path ? 'Hide details' : 'Show details'}
                      aria-label="Toggle details"
                      style={state.artifactApprovals[a.path] ? undefined : { marginLeft: 'auto' }}
                    >
                      <I.chevR style={{ width: 11, height: 11, color: 'var(--muted)', transform: peek === a.path ? 'rotate(90deg)' : '', transition: '.15s' }} />
                    </button>
                  </div>
                  {peek === a.path && (
                    <div className="art-peek">
                      {a.role === 'spec' && annotations?.planMap ? (
                        annotations.planMap.acceptance.map((crit, i) => (
                          <Fragment key={i}>
                            <div className={'spec-req' + (crit.met === true ? ' met' : '')}>
                              <CmtPlus extra="peek-plus" onClick={() => setCommentCriterion(i)} />
                              <span className="req-dot"></span>
                              <span className="req-t">{crit.text}</span>
                              <span className="req-st">{crit.met === true ? 'done' : crit.met === 'partial' ? 'partial' : 'open'}</span>
                            </div>
                            {criterionComments(i).map((c) => <InlineThread key={c.id} c={c} locLabel={`on acceptance criterion ${i + 1}`} />)}
                            {commentCriterion === i && (
                              <Composer
                                placeholder={`Comment on acceptance criterion ${i + 1} — the agent gets it with your next batch…`}
                                onCancel={() => setCommentCriterion(null)}
                                onSubmit={(text) => { void addComment({ kind: 'acceptance', index: i }, text); setCommentCriterion(null) }}
                              />
                            )}
                          </Fragment>
                        ))
                      ) : a.role === 'plan' && annotations?.planMap ? (
                        annotations.planMap.steps.map((st) => (
                          <Fragment key={st.n}>
                            <div className="plan-peek-step" style={{ cursor: st.sectionId ? 'pointer' : 'default' }} onClick={() => st.sectionId && jumpTo(st.sectionId)}>
                              <CmtPlus extra="peek-plus" stop onClick={() => setCommentStep(st.n)} />
                              <span className="pps-n">{st.n}</span>
                              <span className="pps-t" title={st.text}>{st.text}</span>
                              {st.status === 'done' && <I.check style={{ width: 10, height: 10, color: 'var(--accent)' }} />}
                              {st.status === 'changed' && <I.changed style={{ width: 10, height: 10, color: 'var(--amber)' }} />}
                              {st.status === 'missing' && <I.flag style={{ width: 10, height: 10, color: 'var(--red)' }} />}
                            </div>
                            {stepComments(st.n).map((c) => <InlineThread key={c.id} c={c} locLabel={`on plan step ${st.n}`} />)}
                            {commentStep === st.n && (
                              <Composer
                                placeholder={`Comment on plan step ${st.n} — the agent gets it with your next batch…`}
                                onCancel={() => setCommentStep(null)}
                                onSubmit={(text) => { void addComment({ kind: 'plan-step', stepN: st.n }, text); setCommentStep(null) }}
                              />
                            )}
                          </Fragment>
                        ))
                      ) : (
                        <div className="art-goal">{a.lines.find((l) => l.trim() && !l.startsWith('#'))?.slice(0, 140)}</div>
                      )}
                      <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => goToDoc(a.path)}>
                        <I.doc style={{ width: 11, height: 11 }} />Open &amp; comment
                      </button>
                    </div>
                  )}
                </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )}

          <div className="gnav">
            <div className="gnav-planlabel">
              <span className="pl-l"><I.diff style={{ width: 11, height: 11 }} />Changes</span>
              <span className="pl-prog">{reviewedCount}/{sections.length} sections · {viewedCount}/{fileCount} files</span>
            </div>
            {sections.map((s, i) => {
              const done = reviewedSections.has(s.id)
              const sFiles = filesFor(s)
              const hasSince = sFiles.some((f) => f.hunks.some((h) => h.since))
              return (
                <div
                  key={s.id}
                  className={'gnav-sec' + (cur === s.id && !done ? ' cur' : '') + (hasSince ? ' amber' : '') + (done ? ' done' : '')}
                  onClick={() => jumpTo(s.id)}
                >
                  <div className="gnav-head">
                    <span className="gnav-idx">{done ? <I.check style={{ width: 11, height: 11 }} /> : i + 1}</span>
                    <span className="gnav-name" title={s.name}>{s.name}</span>
                    {hasSince && !done && <I.changed style={{ width: 12, height: 12, color: 'var(--amber)' }} />}
                  </div>
                  {cur === s.id && !done && s.desc && <div className="gnav-intent">{s.desc}</div>}
                  <div className="gnav-files">
                    {sFiles.map((f) => {
                      const fSince = f.hunks.some((h) => h.since)
                      const dot = done ? 'dot-rev' : fSince ? 'dot-amber' : 'dot-unrev'
                      const { } = f
                      const idx = f.path.lastIndexOf('/')
                      return (
                        <div key={f.path} className="gnav-file">
                          <span className={'dot ' + dot}></span>
                          <span className={'ficon ' + ficonClass(f.path)}></span>
                          <span className="nm" title={f.path}>
                            {idx >= 0 && <span className="dim">{f.path.slice(0, idx + 1)}</span>}
                            {idx >= 0 ? f.path.slice(idx + 1) : f.path}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="gside-foot">
            <div className={'split-cta ' + (verdict === 'changes' ? 'changes' : 'approve')}>
              <button
                className="sc-main"
                disabled={gen.running || (verdict === 'changes' && gate.blocked && queued.length > 0)}
                onClick={async () => {
                  if (verdict === 'changes') {
                    if (queued.length > 0) sendComments(queued.map((c) => c.id))
                  } else {
                    const id = await store.materialize()   // approving a transient mints the session
                    if (id != null) void window.api.approve(id).then(() => store.reload())
                  }
                }}
              >
                {verdict === 'changes'
                  ? (gate.blocked && queued.length > 0
                    ? <><I.warn />Check out to send {queued.length} change{queued.length === 1 ? '' : 's'}</>
                    : <><I.send />Send {queued.length || 'no'} change{queued.length === 1 ? '' : 's'} to agent</>)
                  : <><I.check />{approved ? 'Approved ✓' : 'Approve this review'}</>}
              </button>
              <button className="sc-caret" onClick={() => setVerdictOpen((o) => !o)} aria-label="Change verdict">
                <I.chevD style={{ width: 13, height: 13 }} />
              </button>
              {verdictOpen && (
                <div className="sc-menu">
                  <button onClick={() => { setVerdict('changes'); setVerdictOpen(false) }}>
                    <I.changed style={{ width: 13, height: 13 }} /><span><b>Request changes</b><small>Send your queued comments back to the agent</small></span>
                  </button>
                  <button onClick={() => { setVerdict('approve'); setVerdictOpen(false) }}>
                    <I.check style={{ width: 13, height: 13 }} /><span><b>Approve</b><small>Record this state as reviewed &amp; approved</small></span>
                  </button>
                </div>
              )}
            </div>
            <div className="gside-note">
              {verdict === 'changes'
                ? gate.blocked
                  ? <>Detached — check out <b>{branch}</b> (Workspace ▸) to send comments to the agent.</>
                  : queued.length > 0 ? 'Inline comments batch up — sent in one prompt.' : 'Comment on lines, sections, or the spec first.'
                : loaded.dirty
                  ? `Records the committed state. ${loaded.volatile.length} uncommitted change${loaded.volatile.length === 1 ? '' : 's'} won't be covered.`
                  : 'Records the current commit as approved.'}
            </div>
          </div>
        </div>

        {/* MAIN */}
        <div className="gmain" ref={scrollRef}>
          {docPath ? (
            <ArtifactDoc path={docPath} onClose={closeDocBack} />
          ) : (
            <>
              <div className="page-head">
                <div className="eyebrow">{skeleton.files.length} files · +{totalAdd} / −{totalDel}{GUIDANCE !== 'minimal' && annotations ? ` · Guided by: ${agentLabel(guidedBy).replace(' · ', ' ')}` : ''}</div>
                <h1 className="page-h1-cmt">
                  {annotations && <CmtPlus extra="h1-plus" onClick={() => setTitleCommenting(true)} />}
                  {annotations?.title ?? `Changes on ${branch}`}
                </h1>
                {(titleComments.length > 0 || titleCommenting) && (
                  <div className="title-threads">
                    {titleComments.map((c) => <InlineThread key={c.id} c={c} locLabel="on the review title" />)}
                    {titleCommenting && (
                      <Composer
                        placeholder="Comment on the review title — the agent gets it with your next batch…"
                        onCancel={() => setTitleCommenting(false)}
                        onSubmit={(text) => { void addComment({ kind: 'title' }, text); setTitleCommenting(false) }}
                      />
                    )}
                  </div>
                )}
              </div>

              <GenPanel />

              {annotations && (
                <>
                  {sinceTagged && lastIteration?.summary ? (
                    <div className="rr-summary rr-summary-cmt" data-limn-summary>
                      <CmtPlus extra="summary-plus" onClick={() => setSummaryCommenting(true)} />
                      <span className="rr-ic"><EngineGlyph engine={lastIteration?.engine} style={{ width: 14, height: 14 }} /></span>
                      <Commentable scope={{ region: 'summary' }} className="rr-tx">
                        <span className="rr-lead">Since you approved{baseline ? <> at <span className="mono">{shortSha(baseline)}</span></> : ''}: </span>
                        {lastIteration.summary}
                      </Commentable>
                      <span className="grow"></span>
                      <span className="seg seg-sm">
                        <button className={topFilter === 'changed' ? 'on' : ''} onClick={() => setTopFilter('changed')}>Just the changes</button>
                        <button className={topFilter === 'all' ? 'on' : ''} onClick={() => setTopFilter('all')}>Everything</button>
                      </span>
                    </div>
                  ) : (
                    <div className="rr-summary rr-summary-cmt" data-limn-summary style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}>
                      <CmtPlus extra="summary-plus" onClick={() => setSummaryCommenting(true)} />
                      <span className="rr-ic" style={{ background: 'var(--accent)' }}><EngineGlyph engine={guidedBy.engine} style={{ width: 14, height: 14 }} /></span>
                      <Commentable scope={{ region: 'summary' }} className="rr-tx">{annotations.summary}</Commentable>
                      <span className="grow"></span>
                    </div>
                  )}
                  {(summaryComments.length > 0 || summaryCommenting) && (
                    <div className="rr-summary-threads">
                      {summaryComments.map((c) => <InlineThread key={c.id} c={c} locLabel="on the summary" />)}
                      {summaryCommenting && (
                        <Composer
                          placeholder="Comment on the overall review summary — the agent gets it with your next batch…"
                          onCancel={() => setSummaryCommenting(false)}
                          onSubmit={(text) => { void addComment({ kind: 'summary' }, text); setSummaryCommenting(false) }}
                        />
                      )}
                    </div>
                  )}
                  <div className="rr-summary-threads"><SelectionThreads scope={{ region: 'summary' }} /></div>
                </>
              )}

              <Questions />

              {sections.map((s, i) => (
                <SectionView
                  key={s.id}
                  s={s}
                  n={i + 1}
                  total={sections.length}
                  files={filesFor(s)}
                  forceOpen={topFilter === 'all'}
                  secRef={(el) => { secRefs.current[s.id] = el }}
                />
              ))}
              {skeleton.files.length === 0 && !loaded.dirty && (
                <div className="limn-empty">No changes between <b>{branch}</b> and <b>{base}</b>.</div>
              )}

              {loaded.dirty && loaded.volatile.length > 0 && (
                <div className="vol-band">
                  <div className="vol-head">
                    <span className="vol-tag"><I.warn style={{ width: 12, height: 12 }} />Uncommitted</span>
                    <span className="vol-lead">Working tree — {loaded.volatile.length} file{loaded.volatile.length === 1 ? '' : 's'} changed since <span className="mono">{shortSha(skeleton.headSha)}</span></span>
                    <span className="vol-note">volatile · not pinned to a commit · auto-pins when committed</span>
                  </div>
                  {loaded.volatile.map((f) => <DiffView key={'vol:' + f.path} f={f} />)}
                </div>
              )}
              <div style={{ height: 40 }}></div>
            </>
          )}
        </div>

        <ChatDrawer open={chatOpen} onClose={() => store.closeChat()} />
      </div>
    </div>
  )
}
