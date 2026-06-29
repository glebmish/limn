import { describe, it, expect } from 'vitest'
import { reduceToolCalls, reduceSegments, deriveVerb, deriveMeta, clampOut, bashArg } from '../src/shared/toolcalls'
import type { EngineEvent } from '../src/shared/types'

describe('reduceToolCalls', () => {
  it('upserts by id — completion replaces the running entry', () => {
    const events: EngineEvent[] = [
      { type: 'tool', call: { id: 'a', verb: 'grep', name: 'Grep', arg: 'foo', state: 'run' } },
      { type: 'status', text: 'thinking' },
      { type: 'tool', call: { id: 'a', verb: 'grep', name: 'Grep', arg: 'foo', state: 'ok', meta: '6 hits', out: 'x' } },
    ]
    const calls = reduceToolCalls(events)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ id: 'a', state: 'ok', meta: '6 hits', out: 'x' })
  })

  it('keeps run identity (verb/name/arg) sticky when completion omits it', () => {
    const events: EngineEvent[] = [
      { type: 'tool', call: { id: 'a', verb: 'read', name: 'Read', arg: 'src/a.ts', state: 'run' } },
      { type: 'tool', call: { id: 'a', verb: 'other', name: '', state: 'ok', out: 'body' } },
    ]
    expect(reduceToolCalls(events)[0]).toMatchObject({ id: 'a', verb: 'read', name: 'Read', arg: 'src/a.ts', state: 'ok', out: 'body' })
  })

  it('preserves first-seen order across multiple calls', () => {
    const events: EngineEvent[] = [
      { type: 'tool', call: { id: 'a', verb: 'read', name: 'Read', state: 'run' } },
      { type: 'tool', call: { id: 'b', verb: 'grep', name: 'Grep', state: 'run' } },
      { type: 'tool', call: { id: 'a', verb: 'read', name: 'Read', state: 'ok' } },
    ]
    expect(reduceToolCalls(events).map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('ignores non-tool events', () => {
    expect(reduceToolCalls([{ type: 'text', text: 'hi' }, { type: 'done' }])).toEqual([])
  })

  it('keeps a still-running call as run when no completion arrives', () => {
    expect(reduceToolCalls([{ type: 'tool', call: { id: 'a', verb: 'grep', name: 'Grep', state: 'run' } }])[0].state).toBe('run')
  })
})

describe('reduceSegments', () => {
  it('preserves interleaved text/tool/text/tool order', () => {
    const events: EngineEvent[] = [
      { type: 'text', text: 'Looking…' },
      { type: 'tool', call: { id: 'a', verb: 'read', name: 'Read', state: 'run' } },
      { type: 'text', text: 'Found it.' },
      { type: 'tool', call: { id: 'b', verb: 'grep', name: 'Grep', state: 'run' } },
    ]
    expect(reduceSegments(events)).toEqual([
      { kind: 'text', text: 'Looking…' },
      { kind: 'tool', id: 'a' },
      { kind: 'text', text: 'Found it.' },
      { kind: 'tool', id: 'b' },
    ])
  })

  it('coalesces consecutive text deltas into one segment', () => {
    const events: EngineEvent[] = [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
      { type: 'status', text: 'thinking' },
      { type: 'text', text: '!' },
    ]
    expect(reduceSegments(events)).toEqual([{ kind: 'text', text: 'Hello world!' }])
  })

  it('emits one tool segment for a run+ok pair (dedupe by id)', () => {
    const events: EngineEvent[] = [
      { type: 'tool', call: { id: 'a', verb: 'grep', name: 'Grep', state: 'run' } },
      { type: 'tool', call: { id: 'a', verb: 'grep', name: 'Grep', state: 'ok', out: 'x' } },
    ]
    expect(reduceSegments(events)).toEqual([{ kind: 'tool', id: 'a' }])
  })

  it('preserves a leading tool followed by text', () => {
    const events: EngineEvent[] = [
      { type: 'tool', call: { id: 'a', verb: 'read', name: 'Read', state: 'run' } },
      { type: 'text', text: 'done' },
    ]
    expect(reduceSegments(events)).toEqual([
      { kind: 'tool', id: 'a' },
      { kind: 'text', text: 'done' },
    ])
  })

  it('skips empty / whitespace-only text segments', () => {
    const events: EngineEvent[] = [
      { type: 'text', text: '   ' },
      { type: 'tool', call: { id: 'a', verb: 'read', name: 'Read', state: 'run' } },
    ]
    expect(reduceSegments(events)).toEqual([{ kind: 'tool', id: 'a' }])
  })

  it('preserves action events at their streamed position', () => {
    const events: EngineEvent[] = [
      { type: 'text', text: 'Before.' },
      { type: 'action', action: { kind: 'focus', anchor: { kind: 'file', file: 'src/a.ts' } } },
      { type: 'text', text: 'After.' },
      { type: 'action', action: { kind: 'comment_resolved', commentId: 'c1', anchor: { kind: 'file', file: 'src/a.ts' }, verdict: 'addressed', note: 'Done.' } },
    ]
    expect(reduceSegments(events)).toEqual([
      { kind: 'text', text: 'Before.' },
      { kind: 'action', index: 0 },
      { kind: 'text', text: 'After.' },
      { kind: 'action', index: 1 },
    ])
  })
})

describe('deriveVerb', () => {
  it.each([
    ['Read', 'read'], ['read_file', 'read'], ['Grep', 'grep'], ['ripgrep', 'grep'],
    ['Edit', 'edit'], ['Write', 'edit'], ['file_change', 'edit'], ['Bash', 'bash'],
    ['command_execution', 'bash'], ['Glob', 'list'],
    ['list_comments', 'list'], ['mcp__limn__add_comment', 'edit'], ['unknown_tool', 'other'],
  ] as const)('%s -> %s', (name, verb) => { expect(deriveVerb(name)).toBe(verb) })
})

describe('deriveMeta', () => {
  it('counts lines for read', () => { expect(deriveMeta('read', 'a\nb\nc')).toBe('3 lines') })
  it('counts hits for grep', () => { expect(deriveMeta('grep', 'f.ts:1\nf.ts:2')).toBe('2 hits') })
  it('returns undefined for empty / other', () => {
    expect(deriveMeta('read', '')).toBeUndefined()
    expect(deriveMeta('other', 'x')).toBeUndefined()
  })
})

describe('bashArg', () => {
  it('unwraps /bin/zsh -lc with single quotes', () => {
    expect(bashArg("/bin/zsh -lc 'git status'")).toBe('git status')
  })
  it('unwraps a double-quoted variant', () => {
    expect(bashArg('bash -lc "git log"')).toBe('git log')
  })
  it('unwraps /bin/bash -c and sh -c', () => {
    expect(bashArg("/bin/bash -c 'ls -la'")).toBe('ls -la')
    expect(bashArg("sh -c 'echo hi'")).toBe('echo hi')
  })
  it('picks a sensible non-empty line out of a multi-line heredoc script', () => {
    const cmd = "/bin/zsh -lc 'cat <<\\'EOF\\'\n# Title\nactual line\nEOF'"
    expect(bashArg(cmd)).toBe('actual line')
  })
  it('passes a bare command through unchanged', () => {
    expect(bashArg('git log')).toBe('git log')
  })
  it('keeps a line with a << bitshift (only heredoc openers are skipped)', () => {
    expect(bashArg('echo $((1<<4))')).toBe('echo $((1<<4))')
  })
  it('returns empty for empty input', () => {
    expect(bashArg('')).toBe('')
  })
  it('caps long output to ~120 chars', () => {
    expect(bashArg('x'.repeat(300)).length).toBeLessThanOrEqual(120)
  })
})

describe('clampOut', () => {
  it('passes short text through unchanged', () => {
    expect(clampOut('a\nb')).toEqual({ out: 'a\nb' })
  })
  it('truncates and reports the remainder', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const { out, outMore } = clampOut(text, 30)
    expect(out.split('\n')).toHaveLength(30)
    expect(outMore).toBe('10 more lines truncated')
  })
})
