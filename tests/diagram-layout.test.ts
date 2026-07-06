import { describe, expect, it } from 'vitest'
import type { Diagram, DiagramNode2 } from '../src/shared/types'
import { layoutDiagram } from '../src/renderer/lib/diagramLayout'

function node(id: string): DiagramNode2 {
  return { id, label: id, kind: 'plain' }
}

function diagram(ids: string[], edges: { from: string; to: string; label?: string }[]): Diagram {
  return { why: 'why', caption: 'caption', nodes: ids.map(node), edges }
}

describe('layoutDiagram', () => {
  it('a linear chain lays out as a single ordered row', () => {
    const d = diagram(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }])
    const { rows, ok } = layoutDiagram(d)
    expect(ok).toBe(true)
    expect(rows).toHaveLength(1)
    expect(rows[0].map((n) => n.id)).toEqual(['a', 'b', 'c'])
  })

  it('a fan-out node stacks its targets as a branch row', () => {
    // `a` fans out to b, c, d — the main row is the chain up to and including
    // the fan-out node (just `a` here), its three targets form the branch row.
    const d = diagram(['a', 'b', 'c', 'd'], [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'a', to: 'd' }
    ])
    const { rows, ok } = layoutDiagram(d)
    expect(ok).toBe(true)
    expect(rows).toHaveLength(2)
    // exact row contents AND order — a garbled split (e.g. [[a,b],[c,d]]) must fail
    expect(rows[0].map((n) => n.id)).toEqual(['a'])
    expect(rows[1].map((n) => n.id)).toEqual(['b', 'c', 'd'])
  })

  it('a chain leading into a fan-out keeps the chain on the main row', () => {
    // x -> a, then a fans out to b, c — main row is the x→a chain, branch row is b, c.
    const d = diagram(['x', 'a', 'b', 'c'], [
      { from: 'x', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' }
    ])
    const { rows, ok } = layoutDiagram(d)
    expect(ok).toBe(true)
    expect(rows).toHaveLength(2)
    expect(rows[0].map((n) => n.id)).toEqual(['x', 'a'])
    expect(rows[1].map((n) => n.id)).toEqual(['b', 'c'])
  })

  it('a cycle cannot be drawn by the two-tier layout — ok:false', () => {
    const d = diagram(['a', 'b'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }])
    const { ok } = layoutDiagram(d)
    expect(ok).toBe(false)
  })

  it('a diagram with no edges still lays out ok (single row, array order)', () => {
    const d = diagram(['a', 'b'], [])
    const { rows, ok } = layoutDiagram(d)
    expect(ok).toBe(true)
    expect(rows.flat().map((n) => n.id)).toEqual(['a', 'b'])
  })
})
