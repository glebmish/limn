import { describe, it, expect } from 'vitest'
import type { RequestPermissionRequest, SessionUpdate } from '@agentclientprotocol/sdk'
import { acpToEvents, acpPermissionToRequest, verbOf } from '../src/server/engines/acpEvents'

// Pure ACP session/update -> EngineEvent mapper. One event per update (folding
// pending->completed by id is downstream, in reduceToolCalls) — mirrors the
// per-message shape of claude.ts's toEvents, which this mapper replaces
// (spec.md §D2), same as the app-server's now-deleted appServerNotifToEvent did.

describe('acpToEvents — text / thought / plan chunks', () => {
  it('maps agent_message_chunk to a text event', () => {
    const update: SessionUpdate = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello there' } }
    expect(acpToEvents(update)).toEqual([{ type: 'text', text: 'hello there' }])
  })

  it('maps agent_thought_chunk to a clamped status event', () => {
    const long = 'x'.repeat(300)
    const update: SessionUpdate = { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: long } }
    const events = acpToEvents(update)
    expect(events).toEqual([{ type: 'status', text: long.slice(0, 160) }])
    expect((events[0] as { text: string }).text.length).toBe(160)
  })

  it('maps plan to a status event with the entry count', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'plan',
      entries: [
        { content: 'read files', priority: 'high', status: 'pending' },
        { content: 'write patch', priority: 'medium', status: 'pending' }
      ]
    }
    expect(acpToEvents(update)).toEqual([{ type: 'status', text: 'plan: 2 steps' }])
  })

  it('maps plan_update (items) to a status event with the entry count', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'plan_update',
      plan: { type: 'items', planId: 'p1', entries: [{ content: 'step', priority: 'low', status: 'pending' }] }
    }
    expect(acpToEvents(update)).toEqual([{ type: 'status', text: 'plan: 1 steps' }])
  })
})

describe('acpToEvents — tool_call (new call)', () => {
  it('maps an execute-kind call to a bash verb with a clamped command arg', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Run tests',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'npm test' }
    }
    expect(acpToEvents(update)).toEqual([
      { type: 'tool', call: { id: 't1', verb: 'bash', name: 'Run tests', arg: 'npm test', kv: [['command', 'npm test']], state: 'run' } }
    ])
  })

  it('maps a read-kind call to verb read, preferring locations[0].path as arg', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'Read file',
      kind: 'read',
      status: 'in_progress',
      rawInput: { file_path: '/repo/src/a.ts' },
      locations: [{ path: '/repo/src/a.ts' }]
    }
    expect(acpToEvents(update)).toEqual([
      { type: 'tool', call: { id: 't2', verb: 'read', name: 'Read file', arg: '/repo/src/a.ts', kv: [['file_path', '/repo/src/a.ts']], state: 'run' } }
    ])
  })

  it('maps an edit-kind call to verb edit', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't3',
      title: 'Edit file',
      kind: 'edit',
      rawInput: { path: '/repo/src/b.ts', old_string: 'a', new_string: 'b' }
    }
    const events = acpToEvents(update)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'tool', call: { id: 't3', verb: 'edit', name: 'Edit file', arg: '/repo/src/b.ts', state: 'run' } })
  })

  it('falls back to deriveVerb(title) for an other-kind call', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't4',
      title: 'list_comments',
      kind: 'other'
    }
    expect(acpToEvents(update)).toEqual([
      { type: 'tool', call: { id: 't4', verb: 'list', name: 'list_comments', state: 'run' } }
    ])
  })

  it('falls back to deriveVerb(title) when kind is undefined', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't5',
      title: 'grep'
    }
    expect(acpToEvents(update)).toEqual([
      { type: 'tool', call: { id: 't5', verb: 'grep', name: 'grep', state: 'run' } }
    ])
  })

  it('omits arg/kv when rawInput is absent', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't6',
      title: 'Think',
      kind: 'think'
    }
    expect(acpToEvents(update)).toEqual([
      { type: 'tool', call: { id: 't6', verb: 'other', name: 'Think', state: 'run' } }
    ])
  })

  it('caps a long kv value — a Write\'s whole file body never lands on the event', () => {
    const body = 'x'.repeat(200_000)
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't7',
      title: 'Write',
      kind: 'edit',
      rawInput: { file_path: '/repo/a.ts', content: body }
    }
    const call = (acpToEvents(update)[0] as { call: { kv: [string, string][] } }).call
    expect(call.kv).toEqual([
      ['file_path', '/repo/a.ts'],
      ['content', 'x'.repeat(500) + '…']
    ])
  })

  it('leaves a short kv value untouched (no truncation marker)', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't8',
      title: 'Write',
      kind: 'edit',
      rawInput: { file_path: '/repo/a.ts', content: 'short body' }
    }
    const call = (acpToEvents(update)[0] as { call: { kv: [string, string][] } }).call
    expect(call.kv).toEqual([
      ['file_path', '/repo/a.ts'],
      ['content', 'short body']
    ])
  })
})

describe('acpToEvents — tool_call_update', () => {
  it('maps a completed update to state ok with clamped text-content output', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'all tests passed' } }]
    }
    expect(acpToEvents(update)).toEqual([
      { type: 'tool', call: { id: 't1', state: 'ok', verb: 'other', name: '', out: 'all tests passed' } }
    ])
  })

  it('falls back to stringified rawOutput when there is no text content', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      rawOutput: { exitCode: 0 }
    }
    expect(acpToEvents(update)).toEqual([
      { type: 'tool', call: { id: 't1', state: 'ok', verb: 'other', name: '', out: '{"exitCode":0}' } }
    ])
  })

  it('maps a failed update to state err', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'boom' } }]
    }
    expect(acpToEvents(update)).toEqual([
      { type: 'tool', call: { id: 't1', state: 'err', verb: 'other', name: '', out: 'boom' } }
    ])
  })

  it('maps a diff content block to verb edit with the path and file count', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't7',
      status: 'completed',
      content: [{ type: 'diff', path: '/repo/src/c.ts', oldText: 'old', newText: 'new' }]
    }
    expect(acpToEvents(update)).toEqual([
      { type: 'tool', call: { id: 't7', verb: 'edit', name: 'file_change', arg: '/repo/src/c.ts', meta: '1 file', state: 'ok' } }
    ])
  })

  it('maps a diff content block that FAILED to verb edit with state err', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't7',
      status: 'failed',
      content: [{ type: 'diff', path: '/repo/src/c.ts', oldText: 'old', newText: 'new' }]
    }
    expect(acpToEvents(update)).toEqual([
      { type: 'tool', call: { id: 't7', verb: 'edit', name: 'file_change', arg: '/repo/src/c.ts', meta: '1 file', state: 'err' } }
    ])
  })

  it('a diff update that is not yet completed folds as running', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't7',
      status: 'in_progress',
      content: [{ type: 'diff', path: '/repo/src/c.ts', oldText: 'old', newText: 'new' }]
    }
    expect(acpToEvents(update)).toEqual([
      { type: 'tool', call: { id: 't7', verb: 'edit', name: 'file_change', arg: '/repo/src/c.ts', meta: '1 file', state: 'run' } }
    ])
  })

  it('folds a sparse pending/in_progress update as a running update carrying only id (+ name if present)', () => {
    const bare: SessionUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 't8', status: 'pending' }
    expect(acpToEvents(bare)).toEqual([
      { type: 'tool', call: { id: 't8', verb: 'other', name: '', state: 'run' } }
    ])

    const withTitle: SessionUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 't9', status: 'in_progress', title: 'Still running' }
    expect(acpToEvents(withTitle)).toEqual([
      { type: 'tool', call: { id: 't9', verb: 'other', name: 'Still running', state: 'run' } }
    ])
  })

  it('folds an update with no status at all (only toolCallId) as running', () => {
    const bare: SessionUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 't10' }
    expect(acpToEvents(bare)).toEqual([
      { type: 'tool', call: { id: 't10', verb: 'other', name: '', state: 'run' } }
    ])
  })
})

describe('acpToEvents — ignored discriminators', () => {
  const cases: [string, SessionUpdate][] = [
    ['current_mode_update', { sessionUpdate: 'current_mode_update', currentModeId: 'default' }],
    ['available_commands_update', { sessionUpdate: 'available_commands_update', availableCommands: [] }],
    ['usage_update', { sessionUpdate: 'usage_update', used: 0, size: 0 }],
    ['config_option_update', { sessionUpdate: 'config_option_update', configOptions: [] }],
    ['session_info_update', { sessionUpdate: 'session_info_update' }],
    ['plan_removed', { sessionUpdate: 'plan_removed', planId: 'p1' }],
    ['user_message_chunk', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } }]
  ]
  for (const [name, update] of cases) {
    it(`ignores ${name}`, () => {
      expect(acpToEvents(update)).toEqual([])
    })
  }
})

describe('verbOf — full ToolKind coverage', () => {
  it('maps every ToolKind to the expected verb', () => {
    expect(verbOf('read', 'x')).toBe('read')
    expect(verbOf('search', 'x')).toBe('grep')
    expect(verbOf('edit', 'x')).toBe('edit')
    expect(verbOf('delete', 'x')).toBe('edit')
    expect(verbOf('move', 'x')).toBe('edit')
    expect(verbOf('execute', 'x')).toBe('bash')
    expect(verbOf('think', 'list_comments')).toBe('list')
    expect(verbOf('fetch', 'grep')).toBe('grep')
    expect(verbOf('switch_mode', 'unknown_thing')).toBe('other')
    expect(verbOf('other', 'ls')).toBe('list')
    expect(verbOf(undefined, 'cat')).toBe('read')
  })
})

describe('acpPermissionToRequest', () => {
  it('normalizes an execute tool call to kind command with the command in detail', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'tc1', kind: 'execute', title: 'Run npm test', rawInput: { command: 'npm test' } },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
      ]
    }
    const result = acpPermissionToRequest(req, 'claude')
    expect(result).toEqual({
      id: 'tc1',
      engine: 'claude',
      kind: 'command',
      summary: 'Run `npm test`',
      detail: { command: 'npm test' }
    })
  })

  it('normalizes an edit tool call to kind file_change with files from locations', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'tc2', kind: 'edit', title: 'Edit file', locations: [{ path: '/repo/src/a.ts' }] },
      options: []
    }
    const result = acpPermissionToRequest(req, 'codex')
    expect(result).toEqual({
      id: 'tc2',
      engine: 'codex',
      kind: 'file_change',
      summary: 'Edit /repo/src/a.ts',
      detail: { files: ['/repo/src/a.ts'] }
    })
  })

  it('normalizes a tool call carrying a diff content block (no kind) to kind file_change, with old/new text in detail.diffs', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: {
        toolCallId: 'tc3',
        title: 'Apply patch',
        content: [{ type: 'diff', path: '/repo/src/b.ts', oldText: 'x', newText: 'y' }]
      },
      options: []
    }
    const result = acpPermissionToRequest(req, 'claude')
    expect(result).toEqual({
      id: 'tc3',
      engine: 'claude',
      kind: 'file_change',
      summary: 'Edit /repo/src/b.ts',
      detail: { files: ['/repo/src/b.ts'], diffs: [{ path: '/repo/src/b.ts', oldText: 'x', newText: 'y' }] }
    })
  })

  it('an add-file diff (no oldText) omits oldText from detail.diffs', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: {
        toolCallId: 'tc3b',
        title: 'Apply patch',
        content: [{ type: 'diff', path: '/repo/src/new.ts', newText: 'brand new file' }]
      },
      options: []
    }
    const result = acpPermissionToRequest(req, 'claude')
    expect(result.detail).toEqual({ files: ['/repo/src/new.ts'], diffs: [{ path: '/repo/src/new.ts', newText: 'brand new file' }] })
  })

  it('truncates an oversized diff text and marks it truncated', () => {
    const huge = 'x'.repeat(5000)
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: {
        toolCallId: 'tc3c',
        title: 'Apply patch',
        content: [{ type: 'diff', path: '/repo/src/big.ts', oldText: 'short', newText: huge }]
      },
      options: []
    }
    const result = acpPermissionToRequest(req, 'claude')
    const newText = result.detail?.diffs?.[0]?.newText ?? ''
    expect(newText.length).toBeLessThan(5000)
    expect(newText.endsWith('(truncated)')).toBe(true)
  })

  it('codex-acp style: bare edit toolCall with no content/locations falls back to a correlated toolDiffs entry', () => {
    // Mirrors codex-acp's buildFileChangePermissionRequest, which sends only
    // { toolCallId, kind: 'edit', status: 'pending' } — the diff was already
    // reported via a preceding tool_call (item/started) session/update, which
    // acp.ts stashes into `toolDiffs` keyed by the same toolCallId.
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'tc-codex-1', kind: 'edit', status: 'pending' },
      options: []
    }
    const toolDiffs = new Map([['tc-codex-1', [{ path: '/repo/src/c.ts', oldText: 'a', newText: 'b' }]]])
    const result = acpPermissionToRequest(req, 'codex', undefined, toolDiffs)
    expect(result).toEqual({
      id: 'tc-codex-1',
      engine: 'codex',
      kind: 'file_change',
      summary: 'Edit /repo/src/c.ts',
      detail: { files: ['/repo/src/c.ts'], diffs: [{ path: '/repo/src/c.ts', oldText: 'a', newText: 'b' }] }
    })
  })

  it('an edit toolCall with locations but no diff content still uses the correlated toolDiffs entry (fallback fires on empty own-diff, not empty locations)', () => {
    // Some engines send locations (so `files` is already non-empty) but never
    // put the actual diff content on the permission-request's own toolCall —
    // the old `locationPaths.length === 0` guard would skip correlation here
    // and the reviewer would see the path with no diff preview at all.
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'tc-loc-1', kind: 'edit', status: 'pending', locations: [{ path: '/repo/src/d.ts' }] },
      options: []
    }
    const toolDiffs = new Map([['tc-loc-1', [{ path: '/repo/src/d.ts', oldText: 'a', newText: 'b' }]]])
    const result = acpPermissionToRequest(req, 'codex', undefined, toolDiffs)
    expect(result).toEqual({
      id: 'tc-loc-1',
      engine: 'codex',
      kind: 'file_change',
      summary: 'Edit /repo/src/d.ts',
      detail: { files: ['/repo/src/d.ts'], diffs: [{ path: '/repo/src/d.ts', oldText: 'a', newText: 'b' }] }
    })
  })

  it('a bare edit toolCall with no correlated toolDiffs entry falls back to the title, still renders defensively', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'tc-mystery', kind: 'edit', status: 'pending', title: 'Editing files' },
      options: []
    }
    const result = acpPermissionToRequest(req, 'codex')
    expect(result).toEqual({
      id: 'tc-mystery',
      engine: 'codex',
      kind: 'file_change',
      summary: 'Edit Editing files',
      detail: { files: [] }
    })
  })

  it('caps a huge multi-file diff at 20 files and surfaces the omitted count as detail.moreFiles', () => {
    const blocks = Array.from({ length: 25 }, (_, i) => ({
      type: 'diff' as const, path: `/repo/src/f${i}.ts`, oldText: 'old', newText: 'new'
    }))
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'tc-many', title: 'Apply patch', content: blocks },
      options: []
    }
    const result = acpPermissionToRequest(req, 'claude')
    expect(result.detail?.diffs).toHaveLength(20)
    expect(result.detail?.moreFiles).toBe(5)
    expect(result.detail?.files).toHaveLength(25) // paths themselves aren't capped, only the diff bodies
  })

  it('does not set detail.moreFiles when the file count is within the cap', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: {
        toolCallId: 'tc-few',
        title: 'Apply patch',
        content: [{ type: 'diff', path: '/repo/src/one.ts', oldText: 'a', newText: 'b' }]
      },
      options: []
    }
    const result = acpPermissionToRequest(req, 'claude')
    expect(result.detail?.moreFiles).toBeUndefined()
  })

  it('normalizes a plain tool call to kind tool_use with toolName', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'tc4', title: 'add_comment', kind: 'other' },
      options: []
    }
    const result = acpPermissionToRequest(req, 'claude')
    expect(result).toEqual({
      id: 'tc4',
      engine: 'claude',
      kind: 'tool_use',
      summary: 'Use add_comment',
      detail: { toolName: 'add_comment' }
    })
  })
})

describe('acpPermissionToRequest — codex-acp MCP tool approvals (_meta.is_mcp_tool_approval)', () => {
  // codex-acp forwards MCP-server tool approvals with kind 'execute' and NO
  // title/command; without the _meta marker they would classify as an empty
  // "Run ``" command and Limn's own tools would never auto-allow.

  it('correlated shape: no title/rawInput — recovers the tool name from the seen tool_call', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'mcp1', kind: 'execute', status: 'pending' },
      _meta: { is_mcp_tool_approval: true },
      options: []
    }
    const titles = new Map([['mcp1', 'mcp.limn.add_comment']])
    const result = acpPermissionToRequest(req, 'codex', titles)
    expect(result).toEqual({
      id: 'mcp1',
      engine: 'codex',
      kind: 'tool_use',
      summary: 'Use mcp.limn.add_comment',
      detail: { toolName: 'mcp.limn.add_comment' }
    })
  })

  it('uncorrelated fallback shape: falls back to rawInput.serverName', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: {
        toolCallId: 'elicitation-limn',
        kind: 'execute',
        status: 'pending',
        content: [{ type: 'content', content: { type: 'text', text: 'Allow tool?' } }],
        rawInput: { serverName: 'limn', schema: {} }
      },
      _meta: { is_mcp_tool_approval: true },
      options: []
    }
    const result = acpPermissionToRequest(req, 'codex')
    expect(result).toEqual({
      id: 'elicitation-limn',
      engine: 'codex',
      kind: 'tool_use',
      summary: 'Use limn',
      detail: { toolName: 'limn' }
    })
  })

  it('non-limn MCP tool still gets a meaningful tool_use summary (not "Run ``")', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'mcp2', kind: 'execute', status: 'pending' },
      _meta: { is_mcp_tool_approval: true },
      options: []
    }
    const titles = new Map([['mcp2', 'mcp.github.create_issue']])
    const result = acpPermissionToRequest(req, 'codex', titles)
    expect(result.kind).toBe('tool_use')
    expect(result.summary).toBe('Use mcp.github.create_issue')
    expect(result.detail).toEqual({ toolName: 'mcp.github.create_issue' })
  })

  it('an MCP approval with no recoverable name still summarizes as an MCP tool', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'mystery', kind: 'execute', status: 'pending' },
      _meta: { is_mcp_tool_approval: true },
      options: []
    }
    const result = acpPermissionToRequest(req, 'codex')
    expect(result.kind).toBe('tool_use')
    expect(result.summary).toBe('Use MCP tool')
  })

  it('a plain execute request WITHOUT the marker still classifies as a command', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'sh1', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } },
      options: []
    }
    const result = acpPermissionToRequest(req, 'codex', new Map([['sh1', 'ls']]))
    expect(result.kind).toBe('command')
    expect(result.detail).toEqual({ command: 'ls' })
  })
})

describe('acpPermissionToRequest — codex-acp escalation justification (_meta.codex.params)', () => {
  // codex-acp attaches the raw permission params it decided to surface as
  // `_meta.codex.params` on every permission request. For a `require_escalated`
  // command, `params.justification` is the model's own user-facing question —
  // Limn maps it straight into `detail.reason`, no re-classification of its own.

  it('maps a non-empty justification to detail.reason on a command request', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'esc1', kind: 'execute', title: 'Run rm -rf build', rawInput: { command: 'rm -rf build' } },
      _meta: { codex: { params: { justification: 'Need to clear the stale build dir before rebuilding.' } } },
      options: []
    }
    const result = acpPermissionToRequest(req, 'codex')
    expect(result.detail?.reason).toBe('Need to clear the stale build dir before rebuilding.')
  })

  it('leaves detail.reason unset when _meta.codex.params has no justification', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'esc2', kind: 'execute', title: 'Run npm test', rawInput: { command: 'npm test' } },
      _meta: { codex: { params: {} } },
      options: []
    }
    const result = acpPermissionToRequest(req, 'codex')
    expect(result.detail?.reason).toBeUndefined()
  })

  it('leaves detail.reason unset when justification is an empty string', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'esc3', kind: 'execute', title: 'Run npm test', rawInput: { command: 'npm test' } },
      _meta: { codex: { params: { justification: '' } } },
      options: []
    }
    const result = acpPermissionToRequest(req, 'codex')
    expect(result.detail?.reason).toBeUndefined()
  })

  it('leaves detail.reason unset when justification is not a string', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'esc4', kind: 'execute', title: 'Run npm test', rawInput: { command: 'npm test' } },
      _meta: { codex: { params: { justification: 42 } } },
      options: []
    }
    const result = acpPermissionToRequest(req, 'codex')
    expect(result.detail?.reason).toBeUndefined()
  })

  it('leaves detail.reason unset when _meta is absent entirely', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'esc5', kind: 'execute', title: 'Run npm test', rawInput: { command: 'npm test' } },
      options: []
    }
    const result = acpPermissionToRequest(req, 'codex')
    expect(result.detail?.reason).toBeUndefined()
  })

  it('also maps justification for a non-command (tool_use) request', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'esc6', title: 'add_comment', kind: 'other' },
      _meta: { codex: { params: { justification: 'Need to leave a note on the risky change.' } } },
      options: []
    }
    const result = acpPermissionToRequest(req, 'codex')
    expect(result.kind).toBe('tool_use')
    expect(result.detail?.reason).toBe('Need to leave a note on the risky change.')
  })

  // codex-acp's file-change permission requests carry `params.grantRoot` (the
  // same field it reads to label its own "Allow Root for Session" option —
  // dist/index.js's buildFileChangeOptions) and its command-execution requests
  // carry `params.networkApprovalContext` (same idea, "Allow Host for
  // Session" — buildCommandOptions). Neither is a justification string, but
  // both are still a reason worth stating when the model didn't give one.

  it('states a grantRoot file-change escalation with no justification as a write-outside-workspace reason', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'esc7', kind: 'edit', title: 'Edit /etc/hosts' },
      _meta: { codex: { params: { grantRoot: true } } },
      options: []
    }
    const result = acpPermissionToRequest(req, 'codex')
    expect(result.detail?.reason).toBe('requests write access outside the workspace')
  })

  it('states a networkApprovalContext command escalation with no justification as a network-access reason', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'esc8', kind: 'execute', title: 'Run curl', rawInput: { command: 'curl example.com' } },
      _meta: { codex: { params: { networkApprovalContext: { host: 'example.com' } } } },
      options: []
    }
    const result = acpPermissionToRequest(req, 'codex')
    expect(result.detail?.reason).toBe('requests network access')
  })

  it('a present justification still wins over grantRoot/networkApprovalContext', () => {
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'esc9', kind: 'edit', title: 'Edit /etc/hosts' },
      _meta: { codex: { params: { grantRoot: true, justification: 'Need to fix the hosts file.' } } },
      options: []
    }
    const result = acpPermissionToRequest(req, 'codex')
    expect(result.detail?.reason).toBe('Need to fix the hosts file.')
  })

  it('caps a long justification at 280 characters with a trailing ellipsis', () => {
    const long = 'x'.repeat(281)
    const req: RequestPermissionRequest = {
      sessionId: 's1',
      toolCall: { toolCallId: 'esc10', kind: 'execute', title: 'Run npm test', rawInput: { command: 'npm test' } },
      _meta: { codex: { params: { justification: long } } },
      options: []
    }
    const result = acpPermissionToRequest(req, 'codex')
    expect(result.detail?.reason).toBe('x'.repeat(280) + '…')
    expect(result.detail?.reason?.length).toBe(281)
  })
})
