import { describe, it, expect } from 'vitest'
import {
  encodeFrame, decodeChunk, classifyMessage, isApprovalMethod, mapApprovalDecision,
  approvalPolicyFor, sandboxPolicyFor, approvalRequestFromParams, appServerNotifToEvent,
} from '../src/main/engines/codexAppServer'

describe('NDJSON framing', () => {
  it('encodes one compact line with a trailing newline', () => {
    expect(encodeFrame({ a: 1 })).toBe('{"a":1}\n')
  })
  it('decodes complete lines, keeps the partial remainder, strips \\r + blanks', () => {
    const { messages, rest } = decodeChunk('{"x":1}\r\n\n{"y":2}\n{"part":')
    expect(messages).toEqual([{ x: 1 }, { y: 2 }])
    expect(rest).toBe('{"part":')
  })
  it('skips non-JSON diagnostic lines', () => {
    expect(decodeChunk('garbage\n{"ok":true}\n').messages).toEqual([{ ok: true }])
  })
})

describe('classifyMessage', () => {
  it('method+id = request; method = notification; id+result = response', () => {
    expect(classifyMessage({ method: 'x', id: 1 })).toBe('request')
    expect(classifyMessage({ method: 'x' })).toBe('notification')
    expect(classifyMessage({ id: 1, result: {} })).toBe('response')
    expect(classifyMessage({ id: 1, error: {} })).toBe('response')
    expect(classifyMessage({})).toBe('unknown')
  })
})

describe('approval routing + decision mapping', () => {
  it('treats approval methods as approvals, not requestUserInput/elicitation', () => {
    expect(isApprovalMethod('item/autoApprovalReview/exec')).toBe(true)
    expect(isApprovalMethod('item/requestApproval')).toBe(true)
    expect(isApprovalMethod('item/tool/requestUserInput')).toBe(false)
    expect(isApprovalMethod('mcpServer/elicitation/request')).toBe(false)
  })
  it('maps allow/deny to approved/denied', () => {
    expect(mapApprovalDecision('allow')).toBe('approved')
    expect(mapApprovalDecision('deny')).toBe('denied')
  })
})

describe('executionPolicy → app-server params', () => {
  it('maps approvalPolicy per tier', () => {
    expect(approvalPolicyFor('ask')).toBe('on-request')
    expect(approvalPolicyFor('full')).toBe('never')
  })
  it('maps sandbox per tier + write guard', () => {
    expect(sandboxPolicyFor('ask', '/repo', false)).toEqual({ type: 'readOnly', networkAccess: false })
    expect(sandboxPolicyFor('edits', '/repo', true)).toEqual({ type: 'workspaceWrite', writableRoots: ['/repo'], networkAccess: false })
    expect(sandboxPolicyFor('edits', '/repo', false)).toEqual({ type: 'readOnly', networkAccess: false }) // guard: no write → read-only
    expect(sandboxPolicyFor('full', '/repo', true)).toEqual({ type: 'dangerFullAccess' })
  })
})

describe('approvalRequestFromParams', () => {
  it('reads a command', () => {
    expect(approvalRequestFromParams('1', { command: 'npm test', cwd: '/r' }))
      .toMatchObject({ kind: 'command', summary: 'Run `npm test`', detail: { command: 'npm test', cwd: '/r' } })
  })
  it('reads a patch (changes[].path)', () => {
    expect(approvalRequestFromParams('2', { changes: [{ path: 'a.ts' }, { path: 'b.ts' }] }))
      .toMatchObject({ kind: 'patch', detail: { files: ['a.ts', 'b.ts'] } })
  })
  it('falls back to mcp_tool', () => {
    expect(approvalRequestFromParams('3', { reason: 'fetch url' })).toMatchObject({ kind: 'mcp_tool', summary: 'fetch url' })
  })
})

describe('appServerNotifToEvent', () => {
  it('maps agent_message → text and reasoning → status', () => {
    expect(appServerNotifToEvent('item/updated', { item: { type: 'agent_message', text: 'hi' } })).toEqual({ type: 'text', text: 'hi' })
    expect(appServerNotifToEvent('item/updated', { item: { type: 'reasoning', text: 'thinking' } })).toEqual({ type: 'status', text: 'thinking' })
  })
  it('ignores unmapped items', () => {
    expect(appServerNotifToEvent('item/updated', { item: { type: 'todo_list' } })).toBeNull()
  })
})
