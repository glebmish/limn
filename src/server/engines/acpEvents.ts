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
import type { ApprovalDiff, ApprovalKind, ApprovalRequest, EngineEvent, EngineId, ToolVerb } from '../../shared/types.js'
import { bashArg, clampOut, deriveVerb } from '../../shared/toolcalls.js'

/** Pure ACP `session/update` -> Limn `EngineEvent` mapper (spec.md §D2). Replaced
 *  `toEvents` (claude.ts) and the app-server's `appServerNotifToEvent`/
 *  `appServerItemToEvent` (now deleted) for the ACP engine — one event per update,
 *  same as those mappers before; pending->completed folding by tool id happens
 *  downstream in `reduceToolCalls` (shared/toolcalls.ts). */

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

/** kv values are a display preview, so each is capped the way tool OUTPUT is
 *  (`clampOut`). Uncapped, a Write's `content` or an Edit's `new_string` — the
 *  adapter forwards the tool input verbatim — would put a whole file body in one
 *  event, sticky on the reduced tool call, persisted on the ChatMessage and
 *  rendered into an unscrolled row. */
const KV_MAX = 500
function clampKv(value: string): string {
  return value.length > KV_MAX ? value.slice(0, KV_MAX) + '…' : value
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
        .map(([k, v]) => [k, clampKv(String(v))] as [string, string])
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

/** The typed diff blocks of a tool call's content — the one filter every
 *  diff-aware branch (update folding, permission classification) shares.
 *  Exported for `acp.ts`'s live tool_call correlation (see `toolDiffs`). */
export function diffBlocks(blocks: ToolCallContent[] | null | undefined): Array<ToolCallContent & { type: 'diff'; path: string }> {
  return (blocks ?? []).filter((b): b is ToolCallContent & { type: 'diff'; path: string } => b.type === 'diff')
}

/** Correlation store keyed by toolCallId; `acp.ts` fills this from live
 *  tool_call(_update) session notifications so a permission request whose own
 *  toolCall omits content (codex-acp's file-change approvals arrive as bare
 *  `{ toolCallId, kind: 'edit', status: 'pending' }`, per its
 *  buildFileChangePermissionRequest) can still recover the diff the agent
 *  already reported for the same id. */
export type ToolDiffs = ReadonlyMap<string, ApprovalDiff[]>

const MAX_DIFF_CHARS = 4000
/** Cap on the number of files carried in `ApprovalRequest.detail.diffs` — a
 *  huge multi-file rewrite still yields a bounded approval payload.
 *  `acpPermissionToRequest` surfaces the omitted count via `detail.moreFiles`
 *  so the reviewer isn't silently shown a partial diff as if it were complete. */
const MAX_DIFF_FILES = 20
/** Cap on `ApprovalRequest.detail.reason` — the agent's stated justification
 *  is free text from the model, so a runaway explanation still yields a
 *  bounded card. Truncated reasons get a trailing `…`. */
const REASON_MAX_LENGTH = 280

/** Cap a diff's old/new text so a huge file rewrite doesn't bloat the
 *  approval payload — the reviewer sees a bounded preview, not the whole file. */
function truncateDiffText(text: string): string {
  return text.length > MAX_DIFF_CHARS ? text.slice(0, MAX_DIFF_CHARS) + '\n… (truncated)' : text
}

/** Diff content blocks -> the truncated `ApprovalDiff[]` shape carried in
 *  `ApprovalRequest.detail.diffs`. Exported so `acp.ts` can pre-truncate when
 *  it stashes a live tool_call's diff into `toolDiffs` for later correlation.
 *  Caps at `MAX_DIFF_FILES` files (see its doc comment). */
export function toApprovalDiffs(blocks: Array<ToolCallContent & { type: 'diff'; path: string }>): ApprovalDiff[] {
  return blocks.slice(0, MAX_DIFF_FILES).map((b) => ({
    path: b.path,
    ...(b.oldText != null ? { oldText: truncateDiffText(b.oldText) } : {}),
    newText: truncateDiffText(b.newText)
  }))
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
  const diffs = diffBlocks(u.content)
  if (diffs.length > 0) {
    const paths = diffs.map((d) => d.path)
    return {
      type: 'tool',
      call: {
        id: u.toolCallId,
        verb: 'edit',
        name: 'file_change',
        arg: paths.join(', ').slice(0, 120),
        meta: `${paths.length} file${paths.length === 1 ? '' : 's'}`,
        // A diff-producing edit can still fail — distinguish it so the renderer shows
        // the failure icon instead of a permanent spinner (reduceToolCalls takes the
        // last event's state unconditionally). Mirrors the old Codex fileChange branch.
        state: u.status === 'completed' ? 'ok' : u.status === 'failed' ? 'err' : 'run'
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

/** True for codex-acp's MCP-server tool approvals. The adapter forwards them as
 *  elicitations shaped `toolCall { kind: 'execute', status: 'pending' }` with
 *  title/rawInput OMITTED (correlated shape) or `rawInput { serverName, schema }`
 *  (uncorrelated fallback), plus `_meta: { is_mcp_tool_approval: true }` — the one
 *  reliable marker. Without this check they'd classify as an empty-command
 *  `command` ("Run \`\`"), so Limn's own tools would never hit the limn auto-allow. */
function isMcpToolApproval(req: RequestPermissionRequest): boolean {
  const metas: unknown[] = [req._meta, (req.toolCall as { _meta?: unknown })._meta]
  return metas.some((m) => Boolean(m && typeof m === 'object' && (m as Record<string, unknown>).is_mcp_tool_approval === true))
}

/** Reads the raw native params as `_meta.codex.params` on a permission request.
 *  The pinned codex-acp (2.2.2) does not send them: for a non-AIR client its
 *  permission requests carry no `_meta` beyond the MCP-tool-approval flag (1.12
 *  sent only `_meta.permission { title, description }`). Kept as a defensive
 *  reader for an adapter that does; without it the card carries no `detail.reason`.
 *  For a `require_escalated` command, `params.justification` is the model's own
 *  user-facing question for why it needs the escalation — the field Limn
 *  prefers for `detail.reason`. When there's no justification, two other
 *  codex-acp param shapes still carry a reason worth stating: `params.grantRoot`
 *  (a file_change request; the same field codex-acp reads to label its own
 *  "Allow Root for Session" option in buildFileChangeOptions) means the edit
 *  writes outside the workspace, and `params.networkApprovalContext` (a
 *  command/execute request; same idea, "Allow Host for Session" in
 *  buildCommandOptions) means the command needs network access. Both are
 *  forwarded straight from the native process with no guaranteed shape, so
 *  only their presence/truthiness is checked, never their contents. */
function escalationJustification(req: RequestPermissionRequest): string | undefined {
  const meta = req._meta as Record<string, unknown> | null | undefined
  const codex = meta && typeof meta === 'object' ? (meta.codex as Record<string, unknown> | undefined) : undefined
  const params = codex && typeof codex === 'object' ? (codex.params as Record<string, unknown> | undefined) : undefined
  if (!params || typeof params !== 'object') return undefined
  const justification = params.justification
  if (typeof justification === 'string' && justification.length > 0) return justification
  if (params.grantRoot === true) return 'requests write access outside the workspace'
  if (params.networkApprovalContext) return 'requests network access'
  return undefined
}

/** Normalize an ACP `session/request_permission` payload to Limn's engine-
 *  agnostic `ApprovalRequest` (spec.md §D3 first bullet) — replaced
 *  `toApprovalRequest` (claude.ts) and the app-server's `approvalRequestFromParams`
 *  (now deleted). `id` is the request's `toolCall.toolCallId` —
 *  `RequestPermissionRequest` carries no separate top-level correlation id, and
 *  the AcpEngine pairs the reviewer's decision back to the same tool call.
 *  `toolTitles` (toolCallId -> title of previously seen tool_call updates) lets an
 *  MCP-tool approval that arrives with no title recover the tool name.
 *  `toolDiffs` is the same idea for file changes: toolCallId -> diff blocks
 *  from a previously seen tool_call(_update), for engines (codex-acp) whose
 *  permission-request toolCall itself carries no diff content — whether or
 *  not it also carries locations. */
export function acpPermissionToRequest(req: RequestPermissionRequest, engine: EngineId, toolTitles?: ReadonlyMap<string, string>, toolDiffs?: ToolDiffs): ApprovalRequest {
  const tc = req.toolCall
  const title = tc.title ?? ''
  const hasDiff = diffBlocks(tc.content).length > 0
  const detail: ApprovalRequest['detail'] = {}
  let kind: ApprovalKind
  let summary: string

  if (isMcpToolApproval(req)) {
    // An MCP tool approval is a tool_use whatever its nominal `kind` says
    // (codex-acp stamps 'execute'). Recover the tool name from the initiating
    // tool_call (correlated shape: `mcp.<server>.<tool>`), else fall back to the
    // uncorrelated shape's rawInput.serverName — either spelling satisfies
    // `isLimnTool` for Limn's own server, and a non-limn MCP tool still gets a
    // meaningful ask summary instead of "Run ``".
    const input = tc.rawInput && typeof tc.rawInput === 'object' ? (tc.rawInput as Record<string, unknown>) : undefined
    const server = typeof input?.serverName === 'string' ? input.serverName : undefined
    const toolName = title || toolTitles?.get(tc.toolCallId) || server || ''
    kind = 'tool_use'
    detail.toolName = toolName
    summary = `Use ${toolName || 'MCP tool'}`
  } else if (tc.kind === 'execute') {
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
    const ownDiffBlocks = diffBlocks(tc.content)
    // codex-acp's file-change permission request omits content entirely (see
    // doc comment above) — fall back to the diff reported for this toolCallId
    // by the item/started tool_call that preceded it. This also covers an
    // engine that sends locations but no content: `ownDiffBlocks` is what
    // actually carries the diff, so its absence — not locations' — is what
    // should trigger the correlation lookup.
    const seenDiffs = ownDiffBlocks.length === 0 ? toolDiffs?.get(tc.toolCallId) : undefined
    const diffPaths = ownDiffBlocks.length ? ownDiffBlocks.map((b) => b.path) : (seenDiffs ?? []).map((d) => d.path)
    const files = Array.from(new Set([...locationPaths, ...diffPaths]))
    detail.files = files
    const diffs = ownDiffBlocks.length ? toApprovalDiffs(ownDiffBlocks) : seenDiffs
    if (diffs && diffs.length) {
      detail.diffs = diffs
      if (ownDiffBlocks.length > MAX_DIFF_FILES) detail.moreFiles = ownDiffBlocks.length - MAX_DIFF_FILES
    }
    summary = `Edit ${files[0] ?? title}`
  } else {
    kind = 'tool_use'
    detail.toolName = title
    summary = `Use ${title}`
  }

  const reason = escalationJustification(req)
  if (reason !== undefined) detail.reason = reason.length > REASON_MAX_LENGTH ? reason.slice(0, REASON_MAX_LENGTH) + '…' : reason

  return { id: tc.toolCallId, engine, kind, summary, detail }
}
