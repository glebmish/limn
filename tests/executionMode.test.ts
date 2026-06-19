import { describe, it, expect } from 'vitest'
import { executionPolicy, EXECUTION_TIERS, isExecutionMode } from '../src/shared/executionMode'
import type { ExecutionMode } from '../src/shared/types'

describe('executionPolicy', () => {
  it.each([
    ['ask', 'default', 'on-request', 'read-only'],
    ['edits', 'acceptEdits', 'on-request', 'workspace-write'],
    ['auto', 'auto', 'on-failure', 'workspace-write'],
    ['full', 'bypassPermissions', 'never', 'danger-full-access'],
  ] as const)('%s → claude=%s codex=%s sandbox=%s', (mode, pm, ap, sb) => {
    const p = executionPolicy(mode as ExecutionMode)
    expect(p.claudePermissionMode).toBe(pm)
    expect(p.codexApprovalPolicy).toBe(ap)
    expect(p.codexSandbox).toBe(sb)
  })

  it('falls back to ask for an unknown mode', () => {
    expect(executionPolicy('bogus' as ExecutionMode)).toEqual(executionPolicy('ask'))
  })
})

describe('EXECUTION_TIERS', () => {
  it('lists the four tiers in ladder order with labels', () => {
    expect(EXECUTION_TIERS.map((t) => t.key)).toEqual(['ask', 'edits', 'auto', 'full'])
    expect(EXECUTION_TIERS.map((t) => t.label)).toEqual([
      'Ask for approval', 'Accept edits', 'Auto mode', 'Full access',
    ])
  })
})

describe('isExecutionMode', () => {
  it('guards valid + invalid values', () => {
    expect(isExecutionMode('ask')).toBe(true)
    expect(isExecutionMode('full')).toBe(true)
    expect(isExecutionMode('nope')).toBe(false)
    expect(isExecutionMode(undefined)).toBe(false)
  })
})
