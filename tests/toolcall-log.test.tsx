import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToolCallLog } from '../src/renderer/components/ToolCallLog'
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

  it('uses action cards instead of generic rows for action-producing Limn tools', () => {
    const segments: MessageSegment[] = [
      { kind: 'text', text: 'Look here.' },
      { kind: 'tool', id: 'focus-1' },
      { kind: 'text', text: 'Then continue.' },
    ]
    const calls: ToolCall[] = [
      { id: 'focus-1', verb: 'bash', name: 'mcp__limn__focus', state: 'ok', out: 'Focused src/a.ts.' },
    ]
    const actions: AgentAction[] = [
      { kind: 'focus', anchor: { kind: 'file', file: 'src/a.ts' } },
    ]

    const out = renderToStaticMarkup(<SegmentBody segments={segments} calls={calls} actions={actions} />)

    expect(out.indexOf('Look here.')).toBeLessThan(out.indexOf('Jump to'))
    expect(out.indexOf('Jump to')).toBeLessThan(out.indexOf('Then continue.'))
    expect(out).toContain('a.ts')
    expect(out).not.toContain('class="tcall-verb">focus</span>')
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
