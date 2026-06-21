import type { ExecutionMode, ExecutionTier } from './types.js'

/** The ladder, in order, with the reviewer-facing copy (wireframe J3). */
export const EXECUTION_TIERS: ExecutionTier[] = [
  { key: 'ask', label: 'Ask for approval', desc: 'Confirm before commands and file changes.' },
  { key: 'edits', label: 'Accept edits', desc: 'Auto-apply edits; ask before other actions.' },
  { key: 'auto', label: 'Auto mode', desc: 'Only asks for actions detected as potentially unsafe.' },
  { key: 'full', label: 'Full access', desc: 'Unrestricted — network and any file.' },
]

/** What a tier means to each engine. The reviewer never sees these — the adapters
 *  translate. Codex enum strings are the intent; pin exact values from the binary
 *  (`codex app-server generate-ts`) at build time. */
export interface EnginePolicy {
  claudePermissionMode: 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions'
  codexApprovalPolicy: 'untrusted' | 'on-request' | 'on-failure' | 'never'
  codexSandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
}

const POLICY: Record<ExecutionMode, EnginePolicy> = {
  ask: { claudePermissionMode: 'default', codexApprovalPolicy: 'on-request', codexSandbox: 'read-only' },
  edits: { claudePermissionMode: 'acceptEdits', codexApprovalPolicy: 'on-request', codexSandbox: 'workspace-write' },
  auto: { claudePermissionMode: 'auto', codexApprovalPolicy: 'on-failure', codexSandbox: 'workspace-write' },
  full: { claudePermissionMode: 'bypassPermissions', codexApprovalPolicy: 'never', codexSandbox: 'danger-full-access' },
}

export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'ask'

export function isExecutionMode(v: unknown): v is ExecutionMode {
  return v === 'ask' || v === 'edits' || v === 'auto' || v === 'full'
}

/** Map a tier to its engine policy. Unknown values fall back to the safest tier. */
export function executionPolicy(mode: ExecutionMode): EnginePolicy {
  return POLICY[mode] ?? POLICY[DEFAULT_EXECUTION_MODE]
}
