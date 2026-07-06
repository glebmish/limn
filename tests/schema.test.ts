import { describe, expect, it } from 'vitest'
import { normalizeWireAnchor } from '../src/main/engines/schema'

describe('normalizeWireAnchor', () => {
  it('no line → whole-file', () => expect(normalizeWireAnchor({ file: 'a.ts' })).toEqual({ kind: 'file', file: 'a.ts' }))
  it('line → diff range with default side new', () => expect(normalizeWireAnchor({ file: 'a.ts', line: 10 })).toMatchObject({ kind: 'diff', file: 'a.ts', side: 'new', line: 10 }))
  it('line+endLine → range', () => expect(normalizeWireAnchor({ file: 'a.ts', line: 10, endLine: 14 })).toMatchObject({ line: 10, endLine: 14 }))
  it('endLine<line → drops endLine', () => expect((normalizeWireAnchor({ file: 'a.ts', line: 10, endLine: 4 }) as any).endLine).toBeUndefined())
  it('side without line → whole-file (side ignored)', () => expect(normalizeWireAnchor({ file: 'a.ts', side: 'old' })).toEqual({ kind: 'file', file: 'a.ts' }))
})
