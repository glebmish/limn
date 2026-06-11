import { describe, it, expect } from 'vitest'
import { wordDiffRanges, pairHunkLines } from '../src/renderer/lib/worddiff'
import type { DiffLine } from '../src/shared/types'

describe('wordDiffRanges', () => {
  it('marks only the changed token', () => {
    const r = wordDiffRanges('  return 1', '  return 2')
    expect(r.old).toEqual([{ start: 9, len: 1 }])
    expect(r.new).toEqual([{ start: 9, len: 1 }])
  })

  it('marks an inserted word on the new side only', () => {
    const r = wordDiffRanges('const x = compute()', 'const x = await compute()')
    expect(r.old).toEqual([])
    expect(r.new).toEqual([{ start: 10, len: 5 }])
  })

  it('merges adjacent changed tokens', () => {
    const r = wordDiffRanges('foo(a, b)', 'foo(x, y)')
    expect(r.old).toEqual([{ start: 4, len: 1 }, { start: 7, len: 1 }])
    expect(r.new).toEqual([{ start: 4, len: 1 }, { start: 7, len: 1 }])
  })

  it('returns no ranges for completely different lines', () => {
    // unrelated lines: marking everything is noise, prefer plain add/del colors
    const r = wordDiffRanges('import fs from "node:fs"', 'export const limit = 20')
    expect(r.old).toEqual([])
    expect(r.new).toEqual([])
  })
})

describe('pairHunkLines', () => {
  const mk = (kind: '' | 'add' | 'del', text: string): DiffLine =>
    ({ old: kind === 'add' ? null : 1, new: kind === 'del' ? null : 1, kind, text })

  it('pairs consecutive del/add runs index-wise', () => {
    const lines = [mk('', 'ctx'), mk('del', 'a1'), mk('del', 'a2'), mk('add', 'b1'), mk('add', 'b2'), mk('', 'ctx')]
    const pairs = pairHunkLines(lines)
    expect(pairs.get(1)).toBe(3)
    expect(pairs.get(2)).toBe(4)
  })

  it('unbalanced runs pair only the overlap', () => {
    const lines = [mk('del', 'a1'), mk('add', 'b1'), mk('add', 'b2')]
    const pairs = pairHunkLines(lines)
    expect(pairs.get(0)).toBe(1)
    expect(pairs.size).toBe(1)
  })

  it('separated runs do not pair', () => {
    const lines = [mk('del', 'a1'), mk('', 'ctx'), mk('add', 'b1')]
    expect(pairHunkLines(lines).size).toBe(0)
  })
})
