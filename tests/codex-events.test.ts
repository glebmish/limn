import { describe, it, expect } from 'vitest'
import { appServerAgentMessageText, appServerItemToEvent, appServerNotifToEvent } from '../src/main/engines/codexAppServer'

// app-server notifications map Codex work into the engine-agnostic event stream.
// Tool activity is represented as a structured ToolCall with run -> ok/err
// lifecycle keyed by item.id.

describe('codex app-server events — tool-call lifecycle', () => {
  it('surfaces a started MCP tool call as a running ToolCall', () => {
    const item = { id: 'i1', type: 'mcpToolCall', server: 'limn', tool: 'add_comment', arguments: { file: 'src/a.ts' }, status: 'inProgress' }
    expect(appServerItemToEvent(item, false)).toEqual({ type: 'tool', call: { id: 'i1', verb: 'edit', name: 'add_comment', kv: [['file', 'src/a.ts']], state: 'run' } })
  })

  it('settles a completed MCP tool call as ok', () => {
    const item = { id: 'i1', type: 'mcpToolCall', server: 'limn', tool: 'add_comment', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } }
    expect(appServerItemToEvent(item, true)).toMatchObject({ type: 'tool', call: { id: 'i1', state: 'ok', out: 'ok' } })
  })

  it('reports a failed MCP tool call as err', () => {
    const item = { id: 'i1', type: 'mcpToolCall', server: 'limn', tool: 'resolve_comment', arguments: {}, status: 'failed', error: { message: 'No comment with id x' } }
    expect(appServerItemToEvent(item, true)).toMatchObject({ type: 'tool', call: { id: 'i1', state: 'err', out: 'No comment with id x' } })
  })

  it('maps command execution start -> run and completion -> ok with output', () => {
    const start = { id: 'c', type: 'commandExecution', command: 'git status', aggregatedOutput: '', status: 'inProgress' }
    expect(appServerItemToEvent(start, false)).toMatchObject({ type: 'tool', call: { id: 'c', verb: 'bash', arg: 'git status', state: 'run' } })
    const done = { id: 'c', type: 'commandExecution', command: 'git status', aggregatedOutput: 'clean', exitCode: 0, status: 'completed' }
    expect(appServerItemToEvent(done, true)).toMatchObject({ type: 'tool', call: { id: 'c', state: 'ok', out: 'clean' } })
  })

  it('maps a non-zero command exit to err', () => {
    const done = { id: 'c', type: 'commandExecution', command: 'rg foo', aggregatedOutput: 'boom', exitCode: 2, status: 'completed' }
    expect(appServerItemToEvent(done, true)).toMatchObject({ type: 'tool', call: { id: 'c', state: 'err', out: 'boom' } })
  })

  it('maps fileChange completion -> edit ok', () => {
    const item = { id: 'f', type: 'fileChange', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' }
    expect(appServerItemToEvent(item, true)).toMatchObject({ type: 'tool', call: { id: 'f', verb: 'edit', arg: 'src/a.ts', state: 'ok' } })
  })

  it('maps agent message deltas to text', () => {
    expect(appServerNotifToEvent('item/agentMessage/delta', { delta: 'done' })).toEqual({ type: 'text', text: 'done' })
  })

  it('does not emit completed agent messages as text directly', () => {
    expect(appServerNotifToEvent('item/completed', { item: { id: 'm', type: 'agentMessage', text: 'done' } })).toBeNull()
  })

  it('extracts completed agent messages from camel-case and snake-case item shapes', () => {
    expect(appServerAgentMessageText('item/completed', { item: { id: 'm', type: 'agentMessage', text: 'done' } })).toBe('done')
    expect(appServerAgentMessageText('item/completed', { item: { id: 'm', type: 'agent_message', content: [{ type: 'text', text: 'done' }] } })).toBe('done')
  })

  it('extracts structured completed agent output when the app-server provides it out-of-band', () => {
    expect(appServerAgentMessageText('item/completed', { item: { id: 'm', type: 'agent_message', structured_output: { title: 'T' } } })).toBe('{"title":"T"}')
  })
})
