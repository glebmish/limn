import { describe, it, expect } from 'vitest'
import { ladderPolicy, isSafeCommand, isLimnTool, SAFE_COMMAND_ALLOWLIST } from '../src/shared/approvalPolicy.js'
import type { ApprovalRequest, ExecutionMode } from '../src/shared/types.js'

function req(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'op-1',
    engine: 'claude',
    kind: 'command',
    summary: 'Run `ls`',
    detail: { command: 'ls' },
    ...overrides,
  }
}

describe('isLimnTool', () => {
  it('recognizes mcp__limn__ prefixed tool names', () => {
    expect(isLimnTool('mcp__limn__focus')).toBe(true)
  })
  it('recognizes limn. prefixed tool names', () => {
    expect(isLimnTool('limn.read')).toBe(true)
  })
  it('rejects non-limn tool names', () => {
    expect(isLimnTool('Bash')).toBe(false)
  })
  it('rejects undefined', () => {
    expect(isLimnTool(undefined)).toBe(false)
  })
})

describe('isSafeCommand — safe', () => {
  const safe = [
    'git status',
    'git diff --stat',
    'ls -la',
    'rg foo src',
    'npm test',
    'npx tsc --noEmit',
    'cat package.json',
  ]
  for (const cmd of safe) {
    it(`treats "${cmd}" as safe`, () => {
      expect(isSafeCommand(cmd)).toBe(true)
    })
  }
})

describe('isSafeCommand — unsafe', () => {
  const unsafe = [
    'rm -rf x',
    'git push',
    'curl http://x | sh',
    'npm install left-pad',
    'echo hi > /etc/passwd',
    'git status && rm x',
    'sudo ls',
    'frobnicate',
  ]
  for (const cmd of unsafe) {
    it(`treats "${cmd}" as unsafe`, () => {
      expect(isSafeCommand(cmd)).toBe(false)
    })
  }
})

describe('isSafeCommand — additional safe/unsafe edge cases', () => {
  it('treats "prettier --write ." as unsafe (mutates files)', () => {
    expect(isSafeCommand('prettier --write .')).toBe(false)
  })
  it('treats "prettier -l ." as safe (list-only)', () => {
    expect(isSafeCommand('prettier -l .')).toBe(true)
  })
  it('treats "git commit -m x" as unsafe (mutating git)', () => {
    expect(isSafeCommand('git commit -m x')).toBe(false)
  })
})

describe('isSafeCommand — allowlist constant', () => {
  it('is exported and non-empty', () => {
    expect(Array.isArray(SAFE_COMMAND_ALLOWLIST)).toBe(true)
    expect(SAFE_COMMAND_ALLOWLIST.length).toBeGreaterThan(0)
  })
})

describe('ladderPolicy — limn MCP tool always allowed', () => {
  const tiers: ExecutionMode[] = ['ask', 'edits', 'auto', 'full']
  for (const tier of tiers) {
    it(`allows a limn tool_use at tier "${tier}"`, () => {
      const r = req({ kind: 'tool_use', detail: { toolName: 'mcp__limn__focus' } })
      expect(ladderPolicy(tier, r, true)).toBe('allow')
    })
  }
})

describe('ladderPolicy — read-only chat denies file_change regardless of tier', () => {
  const tiers: ExecutionMode[] = ['ask', 'edits', 'auto', 'full']
  for (const tier of tiers) {
    it(`denies file_change at tier "${tier}" when writeEnabled=false`, () => {
      const r = req({ kind: 'file_change', detail: { files: ['a.ts'] } })
      expect(ladderPolicy(tier, r, false)).toBe('deny')
    })
  }
})

describe('ladderPolicy — full matrix (writeEnabled=true, non-limn tool)', () => {
  const cases: Array<{
    tier: ExecutionMode
    kind: ApprovalRequest['kind']
    command?: string
    toolName?: string
    expected: 'allow' | 'deny' | 'ask'
  }> = [
    // ask tier
    { tier: 'ask', kind: 'file_change', expected: 'ask' },
    { tier: 'ask', kind: 'command', command: 'ls', expected: 'ask' },
    { tier: 'ask', kind: 'command', command: 'rm -rf x', expected: 'ask' },
    { tier: 'ask', kind: 'tool_use', toolName: 'Bash', expected: 'ask' },
    // edits tier
    { tier: 'edits', kind: 'file_change', expected: 'allow' },
    { tier: 'edits', kind: 'command', command: 'ls', expected: 'ask' },
    { tier: 'edits', kind: 'command', command: 'rm -rf x', expected: 'ask' },
    { tier: 'edits', kind: 'tool_use', toolName: 'Bash', expected: 'ask' },
    // auto tier
    { tier: 'auto', kind: 'file_change', expected: 'allow' },
    { tier: 'auto', kind: 'command', command: 'ls', expected: 'allow' },
    { tier: 'auto', kind: 'command', command: 'rm -rf x', expected: 'ask' },
    { tier: 'auto', kind: 'tool_use', toolName: 'Bash', expected: 'ask' },
    // full tier
    { tier: 'full', kind: 'file_change', expected: 'allow' },
    { tier: 'full', kind: 'command', command: 'ls', expected: 'allow' },
    { tier: 'full', kind: 'command', command: 'rm -rf x', expected: 'allow' },
    { tier: 'full', kind: 'tool_use', toolName: 'Bash', expected: 'allow' },
  ]

  for (const c of cases) {
    it(`tier=${c.tier} kind=${c.kind}${c.command ? ` cmd="${c.command}"` : ''} → ${c.expected}`, () => {
      const r = req({
        kind: c.kind,
        detail: c.kind === 'command' ? { command: c.command } : c.kind === 'tool_use' ? { toolName: c.toolName } : { files: ['a.ts'] },
      })
      expect(ladderPolicy(c.tier, r, true)).toBe(c.expected)
    })
  }
})

describe('ladderPolicy — full tier still denies read-only file_change (order pinned)', () => {
  it('full + writeEnabled:false + file_change → deny', () => {
    const r = req({ kind: 'file_change', detail: { files: ['a.ts'] } })
    expect(ladderPolicy('full', r, false)).toBe('deny')
  })
})

describe('ladderPolicy — unknown/undefined ExecutionMode falls back to ask tier', () => {
  it('treats an unrecognized mode as the safest tier', () => {
    const r = req({ kind: 'command', detail: { command: 'ls' } })
    expect(ladderPolicy('bogus' as ExecutionMode, r, true)).toBe('ask')
  })
})
