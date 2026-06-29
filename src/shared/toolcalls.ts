import type { EngineEvent, MessageSegment, ToolCall, ToolVerb } from './types.js'

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

/** Unwrap a Codex shell invocation (`/bin/zsh -lc '<script>'`, `bash -c "…"`, `sh -c …`)
 *  down to the meaningful command. Multi-line scripts collapse to the first real command
 *  line, skipping comments and heredoc openers. Capped to ~120 chars; never regresses
 *  (an unrecognised command is returned capped as-is). */
export function bashArg(command: string): string {
  const cap = (s: string) => s.trim().slice(0, 120)
  const m = command.trim().match(/^(?:\/\S+\/)?(?:zsh|bash|sh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/)
  const inner = m ? m[2] : command
  const lines = inner.split('\n').map((l) => l.trim())
  // skip blank lines, comments, and heredoc OPENERS (`<<EOF`, `<<-'EOF'`, `<< "X"`)
  // — but not a `<<` bitshift like `echo $((1<<4))`, which a bare includes('<<') hit.
  const isHeredoc = (l: string) => /<<[-~]?\s*\\?['"]?[A-Za-z_]/.test(l)
  const pick = lines.find((l) => l && !l.startsWith('#') && !isHeredoc(l))
  return cap(pick ?? lines.find((l) => l) ?? inner)
}

/** Cap a result preview to ~maxLines / ~maxChars, reporting the hidden remainder.
 *  Generous caps so the expanded row shows the whole command output in practice
 *  (the renderer makes it scrollable); the cap is only a runaway guard. */
export function clampOut(text: string, maxLines = 200, maxChars = 8000): { out: string; outMore?: string } {
  let out = text.length > maxChars ? text.slice(0, maxChars) : text
  const total = text.split('\n').length
  const lines = out.split('\n')
  if (lines.length > maxLines) out = lines.slice(0, maxLines).join('\n')
  const shown = out.split('\n').length
  const hidden = total - shown
  return hidden > 0 ? { out, outMore: `${hidden} more line${hidden === 1 ? '' : 's'} truncated` } : { out }
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

/** Fold an event stream into ORDERED message segments, preserving the agent's
 *  text↔tool interleaving so tool rows render inline at their call site. Consecutive
 *  `text` deltas coalesce into one segment (flushed when a tool/action appears);
 *  a tool is emitted once, at first sighting of its id (its run→ok updates share
 *  that id). Actions are emitted by index into the collected actions array.
 *  Empty/whitespace-only text is dropped. Other events are ignored.
 *  Pairs with `reduceToolCalls`: segments give ORDER (+ tool ids), reduceToolCalls
 *  gives the folded ToolCall objects — resolve a segment's id against that list at
 *  render. Pure, so live (renderer) and persisted (main) render identically. */
export function reduceSegments(events: EngineEvent[]): MessageSegment[] {
  const segments: MessageSegment[] = []
  const seen = new Set<string>()
  let pending = ''
  let actionIndex = 0
  const flush = (): void => {
    if (pending.trim()) segments.push({ kind: 'text', text: pending })
    pending = ''
  }
  for (const ev of events) {
    if (ev.type === 'text') { pending += ev.text; continue }
    if (ev.type === 'tool') {
      if (seen.has(ev.call.id)) continue
      seen.add(ev.call.id)
      flush()
      segments.push({ kind: 'tool', id: ev.call.id })
      continue
    }
    if (ev.type === 'action') {
      flush()
      segments.push({ kind: 'action', index: actionIndex++ })
    }
  }
  flush()
  return segments
}
