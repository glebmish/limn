import type { EngineEvent, ToolCall, ToolVerb } from './types.js'

const VERB_TABLE: [RegExp, ToolVerb][] = [
  [/^(read|read_file|view|cat)$/i, 'read'],
  [/^(grep|ripgrep|rg|search)$/i, 'grep'],
  [/^(edit|write|str_replace|file_change|multiedit)$/i, 'edit'],
  [/^(glob|list|ls|list_comments)$/i, 'list'],
  [/^(bash|shell|command_execution)$/i, 'bash'],
]

/** Map a raw engine/tool name to a display verb. limn MCP tools
 *  (`mcp__limn__add_comment`, `reply_to_comment`, …) fall through to a
 *  sensible bucket; anything unrecognised is `other`. */
export function deriveVerb(name: string): ToolVerb {
  const bare = name.replace(/^mcp__[^_]+__/, '')
  for (const [re, verb] of VERB_TABLE) if (re.test(bare)) return verb
  if (/comment|review|resolve|reply/i.test(bare)) return /list/i.test(bare) ? 'list' : 'edit'
  if (/commit|focus|suggest/i.test(bare)) return 'bash'
  return 'other'
}

/** Best-effort one-line summary of a tool result. `undefined` => the row shows a
 *  plain "done" check instead. */
export function deriveMeta(verb: ToolVerb, resultText: string): string | undefined {
  const t = resultText.trim()
  if (!t) return undefined
  const lines = t.split('\n').length
  if (verb === 'read') return `${lines} ${lines === 1 ? 'line' : 'lines'}`
  if (verb === 'grep') return `${lines} ${lines === 1 ? 'hit' : 'hits'}`
  return undefined
}

/** Cap a result preview to ~maxLines / ~maxChars, reporting the hidden remainder. */
export function clampOut(text: string, maxLines = 30, maxChars = 2000): { out: string; outMore?: string } {
  let out = text.length > maxChars ? text.slice(0, maxChars) : text
  const total = text.split('\n').length
  const lines = out.split('\n')
  if (lines.length > maxLines) out = lines.slice(0, maxLines).join('\n')
  const shown = out.split('\n').length
  const hidden = total - shown
  return hidden > 0 ? { out, outMore: `show ${hidden} more line${hidden === 1 ? '' : 's'}` } : { out }
}

/** Fold an event stream into settled tool calls, upserting by id and preserving
 *  first-seen order. Identity (verb/name/arg/kv) is established by the first
 *  (`run`) event and is sticky — a completion event (notably Claude's
 *  `tool_result`, which carries only the call id) updates status fields
 *  (state/meta/out/outMore) without clobbering identity. Pure — same input,
 *  same output — so the renderer (live) and main (persist) agree. */
export function reduceToolCalls(events: EngineEvent[]): ToolCall[] {
  const order: string[] = []
  const byId = new Map<string, ToolCall>()
  for (const ev of events) {
    if (ev.type !== 'tool') continue
    const inc = ev.call
    const prev = byId.get(inc.id)
    if (!prev) { order.push(inc.id); byId.set(inc.id, inc); continue }
    byId.set(inc.id, {
      ...prev,
      state: inc.state,
      ...(inc.meta !== undefined ? { meta: inc.meta } : {}),
      ...(inc.out !== undefined ? { out: inc.out } : {}),
      ...(inc.outMore !== undefined ? { outMore: inc.outMore } : {}),
      ...(prev.arg === undefined && inc.arg !== undefined ? { arg: inc.arg } : {}),
      ...(prev.kv === undefined && inc.kv !== undefined ? { kv: inc.kv } : {}),
      ...(prev.verb === 'other' && inc.verb !== 'other' ? { verb: inc.verb } : {}),
      ...(prev.name === '' && inc.name ? { name: inc.name } : {}),
    })
  }
  return order.map((id) => byId.get(id)!)
}
