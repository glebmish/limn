import type {
  ContentBlock,
  RequestPermissionRequest,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
  ToolKind
} from '@agentclientprotocol/sdk'
import type { ApprovalKind, ApprovalRequest, EngineEvent, EngineId, ToolVerb } from '../../shared/types.js'
import { bashArg, clampOut, deriveVerb } from '../../shared/toolcalls.js'

/** Pure ACP `session/update` -> Limn `EngineEvent` mapper (spec.md §D2). Replaces
 *  `toEvents` (claude.ts) and `appServerNotifToEvent`/`appServerItemToEvent`
 *  (codexAppServer.ts) for the ACP engine — one event per update, same as those
 *  mappers today; pending->completed folding by tool id happens downstream in
 *  `reduceToolCalls` (shared/toolcalls.ts). */

/** Extract the text payload of a content block, or '' for non-text blocks
 *  (image/audio/resource) — Limn's chat surface only renders text. */
function textOf(content: ContentBlock): string {
  return content.type === 'text' ? content.text : ''
}

/** ACP `ToolKind` -> Limn `ToolVerb`. `think`/`fetch`/`switch_mode`/`other`/
 *  undefined fall back to the existing `deriveVerb` heuristic on the call's
 *  title, so unclassified calls still get a sensible chip verb. */
export function verbOf(kind: ToolKind | undefined, title: string): ToolVerb {
  switch (kind) {
    case 'read':
      return 'read'
    case 'search':
      return 'grep'
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit'
    case 'execute':
      return 'bash'
    default:
      return deriveVerb(title)
  }
}

/** Primary display arg + kv pairs for a tool_call's rawInput, mirroring
 *  claude.ts's `primaryArg`: prefer the first location's path, then (for an
 *  execute call) the shell command via `bashArg`, then a salient rawInput
 *  field. Defensive against absent/any-shaped rawInput. */
function primaryArg(rawInput: unknown, locations: ToolCallLocation[] | null | undefined, kind: ToolKind | undefined): { arg?: string; kv: [string, string][] } {
  const input = rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : undefined
  const kv = input
    ? Object.entries(input)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
        .map(([k, v]) => [k, String(v)] as [string, string])
    : []
  const firstLocation = locations?.[0]?.path
  if (firstLocation) return { arg: firstLocation, kv }
  if (kind === 'execute' && typeof input?.command === 'string') return { arg: bashArg(input.command), kv }
  const raw = input ? input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.query : undefined
  return { arg: raw != null ? String(raw) : undefined, kv }
}

/** A new tool_call -> a running ToolCall chip. */
function toolCallEvent(tc: ToolCall): EngineEvent {
  const { arg, kv } = primaryArg(tc.rawInput, tc.locations, tc.kind)
  return {
    type: 'tool',
    call: {
      id: tc.toolCallId,
      verb: verbOf(tc.kind, tc.title),
      name: tc.title,
      ...(arg ? { arg } : {}),
      ...(kv.length ? { kv } : {}),
      state: 'run'
    }
  }
}

/** Concatenated text of `content`-type ToolCallContent blocks (diff/terminal
 *  blocks carry no inline text). */
function contentText(blocks: ToolCallContent[] | null | undefined): string {
  if (!blocks) return ''
  return blocks
    .filter((b): b is ToolCallContent & { type: 'content'; content: ContentBlock } => b.type === 'content')
    .map((b) => textOf(b.content))
    .join('')
}

/** The completion/failure output text: the tool's textual content if present,
 *  else the stringified rawOutput (many ACP tools only populate one of the
 *  two). */
function outTextOf(content: ToolCallContent[] | null | undefined, rawOutput: unknown): string {
  const fromContent = contentText(content)
  if (fromContent) return fromContent
  if (rawOutput === undefined || rawOutput === null) return ''
  return typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput)
}

/** A tool_call_update -> a folded ToolCall status change. `verb:'other'`/
 *  `name:''` are sticky-safe placeholders (mirrors claude.ts's tool_result
 *  branch): `reduceToolCalls` only lets a non-'other' verb / non-empty name
 *  overwrite the identity established by the initiating `tool_call` event. */
function toolCallUpdateEvent(u: ToolCallUpdate): EngineEvent {
  const diffBlocks = (u.content ?? []).filter((b): b is ToolCallContent & { type: 'diff'; path: string } => b.type === 'diff')
  if (diffBlocks.length > 0) {
    const paths = diffBlocks.map((d) => d.path)
    return {
      type: 'tool',
      call: {
        id: u.toolCallId,
        verb: 'edit',
        name: 'file_change',
        arg: paths.join(', ').slice(0, 120),
        meta: `${paths.length} file${paths.length === 1 ? '' : 's'}`,
        state: u.status === 'completed' ? 'ok' : 'run'
      }
    }
  }
  if (u.status === 'completed' || u.status === 'failed') {
    const { out, outMore } = clampOut(outTextOf(u.content, u.rawOutput))
    return {
      type: 'tool',
      call: {
        id: u.toolCallId,
        verb: 'other',
        name: '',
        state: u.status === 'completed' ? 'ok' : 'err',
        ...(out ? { out } : {}),
        ...(outMore ? { outMore } : {})
      }
    }
  }
  // pending / in_progress / no status yet — sparse fold; only toolCallId is guaranteed.
  return {
    type: 'tool',
    call: {
      id: u.toolCallId,
      verb: 'other',
      name: u.title ?? '',
      state: 'run'
    }
  }
}

/** Map one ACP `session/update` payload to zero or more EngineEvents. Always
 *  maps faithfully — text-suppression for structured-generation turns is the
 *  caller's concern (the AcpEngine drops text events on generate turns), not
 *  this mapper's. */
export function acpToEvents(update: SessionUpdate): EngineEvent[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = update.content.type === 'text' ? update.content.text : undefined
      return text !== undefined ? [{ type: 'text', text }] : []
    }
    case 'agent_thought_chunk': {
      const text = update.content.type === 'text' ? update.content.text : undefined
      return text !== undefined ? [{ type: 'status', text: text.slice(0, 160) }] : []
    }
    case 'plan':
      return [{ type: 'status', text: `plan: ${update.entries.length} steps` }]
    case 'plan_update': {
      const n = update.plan.type === 'items' ? update.plan.entries.length : 0
      return [{ type: 'status', text: `plan: ${n} steps` }]
    }
    case 'tool_call':
      return [toolCallEvent(update)]
    case 'tool_call_update':
      return [toolCallUpdateEvent(update)]
    case 'current_mode_update':
    case 'available_commands_update':
    case 'usage_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'plan_removed':
    case 'user_message_chunk':
      return []
    default:
      return []
  }
}

/** Normalize an ACP `session/request_permission` payload to Limn's engine-
 *  agnostic `ApprovalRequest` (spec.md §D3 first bullet) — replaces
 *  `toApprovalRequest` (claude.ts) and `approvalRequestFromParams`
 *  (codexAppServer.ts). `id` is the request's `toolCall.toolCallId` —
 *  `RequestPermissionRequest` carries no separate top-level correlation id, and
 *  the AcpEngine pairs the reviewer's decision back to the same tool call. */
export function acpPermissionToRequest(req: RequestPermissionRequest, engine: EngineId): ApprovalRequest {
  const tc = req.toolCall
  const title = tc.title ?? ''
  const hasDiff = (tc.content ?? []).some((b) => b.type === 'diff')
  const detail: ApprovalRequest['detail'] = {}
  let kind: ApprovalKind
  let summary: string

  if (tc.kind === 'execute') {
    kind = 'command'
    const input = tc.rawInput && typeof tc.rawInput === 'object' ? (tc.rawInput as Record<string, unknown>) : undefined
    const command =
      input && typeof input.command === 'string'
        ? input.command
        : typeof tc.rawInput === 'string'
          ? tc.rawInput
          : title
    detail.command = command
    summary = `Run \`${command}\``
  } else if (tc.kind === 'edit' || tc.kind === 'delete' || tc.kind === 'move' || hasDiff) {
    kind = 'file_change'
    const locationPaths = (tc.locations ?? []).map((l) => l.path)
    const diffPaths = (tc.content ?? []).filter((b): b is ToolCallContent & { type: 'diff'; path: string } => b.type === 'diff').map((b) => b.path)
    const files = Array.from(new Set([...locationPaths, ...diffPaths]))
    detail.files = files
    summary = `Edit ${files[0] ?? title}`
  } else {
    kind = 'tool_use'
    detail.toolName = title
    summary = `Use ${title}`
  }

  return { id: tc.toolCallId, engine, kind, summary, detail }
}
