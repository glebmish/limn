import { useMemo, useState } from 'react'
import { DENSITY, effectiveSections, fileIsExcluded, fileViewed, reviewOp, GUIDANCE, pendingApprovals, useStore } from '../store'
import { I, shortSha, strategyLabel, CmtPlus } from '../kit'
import type { FileDiff, Section } from '../../shared/types'
import { approvalFresh } from '../../shared/types'
import { HeaderDiffControls } from '../components/HeaderDiffControls'
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
import { api } from '../lib/api'
import { agentLabel } from '../../shared/agents'
import { orderFilesForReview } from '../lib/fileOrder'
import { reviewTimelineGroups, timelineShaInRange } from '../lib/reviewTimeline'
import { useDevReviewHooks } from '../lib/useDevReviewHooks'
import { useReviewScroll } from '../lib/useReviewScroll'
import { dev } from '../dev'

export default function Review() {
  const store = useStore()
  const { loaded, branch, base, viewedAt, cur, curFile, docPath, openDoc, closeDoc, diffMode, setGlobalDiffMode } = store
  // the review-generation op for THIS review (scoped to its threads); drives the gen
  // strip/CTA and the approve-disabled state. A concurrent read-only chat is a
  // separate op and does not gate the review surface.
  const gen = reviewOp(store.ops, loaded)
  const [titleCommenting, setTitleCommenting] = useState(false)
  const chatOpen = store.chatOpen

  const sections = useMemo(() => loaded?.state.annotations ? effectiveSections(loaded) : [], [loaded])
  // When the tree is dirty, the merged base→working-tree diff (committed + uncommitted
  // lines interleaved per file, origin-tagged) drives every file surface; otherwise the
  // plain committed spine does. skeleton/volatile stay canonical for anchoring & approval.
  const renderedFiles = loaded ? (loaded.dirty && loaded.merged ? loaded.merged : loaded.skeleton.files) : []
  const isExcluded = (f: FileDiff): boolean => fileIsExcluded(loaded, f)
  // excluded (untracked, hidden) files leave their section/band for the Excluded group
  const filesFor = (s: Section): FileDiff[] => orderFilesForReview(renderedFiles, s.files).filter((f) => !isExcluded(f))
  // a section is done when all its files are viewed (derived — no separate flag)
  const isSectionDone = (s: Section): boolean => {
    const fs = filesFor(s)
    return fs.length > 0 && fs.every((f) => fileViewed(f, viewedAt, loaded?.skeleton.headSha))
  }

  // all review scroll wiring: refs, header-height + scroll-sync effects, the section/
  // file jump helpers, and the doc scroll-memory (peek + goToDoc/closeDocBack/toggleDoc)
  const {
    scrollRef, headRef, secRefs, peek, setPeek,
    jumpTo, jumpToFile, jumpToRawFile, closeDocBack, toggleDoc
  } = useReviewScroll({ loaded, docPath, sections, filesFor, openDoc, closeDoc, openSection: store.openSection })

  // dev/screenshot one-shots (flow/scroll/focus/batch/fake-gen/fake-drift/open-doc)
  useDevReviewHooks({ loaded, gen, scrollRef, setPendingDrift: store.setPendingDrift, openDoc })

  if (!loaded) return null
  const { skeleton, state, artifacts, commits, sinceTagged } = loaded
  // a parked approval is answerable from the drawer — badge the Chat button
  // unconditionally so it's discoverable even when the drawer is already open.
  const hasPendingApproval = pendingApprovals(gen).length > 0
  const annotations = state.annotations
  const fallbackTitle = branch && /^[0-9a-f]{12,}$/i.test(branch) ? `Changes on ${shortSha(branch)}` : `Changes on ${branch}`
  // who produced THIS review — locked to the generating agent (not the regen picker)
  const guidedBy = annotations?.generatedBy ?? state.agent ?? store.agent
  // the files actually rendered: merged (base→working-tree) while dirty, else the spine.
  // excluded untracked files are split off — they carry no review state and live in
  // their own collapsed group, out of every count and section.
  const renderedAll = renderedFiles
  const excludedFiles = orderFilesForReview(renderedAll.filter(isExcluded))
  const displayFiles = renderedAll.filter((f) => !isExcluded(f))
  const flatDisplayFiles = orderFilesForReview(displayFiles)
  // global diff-baseline switch: the active mode + which baselines exist to switch to
  // across the changed files.
  const globalMode = diffMode
  const anySinceApproved = displayFiles.some((f) => f.sinceHunks)
  const anySinceViewed = displayFiles.some((f) => f.sinceViewedHunks)
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
  const baseline = approvedShas.includes(skeleton.headSha) ? skeleton.headSha : state.approvedSha ?? state.reviewedAtSha
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

      <div className="wf-body">
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
          jumpToRawFile={jumpToRawFile}
          toggleDoc={toggleDoc}
          closeDocBack={closeDocBack}
        />

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
                  <HeaderDiffControls
                    globalMode={globalMode}
                    anySinceApproved={anySinceApproved}
                    anySinceViewed={anySinceViewed}
                    dirty={loaded.dirty}
                    setGlobalDiffMode={setGlobalDiffMode}
                  />
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
                sinceTagged={sinceTagged}
                lastIteration={lastIteration}
                baseline={baseline}
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

              {annotations && <Questions />}

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

        <ChatDrawer open={chatOpen} onClose={() => store.closeChat()} />
      </div>
    </div>
  )
}
