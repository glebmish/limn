import { useEffect, useState } from 'react'
import type { FileDiff } from '../../shared/types'
import { CmtPlus } from '../kit'
import { fileViewed, fileIsExcluded, modeForFile, useStore } from '../store'
import { Composer, InlineThread } from './Threads'
import { reviewStatusForFile } from '../lib/fileStatus'
import { FileHeader, splitPath } from './FileHeader'
import { DiffBody, type ComposerAt } from './DiffBody'

export function DiffView({ f }: {
  f: FileDiff
}) {
  const { viewedAt, toggleViewed, toggleExcluded, loaded, focusTarget, setFileDiffMode } = useStore()
  // this file's own baseline: its override, else the global default
  const mode = modeForFile(useStore.getState(), f.path)
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
  // the header's Expand all / Collapse — every fold in the body at once. Reset with
  // the baseline: the body's own fold state resets there too (line numbers move).
  const [foldsOpen, setFoldsOpen] = useState(false)
  useEffect(() => setFoldsOpen(false), [mode])
  // Multi asked for, no checkpoint column for this file → the body shows Split and
  // the header says so (DiffBody reports it; the note itself is presentational)
  const [layoutFellBack, setLayoutFellBack] = useState(false)

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
      <div className={'gfile' + (showBody ? ' open' : ' collapsed') + (isViewed && !focused ? ' viewed' : '')}>
        <FileHeader
          f={f}
          excluded={excluded}
          isViewed={isViewed}
          changedSinceViewed={changedSinceViewed}
          fileStatus={fileStatus}
          showBody={showBody}
          effectiveOpen={effectiveOpen}
          artifact={artifact}
          baselineMode={mode}
          foldsOpen={foldsOpen}
          layoutNote={layoutFellBack ? 'no checkpoint for this file' : null}
          onToggleFolds={() => setFoldsOpen((o) => !o)}
          onPickBaseline={(m) => setFileDiffMode(f.path, m)}
          onToggleOpen={() => setManualOpen(!effectiveOpen)}
          onToggleViewed={() => { toggleViewed(f.path, isViewed); setManualOpen(null) }}
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

        <DiffBody
          f={f}
          mode={mode}
          showBody={showBody}
          fileComments={fileComments}
          composerAt={composerAt}
          setComposerAt={setComposerAt}
          revealAllFlag={foldsOpen}
          onLayoutFallback={setLayoutFellBack}
        />
      </div>
    </div>
  )
}
