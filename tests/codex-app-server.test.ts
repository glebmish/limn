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
  it('recognizes the v2 approval methods; auto-denies legacy + unsupported surfaces', () => {
    // verified against `codex app-server generate-ts` (0.139.0)
    expect(isApprovalMethod('item/commandExecution/requestApproval')).toBe(true)
    expect(isApprovalMethod('item/fileChange/requestApproval')).toBe(true)
    expect(isApprovalMethod('execCommandApproval')).toBe(false) // legacy → unsupported
    expect(isApprovalMethod('applyPatchApproval')).toBe(false)  // legacy → unsupported
    expect(isApprovalMethod('item/permissions/requestApproval')).toBe(false) // unsupported → auto-deny
    expect(isApprovalMethod('item/tool/requestUserInput')).toBe(false)
    expect(isApprovalMethod('mcpServer/elicitation/request')).toBe(false)
  })
  it('maps allow/deny to the v2 accept/decline vocabulary', () => {
    expect(mapApprovalDecision('allow')).toBe('accept')
    expect(mapApprovalDecision('deny')).toBe('decline')
  })
})

describe('executionPolicy → app-server params', () => {
  it('maps approvalPolicy per tier', () => {
    expect(approvalPolicyFor('ask')).toBe('on-request')
    expect(approvalPolicyFor('full')).toBe('never')
  })
  it('maps sandbox per tier + write guard', () => {
    expect(sandboxPolicyFor('ask', '/repo', false)).toEqual({ type: 'readOnly', networkAccess: false })
    expect(sandboxPolicyFor('edits', '/repo', true)).toEqual({ type: 'workspaceWrite', writableRoots: ['/repo'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false })
    expect(sandboxPolicyFor('edits', '/repo', false)).toEqual({ type: 'readOnly', networkAccess: false }) // guard: no write → read-only
    expect(sandboxPolicyFor('full', '/repo', true)).toEqual({ type: 'dangerFullAccess' })
  })
})

describe('approvalRequestFromParams', () => {
  it('reads a command + cwd (item/commandExecution/requestApproval)', () => {
    expect(approvalRequestFromParams('1', { command: 'npm test', cwd: '/r' }))
      .toMatchObject({ kind: 'command', summary: 'Run `npm test`', detail: { command: 'npm test', cwd: '/r' } })
  })
  it('falls back to file_change with the reason (fileChange carries no file list)', () => {
    expect(approvalRequestFromParams('3', { reason: 'extra write access' }))
      .toMatchObject({ kind: 'file_change', summary: 'extra write access' })
  })
})

describe('appServerNotifToEvent', () => {
  it('maps agentMessage delta → text and reasoning delta → status (by method)', () => {
    expect(appServerNotifToEvent('item/agentMessage/delta', { delta: 'hi' })).toEqual({ type: 'text', text: 'hi' })
    expect(appServerNotifToEvent('item/reasoning/textDelta', { delta: 'thinking' })).toEqual({ type: 'status', text: 'thinking' })
  })
  it('ignores unmapped notifications', () => {
    expect(appServerNotifToEvent('item/completed', { item: { type: 'agent_message' } })).toBeNull()
    expect(appServerNotifToEvent('turn/started', {})).toBeNull()
  })
})
