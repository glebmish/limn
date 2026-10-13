import { useState } from 'react'
import type { BehaviorContrast, Diagram, DiagramNode2, FileDiff, Section } from '../../shared/types'
import { narrationText } from '../../shared/types'
import { I, CmtPlus, DiagramNodeBox, Flow } from '../kit'
import { GUIDANCE, sectionDisclosureState, useStore } from '../store'
import { clickable } from '../lib/clickable'
import { Composer, InlineThread } from './Threads'
import { Commentable, SelectionThreads } from './Commentable'
import { DiffView } from './DiffView'
import { layoutDiagram } from '../lib/diagramLayout'
import { focusAnchor } from '../lib/focus'
import { holdPlace } from '../lib/focusScroll'

/** A single diagram node: `DiagramNodeBox` wrapped in a focus button when the
 *  node carries an anchor (clicking it scrolls/highlights the anchored spot);
 *  a plain wrapper otherwise. `'plain'` kind renders no extra class. */
function DiagramNodeItem({ n }: { n: DiagramNode2 }) {
  const box = <DiagramNodeBox kind={n.kind === 'plain' ? undefined : n.kind} title={n.label} sub={n.sub} />
  if (!n.anchor) return box
  return (
    <button type="button" className="diagram-node-btn" onClick={() => focusAnchor(n.anchor!)}>
      {box}
    </button>
  )
}

/** Renders a section's object diagram (spec A2/A3): a two-tier chain-plus-
 *  branches layout when `layoutDiagram` can draw it, falling back to a flat
 *  node list + `from → to: label` edge list when it can't (cycle, multi-level
 *  fan-in/out). Never crashes, never fakes a chain that isn't there. */
function DiagramView({ d }: { d: Diagram }) {
  const { rows, ok } = layoutDiagram(d)
  const byId = new Map(d.nodes.map((n) => [n.id, n]))
  return (
    <div className="diagram-view">
      {ok ? (
        <div className="diagram-rows">
          {rows.map((row, ri) => (
            <div className="diagram-row" key={ri}>
              {row.map((n, ni) => (
                <span key={n.id} className="diagram-row-item">
                  {ni > 0 && <Flow />}
                  <DiagramNodeItem n={n} />
                </span>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="diagram-fallback">
          <div className="diagram-fallback-nodes">
            {d.nodes.map((n) => <DiagramNodeItem key={n.id} n={n} />)}
          </div>
          <ul className="diagram-fallback-edges">
            {d.edges.map((e, i) => (
              <li key={i}>
                {(byId.get(e.from)?.label ?? e.from)} <Flow /> {(byId.get(e.to)?.label ?? e.to)}
                {e.label ? `: ${e.label}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.caption && <div className="diagram-caption">{d.caption}</div>}
    </div>
  )
}

/** Compact two-row "was"/"now" strip — the densest educational unit (spec A5):
 *  a before/after behavior contrast, rendered directly above the narration so
 *  the reviewer sees what changed in outcome before reading why. */
function ContrastStrip({ c }: { c: BehaviorContrast }) {
  return (
    <div className="gsec-contrast">
      <div className="gsec-contrast-row was"><span className="gc-label">Was</span><span className="gc-text">{c.was}</span></div>
      <div className="gsec-contrast-row now"><span className="gc-label">Now</span><span className="gc-text">{c.now}</span></div>
    </div>
  )
}

export function SectionView({ s, n, total, files, forceOpen, secRef }: {
  s: Section
  n: number
  total: number
  files: FileDiff[]
  forceOpen?: boolean
  secRef: (el: HTMLDivElement | null) => void
}) {
  const { viewedAt, collapsed, expanded, setSectionViewed, openSection, loaded, focusTarget } = useStore()
  const [commenting, setCommenting] = useState<null | 'header' | 'narration' | 'diagram'>(null)
  const comments = loaded?.state.comments ?? []

  const focused = focusTarget?.sectionId === s.id
  const { viewState, done, amber, open } = sectionDisclosureState(files, viewedAt, {
    id: s.id,
    collapsed,
    expanded,
    forceOpen,
    focused
  }, loaded?.skeleton.headSha)
  const reReview = amber
  const showCtx = GUIDANCE !== 'minimal'
  const sectionComments = comments.filter((c) => c.anchor.kind === 'section' && c.anchor.sectionId === s.id)
  // diagram comments are explicitly part:'diagram'; everything else (incl. legacy
  // section comments with no part) shows under the narration.
  const diagramComments = sectionComments.filter((c) => c.anchor.kind === 'section' && c.anchor.part === 'diagram')
  const narrationComments = sectionComments.filter((c) => !(c.anchor.kind === 'section' && c.anchor.part === 'diagram'))

  const cls = 'gsec ' + (done ? 'done ' : reReview ? 'amber ' : '') + (open ? '' : 'collapsed')

  return (
    <div className={cls} ref={secRef} data-limn-section={s.id}>
      <div className="gsec-head" {...(open ? {} : clickable(() => openSection(s.id), { expanded: false, label: `Review section: ${s.name}` }))} style={open ? undefined : { cursor: 'pointer' }}>
        {open && <CmtPlus extra="section-plus" stop onClick={() => setCommenting('header')} />}
        <span className="gsec-no">{n}</span>
        <div className="gsec-h">
          {open && <div className="gsec-step">Section {n} of {total}</div>}
          <div className="t">
            {s.name}
            {!done && !open && reReview && <span className="pill pill-amber"><I.changed />needs re-review</span>}
            {!done && !open && !reReview && <span className="pill pill-unrev">unreviewed</span>}
            {done && <span className="gsec-doneflag"><I.check style={{ width: 12, height: 12 }} />viewed</span>}
          </div>
          {open && showCtx && s.contrast && <ContrastStrip c={s.contrast} />}
          {open && showCtx && s.narration.length > 0 && (
            <Commentable scope={{ region: 'section', sectionId: s.id }}>
              <div className="gsec-narration">
                {s.narration.map((b, i) => (
                  <div key={i} className={'gnar-block' + (b.anchor ? ' anchored' : '')}>{b.text}</div>
                ))}
              </div>
            </Commentable>
          )}
          {!open && !done && (
            <div className="gsec-collapsed-sub" title={narrationText(s) || undefined}>
              {files.length} file{files.length === 1 ? '' : 's'}{narrationText(s) ? ` · ${narrationText(s)}` : ''}
            </div>
          )}
        </div>
        {open ? (
          <label
            className={'file-viewed gsec-viewed' + (viewState !== 'none' ? ' on' : '') + (reReview ? ' amber' : '')}
            title={viewState === 'all' ? 'Mark all files in this section unviewed' : 'Mark all files in this section viewed'}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={done}
              // native tri-state: the section is "mixed" when only some files are viewed.
              // Screen readers announce indeterminate as "mixed"; no aria-checked needed.
              ref={(el) => { if (el) el.indeterminate = viewState === 'some' }}
              aria-label={`Mark all files in “${s.name}” viewed`}
              onChange={(e) => {
                // the fold removes everything under this header; keep the header put
                const restore = holdPlace(e.currentTarget.closest<HTMLElement>('.gsec'))
                setSectionViewed(s.id, files.map((f) => f.path), viewState !== 'all')
                restore()
              }}
            />
            <span className={'fv-box' + (viewState === 'some' ? ' some' : '')}>
              {viewState === 'all' ? <I.check style={{ width: 10, height: 10 }} />
                : reReview ? '~'
                : viewState === 'some' ? <span className="fv-dash" />
                : null}
            </span>
            Viewed
          </label>
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
              onSubmit={async (text) => {
                if (await useStore.getState().addComment({ kind: 'section', sectionId: s.id }, text)) setCommenting(null)
              }}
            />
          )}
          {showCtx && s.diagram && (
            <Commentable scope={{ region: 'section', sectionId: s.id }}>
              <div className="gsec-diagram gsec-diagram-cmt">
                <CmtPlus extra="diagram-plus" onClick={() => setCommenting('diagram')} />
                <DiagramView d={s.diagram} />
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
              onSubmit={async (text) => {
                if (await useStore.getState().addComment({ kind: 'section', sectionId: s.id, part: 'diagram' }, text)) setCommenting(null)
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
              onSubmit={async (text) => {
                if (await useStore.getState().addComment({ kind: 'section', sectionId: s.id, part: 'narration' }, text)) setCommenting(null)
              }}
            />
          )}
          <SelectionThreads scope={{ region: 'section', sectionId: s.id }} />

          {files.map((f) => (
            <DiffView key={f.path} f={f} />
          ))}
        </div>
      )}
    </div>
  )
}
