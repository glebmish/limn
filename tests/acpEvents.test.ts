import { describe, it, expect } from 'vitest'
import type { RequestPermissionRequest, SessionUpdate } from '@agentclientprotocol/sdk'
import { acpToEvents, acpPermissionToRequest, verbOf } from '../src/main/engines/acpEvents'

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
      plan: { type: 'items', id: 'p1', entries: [{ content: 'step', priority: 'low', status: 'pending' }] }
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
    ['plan_removed', { sessionUpdate: 'plan_removed', id: 'p1' }],
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

  it('normalizes a tool call carrying a diff content block (no kind) to kind file_change', () => {
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
      detail: { files: ['/repo/src/b.ts'] }
    })
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
