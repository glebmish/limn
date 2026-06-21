import { useState } from 'react'
import { I } from '../kit'
import type { ToolCall, ToolVerb } from '../../shared/types'

/** Verb → kit icon. `read`/`other` reuse the doc glyph; the rest were ported
 *  from the wireframe A.* set. */
const VERB_ICON: Record<ToolVerb, keyof typeof I> = {
  read: 'doc', grep: 'search', edit: 'edit', bash: 'term', list: 'list', other: 'doc',
}

/** Dev-only: LR_EXPAND_TOOL force-opens rows for a static screenshot
 *  ("all" or a comma list of indices like "1,4"). */
function devExpanded(): Set<number> {
  const raw = window.lrDev?.expandTool
  if (!raw) return new Set()
  if (raw === 'all') return new Set(Array.from({ length: 99 }, (_, i) => i))
  return new Set(String(raw).split(',').map((n) => Number(n.trim())).filter((n) => !Number.isNaN(n)))
}

/** The wf-D activity log: a flat list of tool calls, each row collapsed to
 *  verb · arg · state, expandable to reveal its structured args + result. Used
 *  live (folded from gen.log while streaming) and settled (from message.tools). */
export function ToolCallLog({ calls }: { calls: ToolCall[] }) {
  const [open, setOpen] = useState<Set<number>>(devExpanded)
  if (!calls.length) return null
  const toggle = (i: number): void =>
    setOpen((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })
  return (
    <div className="tlog">
      {calls.map((c, i) => {
        const Ico = I[VERB_ICON[c.verb]]
        const isOpen = open.has(i)
        const cls = 'tcall' + (c.state === 'run' ? ' run' : c.state === 'err' ? ' err' : '')
        const Caret = isOpen ? I.chevD : I.chevR
        return (
          <div key={c.id || i} className={cls}>
            <div className="tcall-head" onClick={() => toggle(i)}>
              <Ico className="tcall-ico" />
              <span className="tcall-verb">{c.verb}</span>
              <span className="tcall-arg" title={c.arg}>{c.arg}</span>
              {c.state === 'run' && <span className="tcall-stat run"><span className="lr-spin" />running</span>}
              {c.state === 'ok' && <span className="tcall-stat ok">{c.meta ?? 'done'}</span>}
              {c.state === 'err' && <span className="tcall-stat err"><I.warn style={{ width: 10, height: 10 }} />failed</span>}
              <Caret className="tcall-cv" />
            </div>
            {isOpen && (c.kv?.length || c.out) && (
              <div className="tcall-body">
                {c.kv?.length ? (
                  <div className="tcall-kv">{c.kv.map(([k, v], j) => <div key={j}><span className="tk">{k} </span>{v}</div>)}</div>
                ) : null}
                {c.out ? <div className="tcall-out">{c.out}{c.outMore && <div className="to-fade" />}</div> : null}
                {c.outMore && <div className="tcall-more">{c.outMore}</div>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
