import { describe, expect, it } from 'vitest'
import { parseJson } from '../src/main/engines/codex'

describe('Codex structured output parsing', () => {
  it('parses bare JSON', () => {
    expect(parseJson('{"title":"T"}')).toEqual({ title: 'T' })
  })

  it('parses fenced JSON', () => {
    expect(parseJson('```json\n{"title":"T"}\n```')).toEqual({ title: 'T' })
  })

  it('parses a JSON object wrapped in prose', () => {
    expect(parseJson('Here is the review:\n{"title":"T","summary":"uses } inside text"}\nDone.'))
      .toEqual({ title: 'T', summary: 'uses } inside text' })
  })
})
