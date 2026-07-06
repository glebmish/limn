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
    // a -> b (main chain), a -> c and a -> d (branches off a)
    const d = diagram(['a', 'b', 'c', 'd'], [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'a', to: 'd' }
    ])
    const { rows, ok } = layoutDiagram(d)
    expect(ok).toBe(true)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    // the fan-out targets beyond the main chain appear in a branch row
    const flat = rows.flat().map((n) => n.id)
    expect(flat.sort()).toEqual(['a', 'b', 'c', 'd'])
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
