import { useEffect, useMemo, useRef, useState } from 'react'
import { effectiveSections, useStore } from '../store'
import { I, ficonClass, shortSha } from '../kit'
import type { FileDiff, Section } from '../../shared/types'
import { SectionView } from '../components/SectionView'
import { GenPanel, startGenerateNow } from '../components/GenPanel'
import { Questions } from '../components/Questions'
import { Tweaks } from '../components/Tweaks'
import { ArtifactDoc } from '../components/ArtifactDoc'
import { ChatDrawer } from '../components/ChatDrawer'
import { queuedComments, sendComments } from '../lib/comments'

let devFlowRan = false

export default function Review() {
  const store = useStore()
  const { loaded, branch, base, reviewedSections, cur, gen, density, accent, guidance } = store
  const scrollRef = useRef<HTMLDivElement>(null)
  const secRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [verdict, setVerdict] = useState<'changes' | 'approve'>('changes')
  const [verdictOpen, setVerdictOpen] = useState(false)
  const [topFilter, setTopFilter] = useState<'changed' | 'all'>('changed')
  const [docOpen, setDocOpen] = useState<string | null>(null)
  const [peek, setPeek] = useState<string | null>(null)
  const [chatOpen, setChatOpen] = useState(false)

  const sections = useMemo(() => effectiveSections(loaded), [loaded])
  const fileMap = useMemo(() => new Map((loaded?.skeleton.files ?? []).map((f) => [f.path, f])), [loaded])
  const filesFor = (s: Section): FileDiff[] => s.files.map((p) => fileMap.get(p)).filter((f): f is FileDiff => Boolean(f))

  // dev-only scripted flow: LR_FLOW=generate auto-runs the engine once
  useEffect(() => {
    if (window.lrDev?.flow === 'generate' && !devFlowRan && loaded && !loaded.state.annotations && !gen.running && !gen.error) {
      devFlowRan = true
      startGenerateNow()
    }
    if (window.lrDev?.flow === 'fix' && !devFlowRan && loaded && !gen.running && !gen.error) {
      const ids = loaded.state.comments.filter((c) => c.status === 'queued').map((c) => c.id)
      if (ids.length > 0) {
        devFlowRan = true
        sendComments(ids)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  // scroll-sync current section
  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const onScroll = (): void => {
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
  const totalAdd = skeleton.files.reduce((n, f) => n + f.add, 0)
  const totalDel = skeleton.files.reduce((n, f) => n + f.del, 0)
  const reviewedCount = sections.filter((s) => reviewedSections.has(s.id)).length
  const queued = queuedComments()
  const baseline = state.approvedSha ?? state.reviewedAtSha
  const driftCount = baseline ? commits.findIndex((c) => c.sha === baseline) : -1
  const iteration = state.iterations.length
  const lastIteration = state.iterations[state.iterations.length - 1]
  const approved = state.approvedSha === skeleton.headSha

  const jumpTo = (id: string): void => {
    store.openSection(id)
    requestAnimationFrame(() => {
      const el = secRefs.current[id]
      const box = scrollRef.current
      if (!el || !box) return
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12
      box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    })
  }

  const rootStyle = {
    '--accent': accent[0], '--accent-ink': accent[1], '--accent-soft': accent[2], '--accent-line': accent[3]
  } as React.CSSProperties

  return (
    <div className={`wf dz-${density} stage-code`} style={rootStyle}>
      <div className="wf-titlebar">
        <span className="wf-title"><b>Code Review</b></span>
        <span className="grow"></span>
        {sinceTagged && baseline && (
          <span className="ctimeline" style={{ marginRight: 14 }}>
            <span className="ctnode"><I.check style={{ width: 11, height: 11, color: 'var(--accent)' }} /><span className="csha">{shortSha(baseline)}</span><span className="clab">reviewed</span></span>
            <span className="ctseg drift"><span className="ctbar"></span><span className="ctcount">{driftCount > 0 ? `${driftCount} commit${driftCount > 1 ? 's' : ''}` : 'drift'}</span><span className="ctbar"></span></span>
            <span className="ctnode"><span className="cdot dot-amber"></span><span className="csha">{shortSha(skeleton.headSha)}</span><span className="clab">current</span></span>
          </span>
        )}
        <button className="btn btn-sm btn-ghost" onClick={() => setChatOpen((o) => !o)} title="Chat with the agent">
          <I.bubble style={{ width: 13, height: 13 }} />Chat
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => store.backToCompare()}>
          <I.branch style={{ width: 12, height: 12 }} />Switch
        </button>
        <span className="branch">
          <I.branch style={{ width: 12, height: 12, color: 'var(--accent)' }} />
          <span className="b-src">{branch}</span><span className="arrow">→</span><span className="b-base">{base}</span>
        </span>
      </div>

      {loaded?.refMissing && (
        <div className="lr-error" style={{ margin: '12px 24px' }}>
          The {loaded.refMissing.side} ref "{loaded.refMissing.symbol}" no longer exists in this repository.
          Review is read-only. <button className="btn btn-sm" onClick={() => store.retarget(loaded.refMissing!.side)}>Pick a new ref</button>
        </div>
      )}

      <div className="stage-strip">
        {artifacts.length > 0 && (() => {
          const allApproved = artifacts.every((a) => state.artifactApprovals[a.path])
          return (
            <>
              <div className={'ss-node ' + (allApproved ? 'done' : 'active')}>
                <span className="ss-dot"></span>
                <span className="ss-tx">
                  <b>{allApproved ? 'Plan' : 'Review the plan'}</b>
                  <span>{allApproved ? 'approved' : `${artifacts.filter((a) => state.artifactApprovals[a.path]).length}/${artifacts.length} approved`}</span>
                </span>
              </div>
              <span className={'ss-conn' + (allApproved ? '' : ' dashed')}></span>
            </>
          )
        })()}
        <div className="ss-node done">
          <span className="ss-dot"></span>
          <span className="ss-tx"><b>Built</b><span className="mono">{shortSha(skeleton.headSha)}</span></span>
        </div>
        {sinceTagged && driftCount > 0 ? (
          <span className="ss-conn drift"><span className="ss-conn-lab"><I.changed style={{ width: 10, height: 10 }} />{driftCount} commit{driftCount > 1 ? 's' : ''} since you reviewed</span></span>
        ) : (
          <span className="ss-conn"></span>
        )}
        <div className={'ss-node ' + (approved ? 'done' : 'active')}>
          <span className="ss-dot"></span>
          <span className="ss-tx">
            <b>{approved ? 'Approved' : 'Review the code'}</b>
            <span>{iteration > 0 ? `iteration ${iteration} · ` : ''}{reviewedCount}/{sections.length} sections</span>
          </span>
        </div>
      </div>

      <div className="wf-body">
        {/* LEFT spine */}
        <div className="gside">
          {artifacts.length > 0 && (
            <div className="gside-arts">
              {artifacts.map((a) => (
                <div key={a.path}>
                  <div className={'art-row' + (peek === a.path ? ' open' : '')} onClick={() => setPeek(peek === a.path ? null : a.path)}>
                    <span className="art-ic">{a.role === 'plan' ? <I.spark style={{ width: 12, height: 12 }} /> : <I.doc style={{ width: 12, height: 12 }} />}</span>
                    <span className="art-name">{a.role === 'plan' ? 'Plan' : 'Spec'}</span>
                    <span className="art-meta">{a.title}</span>
                    {state.artifactApprovals[a.path] && (
                      <span className="art-tick"><I.check style={{ width: 10, height: 10 }} />approved</span>
                    )}
                    <I.chevR style={{ width: 11, height: 11, color: 'var(--muted)', transform: peek === a.path ? 'rotate(90deg)' : '', transition: '.15s', flex: '0 0 auto', marginLeft: state.artifactApprovals[a.path] ? undefined : 'auto' }} />
                  </div>
                  {peek === a.path && (
                    <div className="art-peek">
                      {a.role === 'spec' && annotations?.planMap ? (
                        annotations.planMap.acceptance.map((c, i) => (
                          <div key={i} className={'spec-req' + (c.met === true ? ' met' : '')}>
                            <span className="req-dot"></span>
                            <span className="req-t">{c.text}</span>
                            <span className="req-st">{c.met === true ? 'done' : c.met === 'partial' ? 'partial' : 'open'}</span>
                          </div>
                        ))
                      ) : a.role === 'plan' && annotations?.planMap ? (
                        annotations.planMap.steps.map((st) => (
                          <div key={st.n} className="plan-peek-step" style={{ cursor: st.sectionId ? 'pointer' : 'default' }} onClick={() => st.sectionId && jumpTo(st.sectionId)}>
                            <span className="pps-n">{st.n}</span>
                            <span className="pps-t">{st.text}</span>
                            {st.status === 'done' && <I.check style={{ width: 10, height: 10, color: 'var(--accent)' }} />}
                            {st.status === 'changed' && <I.changed style={{ width: 10, height: 10, color: 'var(--amber)' }} />}
                            {st.status === 'missing' && <I.flag style={{ width: 10, height: 10, color: 'var(--red)' }} />}
                          </div>
                        ))
                      ) : (
                        <div className="art-goal">{a.lines.find((l) => l.trim() && !l.startsWith('#'))?.slice(0, 140)}</div>
                      )}
                      <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setDocOpen(a.path)}>
                        <I.doc style={{ width: 11, height: 11 }} />Open &amp; comment
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="gnav">
            <div className="gnav-planlabel">
              <span className="pl-l"><I.diff style={{ width: 11, height: 11 }} />Changes</span>
              <span className="pl-prog">{reviewedCount}/{sections.length} reviewed</span>
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
                    <span className="gnav-name">{s.name}</span>
                    {hasSince && !done && <I.changed style={{ width: 12, height: 12, color: 'var(--amber)' }} />}
                    {s.flags.some((f) => f.risk) && !done && <I.flag style={{ width: 12, height: 12, color: 'var(--red)' }} />}
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
                          <span className="nm">
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
                disabled={gen.running || store.sessionId == null}
                onClick={() => {
                  if (verdict === 'changes') {
                    if (queued.length > 0) sendComments(queued.map((c) => c.id))
                  } else if (store.sessionId != null) {
                    void window.api.approve(store.sessionId).then(() => store.reload())
                  }
                }}
              >
                {verdict === 'changes'
                  ? <><I.send />Send {queued.length || 'no'} change{queued.length === 1 ? '' : 's'} to agent</>
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
                ? queued.length > 0 ? 'Inline comments batch up — sent in one prompt.' : 'Comment on lines, sections, or the spec first.'
                : 'Records the current commit as approved.'}
            </div>
          </div>
        </div>

        {/* MAIN */}
        <div className="gmain" ref={scrollRef}>
          {docOpen ? (
            <ArtifactDoc path={docOpen} onClose={() => setDocOpen(null)} />
          ) : (
            <>
              <div className="page-head">
                <div className="eyebrow">{skeleton.files.length} files · +{totalAdd} / −{totalDel}{guidance !== 'minimal' && annotations ? ` · ${state.engine === 'codex' ? 'Codex' : 'Claude'} guided` : ''}</div>
                <h1>{annotations?.title ?? `Changes on ${branch}`}</h1>
              </div>

              <GenPanel />

              {annotations && (sinceTagged && lastIteration?.summary ? (
                <div className="rr-summary">
                  <span className="rr-ic"><I.spark style={{ width: 14, height: 14 }} /></span>
                  <span className="rr-tx">
                    <span className="rr-lead">Since you approved{baseline ? <> at <span className="mono">{shortSha(baseline)}</span></> : ''}: </span>
                    {lastIteration.summary}
                  </span>
                  <span className="grow"></span>
                  <span className="seg seg-sm">
                    <button className={topFilter === 'changed' ? 'on' : ''} onClick={() => setTopFilter('changed')}>Just the changes</button>
                    <button className={topFilter === 'all' ? 'on' : ''} onClick={() => setTopFilter('all')}>Everything</button>
                  </span>
                </div>
              ) : (
                <div className="rr-summary" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}>
                  <span className="rr-ic" style={{ background: 'var(--accent)' }}><I.spark style={{ width: 14, height: 14 }} /></span>
                  <span className="rr-tx">{annotations.summary}</span>
                </div>
              ))}

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
              {skeleton.files.length === 0 && (
                <div className="lr-empty">No changes between <b>{branch}</b> and <b>{base}</b>.</div>
              )}
              <div style={{ height: 40 }}></div>
            </>
          )}
        </div>

        <ChatDrawer open={chatOpen} onClose={() => setChatOpen(false)} />
      </div>

      <Tweaks />
    </div>
  )
}
