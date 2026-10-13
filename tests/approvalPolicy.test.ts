import { describe, it, expect } from 'vitest'
import { ladderPolicy, generationLadder, isLimnTool } from '../src/shared/approvalPolicy.js'
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

describe('generationLadder (structured generation turn)', () => {
  it('allows Limn tools', () => {
    expect(generationLadder(req({ kind: 'tool_use', detail: { toolName: 'mcp__limn__focus' } }))).toBe('allow')
    expect(generationLadder(req({ kind: 'tool_use', detail: { toolName: 'mcp.limn.add_comment' } }))).toBe('allow')
  })
  it('denies every command that reaches it (the engine already auto-ran what it deems read-only; Limn never classifies)', () => {
    expect(generationLadder(req({ kind: 'command', detail: { command: 'git log --oneline' } }))).toBe('deny')
    expect(generationLadder(req({ kind: 'command', detail: { command: 'npm install left-pad' } }))).toBe('deny')
  })
  it('denies a Codex sandbox escalation (network / outside-workspace)', () => {
    expect(generationLadder(req({ engine: 'codex', kind: 'command', detail: { command: 'curl x', reason: 'requests network access' } }))).toBe('deny')
    expect(generationLadder(req({ engine: 'codex', kind: 'file_change', detail: { files: ['/etc/x'], reason: 'requests write access outside the workspace' } }))).toBe('deny')
  })
  it('denies file_change (generation explores, it does not edit the tree)', () => {
    expect(generationLadder(req({ kind: 'file_change', detail: { files: ['a.ts'] } }))).toBe('deny')
  })
  it('denies non-Limn tool_use', () => {
    expect(generationLadder(req({ kind: 'tool_use', detail: { toolName: 'WebFetch' } }))).toBe('deny')
  })
})

describe('isLimnTool', () => {
  it('recognizes mcp__limn__ prefixed tool names', () => {
    expect(isLimnTool('mcp__limn__focus')).toBe(true)
  })
  it('recognizes limn. prefixed tool names', () => {
    expect(isLimnTool('limn.read')).toBe(true)
  })
  it('recognizes codex-acp mcp.limn.<tool> titles and the bare limn server name', () => {
    expect(isLimnTool('mcp.limn.add_comment')).toBe(true)
    expect(isLimnTool('limn')).toBe(true)
  })
  it('rejects non-limn MCP tool names', () => {
    expect(isLimnTool('mcp.github.create_issue')).toBe(false)
  })
  // a match is an unconditional 'allow' at every tier, so the prefix must end at a
  // boundary: another server (or an adapter-supplied tool_call title) whose name
  // merely begins with "limn" must not ride the allow.
  it('rejects a name that merely begins with "limn"', () => {
    expect(isLimnTool('limnos')).toBe(false)
    expect(isLimnTool('limn-writer')).toBe(false)
    expect(isLimnTool('limn-writer.apply')).toBe(false)
    expect(isLimnTool('mcp__limnos__write')).toBe(false)
    expect(isLimnTool('limn the diagram')).toBe(false)
  })
  it('a look-alike server name is parked on the reviewer, not auto-allowed', () => {
    const r = req({ kind: 'tool_use', detail: { toolName: 'limn-writer' } })
    expect(ladderPolicy('ask', r, true)).toBe('ask')
    expect(generationLadder(r)).toBe('deny')
  })
  it('rejects non-limn tool names', () => {
    expect(isLimnTool('Bash')).toBe(false)
  })
  it('rejects undefined', () => {
    expect(isLimnTool(undefined)).toBe(false)
  })
})

describe('ladderPolicy — limn MCP tool always allowed, at every tier and writeEnabled setting', () => {
  const tiers: ExecutionMode[] = ['ask', 'edits', 'auto', 'full']
  for (const tier of tiers) {
    for (const writeEnabled of [true, false]) {
      it(`allows a limn tool_use at tier "${tier}" writeEnabled=${writeEnabled}`, () => {
        const r = req({ kind: 'tool_use', detail: { toolName: 'mcp__limn__focus' } })
        expect(ladderPolicy(tier, r, writeEnabled)).toBe('allow')
      })
    }
  }
})

describe('ladderPolicy — !writeEnabled denies file_change regardless of tier (capability gate, not classification)', () => {
  const tiers: ExecutionMode[] = ['ask', 'edits', 'auto', 'full']
  for (const tier of tiers) {
    it(`denies file_change at tier "${tier}" when writeEnabled=false`, () => {
      const r = req({ kind: 'file_change', detail: { files: ['a.ts'] } })
      expect(ladderPolicy(tier, r, false)).toBe('deny')
    })
  }
  it('a non-limn tool_use and a command are still just asked (not denied) when writeEnabled=false', () => {
    expect(ladderPolicy('ask', req({ kind: 'tool_use', detail: { toolName: 'Bash' } }), false)).toBe('ask')
    expect(ladderPolicy('ask', req({ kind: 'command', detail: { command: 'ls' } }), false)).toBe('ask')
  })
})

describe('ladderPolicy — full matrix: 4 tiers x 3 kinds, writeEnabled=true, non-limn tool', () => {
  const kinds: Array<{ kind: ApprovalRequest['kind']; detail: ApprovalRequest['detail'] }> = [
    { kind: 'file_change', detail: { files: ['a.ts'] } },
    { kind: 'command', detail: { command: 'rm -rf /' } },
    { kind: 'tool_use', detail: { toolName: 'Bash' } },
  ]
  const expected: Record<ExecutionMode, 'allow' | 'ask'> = {
    ask: 'ask',
    edits: 'ask',
    auto: 'ask',
    full: 'allow',
  }
  const tiers: ExecutionMode[] = ['ask', 'edits', 'auto', 'full']

  for (const tier of tiers) {
    for (const { kind, detail } of kinds) {
      it(`tier=${tier} kind=${kind} → ${expected[tier]}`, () => {
        const r = req({ kind, detail })
        expect(ladderPolicy(tier, r, true)).toBe(expected[tier])
      })
    }
  }
})

describe('ladderPolicy — a harmless-looking command still parks below full (no leniency by content)', () => {
  const tiers: ExecutionMode[] = ['ask', 'edits', 'auto']
  for (const tier of tiers) {
    it(`asks for "ls" at tier "${tier}"`, () => {
      const r = req({ kind: 'command', detail: { command: 'ls' } })
      expect(ladderPolicy(tier, r, true)).toBe('ask')
    })
  }
  it('full allows "ls" unattended', () => {
    const r = req({ kind: 'command', detail: { command: 'ls' } })
    expect(ladderPolicy('full', r, true)).toBe('allow')
  })
})

describe('ladderPolicy — full tier still denies read-only file_change (order pinned)', () => {
  it('full + writeEnabled:false + file_change → deny', () => {
    const r = req({ kind: 'file_change', detail: { files: ['a.ts'] } })
    expect(ladderPolicy('full', r, false)).toBe('deny')
  })
})

describe('ladderPolicy — unknown/undefined ExecutionMode falls back to asking (never to full-tier allow)', () => {
  it('treats an unrecognized mode as parking', () => {
    const r = req({ kind: 'command', detail: { command: 'ls' } })
    expect(ladderPolicy('bogus' as ExecutionMode, r, true)).toBe('ask')
  })
})

describe('rebase turn stays on the ask ladder (merge §6 — no policy change)', () => {
  it('ask tier parks a git-rebase command approval; full runs it unattended', () => {
    const r = req({ detail: { command: 'git rebase main' } })
    expect(ladderPolicy('ask', r, true)).toBe('ask')
    expect(ladderPolicy('full', r, true)).toBe('allow')
  })
})
