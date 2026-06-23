import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { MD_PLUGINS, type HastNode } from '../src/renderer/lib/markdown'

// ArtifactDoc's per-block comment anchoring depends on react-markdown handing the
// source start line of each block to component overrides. Guard that assumption.
describe('react-markdown source positions', () => {
  it('exposes node.position.start.line to block component overrides', () => {
    const seen: Record<string, number> = {}
    const record = (_tag: string) => ({ node, children }: { node?: HastNode; children?: React.ReactNode }) => {
      seen[String(children)] = node?.position?.start.line ?? -1
      return <div>{children}</div>
    }
    renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={MD_PLUGINS} components={{ h1: record('h1'), p: record('p') }}>
        {'# Title\n\nfirst para\n\nsecond para'}
      </ReactMarkdown>
    )
    expect(seen['Title']).toBe(1)
    expect(seen['first para']).toBe(3)
    expect(seen['second para']).toBe(5)
  })
})
