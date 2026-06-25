import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import { useStore } from '../store'
import { I, CmtPlus } from '../kit'
import { addComment } from '../lib/comments'
import { Composer, InlineThread } from './Threads'
import { Commentable, SelectionThreads } from './Commentable'
import { MD_PLUGINS, PreBlock, InlineCode, type HastNode } from '../lib/markdown'

/** Commentable document view for spec/plan artifacts. The doc renders through the
 *  full markdown pipeline; each rendered block is a hover-"+" comment target,
 *  anchored to the block's source start line so re-anchoring keeps working. */
export function ArtifactDoc({ path, onClose }: { path: string; onClose: () => void }) {
  const { loaded, branch, reload, materialize } = useStore()
  const [composerLine, setComposerLine] = useState<number | null>(null)
  const [commentDeviation, setCommentDeviation] = useState<number | null>(null)
  const [approving, setApproving] = useState(false)
  const art = loaded?.artifacts.find((a) => a.path === path)
  const allComments = loaded?.state.comments ?? []
  const comments = allComments.filter((c) => c.anchor.kind === 'artifact' && c.anchor.path === path)
  if (!art) return null

  const deviations = loaded?.state.annotations?.planMap?.deviations ?? []
  const approvedAt = loaded?.state.artifactApprovals[path]
  const queuedHere = comments.filter((c) => c.status === 'queued').length
  const approve = async (): Promise<void> => {
    if (approving) return
    setApproving(true)
    try {
      const id = await materialize()
      if (id == null) return
      await window.api.approveArtifact(id, path)
      void reload()
    } finally {
      setApproving(false)
    }
  }

  const lineOf = (node?: HastNode): number => node?.position?.start.line ?? 0

  /** One commentable markdown block: hover-"+" + inline threads/composer, anchored
   *  to its source start line. `Tag` is the element to render (a div wrapper, or the
   *  <li> itself so list markup stays valid). */
  const Block = ({ line, tag: Tag = 'div', className, children }: {
    line: number; tag?: 'div' | 'li'; className?: string; children: ReactNode
  }) => {
    const lineContent = art.lines[line - 1] ?? ''
    const threads = comments.filter(
      (c) => c.anchor.kind === 'artifact' && c.anchor.line === line && c.status !== 'outdated'
    )
    return (
      <Tag className={'cmt' + (className ? ` ${className}` : '')}>
        <button className="spec-plus" tabIndex={-1} title="Comment" onClick={() => setComposerLine(line)}>
          <I.plus style={{ width: 12, height: 12 }} />
        </button>
        {children}
        {threads.map((c) => <InlineThread key={c.id} c={c} locLabel={`on ${art.role} line ${line}`} />)}
        {composerLine === line && (
          <Composer
            placeholder={`Comment on this ${art.role} line — the agent gets it with your next batch…`}
            onCancel={() => setComposerLine(null)}
            onSubmit={(t) => {
              void addComment({ kind: 'artifact', path, line, lineContent }, t)
              setComposerLine(null)
            }}
          />
        )}
      </Tag>
    )
  }

  const components: Components = {
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
    a: ({ href, children }) => <a className="md-link" href={href} target="_blank" rel="noreferrer">{children}</a>
  }

  const outdated = comments.filter((c) => c.status === 'outdated')

  return (
    <>
      <div className="plan-stage-banner">
        <span className="psb-ic">{art.role === 'plan' ? <I.plan style={{ width: 14, height: 14 }} /> : <I.doc style={{ width: 14, height: 14 }} />}</span>
        <span className="psb-tx">
          {approvedAt
            ? <><b>{art.role === 'plan' ? 'Plan' : 'Spec'} — approved.</b> Comments still queue for the agent; re-approve if it changes.</>
            : art.role === 'plan'
              ? <><b>Plan — awaiting your approval.</b> Review how this change was meant to be built; comment on any line, then approve or send notes.</>
              : <><b>Spec — the intent this change is judged against.</b> Comment on any line, then approve it as the bar for this branch.</>}
        </span>
        {approvedAt ? (
          <span className="psb-stamp" style={{ marginLeft: 'auto' }}>
            <I.check style={{ width: 12, height: 12 }} />Approved at {approvedAt.slice(0, 7)}
          </span>
        ) : (
          <button className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} disabled={approving} onClick={approve}>
            <I.check style={{ width: 12, height: 12 }} />Approve {art.role}
          </button>
        )}
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
                        onSubmit={(t) => { void addComment({ kind: 'deviation', index: i }, t); setCommentDeviation(null) }}
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
          <ReactMarkdown remarkPlugins={MD_PLUGINS} components={components}>{art.lines.join('\n')}</ReactMarkdown>
        </Commentable>
        <SelectionThreads scope={{ region: 'artifact', path }} />
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
