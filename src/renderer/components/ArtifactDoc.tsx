import { Fragment, useState } from 'react'
import { useStore } from '../store'
import { I } from '../kit'
import { addComment } from '../lib/comments'
import { Composer, InlineThread } from './Threads'

/** v3-style commentable document view for spec/plan artifacts.
 *  Every line is a hover-"+" spec-line; threads render inline under their line. */
export function ArtifactDoc({ path, onClose }: { path: string; onClose: () => void }) {
  const { loaded, branch } = useStore()
  const [composerLine, setComposerLine] = useState<number | null>(null)
  const art = loaded?.artifacts.find((a) => a.path === path)
  const comments = (loaded?.state.comments ?? []).filter(
    (c) => c.anchor.kind === 'artifact' && c.anchor.path === path
  )
  if (!art) return null

  const deviations = loaded?.state.annotations?.planMap?.deviations ?? []

  const renderLine = (text: string, idx: number) => {
    const lineNo = idx + 1
    const threads = comments.filter((c) => c.anchor.kind === 'artifact' && c.anchor.line === lineNo && c.status !== 'outdated')
    const trimmed = text.trim()

    let content: React.ReactNode
    if (trimmed.startsWith('# ')) content = <h1>{trimmed.slice(2)}</h1>
    else if (trimmed.startsWith('## ')) content = <h2>{trimmed.slice(3)}</h2>
    else if (trimmed.startsWith('### ')) content = <h2 style={{ opacity: 0.85 }}>{trimmed.slice(4)}</h2>
    else if (trimmed === '') content = <div style={{ height: 8 }} />
    else {
      const bullet = /^[-*] /.test(trimmed)
      const num = trimmed.match(/^(\d+)\. /)
      content = (
        <div className="spec-line">
          <button className="spec-plus" tabIndex={-1} onClick={() => setComposerLine(lineNo)}>
            <I.plus style={{ width: 12, height: 12 }} />
            <span className="plus-tip">comment</span>
          </button>
          {bullet && <span className="sl-bullet"></span>}
          {num && <span className="sl-num">{num[1]}</span>}
          <span className="sl-text">{bullet ? trimmed.slice(2) : num ? trimmed.slice(num[0].length) : trimmed}</span>
        </div>
      )
    }

    return (
      <Fragment key={idx}>
        {content}
        {threads.map((c) => <InlineThread key={c.id} c={c} locLabel={`on ${art.role} line ${lineNo}`} />)}
        {composerLine === lineNo && (
          <Composer
            placeholder={`Comment on this ${art.role} line — the agent gets it with your next batch…`}
            onCancel={() => setComposerLine(null)}
            onSubmit={(t) => {
              void addComment({ kind: 'artifact', path, line: lineNo, lineContent: text }, t)
              setComposerLine(null)
            }}
          />
        )}
      </Fragment>
    )
  }

  const outdated = comments.filter((c) => c.status === 'outdated')

  return (
    <>
      <div className="plan-stage-banner">
        <span className="psb-ic">{art.role === 'plan' ? <I.spark style={{ width: 14, height: 14 }} /> : <I.doc style={{ width: 14, height: 14 }} />}</span>
        <span className="psb-tx">
          {art.role === 'plan'
            ? <><b>Plan — how this change was meant to be built.</b> Comment on any line; notes go to the agent with your next batch.</>
            : <><b>Spec — the intent this change is judged against.</b> Comment on any line; notes go to the agent with your next batch.</>}
        </span>
        <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose}>
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
          <div className="pdoc-q" style={{ marginTop: 14 }}>
            <div className="pq-h"><I.flag style={{ width: 12, height: 12 }} />Where the implementation diverged</div>
            <ul>{deviations.map((d, i) => <li key={i}>{d.text}</li>)}</ul>
          </div>
        )}
        {art.lines.map(renderLine)}
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
