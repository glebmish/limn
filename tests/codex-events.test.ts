import { describe, it, expect } from 'vitest'
import type { ThreadEvent } from '@openai/codex-sdk'
import { toEvent } from '../src/main/engines/codex'

// toEvent maps Codex ThreadEvents to our EngineEvents. wf-D makes tool activity a
// structured ToolCall with a run -> ok/err lifecycle keyed by item.id.

describe('codex toEvent — tool-call lifecycle', () => {
  it('surfaces a started MCP tool call as a running ToolCall', () => {
    const ev = { type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'localreview', tool: 'add_comment', arguments: { file: 'src/a.ts' }, status: 'in_progress' } } as unknown as ThreadEvent
    expect(toEvent(ev)).toEqual({ type: 'tool', call: { id: 'i1', verb: 'edit', name: 'add_comment', kv: [['file', 'src/a.ts']], state: 'run' } })
  })

  it('settles a completed MCP tool call as ok', () => {
    const ev = { type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'localreview', tool: 'add_comment', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } } } as unknown as ThreadEvent
    expect(toEvent(ev)).toMatchObject({ type: 'tool', call: { id: 'i1', state: 'ok', out: 'ok' } })
  })

  it('reports a failed MCP tool call as err (agent keeps going)', () => {
    const ev = { type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'localreview', tool: 'resolve_comment', arguments: {}, status: 'failed', error: { message: 'No comment with id x' } } } as unknown as ThreadEvent
    expect(toEvent(ev)).toMatchObject({ type: 'tool', call: { id: 'i1', state: 'err', out: 'No comment with id x' } })
  })

  it('does not double-report an in-progress update', () => {
    const ev = { type: 'item.updated', item: { id: 'i1', type: 'mcp_tool_call', server: 'localreview', tool: 'focus', arguments: {}, status: 'in_progress' } } as unknown as ThreadEvent
    expect(toEvent(ev)).toBeNull()
  })

  it('maps command execution start -> run and completion -> ok with output', () => {
    const start = { type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'git status', aggregated_output: '', status: 'in_progress' } } as unknown as ThreadEvent
    expect(toEvent(start)).toMatchObject({ type: 'tool', call: { id: 'c', verb: 'bash', arg: 'git status', state: 'run' } })
    const done = { type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'git status', aggregated_output: 'clean', exit_code: 0, status: 'completed' } } as unknown as ThreadEvent
    expect(toEvent(done)).toMatchObject({ type: 'tool', call: { id: 'c', state: 'ok', out: 'clean' } })
  })

  it('maps a non-zero command exit to err', () => {
    const done = { type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'rg foo', aggregated_output: 'boom', exit_code: 2, status: 'completed' } } as unknown as ThreadEvent
    expect(toEvent(done)).toMatchObject({ type: 'tool', call: { id: 'c', state: 'err', out: 'boom' } })
  })

  it('maps file_change completion -> edit ok', () => {
    const ev = { type: 'item.completed', item: { id: 'f', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' } } as unknown as ThreadEvent
    expect(toEvent(ev)).toMatchObject({ type: 'tool', call: { id: 'f', verb: 'edit', arg: 'src/a.ts', state: 'ok' } })
  })

  it('still maps agent messages to text', () => {
    const msg = { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'done' } } as unknown as ThreadEvent
    expect(toEvent(msg)).toEqual({ type: 'text', text: 'done' })
  })
})
