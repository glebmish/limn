import { Fragment, useState } from 'react'
import type { LoadedReview } from '../../shared/ipc'
import type { Artifact, Comment, FileDiff, ReviewAnnotations, Section, ViewMark } from '../../shared/types'
import { narrationText } from '../../shared/types'
import { I, CmtPlus } from '../kit'
import { sectionDisclosureState, useStore } from '../store'
import { clickable } from '../lib/clickable'
import { focusAnchor } from '../lib/focus'
import { FileTree } from './FileTree'
import { Composer, InlineThread } from './Threads'

/** The left review spine (`<nav className="gside">`): the artifact groups + their peek
 *  panels (spec acceptance criteria / plan steps, each with its inline comment composer),
 *  the `gnav` section tree (or the flat FileTree when unannotated), and the trailing
 *  working-tree FileTree. Navigation is delegated to the orchestrator via callbacks so
 *  the scroll behavior stays owned by the review-scroll hook. Markup is verbatim. */
export function ReviewSidebar({
  loaded,
  annotations,
  sections,
  comments,
  artifacts,
  artifactApprovals,
  peek,
  setPeek,
  docPath,
  viewedAt,
  curFile,
  cur,
  flatDisplayFiles,
  looseFiles,
  filesFor,
  reviewedCount,
  viewedCount,
  fileCount,
  collapsed,
  expanded,
  focusSectionId,
  onToggleSection,
  jumpTo,
  jumpToFile,
  jumpToRawFile,
  toggleDoc,
  closeDocBack
}: {
  loaded: LoadedReview
  annotations: ReviewAnnotations | undefined
  sections: Section[]
  comments: Comment[]
  artifacts: Artifact[]
  artifactApprovals: Record<string, string>
  peek: string | null
  setPeek: (v: string | null) => void
  docPath: string | null
  viewedAt: Record<string, ViewMark>
  curFile: string | null
  cur: string | null
  flatDisplayFiles: FileDiff[]
  looseFiles: FileDiff[]
  filesFor: (s: Section) => FileDiff[]
  reviewedCount: number
  viewedCount: number
  fileCount: number
  collapsed: Set<string>
  expanded: Set<string>
  focusSectionId: string | undefined
  onToggleSection: (id: string, currentlyOpen: boolean) => void
  jumpTo: (id: string) => void
  jumpToFile: (sectionId: string, path: string) => void
  jumpToRawFile: (path: string) => void
  toggleDoc: (path: string) => void
  closeDocBack: () => void
}) {
  const [commentStep, setCommentStep] = useState<number | null>(null)
  const [commentCriterion, setCommentCriterion] = useState<number | null>(null)
  const stepComments = (n: number) => comments.filter((c) => c.anchor.kind === 'plan-step' && c.anchor.stepN === n)
  const criterionComments = (i: number) => comments.filter((c) => c.anchor.kind === 'acceptance' && c.anchor.index === i)
  // An acceptance criterion's `source` (integrity-gated in mergeAnnotations — only
  // ever a diff file or a detected artifact) jumps the reviewer to where it's
  // grounded: a diff-file source flashes the exact line via focusAnchor; an
  // artifact-path source opens the rendered doc (no per-line scroll target exists
  // there yet, so opening it is the useful thing a click can do).
  const jumpToSource = (source: { path: string; line?: number }): void => {
    if (loaded.skeleton.files.some((f) => f.path === source.path)) {
      focusAnchor({ kind: 'diff', file: source.path, side: 'new', line: source.line ?? 1, hunkRange: '', lineContent: '' })
    } else {
      useStore.getState().openDoc(source.path)
    }
  }
  return (
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
                  <span className={'art-ic' + (artifactApprovals[a.path] ? ' is-approved' : '')}>{a.role === 'plan' ? <I.plan style={{ width: 12, height: 12 }} /> : <I.doc style={{ width: 12, height: 12 }} />}</span>
                  <span className="art-name">{a.role === 'plan' ? 'Plan' : 'Spec'}</span>
                  <span className="art-meta" title={a.title}>{a.title}</span>
                </span>
                {artifactApprovals[a.path] && (
                  <span className="art-tick"><I.check style={{ width: 10, height: 10 }} />approved</span>
                )}
                <button
                  className="art-expand"
                  // collapsing the row while its doc is open would strand the doc
                  // (peek drives the row, docPath the main pane) — close both in sync.
                  onClick={(e) => { e.stopPropagation(); if (docPath === a.path) closeDocBack(); else setPeek(peek === a.path ? null : a.path) }}
                  title={peek === a.path ? 'Hide details' : 'Show details'}
                  aria-label="Toggle details"
                  style={artifactApprovals[a.path] ? undefined : { marginLeft: 'auto' }}
                >
                  <I.chevR style={{ width: 11, height: 11, color: 'var(--muted)', transform: peek === a.path ? 'rotate(90deg)' : '', transition: '.15s' }} />
                </button>
              </div>
              {peek === a.path && (
                <div className="art-peek">
                  {a.role === 'spec' && annotations?.planMap ? (
                    annotations.planMap.acceptance.map((crit, i) => (
                      <Fragment key={i}>
                        <div
                          className={'spec-req' + (crit.met === true ? ' met' : '') + (crit.source ? ' has-source' : '')}
                          title={crit.source ? `Grounded in ${crit.source.path}${crit.source.line ? `:${crit.source.line}` : ''} — click to jump there` : undefined}
                          {...(crit.source ? clickable(() => jumpToSource(crit.source!)) : {})}
                        >
                          <CmtPlus extra="peek-plus" stop onClick={() => setCommentCriterion(i)} />
                          <span className="req-dot"></span>
                          <span className="req-t">{crit.text}</span>
                          <span className="req-st">{crit.met === true ? 'done' : crit.met === 'partial' ? 'partial' : 'open'}</span>
                        </div>
                        {criterionComments(i).map((c) => <InlineThread key={c.id} c={c} locLabel={`on acceptance criterion ${i + 1}`} />)}
                        {commentCriterion === i && (
                          <Composer
                            placeholder={`Comment on acceptance criterion ${i + 1} — the agent gets it with your next batch…`}
                            onCancel={() => setCommentCriterion(null)}
                            onSubmit={(text) => { void useStore.getState().addComment({ kind: 'acceptance', index: i }, text); setCommentCriterion(null) }}
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
                            onSubmit={(text) => { void useStore.getState().addComment({ kind: 'plan-step', stepN: st.n }, text); setCommentStep(null) }}
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
            collapsed,
            expanded,
            focused: focusSectionId === s.id
          }, loaded.skeleton.headSha)
          return (
            <div
              key={s.id}
              className={
                'gnav-sec'
                + (cur === s.id && !sectionNav.done ? ' cur' : '')
                + (sectionNav.amber ? ' amber' : '')
                + (sectionNav.done ? ' done' : '')
                + (!sectionNav.open ? ' collapsed' : '')
              }
            >
              <div className="gnav-head">
                <span className="gnav-caret" {...clickable(() => onToggleSection(s.id, sectionNav.open), { expanded: sectionNav.open })} />
                <span className="gnav-idx" {...clickable(() => jumpTo(s.id))}>{i + 1}</span>
                <span className="gnav-name" title={s.name} {...clickable(() => jumpTo(s.id))}>{s.name}</span>
              </div>
              {sectionNav.open && !sectionNav.done && narrationText(s) && <div className="gnav-intent" {...clickable(() => jumpTo(s.id))}>{narrationText(s)}</div>}
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
  )
}
