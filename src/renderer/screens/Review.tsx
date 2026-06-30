import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { DENSITY, effectiveSections, fileIsExcluded, fileViewed, globalDiffModeSelection, GUIDANCE, sectionDisclosureState, useStore } from '../store'
import type { GenState } from '../store'
import { I, shortSha, ago, EngineGlyph, CmtPlus } from '../kit'
import type { DriftSummary, EngineEvent, FileDiff, Section, ToolVerb } from '../../shared/types'
import { approvalFresh } from '../../shared/types'
import { SectionView } from '../components/SectionView'
import { DiffView } from '../components/DiffView'
import { UntrackedGroup } from '../components/UntrackedGroup'
import { GenPanel, startGenerateNow } from '../components/GenPanel'
import { Questions } from '../components/Questions'
import { ArtifactDoc } from '../components/ArtifactDoc'
import { ChatDrawer } from '../components/ChatDrawer'
import { WorkspacePicker } from '../components/WorkspacePicker'
import { RefPicker } from '../components/RefPicker'
import { FileTree } from '../components/FileTree'
import { addComment, sendComments } from '../lib/comments'
import { Composer, InlineThread } from '../components/Threads'
import { Commentable, SelectionThreads } from '../components/Commentable'
import { Tooltip } from '../components/Tooltip'
import { agentLabel } from '../../shared/agents'
import { focusAnchor } from '../lib/focus'
import { clickable } from '../lib/clickable'
import { orderFilesForReview } from '../lib/fileOrder'
import { reviewTimelineGroups, timelineShaInRange } from '../lib/reviewTimeline'
import { dev } from '../dev'

let devFlowRan = false
let devFocusRan = false
let devBatchRan = false
let devGenRan = false
let devDocRan = false
let devDriftRan = false

/** dev-only: a synthetic mid-flight review op for capturing the live gen panel. */
function fakeGenState(): GenState {
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
  return { running: true, opId: 'dev-fake', kind: 'review', threadId: null, log, error: null, startedAt: Date.now() - 48000, outcome: null }
}

/** Titlebar fetch pill (design: 04-drift-close). The branch moved past the loaded
 *  snapshot — a single pulsing dot sits at HEAD; the counts stay collapsed until
 *  hover (Limn never re-renders under you). On hover: a commit chip and, separately,
 *  a working-tree-edit (pencil) chip — committed vs uncommitted told apart by ICON —
 *  plus the combined +X −Y delta. Click folds it in (reload). */
function DriftFetchPill({ drift, loadedSha, onPull, open }: { drift: DriftSummary; loadedSha: string; onPull: () => void; open?: boolean }) {
  const [pulling, setPulling] = useState(false)
  const tip =
    `The agent moved the branch while you were reading — `
    + [
      drift.commits ? `${drift.commits} new commit${drift.commits === 1 ? '' : 's'}` : null,
      drift.dirty ? 'uncommitted edits' : null
    ].filter(Boolean).join(' and ')
    + ` (+${drift.add} −${drift.del} since ${shortSha(loadedSha)}), not yet loaded. Click to refresh.`
  return (
    <button
      className={'cm-fetch' + (pulling ? ' pulling gone' : '') + (open ? ' is-open' : '')}
      title={tip}
      aria-label={tip}
      onClick={() => { if (pulling) return; setPulling(true); window.setTimeout(onPull, 240) }}
    >
      <span className="cmf-dot"></span>
      <span className="cmf-rest">
        {drift.commits > 0 && (
          <span className="cmf-chip">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="2.6" /><path d="M.6 7h3.8M9.6 7h3.8" strokeLinecap="round" /></svg>
            {drift.commits}
          </span>
        )}
        {drift.dirty && (
          <span className="cmf-chip" title="uncommitted working-tree edits">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round"><path d="M8.4 2.7l2.9 2.9M2.4 11.6l.7-2.7 5.3-5.3 2 2-5.3 5.3-2.7.7z" /></svg>
          </span>
        )}
        <span className="cmf-delta">+{drift.add} <span className="cmf-del">−{drift.del}</span></span>
      </span>
    </button>
  )
}

/** Markers-key legend (design 07 `fh-rails`/`fh-pop`): an "i" affordance that opens a
 *  hover/focus popover explaining the per-line left-edge rails — committed (solid grey),
 *  staged (solid amber), unstaged (dotted amber). Replaces the per-file "uncommitted"
 *  chip that used to repeat on every working-tree row. */
function MarkersKey() {
  return (
    <span className="fh-rails" tabIndex={0} role="button" aria-label="What the diff left-edge markers mean">
      <I.info className="fh-i" />
      <span className="fh-pop" role="tooltip">
        <span className="rail-row"><span className="rail-sw com" /><span className="rail-tx"><b>committed</b><em>landed in a commit</em></span></span>
        <span className="rail-row"><span className="rail-sw staged" /><span className="rail-tx"><b>staged</b><em>in the index</em></span></span>
        <span className="rail-row"><span className="rail-sw unstaged" /><span className="rail-tx"><b>unstaged</b><em>working-tree edit</em></span></span>
      </span>
    </span>
  )
}

/** The global diff-baseline dropdown (design 07 `fh-dd`) + the markers key. Always
 *  renders the "Full diff" option; "Since approved"/"Since viewed" appear only when a
 *  file has that baseline. Picking one re-syncs every file via `setGlobalDiffMode`.
 *  Shown in both the annotated (page-head) and flat (flat-toolbar) headers. */
function HeaderDiffControls({ globalMode, anySinceApproved, anySinceViewed, dirty, setGlobalDiffMode }: {
  globalMode: ReturnType<typeof globalDiffModeSelection>
  anySinceApproved: boolean
  anySinceViewed: boolean
  dirty: boolean
  setGlobalDiffMode: (m: 'branch' | 'approved' | 'viewed') => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const labelFor = (m: 'branch' | 'approved' | 'viewed'): string =>
    m === 'approved' ? 'Since approved' : m === 'viewed' ? 'Since viewed' : 'Full diff'
  const items: ('branch' | 'approved' | 'viewed')[] = [
    'branch',
    ...(anySinceApproved ? (['approved'] as const) : []),
    ...(anySinceViewed ? (['viewed'] as const) : [])
  ]
  return (
    <div className="diffmode-bar">
      <span className={'fh-dd' + (open ? ' open' : '')} ref={ref}>
        <button
          type="button"
          className="fh-seg"
          aria-haspopup="listbox"
          aria-expanded={open}
          title="Choose which baseline the diffs are shown against"
          onClick={() => setOpen((o) => !o)}
          onBlur={(e) => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) setOpen(false) }}
        >
          <I.list style={{ width: 13, height: 13 }} />
          <span className="fh-dd-label">{globalMode ? labelFor(globalMode) : 'Mixed'}</span>
          <span className="fh-chev">▾</span>
        </button>
        <span className="fh-dd-menu" role="listbox">
          {items.map((m) => (
            <button
              type="button"
              key={m}
              role="option"
              aria-selected={globalMode === m}
              className={'fh-dd-item' + (globalMode === m ? ' sel' : '')}
              onClick={() => { setGlobalDiffMode(m); setOpen(false) }}
            >
              <span className="fh-dd-check">✓</span>{labelFor(m)}
            </button>
          ))}
        </span>
      </span>
      {globalMode === null && (
        <span className="dm-mixed" title="Files are showing different diff bases — pick one above to re-sync them all">
          <I.diff style={{ width: 10, height: 10 }} />mixed · per-file
        </span>
      )}
      {dirty && <MarkersKey />}
    </div>
  )
}

export default function Review() {
  const store = useStore()
  const { loaded, branch, base, viewedAt, cur, curFile, gen, docPath, openDoc, closeDoc, diffMode, fileDiffMode, setGlobalDiffMode } = store
  const scrollRef = useRef<HTMLDivElement>(null)
  const secRefs = useRef<Record<string, HTMLDivElement | null>>({})
  // scroll memory: the review position to return to when a doc closes, plus each
  // doc's own scroll position (per file — a different doc opens from its own top)
  const reviewScrollRef = useRef(0)
  const docScrollRef = useRef<Record<string, number>>({})
  const [peek, setPeek] = useState<string | null>(dev.openPeek ?? null)
  const [summaryCommenting, setSummaryCommenting] = useState(false)
  const [commentStep, setCommentStep] = useState<number | null>(null)
  const [titleCommenting, setTitleCommenting] = useState(false)
  const [commentCriterion, setCommentCriterion] = useState<number | null>(null)
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
      store.setPendingDrift({ headSha: loaded.skeleton.headSha, commits: 2, files: 1, add: 24, del: 7, dirty: true })
    }
    // dev-only: LIMN_OPEN_DOC opens a spec/plan artifact doc once after mount
    if (dev.openDoc && !devDocRan && loaded) {
      devDocRan = true
      openDoc(dev.openDoc)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  // scroll-sync: keep the sidebar's current section AND current file in step with
  // the scroll position, so the tree always shows where you are in the diff.
  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const onScroll = (): void => {
      // the doc view shares this scroll container; scrolling a spec/plan must
      // not re-track the (unmounted) changes sections in the sidebar
      if (useStore.getState().docPath) return
      const baseTop = box.getBoundingClientRect().top + 90
      const va = useStore.getState().viewedAt
      const vaHead = useStore.getState().loaded?.skeleton.headSha
      const sectionDone = (s: Section): boolean => {
        const fs = filesFor(s)
        return fs.length > 0 && fs.every((f) => fileViewed(f, va, vaHead))
      }
      let active: string | undefined
      if (sections.length > 0) {
        const firstOpen = sections.find((s) => !sectionDone(s))
        active = firstOpen ? firstOpen.id : sections[0]?.id
        for (const s of sections) {
          if (sectionDone(s)) continue
          const el = secRefs.current[s.id]
          if (el && el.getBoundingClientRect().top <= baseTop) active = s.id
        }
        if (active) useStore.getState().setCur(active)
      }
      // current file: within the active section, the last file header at or above
      // the fold line; if none is above it yet (we're still in the section's
      // narration/diagram band), the section's FIRST file. Tying this to the active
      // section is what stops a section jump from leaving the *previous* section's
      // last file highlighted, and keeps the highlight in step while scrolling.
      const activeSecEl = active ? secRefs.current[active] : null
      const secTop = activeSecEl ? activeSecEl.getBoundingClientRect().top : -Infinity
      let activeFile: string | null = null
      let firstInSec: string | null = null
      for (const el of box.querySelectorAll<HTMLElement>('[data-limn-file]')) {
        const top = el.getBoundingClientRect().top
        if (top < secTop - 1) continue // file belongs to an earlier section
        const path = el.dataset.limnFile ?? null
        if (firstInSec === null) firstInSec = path
        if (top <= baseTop) activeFile = path
        else break
      }
      // fall back to the section's first file only once its header has reached the
      // fold (so reading the top summary doesn't pre-light section 1's first file)
      useStore.getState().setCurFile(activeFile ?? (secTop <= baseTop ? firstInSec : null))
    }
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => box.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections])

  if (!loaded) return null
  const { skeleton, state, artifacts, commits, sinceTagged } = loaded
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
  // global diff-baseline switch: which mode (if any) all files currently agree on, and
  // which baselines exist to switch to across the changed files.
  const globalMode = globalDiffModeSelection(diffMode, fileDiffMode)
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
  const stepComments = (n: number) => state.comments.filter((c) => c.anchor.kind === 'plan-step' && c.anchor.stepN === n)
  const criterionComments = (i: number) => state.comments.filter((c) => c.anchor.kind === 'acceptance' && c.anchor.index === i)
  const approvedShas = state.approvedShas ?? (state.approvedSha ? [state.approvedSha] : [])
  const approvedHashes = state.approvedHashes ?? approvedShas
  const baseline = approvedShas.includes(skeleton.headSha) ? skeleton.headSha : state.approvedSha ?? state.reviewedAtSha
  const lastIteration = state.latestIteration
  const commitApproved = approvalFresh(approvedShas, skeleton.headSha)
  const approved = approvalFresh(approvedHashes, loaded.branchHash)
  const dirtyNeedsApproval = loaded.dirty && commitApproved && !approved
  const generatedSha = lastIteration?.endSha ?? state.reviewedAtSha
  const timelineTitle = (sha: string, labels: string[]): string => {
    const c = commits.find((item) => item.sha === sha)
    return [
      labels.join(' · '),
      shortSha(sha),
      c?.date ? ago(c.date) : null,
      c?.subject ?? null
    ].filter(Boolean).join(' · ')
  }
  // tooltip body for a timeline mark — wrapped by <Tooltip> which positions the
  // `.cm-tip` bubble on-screen (it flips below the bar instead of clipping off the
  // top, and clamps to the viewport instead of spilling left/right).
  const timelineTipContent = (sha: string, labels: string[]) => {
    const c = commits.find((item) => item.sha === sha)
    return (
      <>
        <span className="l1">
          <span className="lead">{labels.join(' · ')}</span>
          <span className="sep">·</span>
          <span className="sha">{shortSha(sha)}</span>
          {c?.date ? <><span className="sep">·</span>{ago(c.date)}</> : null}
        </span>
        {c?.subject ? <span className="l2">{c.subject}</span> : null}
      </>
    )
  }
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

  const renderTimelineStop = (group: (typeof timelineGroups)[number]) => {
    const hasHead = group.roles.includes('head')
    const hasGenerated = group.roles.includes('generated')
    const hasApproved = group.roles.includes('approved')
    const hasLoadedDirty = hasHead && loaded.dirty && !store.pendingDrift
    const commitOnlyApproved = hasApproved && hasLoadedDirty && !approved
    const labels = group.roles.map((role) => role === 'generated' ? 'Review generated' : role === 'approved' ? 'Approved by you' : 'HEAD')
    const title = timelineTitle(group.sha, labels)
    const roleIcons = (
      <>
        {hasGenerated && <I.changed />}
        {hasGenerated && hasApproved && <span className="cm-div"></span>}
        {hasApproved && <I.check className={commitOnlyApproved ? 'cm-commit-approved' : undefined} />}
      </>
    )

    const tip = (
      <>
        {timelineTipContent(group.sha, labels)}
        {hasLoadedDirty && <span className="l2">Working tree: +{dirtyAdd} -{dirtyDel} uncommitted</span>}
      </>
    )
    if (hasHead && (hasGenerated || hasApproved || hasLoadedDirty)) {
      return (
        <Tooltip key={group.sha} className="cm-merge" tipClassName="cm-tip" tabIndex={0} role="button" content={tip} aria-label={title}>
          {roleIcons}
          {(hasGenerated || hasApproved) && <span className="cm-div"></span>}
          <span className="cm-sha">{shortSha(group.sha)}</span>
          {hasLoadedDirty && <I.edit className="cm-dirty-ico" />}
        </Tooltip>
      )
    }
    if (hasHead) {
      return <Tooltip key={group.sha} className="cm-head" tipClassName="cm-tip" tabIndex={0} role="button" content={tip} aria-label={title}>{shortSha(group.sha)}</Tooltip>
    }
    if (hasGenerated && hasApproved) {
      return <Tooltip key={group.sha} className="cm-merge" tipClassName="cm-tip" tabIndex={0} role="button" content={tip} aria-label={title}>{roleIcons}</Tooltip>
    }
    return (
      <Tooltip key={group.sha} className={'cm-pin ' + (hasApproved ? 'appr' : 'gen')} tipClassName="cm-tip" tabIndex={0} role="button" content={tip} aria-label={title}>
        {hasApproved ? <I.check /> : <I.changed />}
      </Tooltip>
    )
  }

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

  // jump straight to a file's diff (not just its section): force-open the section
  // so a collapsed/completed one still renders, then scroll its file header to top.
  const jumpToFile = (sectionId: string, path: string): void => {
    if (docPath) {
      if (scrollRef.current) docScrollRef.current[docPath] = scrollRef.current.scrollTop
      closeDoc()
    }
    store.openSection(sectionId)
    let tries = 0
    const scroll = (): void => {
      const box = scrollRef.current
      const el = box?.querySelector<HTMLElement>(`[data-limn-file="${CSS.escape(path)}"]`)
      if (!box || !el) {
        if (tries++ < 12) requestAnimationFrame(scroll)
        return
      }
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12
      box.scrollTo({ top: Math.max(0, top), behavior: 'instant' })
    }
    requestAnimationFrame(scroll)
  }

  const jumpToRawFile = (path: string): void => {
    if (docPath) {
      if (scrollRef.current) docScrollRef.current[docPath] = scrollRef.current.scrollTop
      closeDoc()
    }
    let tries = 0
    const scroll = (): void => {
      const box = scrollRef.current
      const el = box?.querySelector<HTMLElement>(`[data-limn-file="${CSS.escape(path)}"]`)
      if (!box || !el) {
        if (tries++ < 12) requestAnimationFrame(scroll)
        return
      }
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12
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

  const approveButton = (
    <button
      className={'btn btn-sm rv-approve ' + (approved ? 'btn-ghost rv-approved' : 'btn-primary')}
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
        if (id != null) void (approved ? window.api.unapprove(id) : window.api.approve(id)).then(() => store.reload())
      }}
    >
      <span className="rv-approve-main">
        {approved
          ? <><I.x style={{ width: 13, height: 13 }} />Unapprove</>
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
        <span className="ctmark">
          {generatedSha && generatedOffTimeline && (
            <Tooltip className="cm-off" tipClassName="cm-tip" tabIndex={0} role="button"
              aria-label={`Review is off history · ${shortSha(generatedSha)}`}
              content={timelineTipContent(generatedSha, ['Review is off history'])}>
              <I.changed />
              <span className="cm-off-text">off history</span>
            </Tooltip>
          )}
          <Tooltip className="cm-pin" tipClassName="cm-tip" tabIndex={0} role="button" aria-label={`Branch start · ${shortSha(skeleton.mergeBase)}`}
            content={timelineTipContent(skeleton.mergeBase, [base || 'Branch start'])}>
            <I.branch />
          </Tooltip>
          {timelineGroups.map((group, i) => {
            const prevPos = i === 0 ? commits.length : timelineGroups[i - 1].pos
            const n = Math.max(0, prevPos - group.pos)
            const drift = group.roles.includes('head') && generatedShaInTimeline && generatedSha !== skeleton.headSha
            return (
              <Fragment key={group.sha}>
                <span className={'cm-arr' + (drift ? ' drift' : '')}>{n > 0 ? n : ''}</span>
                {renderTimelineStop(group)}
              </Fragment>
            )
          })}
          {store.pendingDrift && (
            <DriftFetchPill drift={store.pendingDrift} loadedSha={skeleton.headSha} onPull={() => void store.reload()} open={Boolean(dev.fakeDriftOpen)} />
          )}
        </span>
        <WorkspacePicker branch={branch} />
        <button className="btn btn-sm btn-ghost rv-sessions" onClick={() => void store.enterHub(state.repo)} title="All sessions for this repo">
          <I.list style={{ width: 13, height: 13 }} />Sessions
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => (chatOpen ? store.closeChat() : store.openChat())} title="Chat with the agent">
          <I.bubble style={{ width: 13, height: 13 }} />Chat
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
        <nav className="gside" aria-label="Review sections">
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
                      <span className={'art-ic' + (state.artifactApprovals[a.path] ? ' is-approved' : '')}>{a.role === 'plan' ? <I.plan style={{ width: 12, height: 12 }} /> : <I.doc style={{ width: 12, height: 12 }} />}</span>
                      <span className="art-name">{a.role === 'plan' ? 'Plan' : 'Spec'}</span>
                      <span className="art-meta" title={a.title}>{a.title}</span>
                    </span>
                    {state.artifactApprovals[a.path] && (
                      <span className="art-tick"><I.check style={{ width: 10, height: 10 }} />approved</span>
                    )}
                    <button
                      className="art-expand"
                      // collapsing the row while its doc is open would strand the doc
                      // (peek drives the row, docPath the main pane) — close both in sync.
                      onClick={(e) => { e.stopPropagation(); if (docPath === a.path) closeDocBack(); else setPeek(peek === a.path ? null : a.path) }}
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
                        annotations.planMap.steps.map((st) => {
                          const destSec = st.sectionId ? sections.find((s) => s.id === st.sectionId) : undefined
                          const destN = destSec ? sections.indexOf(destSec) + 1 : 0
                          return (
                          <Fragment key={st.n}>
                            <div className={'plan-peek-step' + (destSec ? '' : ' unmapped')} {...clickable(() => { if (st.sectionId) jumpTo(st.sectionId) })}>
                              <CmtPlus extra="peek-plus" stop onClick={() => setCommentStep(st.n)} />
                              <span className="pps-n">{st.n}</span>
                              <span className="pps-t" title={st.text}>{st.text}</span>
                              {destSec
                                ? <span className="pps-dest" title={`Jumps to section ${destN}: ${destSec.name}`}>§{destN}</span>
                                : <span className="pps-dest none" title="No matching review section — this step has nowhere to jump">no section</span>}
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
                          )
                        })
                      ) : (
                        <div className="art-goal">{a.lines.find((l) => l.trim() && !l.startsWith('#'))?.slice(0, 140)}</div>
                      )}
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
              <span className="pl-l"><I.diff style={{ width: 11, height: 11 }} />{annotations ? 'Sections' : 'Files'}</span>
              <span className="pl-prog">{annotations ? `${reviewedCount}/${sections.length} sections · ` : ''}{viewedCount}/{fileCount} viewed</span>
            </div>
            {!annotations ? (
              <FileTree
                files={flatDisplayFiles}
                viewedAt={viewedAt}
                headSha={loaded.skeleton.headSha}
                currentFile={curFile}
                onFileClick={(path) => jumpToRawFile(path)}
                className="gnav-tree-flat"
              />
            ) : sections.map((s, i) => {
              const sFiles = filesFor(s)
              const sectionNav = sectionDisclosureState(sFiles, viewedAt, {
                id: s.id,
                collapsed: store.collapsed,
                expanded: store.expanded,
                focused: store.focusTarget?.sectionId === s.id
              }, loaded.skeleton.headSha)
              return (
                <div
                  key={s.id}
                  className={
                    'gnav-sec'
                    + (cur === s.id && !sectionNav.done ? ' cur' : '')
                    + (sectionNav.hasSince ? ' amber' : '')
                    + (sectionNav.done ? ' done' : '')
                    + (!sectionNav.open ? ' collapsed' : '')
                  }
                >
                  <div className="gnav-head">
                    <span className="gnav-caret" {...clickable(() => store.toggleSection(s.id, sectionNav.open), { expanded: sectionNav.open })} />
                    <span className="gnav-idx" {...clickable(() => jumpTo(s.id))}>{i + 1}</span>
                    <span className="gnav-name" title={s.name} {...clickable(() => jumpTo(s.id))}>{s.name}</span>
                  </div>
                  {sectionNav.open && !sectionNav.done && s.desc && <div className="gnav-intent" {...clickable(() => jumpTo(s.id))}>{s.desc}</div>}
                  <FileTree
                    files={sFiles}
                    viewedAt={viewedAt}
                    headSha={loaded.skeleton.headSha}
                    currentFile={curFile}
                    onFileClick={(path) => jumpToFile(s.id, path)}
                    order="explicit"
                  />
                </div>
              )
            })}
            {annotations && looseFiles.length > 0 && (
              <div className="gnav-worktree">
                <div className="gnav-wt-head">
                  <span className="gnav-dirty" />Working tree
                  <span className="gnav-wt-count">{looseFiles.length}</span>
                </div>
                <FileTree
                  files={looseFiles}
                  viewedAt={viewedAt}
                  headSha={loaded.skeleton.headSha}
                  currentFile={curFile}
                  onFileClick={(path) => jumpToRawFile(path)}
                  order="explicit"
                />
              </div>
            )}
          </div>

        </nav>

        {/* MAIN */}
        <main className="gmain" ref={scrollRef}>
          {docPath ? (
            <ArtifactDoc path={docPath} onClose={closeDocBack} />
          ) : (
            <>
              <div className="page-head">
                <div className="eyebrow">{displayFiles.length} file{displayFiles.length === 1 ? '' : 's'} · +{totalAdd} / −{totalDel}{GUIDANCE !== 'minimal' && annotations ? ` · Guided by: ${agentLabel(guidedBy).replace(' · ', ' ')}` : ''}</div>
                <div className="page-title-row">
                  <h1 className="page-h1-cmt">
                    {annotations && <CmtPlus extra="h1-plus" onClick={() => setTitleCommenting(true)} />}
                    {annotations?.title ?? fallbackTitle}
                  </h1>
                  <HeaderDiffControls
                    globalMode={globalMode}
                    anySinceApproved={anySinceApproved}
                    anySinceViewed={anySinceViewed}
                    dirty={loaded.dirty}
                    setGlobalDiffMode={setGlobalDiffMode}
                  />
                  {approveButton}
                </div>
              </div>

              <GenPanel />

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
