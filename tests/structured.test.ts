import { describe, expect, it } from 'vitest'
import { buildRepairPrompt, parseJson, structuredEpilogue } from '../src/server/engines/structured'

describe('parseJson', () => {
  it('parses bare JSON', () => {
    expect(parseJson('{"title":"T"}')).toEqual({ title: 'T' })
  })

  it('parses fenced JSON', () => {
    expect(parseJson('```json\n{"title":"T"}\n```')).toEqual({ title: 'T' })
  })

  it('parses a JSON object wrapped in prose (balanced-brace slice)', () => {
    expect(parseJson('Here is the review:\n{"title":"T","summary":"uses } inside text"}\nDone.'))
      .toEqual({ title: 'T', summary: 'uses } inside text' })
  })

  it('parses an array payload', () => {
    expect(parseJson('[1,2,3]')).toEqual([1, 2, 3])
  })

  it('does not miscount nested braces inside strings', () => {
    const text = 'prose before {"a":"{{{not a brace","b":{"nested":"}}} still a string"}}\nprose after'
    expect(parseJson(text)).toEqual({ a: '{{{not a brace', b: { nested: '}}} still a string' } })
  })

  it('prefers the LAST balanced object when a preamble contains a brace fragment', () => {
    const text = 'I will structure the output as {"sections": [...]} roughly.\nHere it is:\n{"title":"T","summary":"S"}'
    expect(parseJson(text)).toEqual({ title: 'T', summary: 'S' })
  })

  it('falls back to an earlier balanced object when the last one is not valid JSON', () => {
    const text = '{"title":"T"}\ntrailing note {not json}'
    expect(parseJson(text)).toEqual({ title: 'T' })
  })

  it('still finds a trailing payload after a stray unbalanced opener in prose', () => {
    const text = 'an { unbalanced brace in prose\n{"title":"T"}'
    expect(parseJson(text)).toEqual({ title: 'T' })
  })

  it('single wrapped object behaviour is unchanged', () => {
    expect(parseJson('preamble\n{"only":"one"}\npostamble')).toEqual({ only: 'one' })
  })

  it('throws a generic error for non-JSON output', () => {
    expect(() => parseJson('not json at all, no braces')).toThrow('Engine returned non-JSON output')
  })
})

describe('structuredEpilogue', () => {
  const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }

  it('inlines the stringified schema', () => {
    const out = structuredEpilogue(schema)
    expect(out).toContain(JSON.stringify(schema, null, 2))
  })

  it('instructs a single JSON object with no fences and no prose', () => {
    const out = structuredEpilogue(schema)
    expect(out.toLowerCase()).toContain('json object')
    expect(out.toLowerCase()).toContain('no markdown')
    expect(out.toLowerCase()).toContain('no prose')
  })

  it('is deterministic across calls', () => {
    expect(structuredEpilogue(schema)).toBe(structuredEpilogue(schema))
  })
})

describe('buildRepairPrompt', () => {
  it('includes the passed issues text', () => {
    const issues = 'title: Required\nsummary: Expected string, received number'
    expect(buildRepairPrompt(issues)).toContain(issues)
  })

  it('instructs replying with only the corrected JSON, no fences, no prose', () => {
    const out = buildRepairPrompt('some issue').toLowerCase()
    expect(out).toContain('corrected json')
    expect(out).toContain('no fences')
    expect(out).toContain('no prose')
  })
})
