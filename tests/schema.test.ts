import { describe, expect, it } from 'vitest'
import { normalizeWireAnchor, parseReviewOutput } from '../src/server/engines/schema'
import type { FocusTarget } from '../src/shared/types'

describe('parseReviewOutput', () => {
  it('returns hotspots as a sibling of annotations — never a field on the persisted type', () => {
    const raw = {
      title: 'T', summary: 'S',
      sections: [{ id: 's1', name: 'A', narration: [{ text: 'w' }], files: ['x.ts'] }],
      planMap: null, questions: [], artifactPaths: null,
      hotspots: [{ anchor: { file: 'x.ts', line: 3 }, text: 'careful', severity: 'risk' }]
    }
    const parsed = parseReviewOutput(raw)
    expect(parsed.annotations.title).toBe('T')
    expect(parsed.hotspots).toHaveLength(1)
    expect(parsed.hotspots[0].severity).toBe('risk')
    // structural guarantee: the transient field cannot ride along into persistence
    expect('hotspots' in parsed.annotations).toBe(false)
  })
})

describe('normalizeWireAnchor', () => {
  it('no line → whole-file', () => expect(normalizeWireAnchor({ file: 'a.ts' })).toEqual({ kind: 'file', file: 'a.ts' }))
  it('line → diff range with default side new', () => expect(normalizeWireAnchor({ file: 'a.ts', line: 10 })).toMatchObject({ kind: 'diff', file: 'a.ts', side: 'new', line: 10 }))
  it('line+endLine → range', () => expect(normalizeWireAnchor({ file: 'a.ts', line: 10, endLine: 14 })).toMatchObject({ line: 10, endLine: 14 }))
  it('endLine<line → drops endLine', () => expect((normalizeWireAnchor({ file: 'a.ts', line: 10, endLine: 4 }) as Extract<FocusTarget, { kind: 'diff' }>).endLine).toBeUndefined())
  it('side without line → whole-file (side ignored)', () => expect(normalizeWireAnchor({ file: 'a.ts', side: 'old' })).toEqual({ kind: 'file', file: 'a.ts' }))
})
