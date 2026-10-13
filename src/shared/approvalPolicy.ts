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
 *  and would silently degrade to deny. Only Limn's own MCP tools are allowed.
 *  Everything else that reaches here is denied, commands included: the engine has
 *  already auto-run what IT deems safe (claude-agent-acp's read-only bash under
 *  `default`; codex-acp's `read-only` mode runs commands in a readOnly sandbox with
 *  network off — since 2.2.2; 1.7–1.12 used a workspaceWrite sandbox there — so a
 *  write fails inside the sandbox rather than landing), so a command request is one
 *  the engine itself wanted a human for — a write, a network call, a Codex sandbox
 *  escalation — and Limn must not second-guess that with a classifier of its own. `file_change` is denied (the model explores and emits JSON, it does
 *  not edit the tree); non-Limn tool_use is denied. Never 'ask' — there is nobody
 *  to ask. */
export function generationLadder(req: ApprovalRequest): 'allow' | 'deny' {
  return req.kind === 'tool_use' && isLimnTool(req.detail?.toolName) ? 'allow' : 'deny'
}

/** The one shared decision function that runs on every incoming ACP
 *  `session/request_permission`, identical for every engine.
 *
 *  By the time a request reaches Limn, the ENGINE has already decided the action
 *  needs a human — claude-agent-acp's CLI auto-allows read-only bash and applies
 *  its own model classifier under native `auto`; codex-acp runs commands inside its
 *  sandbox (`workspace-write` / `agent`) and surfaces only escalations. Limn never
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
