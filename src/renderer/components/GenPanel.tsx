import { useEffect, useRef, useState } from 'react'
import { checkoutGate, genCancelled, genForLoaded, newOpId, useStore } from '../store'
import { I, EngineGlyph, shortSha, ago } from '../kit'
import { reduceToolCalls } from '../../shared/toolcalls'
import { AgentPicker } from './AgentPicker'
import { ToolCallLog } from './ToolCallLog'
import { useTooltip } from '../lib/useTooltip'
import { usePopover } from '../lib/usePopover'
import type { AgentRef, CommitInfo } from '../../shared/types'

/** mm:ss for the live elapsed counter. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export async function startGenerate(sessionId: number, agent: AgentRef, opId: string, steer?: string, update?: boolean): Promise<void> {
  const store = useStore.getState()
  // create the review thread (with its opening user turn) and select it BEFORE the
  // agent runs, so generation streams into a real, persisted chat from the first
  // moment — the live stream renders through the normal chat path.
  const threadId = await window.api.beginReview(sessionId, agent)
  await store.reload()              // pull the new review thread into loaded state
  store.switchChat(threadId)        // select it (drawer shows the live stream if open)
  store.startOp('review', opId, threadId)
  void window.api.generate(sessionId, agent, opId, threadId, steer, update)
}

/** Materialize the (possibly transient) review, then run the agent with the chosen
 *  review agent. The first generate from a transient entry mints the session.
 *  `steer` is an optional one-shot note that focuses the pass; `update` folds new
 *  drift commits into the existing review instead of re-narrating from scratch. */
export async function startGenerateNow(steer?: string, update?: boolean): Promise<void> {
  if (useStore.getState().gen.running) return // an op is already in flight
  const sessionId = await useStore.getState().materialize()
  if (sessionId == null) return
  const { loaded, agent } = useStore.getState()
  await startGenerate(sessionId, loaded?.state.agent ?? agent, newOpId(), steer?.trim() || undefined, update)
}

/** CTA before annotations exist + live progress strip during any agent op. */
/** Blocked / dirty banner shown in the generate CTA when the compare branch isn't
 *  safely checked out. Checkout itself lives in the Workspace menu (header). */
function GateNote({ branch, dirty }: { branch: string | null; dirty?: boolean }) {
  if (dirty) {
    return (
      <span className="gc-gate warn">
        <I.warn style={{ width: 12, height: 12, color: 'var(--amber)' }} />
        Uncommitted changes in the worktree — agent edits will mix with them.
      </span>
    )
  }
  return (
    <span className="gc-gate block">
      <I.warn style={{ width: 12, height: 12, color: 'var(--amber)' }} />
      <b>{branch}</b> isn't checked out — use the Workspace menu to check it out before the agent runs.
    </span>
  )
}

/** Optional one-shot steer for a generation pass. Enter submits when not gated. */
function SteerInput({ value, onChange, onSubmit, disabled }: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; disabled?: boolean
}) {
  return (
    <input
      className="gc-steer"
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter' && !disabled) { e.preventDefault(); onSubmit() } }}
      placeholder="Steer this pass (optional) — e.g. focus on error handling, skip test churn"
      aria-label="Steer this generation pass"
    />
  )
}

/** Drift "View commits": a popover anchored to the button listing the commits that
 *  landed after the generated SHA. `commits` is the newest-first drift slice of
 *  loaded.commits (so row 0 is the branch tip). Own usePopover so the hook stays
 *  above GenPanel's conditional returns. */
function DriftCommits({ commits }: { commits: CommitInfo[] }) {
  const { open, toggle, anchorRef, floatingRef, popStyle } = usePopover<HTMLButtonElement, HTMLDivElement>({ side: 'bottom', align: 'start', gap: 4 })
  return (
    <>
      <button className="gen-viewn" ref={anchorRef} aria-expanded={open} onClick={toggle}>View commits</button>
      {open && (
        <div className="drift-pop" ref={floatingRef} style={popStyle}>
          <div className="drift-pop-hd">{commits.length} commit{commits.length === 1 ? '' : 's'} since the review</div>
          <div className="drift-pop-list">
            {commits.length === 0 ? (
              <div className="dim" style={{ padding: 8, fontSize: 11.5 }}>Commit details unavailable.</div>
            ) : commits.map((c) => (
              // row-level title (like RefPicker's commit rows) — full message on hover
              <div key={c.sha} className="limn-refpick-item" title={`${c.subject}\n${shortSha(c.sha)} · ${ago(c.date)}`}>
                <span className="ri-name ri-sha">{shortSha(c.sha)}</span>
                <span className="ri-sub">{c.subject}</span>
                <span className="ri-age">{ago(c.date)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

export function GenPanel() {
  const { loaded, gen: rawGen, agent } = useStore()
  // gen is global to the renderer; only honor it here when the op belongs to the
  // review being viewed, so a generation started on another session doesn't paint
  // its progress/cancel state onto this one.
  const gen = genForLoaded(rawGen, loaded)
  const reviewAgent = loaded?.state.agent ?? agent
  const gate = checkoutGate(loaded)
  const logRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [now, setNow] = useState(() => Date.now())
  const [steer, setSteer] = useState('')
  // action-row hints: rendered bubbles that flip/clamp on-screen (shared tooltip
  // core), replacing the old pure-CSS [data-hint] ::after that couldn't flip.
  const hintL = useTooltip<HTMLButtonElement, HTMLSpanElement>({ side: 'top', align: 'start', gap: 9 })
  const hintR = useTooltip<HTMLDivElement, HTMLSpanElement>({ side: 'top', align: 'end', gap: 9 })

  // follow the latest tool call only while the user is parked at the bottom.
  // once they scroll up to read, new calls stop yanking them down; following
  // resumes when they scroll back to the bottom. (gen.log is a fresh array each
  // event, so this fires on every event — its length plateaus at the 200 cap)
  useEffect(() => {
    const el = logRef.current
    if (el && stickRef.current) el.scrollTo({ top: el.scrollHeight })
  }, [gen.log])

  // a scroll landing within ~24px of the bottom re-arms following
  const onLogScroll = () => {
    const el = logRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
  }

  // tick the elapsed counter once a second while an op is running
  useEffect(() => {
    if (!gen.running) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [gen.running])

  if (gen.running) {
    const engineName = reviewAgent.engine === 'codex' ? 'Codex' : 'Claude'
    const verb = gen.kind === 'review' ? 'is exploring the branch' : 'is thinking'
    const label = `${engineName} ${verb}…`
    const calls = reduceToolCalls(gen.log)
    return (
      <div className="gen-strip">
        <div className="gs-head">
          <span className="gen-spinner"></span>
          <span className="gs-title">{label}</span>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => useStore.getState().cancelOp()}
          >
            Cancel
          </button>
        </div>
        <div className="counts">
          <span><b>{calls.length}</b> tool call{calls.length === 1 ? '' : 's'}</span>
          <span><b>{fmtElapsed(gen.startedAt ? now - gen.startedAt : 0)}</b> elapsed</span>
        </div>
        <div className="gs-log" ref={logRef} onScroll={onLogScroll}>
          <ToolCallLog calls={calls} />
        </div>
      </div>
    )
  }

  // a user-initiated cancel must reopen the generate block, never the failure
  // banner — classified by the explicit flag set on cancel (genCancelled).
  const wasCancelled = genCancelled(gen)

  if (gen.error && !wasCancelled) {
    return (
      <div className="gen-strip err">
        <div className="gs-head">
          <I.flag style={{ width: 13, height: 13, color: 'var(--red)' }} />
          <span className="gs-title">Agent run failed: {gen.error}</span>
          <button className="btn btn-sm" onClick={() => startGenerateNow(steer)}>Retry</button>
        </div>
      </div>
    )
  }

  // a cancelled run reopens the generation section so you can pick a different
  // agent/model or steer the next pass, then retry. (If a review already exists,
  // fall through to its regenerate controls instead.)
  if (wasCancelled && !loaded?.state.annotations) {
    return (
      <div className="gen-cta gen-cancelled">
        <span className="gc-tx">
          <I.flag style={{ width: 13, height: 13, color: 'var(--muted)' }} />
          <b>Generation cancelled.</b> Pick an agent and run again, or steer the next pass.
        </span>
        <SteerInput value={steer} onChange={setSteer} onSubmit={() => startGenerateNow(steer)} disabled={gate.blocked} />
        <AgentPicker value={reviewAgent} onChange={(a) => useStore.getState().setAgent(a)} align="left" />
        <button className="btn btn-primary" disabled={gate.blocked} onClick={() => startGenerateNow(steer)}>
          <EngineGlyph engine={reviewAgent.engine} style={{ width: 13, height: 13 }} />Retry generation
        </button>
        {gate.blocked && <GateNote branch={gate.branch} />}
        {gate.dirtyWarn && <GateNote branch={gate.branch} dirty />}
      </div>
    )
  }

  if (!loaded?.state.annotations) {
    return (
      <div className="gen-cta">
        <span className="gc-tx">
          <b>Generate a guided review.</b> The agent explores the repo — callers, tests, history, specs —
          then groups this diff into narrated sections with risk flags.
        </span>
        <SteerInput value={steer} onChange={setSteer} onSubmit={() => startGenerateNow(steer)} disabled={gate.blocked} />
        <AgentPicker value={reviewAgent} onChange={(a) => useStore.getState().setAgent(a)} align="left" />
        <button className="btn btn-primary" disabled={gate.blocked || gen.running} onClick={() => startGenerateNow(steer)}>
          <EngineGlyph engine={reviewAgent.engine} style={{ width: 13, height: 13 }} />Generate guided review
        </button>
        {gate.blocked && <GateNote branch={gate.branch} />}
        {gate.dirtyWarn && <GateNote branch={gate.branch} dirty />}
      </div>
    )
  }

  // review exists — freshness stamp + follow-up/regenerate controls. Follow-up
  // keeps the existing review chat; regenerate starts a fresh narration pass.
  const generatedSha = loaded?.state.reviewedAtSha ?? loaded?.state.iterations.at(-1)?.endSha
  // drift = commits between the generated SHA and HEAD. When that SHA is no longer
  // in history (rebase/squash/force-push) findIndex returns -1 — treat it as
  // drifted (basis gone), NOT "up to date", mirroring Review.tsx's timeline fallback.
  const genIdx = generatedSha && generatedSha !== loaded?.skeleton.headSha
    ? loaded?.commits.findIndex((c) => c.sha === generatedSha) ?? -1
    : 0
  const driftCount = genIdx < 0 ? (loaded?.commits.length ?? 0) : genIdx
  const behind = driftCount > 0
  const submitFollowUp = (): void => {
    const t = steer.trim()
    if (t) {
      useStore.getState().followUp(t)
      setSteer('')
    } else {
      useStore.getState().openChat()
    }
  }
  const submitExistingReviewPrimary = (): void => {
    if (behind) void startGenerateNow(steer, true)
    else submitFollowUp()
  }
  // drift commits = the entries ahead of the generated SHA (loaded.commits is
  // newest-first, so the first driftCount rows are exactly the new commits).
  const driftCommits = (loaded?.commits ?? []).slice(0, driftCount)
  return (
    <div className={'gen-cta gen-regen' + (behind ? ' gen-drift' : '')}>
      <span className={'gen-fresh' + (behind ? ' drift' : '')}>
        {behind ? <I.flag style={{ width: 13, height: 13 }} /> : <I.check style={{ width: 13, height: 13 }} />}
        {generatedSha ? <>generated at <span className="mono">{generatedSha.slice(0, 7)}</span> · </> : null}
        {behind ? (
          <>
            <span className="beh">{driftCount} commit{driftCount === 1 ? '' : 's'} behind</span>
            <DriftCommits commits={driftCommits} />
          </>
        ) : <span className="ud">up to date</span>}
      </span>
      <SteerInput value={steer} onChange={setSteer} onSubmit={submitExistingReviewPrimary} disabled={gate.blocked} />
      <div className="gen-acts">
        {behind ? (
          <button
            className="btn btn-sm btn-primary"
            disabled={gate.blocked || gen.running}
            ref={hintL.anchorRef}
            {...hintL.hoverProps}
            onClick={() => void startGenerateNow(steer, true)}
          >
            <I.changed style={{ width: 12, height: 12 }} />Update review
            {hintL.show && <span className="gen-hint" ref={hintL.floatingRef} style={hintL.style} data-side={hintL.side}>Same session. Folds the new commits into the existing review narration; your comments and viewed marks survive.</span>}
          </button>
        ) : (
          <button
            className="btn btn-sm btn-primary"
            ref={hintL.anchorRef}
            {...hintL.hoverProps}
            onClick={submitFollowUp}
          >
            <I.arrow style={{ width: 12, height: 12 }} />Follow up
            {hintL.show && <span className="gen-hint" ref={hintL.floatingRef} style={hintL.style} data-side={hintL.side}>Same session. Sends your note to the review agent (or opens the chat if empty) for comments, decisions and focused follow-ups.</span>}
          </button>
        )}
        <span className="grow"></span>
        <div className="regen-split" ref={hintR.anchorRef} {...hintR.hoverProps}>
          <button className="rs-go" disabled={gate.blocked || gen.running} onClick={() => startGenerateNow(steer)}>
            <I.changed />Regenerate
          </button>
          <span className="rs-sep"></span>
          <AgentPicker value={reviewAgent} onChange={(a) => useStore.getState().setAgent(a)} align="right" disabled={gate.blocked} />
          {hintR.show && <span className="gen-hint gen-hint--r" ref={hintR.floatingRef} style={hintR.style} data-side={hintR.side}>Fresh agent, new session. Your comments and viewed marks survive; the narration is replaced.</span>}
        </div>
      </div>
      {gate.blocked && <GateNote branch={gate.branch} />}
    </div>
  )
}
