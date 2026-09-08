import type { ApprovalRequest, ExecutionMode } from './types.js'

/** True when a tool name is one of Limn's own MCP tools (read/annotation only).
 *  These are always allowed regardless of tier — row 1 of the ladder.
 *  Adapters spell the name differently: claude-agent-acp uses `mcp__limn__<tool>`,
 *  codex-acp titles MCP calls `mcp.limn.<tool>` (and its uncorrelated approval
 *  fallback surfaces only the server name, `limn`).
 *
 *  Matched at a boundary, never as a bare `limn` prefix: the name reaching here is
 *  not always a registered tool id — acpEvents falls back to the raw serverName and
 *  even to the model/adapter-supplied tool_call title — and a match is an
 *  unconditional 'allow' in every caller, so a second server or a title starting
 *  with "limn" (`limnos`, `limn-writer`) must not ride it. */
export function isLimnTool(name?: string): boolean {
  if (!name) return false
  const lower = name.toLowerCase()
  return lower === 'limn' || lower.startsWith('limn.') || lower.startsWith('mcp__limn__') || lower.startsWith('mcp.limn.')
}

type LadderDecision = 'allow' | 'deny' | 'ask'

/** Structured-generation turn (review / scoped update): its own explicit policy,
 *  NOT a chat tier — a generation turn has no opId, so an 'ask' could never park
 *  and would silently degrade to deny. Commands are allowed unconditionally (parity
 *  with the pre-ACP engines, where generation ran Read/Grep/Glob/Bash under the
 *  SDK's permissive mode: the reviewer asked for this run, and it holds the
 *  exclusive lane); `file_change` is denied (the old engines disallowed Edit/Write
 *  during generation — the model explores and emits JSON, it does not edit the
 *  tree); non-Limn tool_use is denied (those tools simply weren't mounted before).
 *  Never 'ask' — there is nobody to ask. */
export function generationLadder(req: ApprovalRequest): 'allow' | 'deny' {
  if (req.kind === 'command') return 'allow'
  if (req.kind === 'file_change') return 'deny'
  return isLimnTool(req.detail?.toolName) ? 'allow' : 'deny'
}

/** The one shared decision function that runs on every incoming ACP
 *  `session/request_permission`, identical for every engine.
 *
 *  By the time a request reaches Limn, the ENGINE has already decided the action
 *  needs a human — claude-agent-acp's CLI auto-allows read-only bash and applies
 *  its own model classifier under native `auto`; codex-acp runs commands sandboxed
 *  under its native `agent` mode and surfaces only escalations. Limn never
 *  re-classifies what the engine chose to surface: it parks everything on the
 *  reviewer, except the two cases that are Limn's own to decide — its own MCP
 *  tools (always safe, always allowed) and the `full` tier (the reviewer told
 *  Limn to stop asking, so anything that still reaches here is auto-approved). */
export function ladderPolicy(mode: ExecutionMode, req: ApprovalRequest, writeEnabled: boolean): LadderDecision {
  if (req.kind === 'tool_use' && isLimnTool(req.detail?.toolName)) return 'allow'
  if (writeEnabled === false && req.kind === 'file_change') return 'deny'
  if (mode === 'full') return 'allow'
  return 'ask'
}
