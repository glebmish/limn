import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isMcpToolRow, mcpToolInfo, ToolCallLog, unwrapMcpOutput } from '../src/renderer/components/ToolCallLog'
import { inferSubmittedCommentRefs, SegmentBody, SubmittedCommentRefs } from '../src/renderer/components/ChatDrawer'
import type { AgentAction, MessageSegment, ToolCall } from '../src/shared/types'

describe('ToolCallLog', () => {
  it('shows Limn MCP tool names instead of collapsing them to generic verbs', () => {
    const calls: ToolCall[] = [
      { id: 'a', verb: 'edit', name: 'mcp__limn__reply_to_comment', state: 'ok' },
      { id: 'b', verb: 'edit', name: 'Edit', arg: 'src/a.ts', state: 'ok' },
    ]

    const out = renderToStaticMarkup(<ToolCallLog calls={calls} />)

    expect(out).toContain('reply_to_comment')
    expect(out).toContain('>edit</span>')
  })

  it('titles a Codex-proxied MCP tool call by tool name, not the bash verb, and drops the server row (#12)', () => {
    const calls: ToolCall[] = [
      {
        id: 'mcp-1',
        verb: 'bash',
        name: '',
        kv: [['server', 'limn'], ['tool', 'list_comments']],
        state: 'ok',
        out: '{"result":{"content":[{"type":"text","text":"[]"}]}}',
      },
    ]

    const out = renderToStaticMarkup(<ToolCallLog calls={calls} />)

    expect(out).toContain('>list_comments</span>')
    expect(out).not.toContain('>bash</span>')
    expect(out).not.toContain('server')
    expect(out).not.toContain('limn')
  })

  it('recognizes the server+tool kv shape and strips it from the displayed kv rows (#12)', () => {
    const call: ToolCall = {
      id: 'mcp-1', verb: 'bash', name: '',
      kv: [['server', 'limn'], ['tool', 'list_comments'], ['status', 'queued']],
      state: 'ok',
    }

    expect(mcpToolInfo(call)).toEqual({ tool: 'list_comments', kv: [['status', 'queued']] })
  })

  it('does not misfire on an unrelated tool call that merely has a "tool" kv key', () => {
    const call: ToolCall = { id: 'x', verb: 'other', name: 'weird', kv: [['tool', 'x']], state: 'ok' }
    expect(mcpToolInfo(call)).toBeUndefined()
  })

  it('unwraps the MCP result envelope and pretty-prints the inner JSON payload (#13)', () => {
    const raw = '{"result":{"content":[{"type":"text","text":"[{\\"id\\":\\"c-1\\",\\"text\\":\\"hi\\"}]"}]}}'

    const result = unwrapMcpOutput(raw)

    expect(result).not.toContain('\\"')
    expect(result).toBe(JSON.stringify([{ id: 'c-1', text: 'hi' }], null, 2))
  })

  it('unwraps the envelope but leaves non-JSON inner text as plain text (still de-escaped)', () => {
    const raw = '{"result":{"content":[{"type":"text","text":"Added a comment on src/a.ts:1."}]}}'
    expect(unwrapMcpOutput(raw)).toBe('Added a comment on src/a.ts:1.')
  })

  it('falls back to the original text for non-envelope or non-JSON output, without throwing', () => {
    expect(unwrapMcpOutput('not json at all')).toBe('not json at all')
    expect(unwrapMcpOutput('{"foo":"bar"}')).toBe('{"foo":"bar"}')
    expect(unwrapMcpOutput('{"result":{"content":[]}}')).toBe('{"result":{"content":[]}}')
    expect(unwrapMcpOutput('')).toBe('')
  })

  it('leaves non-MCP tool calls (real bash) rendered as before', () => {
    const calls: ToolCall[] = [
      { id: 'b1', verb: 'bash', name: 'Bash', arg: 'npm test', kv: [['description', 'run tests']], state: 'ok' },
    ]

    const out = renderToStaticMarkup(<ToolCallLog calls={calls} />)

    expect(out).toContain('>bash</span>')
    expect(out).toContain('npm test')
    // the plain-bash row keeps the term-verb glyph, not the MCP plug's telltale path
    expect(out).not.toContain('M4.7 1.5v3.2M9.3 1.5v3.2')
  })

  it('gives MCP rows a distinct plug icon, both by direct name and by the Codex kv shape', () => {
    const calls: ToolCall[] = [
      { id: 'a', verb: 'edit', name: 'mcp__limn__reply_to_comment', state: 'ok' },
      { id: 'mcp-1', verb: 'bash', name: '', kv: [['server', 'limn'], ['tool', 'list_comments']], state: 'ok' },
    ]

    const out = renderToStaticMarkup(<ToolCallLog calls={calls} />)

    expect((out.match(/M4\.7 1\.5v3\.2M9\.3 1\.5v3\.2/g) ?? []).length).toBe(2)
  })

  it('isMcpToolRow recognizes both the direct mcp__server__tool name and the recovered kv shape', () => {
    expect(isMcpToolRow({ id: 'a', verb: 'edit', name: 'mcp__limn__reply_to_comment', state: 'ok' })).toBe(true)
    expect(isMcpToolRow({ id: 'b', verb: 'bash', name: '', kv: [['server', 'limn'], ['tool', 'x']], state: 'ok' })).toBe(true)
    expect(isMcpToolRow({ id: 'c', verb: 'bash', name: 'Bash', arg: 'npm test', state: 'ok' })).toBe(false)
    expect(isMcpToolRow({ id: 'd', verb: 'other', name: 'weird', kv: [['tool', 'x']], state: 'ok' })).toBe(false)
  })

  it('falls back to the raw text when the output is not the MCP envelope shape', () => {
    const calls: ToolCall[] = [
      { id: 'b2', verb: 'other', name: 'weird', kv: [['tool', 'x']], state: 'ok', out: 'not json at all' },
    ]

    expect(() => renderToStaticMarkup(<ToolCallLog calls={calls} />)).not.toThrow()
  })

  it('uses action cards instead of generic rows for action-producing Limn tools', () => {
    const segments: MessageSegment[] = [
      { kind: 'text', text: 'Look here.' },
      { kind: 'tool', id: 'point-1' },
      { kind: 'text', text: 'Then continue.' },
    ]
    const calls: ToolCall[] = [
      { id: 'point-1', verb: 'bash', name: 'mcp__limn__point', state: 'ok', out: 'Pointed at src/a.ts.' },
    ]
    const actions: AgentAction[] = [
      { kind: 'point', stops: [{ target: { kind: 'file', file: 'src/a.ts' } }] },
    ]

    const out = renderToStaticMarkup(<SegmentBody segments={segments} calls={calls} actions={actions} />)

    expect(out.indexOf('Look here.')).toBeLessThan(out.indexOf('Jump to'))
    expect(out.indexOf('Jump to')).toBeLessThan(out.indexOf('Then continue.'))
    expect(out).toContain('a.ts')
    expect(out).not.toContain('class="tcall-verb">point</span>')
  })

  it('uses an action chip instead of a generic row for update_plan_status', () => {
    const segments: MessageSegment[] = [
      { kind: 'tool', id: 'plan-1' },
    ]
    const calls: ToolCall[] = [
      { id: 'plan-1', verb: 'bash', name: 'mcp__limn__update_plan_status', state: 'ok', out: 'Updated plan item 0.' },
    ]
    const actions: AgentAction[] = [
      { kind: 'plan_status_updated', index: 0, met: true },
    ]

    const out = renderToStaticMarkup(<SegmentBody segments={segments} calls={calls} actions={actions} />)

    expect(out).toContain('updated plan status')
    expect(out).not.toContain('update_plan_status')
  })

  it('renders submitted comment references as clickable visual cards', () => {
    const out = renderToStaticMarkup(
      <SubmittedCommentRefs commentRefs={['c1']} comments={[{
        id: 'c1',
        author: 'user',
        text: 'Spell out the risk.',
        status: 'sent',
        replies: [],
        iteration: 1,
        createdAt: 'T1',
        anchor: { kind: 'diff', file: 'src/shared/executionMode.ts', side: 'new', line: 8, hunkRange: '@@', lineContent: 'x' }
      }]} />
    )

    expect(out).toContain('Submitted')
    expect(out).toContain('executionMode.ts:8')
    expect(out).toContain('Spell out the risk.')
    expect(out).toContain('button')
  })

  it('infers refs for older bare batch submission messages from following actions', () => {
    expect(inferSubmittedCommentRefs([
      { role: 'user', text: 'Handle 3 comment(s).' },
      {
        role: 'agent',
        text: 'done',
        actions: [
          { kind: 'comment_resolved', commentId: 'c1', anchor: { kind: 'file', file: 'src/a.ts' }, verdict: 'addressed', note: 'done' },
          { kind: 'comment_replied', commentId: 'c2', anchor: { kind: 'file', file: 'src/b.ts' }, reply: { author: 'agent', text: 'ok', at: 'T1' } },
          { kind: 'comment_resolved', commentId: 'c1', anchor: { kind: 'file', file: 'src/a.ts' }, verdict: 'addressed', note: 'done' },
        ]
      }
    ], 0)).toEqual(['c1', 'c2'])
  })
})
