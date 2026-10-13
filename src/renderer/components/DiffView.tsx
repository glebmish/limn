import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { FileDiff } from '../../shared/types'
import { CmtPlus } from '../kit'
import { fileViewed, fileIsExcluded, useStore, type AppStore } from '../store'
import { renderedFiles } from '../store/derive'
import { effectiveStack, sameStack } from '../lib/stack'
import { holdPlace } from '../lib/focusScroll'
import { DiffStack } from './DiffStack'
import { Composer, InlineThread } from './Threads'
import { reviewStatusForFile } from '../lib/fileStatus'
import { FileHeader, splitPath } from './FileHeader'
import { DiffBody, type ComposerAt } from './DiffBody'
import { approvedShaList, sinceBasis } from '../../shared/sinceBasis'

/** Whether the header's Expand-all latch still stands: it was taken on one file
 *  object and one stack, and the body's folds reset with either. A refresh (a save,
 *  a pull, a re-generate) mints a fresh `FileDiff` for the same path, so an
 *  identity check — not a path check — is what keeps the header's word ("Collapse")
 *  and the rows underneath it from disagreeing. */
export function foldsStillOpen(
  open: { f: FileDiff; stackKey: string } | null, f: FileDiff, stackKey: string
): boolean {
  return open != null && open.f === f && open.stackKey === stackKey
}

/** Everything DiffView reads out of the store, for ONE file. Everything else the
 *  store holds — `ops` (one write per streamed agent event), `cur`/`curFile` (one
 *  per section/file boundary the reader scrolls past), chat, dashboard, prefs — is
 *  deliberately absent: a selector-less `useStore()` here re-ran the whole row tree
 *  of every open file on each of those writes, since zustand mints a new top-level
 *  state object per `set()`. Shallow-compared, so a slice whose fields are all
 *  unchanged does not re-render the file at all.
 *
 *  Actions are not in it: they are stable for the store's lifetime and are read off
 *  `useStore.getState()` where they are called, so subscribing to them would buy
 *  nothing. */
export function diffViewSlice(s: AppStore, path: string) {
  return {
    loaded: s.loaded,
    viewedAt: s.viewedAt,
    diffStack: s.diffStack,
    /** this file's own stack override, not the whole per-file map */
    override: s.fileStack[path],
    /** whether the focus hold is on THIS file, not which file it is on */
    focused: s.focusTarget?.file === path
  }
}

/** Memoized on `f`: `renderedFiles` hands back `loaded.skeleton.files` (or `merged`),
 *  so a file object is referentially stable between refreshes — and its parents
 *  (`SectionView`, `Review`) are selector-less store subscribers that re-render on
 *  every write in the app. Without the boundary each of those writes repainted every
 *  row of every open file. */
export const DiffView = memo(function DiffView({ f }: {
  f: FileDiff
}) {
  const { loaded, viewedAt, diffStack, override, focused } = useStore(useShallow((s) => diffViewSlice(s, f.path)))
  // this file's stack: its override, else the review's default — narrowed to the
  // sheets the file has. The ✓ shows while the override differs from the default.
  const requested = override ?? diffStack
  const stack = effectiveStack(requested, f)
  const differs = override != null && !sameStack(override, diffStack)
  const stackKey = JSON.stringify(stack)
  // `fileIsExcluded` rebuilds a Set of every sectioned path, so it is worth keeping
  // off the render path of a review with many files
  const excluded = useMemo(() => fileIsExcluded(loaded, f), [loaded, f])
  // how many files the ✓ would spread to — the same list `fileIsExcluded` walks, and
  // the same reason to walk it off the render path
  const fileCount = useMemo(() => renderedFiles(loaded).length, [loaded])
  // stable while the review is: the `?? []` fallback would otherwise mint a fresh
  // array every render and defeat the two memos below
  const comments = useMemo(() => loaded?.state.comments ?? [], [loaded])
  const { name } = splitPath(f.path)
  // recognized spec/plan: this same file is reviewable rendered at the top
  const artifact = loaded?.artifacts.find((a) => a.path === f.path)
  // an unambiguous file-line identity for the per-line composer — two identical
  // lines can no longer open the composer together (was content-matched, then
  // hunk-indexed; #11 re-keyed it onto the file line the reader sees).
  const [composerAt, setComposerAt] = useState<ComposerAt | null>(null)
  const [fileCommenting, setFileCommenting] = useState(false)
  // manual open/collapse override for this file's diff. null = follow the default
  // (open when unviewed, collapsed when viewed); true/false = explicitly toggled.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  // the header's Expand all / Collapse — every fold in the body at once. Held as the
  // file/stack it was opened on rather than a bare flag: the body's own fold state
  // resets with either (line numbers move), so deriving the header's label from the
  // same identity is what stops it saying "Collapse" over folds that just shut.
  const [foldsOpenOn, setFoldsOpenOn] = useState<{ f: FileDiff; stackKey: string } | null>(null)
  const foldsOpen = foldsStillOpen(foldsOpenOn, f, stackKey)
  // the strip's − and caption row stick right under the sticky file header, so they
  // need its real height (a wrapped path or a pill changes it) — measured, not assumed
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const card = cardRef.current
    const head = card?.querySelector<HTMLElement>('.gfile-head')
    if (!card || !head || typeof ResizeObserver === 'undefined') return
    const apply = (): void => card.style.setProperty('--gfile-head-h', `${head.getBoundingClientRect().height}px`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(head)
    return () => ro.disconnect()
  }, [])

  // folding this file (tick, or a click on its stuck header) must not move the page
  // under the reader: hold the header where it is — or, when the fold takes the whole
  // section with it (last file ticked), the section block. Both are resolved BEFORE
  // the change: a detached card no longer knows its section.
  const holdFold = (): (() => void) => {
    const card = cardRef.current
    const restore = holdPlace(card?.querySelector<HTMLElement>('.gfile-head'))
    const section = card?.closest<HTMLElement>('.gsec') ?? null
    return () => restore(section)
  }

  // two passes over every comment in the review, per file — memoized on the list they
  // read (and stable, so DiffBody's own props stop churning with them)
  const fileComments = useMemo(
    () => comments.filter((c) => c.anchor.kind === 'diff' && c.anchor.file === f.path), [comments, f.path])
  const fileLevelComments = useMemo(
    () => comments.filter((c) => c.anchor.kind === 'file' && c.anchor.file === f.path), [comments, f.path])
  const viewMark = viewedAt[f.path]
  // single source of truth (matches section counts); ignores stale `sinceViewed`
  // once the mark sits at head, so re-viewing a drifted file sticks immediately.
  const isViewed = fileViewed(f, viewedAt, loaded?.skeleton.headSha)
  // a file you ticked viewed that has since changed sits in the amber `~` middle
  // ground: not fully viewed, but distinct from one you never looked at. Clicking
  // its tick re-views it (stamps a fresh mark at head → green).
  const changedSinceViewed = !isViewed && Boolean(viewMark)
  const fileStatus = reviewStatusForFile(f, viewedAt, loaded?.skeleton.headSha)
  // open by default, collapsed once viewed — unless the header was clicked to
  // override it. A focus always force-shows the body (without clearing the tick).
  const effectiveOpen = manualOpen ?? !isViewed
  const showBody = focused || effectiveOpen

  return (
    <div className="gfile-wrap">
      <span className="gfile-cmt-zone" />
      <CmtPlus extra="gfile-plus" onClick={() => setFileCommenting(true)} />
      <div ref={cardRef} className={'gfile' + (showBody ? ' open' : ' collapsed') + (isViewed && !focused ? ' viewed' : '')}>
        <FileHeader
          f={f}
          excluded={excluded}
          isViewed={isViewed}
          changedSinceViewed={changedSinceViewed}
          fileStatus={fileStatus}
          showBody={showBody}
          effectiveOpen={effectiveOpen}
          artifact={artifact}
          foldsOpen={foldsOpen}
          onToggleFolds={() => setFoldsOpenOn(foldsOpen ? null : { f, stackKey })}
          // a header click on the focused file collapses it too: the focus hold
          // (which force-shows the body) ends, and the toggle goes off what is SHOWN
          onToggleOpen={() => { const restore = holdFold(); if (focused) useStore.getState().setFocusTarget(null); setManualOpen(!showBody); restore() }}
          onToggleViewed={() => { const restore = holdFold(); useStore.getState().toggleViewed(f.path, isViewed); setManualOpen(null); restore() }}
          onToggleExcluded={() => useStore.getState().toggleExcluded(f)}
        />

        {(fileLevelComments.length > 0 || fileCommenting) && (
          <div className="gfile-filecmt">
            {fileLevelComments.map((c) => (
              <InlineThread key={c.id} c={c} locLabel={`on ${name}`} />
            ))}
            {fileCommenting && (
              <Composer
                placeholder={`Comment on ${name} as a whole — the agent gets it with your next batch…`}
                onCancel={() => setFileCommenting(false)}
                onSubmit={async (text) => {
                  if (await useStore.getState().addComment({ kind: 'file', file: f.path }, text)) setFileCommenting(false)
                }}
              />
            )}
          </div>
        )}

        {showBody && (
          <DiffStack
            f={f}
            stack={stack}
            differs={differs}
            defaultStack={diffStack}
            fileCount={fileCount}
            shas={{
              review: loaded?.state.reviewedAtSha,
              approved: loaded ? (approvedShaList(loaded.state).includes(loaded.skeleton.headSha) ? loaded.skeleton.headSha : loaded.state.approvedSha) : undefined,
              viewed: viewMark?.sha
            }}
            since={loaded ? sinceBasis(loaded.state, loaded.skeleton.headSha)?.basis ?? null : null}
            onChange={(next, spread) => {
              useStore.getState().setFileStack(f.path, next)
              if (spread) useStore.getState().spreadStack(f.path)
            }}
            onSpread={() => useStore.getState().spreadStack(f.path)}
          >
            <DiffBody
              f={f}
              stack={stack}
              showBody={showBody}
              fileComments={fileComments}
              composerAt={composerAt}
              setComposerAt={setComposerAt}
              revealAllFlag={foldsOpen}
            />
          </DiffStack>
        )}
      </div>
    </div>
  )
})
