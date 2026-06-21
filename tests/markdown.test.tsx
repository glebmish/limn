import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../src/renderer/lib/markdown'

// renderToStaticMarkup needs no DOM — react-markdown renders server-side fine.
const html = (text: string): string => renderToStaticMarkup(<Markdown text={text} />)

describe('Markdown', () => {
  it('renders GFM tables', () => {
    const out = html('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(out).toContain('<table')
    expect(out).toContain('<td')
  })

  it('renders links, italics, and bold', () => {
    const out = html('see [x](https://example.com) and *em* and **bold**')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('<em>')
    expect(out).toContain('<strong>')
  })

  it('renders ordered lists', () => {
    const out = html('1. one\n2. two')
    expect(out).toContain('<ol')
  })

  it('highlights fenced code blocks with hljs', () => {
    const out = html('```ts\nconst x = 1\n```')
    expect(out).toContain('md-pre')
    expect(out).toContain('hljs')
  })

  it('keeps inline code with the md-code class', () => {
    expect(html('use `npm test` here')).toContain('class="md-code"')
  })

  it('does not throw on malformed input', () => {
    expect(() => html('**unclosed [bracket')).not.toThrow()
  })
})
