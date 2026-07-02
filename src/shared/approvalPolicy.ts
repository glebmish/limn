import type { ApprovalRequest, ExecutionMode } from './types.js'

/** True when a tool name is one of Limn's own MCP tools (read/annotation only).
 *  These are always allowed regardless of tier — row 1 of the D3 ladder table. */
export function isLimnTool(name?: string): boolean {
  if (!name) return false
  const lower = name.toLowerCase()
  return lower.startsWith('limn') || lower.includes('__limn__') || lower.startsWith('mcp__limn')
}

/** Read/inspect/build/test leading verbs that are safe on their own. */
export const SAFE_COMMAND_ALLOWLIST = [
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'pwd', 'echo',
  'which', 'file', 'stat', 'tree', 'true',
] as const

/** Read-only `git` subcommands — `git <one of these>` is safe. */
const SAFE_GIT_SUBCOMMANDS = [
  'status', 'log', 'diff', 'show', 'branch', 'ls-files', 'blame', 'rev-parse', 'describe',
] as const

/** Tokens that make a segment unsafe no matter what the leading verb is. */
const DANGEROUS_TOKEN_PATTERNS: RegExp[] = [
  />>?/, // redirection: > or >>
  /`/, // command substitution (backtick)
  /\$\(/, // command substitution $(
  /\bsudo\b/,
  /\brm\b/,
  /\bmv\b/,
  /\bdd\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bkill\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bnc\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\bnpm\s+(i|install|ci)\b/,
  /\bpnpm\s+add\b/,
  /\byarn\s+add\b/,
  /\bpip\s+install\b/,
  /\bbrew\s+install\b/,
  /\bcargo\s+add\b/,
  /\bgo\s+get\b/,
  /\bgit\s+push\b/,
  /\bgit\s+commit\b/,
  /\bgit\s+reset\b/,
  /\bgit\s+checkout\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+rebase\b/,
  /\bgit\s+merge\b/,
  /\bgit\s+stash\b/,
]

/** Package-manager script / direct-binary invocations that are read/build/test only. */
const SAFE_SCRIPT_PATTERNS: RegExp[] = [
  /^npm\s+run\s+(test|lint|typecheck|build)\b/,
  /^npm\s+test\b/,
  /^pnpm\s+(run\s+)?(test|lint|typecheck|build)\b/,
  /^yarn\s+(run\s+)?(test|lint|typecheck|build)\b/,
  /^npx\s+tsc\b/,
  /^tsc\b/,
  /^(npx\s+)?vitest\b/,
  /^(npx\s+)?jest\b/,
  /^(npx\s+)?eslint\b/,
  /^(npx\s+)?prettier\b.*(--check\b|(?:^|\s)-l\b)/,
  /^node\s+--version\b/,
]

/** Split a shell command into segments on `&&`, `||`, `;`, `|`. Every segment must
 *  be independently safe for the whole command to be safe. */
function splitSegments(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** True if the segment contains any token that makes it unsafe outright. */
function hasDangerousToken(segment: string): boolean {
  return DANGEROUS_TOKEN_PATTERNS.some((re) => re.test(segment))
}

/** True if the segment's leading verb (or recognized script form) is on the safe
 *  allowlist — plain allowlisted verbs, read-only `git` subcommands, or a safe
 *  package-manager script / test-tool invocation. */
function leadingVerbSafe(segment: string): boolean {
  const leadingVerb = segment.split(/\s+/)[0]
  if ((SAFE_COMMAND_ALLOWLIST as readonly string[]).includes(leadingVerb)) return true

  if (leadingVerb === 'git') {
    const sub = segment.split(/\s+/)[1]
    if (sub && (SAFE_GIT_SUBCOMMANDS as readonly string[]).includes(sub)) return true
  }

  return SAFE_SCRIPT_PATTERNS.some((re) => re.test(segment))
}

/** Conservative, Limn-owned classifier: a command is "safe" only when every
 *  shell-separated segment is a recognized read/inspect/build/test verb with no
 *  dangerous tokens. Deny-by-default — unrecognized verbs are unsafe. */
export function isSafeCommand(cmd: string): boolean {
  const segments = splitSegments(cmd)
  if (segments.length === 0) return false
  return segments.every((segment) => !hasDangerousToken(segment) && leadingVerbSafe(segment))
}

type LadderDecision = 'allow' | 'deny' | 'ask'

/** D3(b) tier × kind decision table, for non-limn tool_use / non-read-only-deny
 *  cases. `safe` only matters for `command`. */
const TIER_TABLE: Record<ExecutionMode, { file_change: LadderDecision; commandSafe: LadderDecision; commandUnsafe: LadderDecision; tool_use: LadderDecision }> = {
  ask: { file_change: 'ask', commandSafe: 'ask', commandUnsafe: 'ask', tool_use: 'ask' },
  edits: { file_change: 'allow', commandSafe: 'ask', commandUnsafe: 'ask', tool_use: 'ask' },
  auto: { file_change: 'allow', commandSafe: 'allow', commandUnsafe: 'ask', tool_use: 'ask' },
  full: { file_change: 'allow', commandSafe: 'allow', commandUnsafe: 'allow', tool_use: 'allow' },
}

/** The one shared decision function that runs on every incoming ACP
 *  `session/request_permission`, identical for every engine (D3(b)). */
export function ladderPolicy(mode: ExecutionMode, req: ApprovalRequest, writeEnabled: boolean): LadderDecision {
  if (req.kind === 'tool_use' && isLimnTool(req.detail?.toolName)) return 'allow'
  if (writeEnabled === false && req.kind === 'file_change') return 'deny'

  const row = TIER_TABLE[mode] ?? TIER_TABLE.ask

  if (req.kind === 'file_change') return row.file_change
  if (req.kind === 'tool_use') return row.tool_use

  // req.kind === 'command'
  const safe = isSafeCommand(req.detail?.command ?? req.summary)
  return safe ? row.commandSafe : row.commandUnsafe
}
