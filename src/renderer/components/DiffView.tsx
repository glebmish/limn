import { useEffect, useRef, useState } from 'react'
import type { FileDiff } from '../../shared/types'
import { CmtPlus } from '../kit'
import { fileViewed, fileIsExcluded, useStore } from '../store'
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

export function DiffView({ f }: {
  f: FileDiff
}) {
  const { viewedAt, toggleViewed, toggleExcluded, loaded, focusTarget, setFocusTarget, diffStack, fileStack, setFileStack, spreadStack } = useStore()
  // this file's stack: its override, else the review's default — narrowed to the
  // sheets the file has. The ✓ shows while the override differs from the default.
  const override = fileStack[f.path]
  const requested = override ?? diffStack
  const stack = effectiveStack(requested, f)
  const differs = override != null && !sameStack(override, diffStack)
  const stackKey = JSON.stringify(stack)
  const excluded = fileIsExcluded(loaded, f)
  const comments = loaded?.state.comments ?? []
  const { name } = splitPath(f.path)
  // recognized spec/plan: this same file is reviewable rendered at the top
  const artifact = loaded?.artifacts.find((a) => a.path === f.path)
  const focused = focusTarget?.file === f.path
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

  const fileComments = comments.filter((c) => c.anchor.kind === 'diff' && c.anchor.file === f.path)
  const fileLevelComments = comments.filter((c) => c.anchor.kind === 'file' && c.anchor.file === f.path)
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
          onToggleOpen={() => { const restore = holdFold(); if (focused) setFocusTarget(null); setManualOpen(!showBody); restore() }}
          onToggleViewed={() => { const restore = holdFold(); toggleViewed(f.path, isViewed); setManualOpen(null); restore() }}
          onToggleExcluded={() => toggleExcluded(f)}
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
                onSubmit={(text) => {
                  void useStore.getState().addComment({ kind: 'file', file: f.path }, text)
                  setFileCommenting(false)
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
            fileCount={renderedFiles(loaded).length}
            shas={{
              review: loaded?.state.reviewedAtSha,
              approved: loaded ? (approvedShaList(loaded.state).includes(loaded.skeleton.headSha) ? loaded.skeleton.headSha : loaded.state.approvedSha) : undefined,
              viewed: viewMark?.sha
            }}
            since={loaded ? sinceBasis(loaded.state, loaded.skeleton.headSha)?.basis ?? null : null}
            onChange={(next, spread) => { setFileStack(f.path, next); if (spread) spreadStack(f.path) }}
            onSpread={() => spreadStack(f.path)}
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
}
