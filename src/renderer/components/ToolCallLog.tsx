import { useState } from 'react'
import { I } from '../kit'
import { clickable } from '../lib/clickable'
import type { ToolCall, ToolVerb } from '../../shared/types'
import { dev } from '../dev'

/** Verb → kit icon. `read`/`other` reuse the doc glyph; the rest were ported
 *  from the wireframe A.* set. */
const VERB_ICON: Record<ToolVerb, keyof typeof I> = {
  read: 'doc', grep: 'search', edit: 'edit', bash: 'term', list: 'list', other: 'doc',
}

/** Row label: known verbs read nicely on their own; an `other` row falls back to
 *  the tool's real name (minus any `mcp__server__` prefix) instead of the opaque
 *  "other" bucket. */
function rowLabel(c: ToolCall): string {
  const mcp = c.name.match(/^mcp__[^_]+__(.+)$/)
  if (mcp) return mcp[1] || c.name
  if (c.verb !== 'other') return c.verb
  return c.name.replace(/^mcp__[^_]+__/, '') || 'other'
}

/** Codex (via ACP) reports a generic MCP tool call — including Limn's own
 *  loopback "limn" server — as a plain `execute` tool_call whose `rawInput` is
 *  `{ server, tool, arguments }` rather than a resolved title (see
 *  `acpEvents.ts`'s `primaryArg`, which lifts unrecognised string/number
 *  rawInput fields into `kv`). Left alone that renders as a card titled "bash"
 *  with a `server limn` / `tool list_comments` body — the tool name is present,
 *  just not where the header looks. Detect the shape from `kv` (both `server`
 *  and `tool` keys present) and recover the real tool name + the kv rows minus
 *  that plumbing, without any data-model change. */
export function mcpToolInfo(c: ToolCall): { tool: string; kv: [string, string][] } | undefined {
  const tool = c.kv?.find(([k]) => k === 'tool')?.[1]
  if (!tool || !c.kv!.some(([k]) => k === 'server')) return undefined
  return { tool, kv: c.kv!.filter(([k]) => k !== 'tool' && k !== 'server') }
}

/** Best-effort unwrap of an MCP result envelope (`{"result":{"content":[{"type":
 *  "text","text":"…"}]}}`) plus a pretty-print of the inner JSON payload, so
 *  tool output isn't a wall of double-escaped JSON. Defensive: any shape
 *  mismatch or parse failure falls back to the original text untouched — never
 *  throws, never renders blank. Semantic per-tool rendering of the unwrapped
 *  payload is a deliberate non-goal (follow-up work). */
export function unwrapMcpOutput(text: string): string {
  let envelope: unknown
  try { envelope = JSON.parse(text) } catch { return text }
  if (!envelope || typeof envelope !== 'object') return text
  const result = (envelope as Record<string, unknown>).result
  if (!result || typeof result !== 'object') return text
  const content = (result as Record<string, unknown>).content
  if (!Array.isArray(content) || !content.length) return text
  const inner = content
    .filter((b): b is { type: string; text: string } => Boolean(b) && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
  if (!inner) return text
  try { return JSON.stringify(JSON.parse(inner), null, 2) } catch { return inner }
}

/** Dev-only: LIMN_EXPAND_TOOL force-opens rows for a static screenshot
 *  ("all" or a comma list of indices like "1,4"). */
function devExpanded(): Set<number> {
  const raw = dev.expandTool
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
        const mcp = mcpToolInfo(c)
        const kv = mcp?.kv ?? c.kv
        const out = c.out ? unwrapMcpOutput(c.out) : c.out
        return (
          <div key={c.id || i} className={cls}>
            <div className="tcall-head" {...clickable(() => toggle(i), { expanded: isOpen })}>
              <Ico className="tcall-ico" />
              <span className="tcall-verb">{mcp?.tool ?? rowLabel(c)}</span>
              <span className="tcall-arg" title={c.arg}>{c.arg}</span>
              {c.state === 'run' && <span className="tcall-stat run"><span className="limn-spin" />running</span>}
              {c.state === 'ok' && <span className="tcall-stat ok">{c.meta ?? 'done'}</span>}
              {c.state === 'err' && <span className="tcall-stat err"><I.warn style={{ width: 10, height: 10 }} />failed</span>}
              <Caret className="tcall-cv" />
            </div>
            {isOpen && (c.arg || kv?.length || out) && (
              <div className="tcall-body">
                {/* full command/arg, untruncated (the collapsed header ellipsizes it) */}
                {c.arg ? <div className="tcall-cmd">{c.arg}</div> : null}
                {kv?.length ? (
                  <div className="tcall-kv">{kv.map(([k, v], j) => <div key={j}><span className="tk">{k} </span>{v}</div>)}</div>
                ) : null}
                {out ? <div className="tcall-out">{out}</div> : null}
                {c.outMore && <div className="tcall-more">{c.outMore}</div>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
