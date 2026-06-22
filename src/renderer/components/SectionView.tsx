import { useState } from 'react'
import type { FileDiff, Section } from '../../shared/types'
import { I, DiagramNodeBox, Flow, EngineGlyph, CmtPlus } from '../kit'
import { GUIDANCE, useStore } from '../store'
import { addComment } from '../lib/comments'
import { Composer, InlineThread } from './Threads'
import { Commentable, SelectionThreads } from './Commentable'
import { DiffView } from './DiffView'

export function SectionView({ s, n, total, files, forceOpen, secRef }: {
  s: Section
  n: number
  total: number
  files: FileDiff[]
  forceOpen?: boolean
  secRef: (el: HTMLDivElement | null) => void
}) {
  const { reviewedSections, collapsed, markReviewed, openSection, loaded, focusTarget } = useStore()
  const [commenting, setCommenting] = useState<null | 'header' | 'narration' | 'diagram'>(null)
  const comments = loaded?.state.comments ?? []

  const focused = focusTarget?.sectionId === s.id
  const done = reviewedSections.has(s.id)
  // focus force-shows a reviewed/collapsed section without clearing its reviewed state
  const open = forceOpen || focused || (!done && !collapsed.has(s.id))
  const hasSince = files.some((f) => f.hunks.some((h) => h.since))
  const reReview = hasSince
  const showCtx = GUIDANCE !== 'minimal'
  const sectionComments = comments.filter((c) => c.anchor.kind === 'section' && c.anchor.sectionId === s.id)
  // diagram comments are explicitly part:'diagram'; everything else (incl. legacy
  // section comments with no part) shows under the narration.
  const diagramComments = sectionComments.filter((c) => c.anchor.kind === 'section' && c.anchor.part === 'diagram')
  const narrationComments = sectionComments.filter((c) => !(c.anchor.kind === 'section' && c.anchor.part === 'diagram'))
  const approvedAt = loaded?.state.approvedSha?.slice(0, 7)

  const cls = 'gsec ' + (done ? 'done ' : reReview ? 'amber ' : '') + (open ? '' : 'collapsed')

  return (
    <div className={cls} ref={secRef} data-lr-section={s.id}>
      <div className="gsec-head" onClick={() => { if (!open) openSection(s.id) }} style={{ cursor: open ? 'default' : 'pointer' }}>
        {open && <CmtPlus extra="section-plus" stop onClick={() => setCommenting('header')} />}
        <span className="gsec-no">{done ? <I.check style={{ width: 13, height: 13 }} /> : n}</span>
        <div className="gsec-h">
          {open && <div className="gsec-step">Change {n} of {total}</div>}
          <div className="t">
            {s.name}
            {!done && !open && reReview && <span className="pill pill-amber"><I.changed />needs re-review</span>}
            {!done && !open && !reReview && <span className="pill pill-unrev">unreviewed</span>}
            {done && <span className="gsec-doneflag"><I.check style={{ width: 12, height: 12 }} />reviewed{approvedAt ? ` at ${approvedAt}` : ''}</span>}
          </div>
          {open && showCtx && s.desc && (
            <Commentable scope={{ region: 'section', sectionId: s.id }}><div className="d">{s.desc}</div></Commentable>
          )}
          {!open && !done && (
            <div className="gsec-collapsed-sub" title={s.what || undefined}>
              {files.length} file{files.length > 1 ? 's' : ''}{s.what ? ` · ${s.what}` : ''}
            </div>
          )}
        </div>
        {open ? (
          <button
            className={'btn btn-sm gsec-tick ' + (reReview ? 'btn-amber' : 'btn-primary')}
            onClick={(e) => { e.stopPropagation(); markReviewed(s.id) }}
          >
            <I.check />{reReview ? 'Re-approve section' : 'Mark reviewed'}
          </button>
        ) : (
          <button className="btn btn-sm gsec-tick" onClick={(e) => { e.stopPropagation(); openSection(s.id) }}>
            {done ? 'Re-open' : 'Review'}<I.chevR />
          </button>
        )}
      </div>

      {open && (
        <div className="gsec-body">
          {commenting === 'header' && (
            <Composer
              placeholder={`Comment on the “${s.name}” change…`}
              onCancel={() => setCommenting(null)}
              onSubmit={(text) => {
                void addComment({ kind: 'section', sectionId: s.id }, text)
                setCommenting(null)
              }}
            />
          )}
          {showCtx && (s.diagram || s.what) && (
            <Commentable scope={{ region: 'section', sectionId: s.id }}>
            <div className="gsec-cols" style={!s.diagram ? { gridTemplateColumns: '1fr' } : undefined}>
              {s.diagram && (
                <div className={(s.insight ? 'gsec-insight' : 'gsec-diagram') + ' gsec-diagram-cmt'}>
                  <CmtPlus extra="diagram-plus" onClick={() => setCommenting('diagram')} />
                  {s.insight && (
                    <div className="ins-switch">
                      <span className="ins-switch-lab">mechanism</span>
                      <span className="grow"></span>
                    </div>
                  )}
                  <div className={s.insight ? 'df-lane' : undefined} style={s.insight ? { justifyContent: 'center', display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' } : { display: 'contents' }}>
                    {s.diagram.map((nd, i) => (
                      <span key={i} style={{ display: 'contents' }}>
                        {i > 0 && <Flow />}
                        <DiagramNodeBox kind={nd[1]} title={nd[0]} sub={nd[2]} />
                      </span>
                    ))}
                  </div>
                  {s.insight && <div className="ins-caption">{s.insight.caption}</div>}
                </div>
              )}
              {s.what && (
                <div className="agent-note gsec-what gsec-what-cmt">
                  <CmtPlus extra="narration-plus" onClick={() => setCommenting('narration')} />
                  <span className="ai"><EngineGlyph engine={loaded?.state.annotations?.generatedBy?.engine ?? loaded?.state.agent?.engine} style={{ width: 11, height: 11 }} /></span>
                  <span className="txt">
                    <b>What changed: </b>{s.what}
                  </span>
                </div>
              )}
            </div>
            </Commentable>
          )}

          {diagramComments.map((c) => (
            <InlineThread key={c.id} c={c} locLabel={`on the diagram in “${s.name}”`} />
          ))}
          {commenting === 'diagram' && (
            <Composer
              placeholder={`Comment on the diagram in “${s.name}”…`}
              onCancel={() => setCommenting(null)}
              onSubmit={(text) => {
                void addComment({ kind: 'section', sectionId: s.id, part: 'diagram' }, text)
                setCommenting(null)
              }}
            />
          )}

          {narrationComments.map((c) => (
            <InlineThread key={c.id} c={c} locLabel={`on section “${s.name}”`} />
          ))}
          {commenting === 'narration' && (
            <Composer
              placeholder={`Comment on the “${s.name}” section…`}
              onCancel={() => setCommenting(null)}
              onSubmit={(text) => {
                void addComment({ kind: 'section', sectionId: s.id, part: 'narration' }, text)
                setCommenting(null)
              }}
            />
          )}
          <SelectionThreads scope={{ region: 'section', sectionId: s.id }} />

          {files.map((f) => (
            <DiffView
              key={f.path}
              f={f}
              plainNote={s.plainNotes?.[f.path] ?? s.plainNotes?.[f.path.split('/').pop() ?? '']}
            />
          ))}
        </div>
      )}
    </div>
  )
}
