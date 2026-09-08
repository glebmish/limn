import { memo, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { DENSITY, effectiveSections, fileIsExcluded, fileViewed, reviewOp, GUIDANCE, pendingApprovals, useStore } from '../store'
import { doneSectionIds as computeDoneSectionIds, renderedFiles } from '../store/derive'
import { I, shortSha, strategyLabel, CmtPlus } from '../kit'
import type { FileDiff, Section } from '../../shared/types'
import { approvalFresh } from '../../shared/types'
import { useStackKeys } from '../lib/useStackKeys'
import { ReviewTimeline } from '../components/ReviewTimeline'
import { ReviewSidebar } from '../components/ReviewSidebar'
import { ReviewSummary } from '../components/ReviewSummary'
import { SectionView } from '../components/SectionView'
import { DiffView } from '../components/DiffView'
import { UntrackedGroup } from '../components/UntrackedGroup'
import { GenPanel } from '../components/GenPanel'
import { Questions } from '../components/Questions'
import { ArtifactDoc } from '../components/ArtifactDoc'
import { ChatDrawer } from '../components/ChatDrawer'
import { MergeButton } from '../components/MergeSheet'
import { WorkspacePicker } from '../components/WorkspacePicker'
import { RefPicker } from '../components/RefPicker'
import { SplitHandle } from '../components/SplitHandle'
import { api } from '../lib/api'
import { agentLabel } from '../../shared/agents'
import { orderFilesForReview } from '../lib/fileOrder'
import { reviewTimelineGroups, timelineShaInRange } from '../lib/reviewTimeline'
import { useDevReviewHooks } from '../lib/useDevReviewHooks'
import { useReviewScroll } from '../lib/useReviewScroll'
import { dev } from '../dev'
import {
  PANELS, PANEL_DIRECTIONS, PANEL_LABELS, PREF_KEYS,
  clampPanelRange, clampPanelWidth, effectiveWidths, panelVarName, panelVars, shouldPersist,
  type PanelKind
} from '../lib/panelWidths'
import { useViewportWidth } from '../lib/useViewportWidth'

/** Wraps a SplitHandle with the clamp/persist plumbing shared by the sidebar and
 *  chat-drawer dividers.
 *
 *  Two widths, deliberately different. The STORE holds the reviewer's *preferred*
 *  width (range-clamped only, and the only thing ever persisted); the panel is
 *  painted and announced at its *effective* width — the preference put through the
 *  viewport guard, recomputed by `Review` on every resize and handed down as
 *  `effective`. So a window too narrow for the preference squeezes the panel and
 *  gives the width back when the window widens, and a drag that starts on such a
 *  window commits a real range-clamped preference, never a squeezed one.
 *
 *  `Review` subscribes to the whole store (`useStore()`), so a store write on
 *  every pointer move would re-render the entire review tree per pixel dragged.
 *  Instead, a POINTER drag never touches the store: `onChange` rounds + clamps the
 *  candidate and writes the CSS var straight onto `bodyRef` (the `.wf-body`
 *  element), bypassing React for the whole gesture, and returns the applied width
 *  for the handle to announce. The store is only written at gesture end —
 *  `onCommit` (pointerup) and `onReset` (double-click) — via `setPanelWidth`,
 *  which always persists. A keyboard nudge calls `onChange` then `onCommit`
 *  back-to-back with no drag in between, so it still commits (and persists)
 *  immediately, one key press = one store write.
 *
 *  No cross-render drag state lives here: `onCommit` is handed the gesture's final
 *  width by the handle itself, so a mid-drag re-render of this component (an agent
 *  opening the chat drawer flips the sidebar handle's `other` prop) can't discard
 *  the gesture. The memo is a render-cost optimisation, not a correctness crutch. */
const ShellHandle = memo(function ShellHandle(
  { kind, other, effective, viewport, bodyRef }:
  { kind: PanelKind; other: number; effective: number; viewport: number; bodyRef: RefObject<HTMLDivElement | null> }
) {
  const spec = PANELS[kind]
  const varName = panelVarName(kind)
  // No subscription to the committed width: `effective` already arrives as a prop
  // (Review recomputes it whenever the preference or the viewport changes), and
  // onCommit reads the store imperatively so a mid-drag render can't stale it.
  const setPanelWidth = useStore((s) => s.setPanelWidth)

  /** Paint a width straight onto `.wf-body`, bypassing React for the drag. */
  const paint = (w: number): number => {
    bodyRef.current?.style.setProperty(varName, `${w}px`)
    return w
  }

  return (
    <SplitHandle
      label={PANEL_LABELS[kind]}
      value={effective}
      min={spec.min}
      max={spec.max}
      direction={PANEL_DIRECTIONS[kind]}
      onChange={(w) => paint(clampPanelWidth(kind, Math.round(w), viewport, other))}
      onCommit={(w) => {
        const preferred = clampPanelRange(kind, Math.round(w))
        // Keep the DOM in step with what React would render for this preference,
        // whether or not the store write below happens.
        paint(clampPanelWidth(kind, preferred, viewport, other))
        if (!shouldPersist(preferred, useStore.getState()[PREF_KEYS[kind]])) return
        setPanelWidth(kind, preferred)
      }}
      onReset={() => {
        paint(clampPanelWidth(kind, spec.default, viewport, other))
        setPanelWidth(kind, spec.default)
      }}
    />
  )
})

export default function Review() {
  const store = useStore()
  const { loaded, branch, base, viewedAt, cur, curFile, docPath, openDoc, closeDoc, sidebarWidth, chatWidth } = store
  // the review-generation op for THIS review (scoped to its threads); drives the gen
  // strip/CTA and the approve-disabled state. A concurrent read-only chat is a
  // separate op and does not gate the review surface.
  const gen = reviewOp(store.ops, loaded)
  const [titleCommenting, setTitleCommenting] = useState(false)
  const chatOpen = store.chatOpen
  // the ShellHandles write --gside-w / --chat-w straight onto this element during
  // a pointer drag, bypassing the store (see ShellHandle above) until commit
  const wfBodyRef = useRef<HTMLDivElement>(null)
  // The stored widths are *preferences*; what gets painted is derived per viewport,
  // so shrinking the window squeezes the panels (keeping the main pane at MAIN_MIN
  // and the drawer on screen) and widening it hands the preference back.
  const viewport = useViewportWidth()
  const panelW = effectiveWidths({ sidebar: sidebarWidth, chat: chatWidth, chatOpen, viewport })

  const sections = useMemo(() => loaded?.state.annotations ? effectiveSections(loaded) : [], [loaded])
  // When the tree is dirty, the merged base→working-tree diff (committed + uncommitted
  // lines interleaved per file, origin-tagged) drives every file surface; otherwise the
  // plain committed spine does. skeleton/volatile stay canonical for anchoring & approval.
  // The rule itself lives in derive.ts — viewMarkFor stamps the hash out of exactly this
  // list, so a local copy would silently desynchronize the ticks from what's on screen.
  const rendered = renderedFiles(loaded)
  const isExcluded = (f: FileDiff): boolean => fileIsExcluded(loaded, f)
  // excluded (untracked, hidden) files leave their section/band for the Excluded group
  const filesFor = (s: Section): FileDiff[] => orderFilesForReview(rendered, s.files).filter((f) => !isExcluded(f))
  // a section is done when all its files are viewed (derived — no separate flag;
  // sectionViewState, which doneSectionIds wraps, is the one place that rule lives —
  // ActionChips reads sectionViewState directly for the same predicate). Computed
  // once here, not per scroll frame: useReviewScroll's scroll-sync used to recompute
  // this per section (up to 2N times per scroll event) via its own copy of the
  // predicate; it now reads this same memo through a ref. isSectionDone is a thin
  // lookup into it, not a second computation. doneSectionIds reads loaded/sections/
  // viewedAt directly (not the filesFor closure), so its deps here are exhaustive —
  // filesFor is an unmemoised closure that would otherwise recompute this every render.
  const doneSectionIds = useMemo(
    () => computeDoneSectionIds(loaded, sections, viewedAt),
    [loaded, sections, viewedAt]
  )
  const isSectionDone = (s: Section): boolean => doneSectionIds.has(s.id)

  // all review scroll wiring: refs, header-height + scroll-sync effects, the section/
  // file jump helpers, and the doc scroll-memory (peek + goToDoc/closeDocBack/toggleDoc)
  const {
    scrollRef, headRef, secRefs, peek, setPeek,
    jumpTo, jumpToFile, closeDocBack, toggleDoc
  } = useReviewScroll({ loaded, docPath, sections, doneSectionIds, openDoc, closeDoc })

  // dev/screenshot one-shots (flow/scroll/focus/batch/fake-gen/fake-drift/open-doc)
  useDevReviewHooks({ loaded, gen, scrollRef, setPendingDrift: store.setPendingDrift, openDoc })
  // [ / ] pull and put back sheets on the file nearest the top; ⇧ spreads
  useStackKeys(curFile, rendered)

  if (!loaded) return null
  const { skeleton, state, artifacts, commits } = loaded
  // a parked approval is answerable from the drawer — badge the Chat button
  // unconditionally so it's discoverable even when the drawer is already open.
  const hasPendingApproval = pendingApprovals(gen).length > 0
  const annotations = state.annotations
  const fallbackTitle = branch && /^[0-9a-f]{12,}$/i.test(branch) ? `Changes on ${shortSha(branch)}` : `Changes on ${branch}`
  // who produced THIS review — locked to the generating agent (not the regen picker)
  const guidedBy = annotations?.generatedBy ?? state.agent ?? store.agent
  // excluded untracked files are split off the rendered list — they carry no review
  // state and live in their own collapsed group, out of every count and section.
  const excludedFiles = orderFilesForReview(rendered.filter(isExcluded))
  const displayFiles = rendered.filter((f) => !isExcluded(f))
  const flatDisplayFiles = orderFilesForReview(displayFiles)
  // dirty-only files (untracked or worktree-only edits) have no committed section/spine
  // entry — surfaced in a trailing band so they aren't dropped.
  const sectionedPaths = new Set(sections.flatMap((s) => s.files))
  // only meaningful in sectioned (annotated) mode; flat mode renders displayFiles whole
  const looseFiles = sections.length > 0 ? orderFilesForReview(displayFiles.filter((f) => !sectionedPaths.has(f.path))) : []
  const totalAdd = displayFiles.reduce((n, f) => n + f.add, 0)
  const totalDel = displayFiles.reduce((n, f) => n + f.del, 0)
  const dirtyAdd = loaded.volatile.reduce((n, f) => n + f.add, 0)
  const dirtyDel = loaded.volatile.reduce((n, f) => n + f.del, 0)
  const reviewedCount = sections.filter(isSectionDone).length
  const fileCount = displayFiles.length
  const viewedCount = displayFiles.filter((f) => fileViewed(f, viewedAt, loaded.skeleton.headSha)).length
  const summaryComments = state.comments.filter((c) => c.anchor.kind === 'summary')
  const titleComments = state.comments.filter((c) => c.anchor.kind === 'title')
  const approvedShas = state.approvedShas ?? (state.approvedSha ? [state.approvedSha] : [])
  const approvedHashes = state.approvedHashes ?? approvedShas
  const lastIteration = state.latestIteration
  const commitApproved = approvalFresh(approvedShas, skeleton.headSha)
  const approved = approvalFresh(approvedHashes, loaded.branchHash)
  const dirtyNeedsApproval = loaded.dirty && commitApproved && !approved
  const generatedSha = lastIteration?.endSha ?? state.reviewedAtSha
  const timelineGroups = reviewTimelineGroups({
    headSha: skeleton.headSha,
    commits,
    generatedSha,
    approvedSha: state.approvedSha,
    approvedShas,
    commitApproved
  })
  const generatedShaInTimeline = timelineShaInRange(skeleton.headSha, commits, generatedSha)
  const generatedOffTimeline = Boolean(generatedSha && !generatedShaInTimeline)

  // Terminal merged record (spec §7): the verdict button becomes a non-interactive
  // "Merged into <base>" and takes the place of the approve button (which MergeButton
  // already defers to by rendering null once state.merged is set).
  const merged = state.merged
  const verdictButton = merged ? (
    <span
      className="btn btn-sm rv-approve btn-primary rv-merged"
      title={`Merged into ${merged.baseSymbol} at ${shortSha(merged.mergedSha)} (${strategyLabel(merged.strategy)})${merged.external ? ' — recorded from an external merge' : ''}`}
    >
      <span className="rv-approve-main">
        <I.merge style={{ width: 13, height: 13 }} />Merged into {merged.baseSymbol}
      </span>
    </span>
  ) : null

  const approveButton = (
    <button
      className={'btn btn-sm rv-approve ' + (approved ? 'btn-primary rv-approved' : '')}
      disabled={gen.running}
      title={approved
        ? 'Clear your approval for this commit'
        : dirtyNeedsApproval
          ? 'Approve this commit together with its current uncommitted working-tree changes'
        : loaded.dirty
          ? `Records the committed state — ${loaded.volatile.length} uncommitted change${loaded.volatile.length === 1 ? '' : 's'} won't be covered.`
          : 'Record the current commit as approved'}
      onClick={async () => {
        const id = await store.materialize()
        if (id != null) void (approved ? api().unapprove(id) : api().approve(id)).then(() => store.reload())
      }}
    >
      <span className="rv-approve-main">
        {approved
          ? <><I.check style={{ width: 13, height: 13 }} />Approved</>
          : <><I.check style={{ width: 13, height: 13 }} />{dirtyNeedsApproval ? 'Committed changes approved' : 'Approve'}</>}
      </span>
      {dirtyNeedsApproval && <span className="rv-approve-dirty">new uncommitted changes</span>}
    </button>
  )

  // Dirty-only files (no committed counterpart): all-uncommitted, shown in a trailing
  // band. Mixed/committed files render inline via the merged diff, not here.
  const looseBand = loaded.dirty && looseFiles.length > 0 && (
    <div className="vol-band">
      <div className="vol-head">
        <span className="vol-title">Working tree</span>
        <span className="vol-count">{looseFiles.length}</span>
        <span className="vol-sub">Uncommitted changes not in a narrated section</span>
      </div>
      {looseFiles.map((f) => <DiffView key={'vol:' + f.path} f={f} />)}
    </div>
  )

  // Excluded untracked files: a compact `utrack` box (design 07), narrower than the
  // diff column, rows collapsed by default (peek to read, Include to lift into the
  // review). Carries no review state; never affects counts or approval.
  const excludedBand = <UntrackedGroup files={excludedFiles} />

  return (
    <div className={`wf dz-${DENSITY} stage-code`}>
      <div className="wf-titlebar">
        <span className="rv-refs">
          <RefPicker value={base} onChange={(v) => void store.setSessionBase(v)} repo={state.repo} relativeTo={base || branch || 'HEAD'} label="base ref"
            loc={loaded.baseLoc} />
          <span className="rv-arrow" title="base ← compare (changes this branch adds over the base)">←</span>
          <RefPicker value={branch} onChange={(v) => { if (state.repo) void store.openReview(state.repo, { compare: v }) }} repo={state.repo} relativeTo={branch || 'HEAD'} label="compare ref" prominent
            loc={loaded.compareLoc} />
        </span>
        <span className="grow"></span>
        <ReviewTimeline
          loaded={loaded}
          base={base}
          approved={approved}
          generatedSha={generatedSha}
          generatedShaInTimeline={generatedShaInTimeline}
          generatedOffTimeline={generatedOffTimeline}
          timelineGroups={timelineGroups}
          dirtyAdd={dirtyAdd}
          dirtyDel={dirtyDel}
          pendingDrift={store.pendingDrift}
          watchStopped={store.watchStopped}
          onReload={() => void store.reload()}
          fakeDriftOpen={Boolean(dev.fakeDriftOpen)}
        />
        <WorkspacePicker branch={branch} />
        <button className="btn btn-sm btn-ghost rv-sessions" onClick={() => void store.enterHub(state.repo)} title="All sessions for this repo">
          <I.list style={{ width: 13, height: 13 }} />Sessions
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => (chatOpen ? store.closeChat() : store.openChat())} title={hasPendingApproval ? 'Chat with the agent — waiting on your approval' : 'Chat with the agent'}>
          <I.bubble style={{ width: 13, height: 13 }} />Chat
          {hasPendingApproval && <span className="pill pill-amber">approval</span>}
        </button>
        <button className="wf-iconbtn" onClick={store.openSettings} title="Settings" aria-label="Settings">
          <I.gear style={{ width: 13, height: 13 }} />
        </button>
      </div>

      {store.error && <div className="limn-error limn-toast" role="alert" style={{ marginTop: 12 }}>{store.error}</div>}

      {loaded?.refMissing && (
        <div className="limn-error" style={{ margin: '12px 24px' }}>
          The {loaded.refMissing.side} ref "{loaded.refMissing.symbol}" no longer exists in this repository.
          Review is read-only — pick a new {loaded.refMissing.side} ref from the {loaded.refMissing.side === 'base' ? 'base picker' : 'branch picker'} in the header above.
        </div>
      )}

      <div className="wf-body" ref={wfBodyRef} style={panelVars(panelW.sidebar, panelW.chat) as CSSProperties}>
        {/* LEFT spine */}
        <ReviewSidebar
          loaded={loaded}
          annotations={annotations}
          sections={sections}
          comments={state.comments}
          artifacts={artifacts}
          artifactApprovals={state.artifactApprovals}
          peek={peek}
          setPeek={setPeek}
          docPath={docPath}
          viewedAt={viewedAt}
          curFile={curFile}
          cur={cur}
          flatDisplayFiles={flatDisplayFiles}
          looseFiles={looseFiles}
          filesFor={filesFor}
          reviewedCount={reviewedCount}
          viewedCount={viewedCount}
          fileCount={fileCount}
          collapsed={store.collapsed}
          expanded={store.expanded}
          focusSectionId={store.focusTarget?.sectionId}
          onToggleSection={store.toggleSection}
          jumpTo={jumpTo}
          jumpToFile={jumpToFile}
          toggleDoc={toggleDoc}
          closeDocBack={closeDocBack}
        />
        <ShellHandle kind="sidebar" other={chatOpen ? chatWidth : 0} effective={panelW.sidebar} viewport={viewport} bodyRef={wfBodyRef} />

        {/* MAIN */}
        <main className="gmain" ref={scrollRef}>
          {docPath ? (
            <ArtifactDoc path={docPath} onClose={closeDocBack} />
          ) : (
            <>
              <div className="page-head" ref={headRef}>
                <div className="eyebrow">{displayFiles.length} file{displayFiles.length === 1 ? '' : 's'} · +{totalAdd} / −{totalDel}{GUIDANCE !== 'minimal' && annotations ? ` · Guided by: ${agentLabel(guidedBy).replace(' · ', ' ')}` : ''}</div>
                <div className="page-title-row">
                  <h1 className="page-h1-cmt">
                    {annotations && !merged && <CmtPlus extra="h1-plus" onClick={() => setTitleCommenting(true)} />}
                    {annotations?.title ?? fallbackTitle}
                  </h1>
                  {verdictButton ?? approveButton}
                  <MergeButton loaded={loaded} />
                </div>
              </div>

              {/* no follow-up / steer / regenerate on a terminal merged record (§7) */}
              {!merged && <GenPanel />}

              <ReviewSummary
                annotations={annotations}
                titleComments={titleComments}
                titleCommenting={titleCommenting}
                setTitleCommenting={setTitleCommenting}
                summaryComments={summaryComments}
                guidedBy={guidedBy}
                merged={merged}
                mergedBranch={branch}
              />

              {!annotations && (
                <>
                  <div className="flat-toolbar">
                    <span className="ft-l">Changed files</span>
                    <span className="ft-count">{displayFiles.length} file{displayFiles.length === 1 ? '' : 's'} · {viewedCount}/{fileCount} viewed</span>
                  </div>
                  <div className="flat-files">
                    {flatDisplayFiles.map((f) => <DiffView key={f.path} f={f} />)}
                  </div>
                  {displayFiles.length === 0 && !loaded.dirty && (
                    <div className="limn-empty">No changes between <b>{branch}</b> and <b>{/^[0-9a-f]{7,40}$/i.test(base) ? shortSha(base) : base}</b>.</div>
                  )}
                </>
              )}

              {annotations && !merged && <Questions />}

              {sections.map((s, i) => (
                <SectionView
                  key={s.id}
                  s={s}
                  n={i + 1}
                  total={sections.length}
                  files={filesFor(s)}
                  secRef={(el) => { secRefs.current[s.id] = el }}
                />
              ))}
              {annotations && displayFiles.length === 0 && !loaded.dirty && (
                <div className="limn-empty">No changes between <b>{branch}</b> and <b>{/^[0-9a-f]{7,40}$/i.test(base) ? shortSha(base) : base}</b>.</div>
              )}

              {annotations && looseBand}
              {excludedBand}
              <div style={{ height: 40 }}></div>
            </>
          )}
        </main>

        {chatOpen && <ShellHandle kind="chat" other={panelW.sidebar} effective={panelW.chat} viewport={viewport} bodyRef={wfBodyRef} />}
        <ChatDrawer open={chatOpen} onClose={() => store.closeChat()} />
      </div>
    </div>
  )
}
