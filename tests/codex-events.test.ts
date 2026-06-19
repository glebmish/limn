import { describe, it, expect } from 'vitest'
import type { ThreadEvent } from '@openai/codex-sdk'
import { toEvent } from '../src/main/engines/codex'

// toEvent maps Codex ThreadEvents to our EngineEvents. Phase 6 adds the
// localreview MCP tool calls (item.type 'mcp_tool_call') + the live 'item.updated'.

describe('codex toEvent — MCP tool calls', () => {
  it('surfaces a started MCP tool call as tool activity', () => {
    const ev = { type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'localreview', tool: 'focus', arguments: {}, status: 'in_progress' } } as unknown as ThreadEvent
    expect(toEvent(ev)).toEqual({ type: 'tool', text: 'focus' })
  })

  it('does not double-report an in-progress update', () => {
    const ev = { type: 'item.updated', item: { id: 'i1', type: 'mcp_tool_call', server: 'localreview', tool: 'focus', arguments: {}, status: 'in_progress' } } as unknown as ThreadEvent
    expect(toEvent(ev)).toBeNull()
  })

  it('reports a failed MCP tool call (agent keeps going)', () => {
    const ev = { type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'localreview', tool: 'resolve_comment', arguments: {}, status: 'failed', error: { message: 'No comment with id x' } } } as unknown as ThreadEvent
    expect(toEvent(ev)).toEqual({ type: 'status', text: 'note: No comment with id x' })
  })

  it('still maps agent messages and command execution', () => {
    const msg = { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'done' } } as unknown as ThreadEvent
    expect(toEvent(msg)).toEqual({ type: 'text', text: 'done' })
    const cmd = { type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'git status' } } as unknown as ThreadEvent
    expect(toEvent(cmd)).toEqual({ type: 'tool', text: 'git status' })
  })
})
