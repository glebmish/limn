import { Fragment, createContext, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import { useStore } from '../store'
import { I, CmtPlus } from '../kit'
import { api } from '../lib/api'
import type { Artifact, Comment } from '../../shared/types'
import { Composer, InlineThread } from './Threads'
import { Commentable, SelectionThreads } from './Commentable'
import { MD_PLUGINS, PreBlock, InlineCode, SafeImage, type HastNode } from '../lib/markdown'

/** What a commentable block needs to render, handed down by context rather than
 *  captured in closures: React compares element types by reference, so the
 *  `components` map below has to be a module-level constant. Rebuilt per render it
 *  would give every `<p>`/`<li>`/`<pre>` in the doc a new type on each render, and
 *  React would unmount and rebuild the whole markdown subtree — throwing away the
 *  local state of the InlineThreads (an open edit and its draft) and the Composer
 *  mounted inside it, so a half-typed comment vanishes the moment anything else on
 *  the page changes. */
interface BlockScope {
  art: Artifact
  path: string
  comments: Comment[]
  composerLine: number | null
  setComposerLine: (line: number | null) => void
}
const BlockCtx = createContext<BlockScope | null>(null)

const lineOf = (node?: HastNode): number => node?.position?.start.line ?? 0

/** One commentable markdown block: hover-"+" + inline threads/composer, anchored
 *  to its source start line. `Tag` is the element to render (a div wrapper, or the
 *  <li> itself so list markup stays valid). */
function Block({ line, tag: Tag = 'div', className, children }: {
  line: number; tag?: 'div' | 'li'; className?: string; children?: ReactNode
}) {
  const scope = useContext(BlockCtx)
  if (!scope) throw new Error('ArtifactDoc block rendered outside its document')
  const { art, path, comments, composerLine, setComposerLine } = scope
  const lineContent = art.lines[line - 1] ?? ''
  // `notInDiff` is excluded for the same reason as 'outdated': the re-anchor pass
  // could not place the comment's quote in this doc, so `line` is a leftover number.
  // Mounting the thread here would park it under whatever block now holds that line.
  const threads = comments.filter(
    (c) => c.anchor.kind === 'artifact' && c.anchor.line === line && c.status !== 'outdated' && !c.notInDiff
  )
  return (
    <Tag className={'cmt' + (className ? ` ${className}` : '')}>
      <button className="spec-plus" title="Comment" onClick={() => setComposerLine(line)}>
        <I.plus style={{ width: 12, height: 12 }} />
      </button>
      {children}
      {threads.map((c) => <InlineThread key={c.id} c={c} locLabel={`on ${art.role} line ${line}`} />)}
      {composerLine === line && (
        <Composer
          placeholder={`Comment on this ${art.role} line — the agent gets it with your next batch…`}
          onCancel={() => setComposerLine(null)}
          onSubmit={async (t) => {
            if (await useStore.getState().addComment({ kind: 'artifact', path, line, lineContent }, t)) setComposerLine(null)
          }}
        />
      )}
    </Tag>
  )
}

/** Module-level so every element type in the doc keeps its identity across renders
 *  (see BlockScope) — the same shape as lib/markdown's MD_COMPONENTS. */
const BLOCK_COMPONENTS: Components = {
  p: ({ node, children }) => <Block line={lineOf(node)}><p>{children}</p></Block>,
  h1: ({ node, children }) => <Block line={lineOf(node)}><h1>{children}</h1></Block>,
  h2: ({ node, children }) => <Block line={lineOf(node)}><h2>{children}</h2></Block>,
  h3: ({ node, children }) => <Block line={lineOf(node)}><h2 style={{ opacity: 0.85 }}>{children}</h2></Block>,
  h4: ({ node, children }) => <Block line={lineOf(node)}><h2 style={{ opacity: 0.85 }}>{children}</h2></Block>,
  blockquote: ({ node, children }) => <Block line={lineOf(node)}><blockquote className="md-quote">{children}</blockquote></Block>,
  li: ({ node, children }) => <Block line={lineOf(node)} tag="li">{children}</Block>,
  pre: ({ node }) => <Block line={lineOf(node)}><PreBlock node={node} /></Block>,
  table: ({ node, children }) => <Block line={lineOf(node)}><table className="md-table">{children}</table></Block>,
  code: InlineCode,
  img: SafeImage,
  a: ({ href, children }) => <a className="md-link" href={href} target="_blank" rel="noreferrer">{children}</a>
}

/** Commentable document view for spec/plan artifacts. The doc renders through the
 *  full markdown pipeline; each rendered block is a hover-"+" comment target,
 *  anchored to the block's source start line so re-anchoring keeps working. */
export function ArtifactDoc({ path, onClose }: { path: string; onClose: () => void }) {
  // narrow selectors: a streaming op pushes store updates constantly, and a bare
  // useStore() would re-render (and re-parse) the whole doc on every one of them.
  const loaded = useStore((s) => s.loaded)
  const branch = useStore((s) => s.branch)
  const reload = useStore((s) => s.reload)
  const materialize = useStore((s) => s.materialize)
  const [composerLine, setComposerLine] = useState<number | null>(null)
  const [commentDeviation, setCommentDeviation] = useState<number | null>(null)
  const [approving, setApproving] = useState(false)
  const allComments = loaded?.state.comments ?? []
  // `loaded` is replaced wholesale on every reload, so keying the memos on it is what
  // keeps `art`/`comments` — and through them the block scope — reference-stable
  // while unrelated state (approving, commentDeviation) churns.
  const art = useMemo(() => loaded?.artifacts.find((a) => a.path === path), [loaded, path])
  const comments = useMemo(
    () => (loaded?.state.comments ?? []).filter((c) => c.anchor.kind === 'artifact' && c.anchor.path === path),
    [loaded, path]
  )
  const blockScope = useMemo<BlockScope | null>(
    () => (art ? { art, path, comments, composerLine, setComposerLine } : null),
    [art, path, comments, composerLine]
  )
  if (!art || !blockScope) return null

  const deviations = loaded?.state.annotations?.planMap?.deviations ?? []
  const approvedAt = loaded?.state.artifactApprovals[path]
  const merged = Boolean(loaded?.state.merged)  // terminal record keeps its approvals (§7)
  const queuedHere = comments.filter((c) => c.status === 'queued').length
  const approve = async (): Promise<void> => {
    if (approving) return
    setApproving(true)
    try {
      const id = await materialize()
      if (id == null) return
      if (approvedAt) await api().unapproveArtifact(id, path)
      else await api().approveArtifact(id, path)
      void reload()
    } catch (err) {
      // the click otherwise rejects unhandled and the checkmark just never changes
      useStore.setState({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      setApproving(false)
    }
  }

  const outdated = comments.filter((c) => c.status === 'outdated')
  // anchored nowhere in the doc (a resolved comment whose quote vanished) — shown in
  // its own bucket at the bottom, exactly as DiffBody does for a file's comments
  const notShown = comments.filter((c) => c.notInDiff && c.status !== 'outdated')

  return (
    <>
      <div className={'plan-stage-banner' + (approvedAt ? ' is-approved' : '')}>
        <span className="psb-ic">{art.role === 'plan' ? <I.plan style={{ width: 14, height: 14 }} /> : <I.doc style={{ width: 14, height: 14 }} />}</span>
        <span className="psb-tx">
          {approvedAt
            ? <><b>{art.role === 'plan' ? 'Plan' : 'Spec'} — approved.</b> Comments still queue for the agent; re-approve if it changes.</>
            : art.role === 'plan'
              ? <><b>Plan — awaiting your approval.</b> Review how this change was meant to be built; comment on any line, then approve or send notes.</>
              : <><b>Spec — the intent this change is judged against.</b> Comment on any line, then approve it as the bar for this branch.</>}
        </span>
        {!merged && (approvedAt ? (
          <button className="btn btn-sm psb-stamp" style={{ marginLeft: 'auto' }} disabled={approving} onClick={approve} title="Clear this approval">
            <I.x style={{ width: 12, height: 12 }} />Unapprove {art.role}
          </button>
        ) : (
          <button className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} disabled={approving} onClick={approve}>
            <I.check style={{ width: 12, height: 12 }} />Approve {art.role}
          </button>
        ))}
        {!approvedAt && queuedHere > 0 && (
          <span className="dim" style={{ fontSize: 10.5, whiteSpace: 'nowrap' }}>{queuedHere} note{queuedHere > 1 ? 's' : ''} queued</span>
        )}
        <button className="btn btn-sm" onClick={onClose}>
          <I.arrow style={{ width: 12, height: 12, transform: 'rotate(180deg)' }} />Back to changes
        </button>
      </div>
      <div className="pdoc pdoc-spec">
        <div className="pdoc-eyebrow pdoc-path">
          <I.branch style={{ width: 11, height: 11, color: 'var(--accent)' }} />
          <span className="pp-branch">{branch}</span>
          <span className="pp-sep">/</span>
          <span className="pp-file">{art.path}</span>
        </div>
        {deviations.length > 0 && (
          <Commentable scope={{ region: 'artifact', path }}>
          <div className="pdoc-q" style={{ marginTop: 14 }}>
            <div className="pq-h"><I.flag style={{ width: 12, height: 12 }} />Where the implementation diverged</div>
            <ul>
              {deviations.map((d, i) => {
                const threads = allComments.filter((c) => c.anchor.kind === 'deviation' && c.anchor.index === i && c.status !== 'outdated')
                return (
                  <Fragment key={i}>
                    <li className="dev-li">
                      <CmtPlus extra="dev-plus" onClick={() => setCommentDeviation(i)} />
                      <span className="dev-t">{d.text}</span>
                    </li>
                    {threads.map((c) => <InlineThread key={c.id} c={c} locLabel={`on plan deviation ${i + 1}`} />)}
                    {commentDeviation === i && (
                      <Composer
                        placeholder={`Comment on plan deviation ${i + 1} — the agent gets it with your next batch…`}
                        onCancel={() => setCommentDeviation(null)}
                        onSubmit={async (t) => { if (await useStore.getState().addComment({ kind: 'deviation', index: i }, t)) setCommentDeviation(null) }}
                      />
                    )}
                  </Fragment>
                )
              })}
            </ul>
          </div>
          </Commentable>
        )}
        <Commentable scope={{ region: 'artifact', path }} className="pdoc-md">
          <BlockCtx.Provider value={blockScope}>
            <ReactMarkdown remarkPlugins={MD_PLUGINS} components={BLOCK_COMPONENTS}>{art.lines.join('\n')}</ReactMarkdown>
          </BlockCtx.Provider>
        </Commentable>
        <SelectionThreads scope={{ region: 'artifact', path }} />
        {notShown.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div className="pdoc-eyebrow">comments no longer anchored in this {art.role}</div>
            {notShown.map((c) => <InlineThread key={c.id} c={c} locLabel="not shown here" />)}
          </div>
        )}
        {outdated.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div className="pdoc-eyebrow">outdated comments</div>
            {outdated.map((c) => <InlineThread key={c.id} c={c} locLabel="outdated" />)}
          </div>
        )}
        <div style={{ height: 60 }}></div>
      </div>
    </>
  )
}
