import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { Diagram, FileDiff, Section } from '../src/shared/types'
import { SectionView } from '../src/renderer/components/SectionView'
import { useStore } from '../src/renderer/store'
import { initialStateOf } from './helpers/store'

// minimal FileDiff: viewed-state derivation reads `path`/`fileHash`; DiffView needs a
// renderable hunk shape when the section body is open.
function file(path: string): FileDiff {
  return {
    path,
    fileHash: 'h',
    status: 'modified',
    binary: false,
    add: 1,
    del: 0,
    hunks: [{ range: '@@ -1,1 +1,1 @@', header: '', lines: [{ old: null, new: 1, kind: 'add', text: 'x' }] }],
  } as unknown as FileDiff
}

function section(diagram: Diagram): Section {
  return { id: 's1', name: 'Auth', narration: [], files: ['a.ts'], diagram } as unknown as Section
}

function initial() {
  return initialStateOf(useStore)
}
function reset(): void {
  const init = initial()
  for (const k of Object.keys(init.viewedAt)) delete init.viewedAt[k]
  init.collapsed.clear()
  init.expanded.clear()
}
afterEach(reset)

function html(diagram: Diagram): string {
  return renderToStaticMarkup(
    <SectionView s={section(diagram)} n={1} total={1} files={[file('a.ts')]} secRef={() => {}} />
  )
}

describe('SectionView diagram rendering', () => {
  it('a 3-node chained diagram renders node labels, the caption, and flowarrow connectors', () => {
    const diagram: Diagram = {
      why: 'shows the request path',
      caption: 'requests flow through the middleware stack',
      nodes: [
        { id: 'n1', label: 'Request', kind: 'plain' },
        { id: 'n2', label: 'Middleware', kind: 'hi' },
        { id: 'n3', label: 'Handler', kind: 'new' }
      ],
      edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }]
    }
    const out = html(diagram)
    expect(out).toContain('Request')
    expect(out).toContain('Middleware')
    expect(out).toContain('Handler')
    expect(out).toContain('requests flow through the middleware stack')
    expect(out).toContain('flowarrow')
  })

  it('a cyclic diagram falls back to a node-list + edge-list rendering', () => {
    const diagram: Diagram = {
      why: 'shows a feedback loop',
      caption: 'this loop is intentional',
      nodes: [
        { id: 'n1', label: 'Alpha', kind: 'plain' },
        { id: 'n2', label: 'Beta', kind: 'plain' }
      ],
      edges: [{ from: 'n1', to: 'n2', label: 'ping' }, { from: 'n2', to: 'n1', label: 'pong' }]
    }
    const out = html(diagram)
    expect(out).toContain('Alpha')
    expect(out).toContain('Beta')
    // fallback edge-list markup: from → to: label
    expect(out).toContain('ping')
    expect(out).toContain('pong')
    expect(out).toContain('this loop is intentional')
  })
})
