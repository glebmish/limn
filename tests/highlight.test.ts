import { describe, expect, it } from 'vitest'
import { highlightRun, splitHighlightedHtml } from '../src/renderer/lib/highlight'

/** #7: syntax highlighting must be aware of state that spans a diff-visible line
 *  boundary — a block comment or a template literal — not just tokenize each line
 *  in isolation (which is what `highlightLine` does, and is the defect this file
 *  pins the fix for at the `highlightRun` level). */

function openSpans(html: string): number {
  return (html.match(/<span /g) ?? []).length
}
function closeSpans(html: string): number {
  return (html.match(/<\/span>/g) ?? []).length
}

describe('highlightRun', () => {
  it('keeps a block comment styled on every line it spans, not just the first', () => {
    // the evidence-shot case: a doc comment opening on one line, continuing onto the
    // next — per-line tokenization loses the comment state and reads line 3 as code,
    // marking `never` as a TS keyword (hljs-built_in) and `null` as a literal.
    const lines = [
      'const x = 1',
      '/** Parse a persisted JSON blob',
      ' * never returns null',
      ' */',
      'function f() {}'
    ]
    const html = highlightRun(lines, 'typescript')
    expect(html).toHaveLength(lines.length)
    expect(html[1]).toContain('hljs-comment')
    // line 3 (index 2): still inside the comment — `never`/`null` must NOT be tagged
    // as TS keyword/literal tokens
    expect(html[2]).toContain('hljs-comment')
    expect(html[2]).not.toContain('hljs-built_in')
    expect(html[2]).not.toContain('hljs-literal')
    expect(html[3]).toContain('hljs-comment')
  })

  it('keeps a template literal styled across the lines it spans, on both sides of an interpolation', () => {
    const lines = [
      'const s = `hello',
      '  world ${x}',
      'end`;',
      'const y = 2'
    ]
    const html = highlightRun(lines, 'typescript')
    expect(html).toHaveLength(lines.length)
    // the interpolation line: per-line tokenization sees no opening backtick and
    // renders this as plain unstyled code
    expect(html[1]).toContain('hljs-string')
    expect(html[1]).toContain('hljs-subst')
    // the closing line: per-line tokenization sees a bare leading backtick and misreads
    // it as opening a NEW string, rather than closing the one already open — here the
    // string span is reopened at the top of the line (state carried across the split)
    // and covers "end`" before closing, with the trailing `;` outside it
    expect(html[2]).toMatch(/^<span class="hljs-string">end`<\/span>;$/)
  })

  it('splits into balanced HTML per line — every opened span closes on the same line', () => {
    const lines = ['/**', ' * multi', ' * line', ' * comment', ' */', 'const z = 1']
    const html = highlightRun(lines, 'typescript')
    for (const line of html) expect(openSpans(line)).toBe(closeSpans(line))
  })

  it('returns one string per input line, including blank lines inside the run', () => {
    const lines = ['const a = 1', '', 'const b = 2']
    const html = highlightRun(lines, 'typescript')
    expect(html).toHaveLength(3)
    expect(html[1]).toBe('')
  })

  it('falls back to escaped plain text with no language', () => {
    const html = highlightRun(['<b>&x</b>'], null)
    expect(html).toEqual(['&lt;b&gt;&amp;x&lt;/b&gt;'])
  })

  it('degrades to escaped text on an unknown language rather than throwing', () => {
    expect(() => highlightRun(['a'], 'not-a-real-language')).not.toThrow()
  })

  it('handles an empty run', () => {
    expect(highlightRun([], 'typescript')).toEqual([])
  })

  it('memoizes identical (lang, text) runs — repeat calls hit the same cached array', () => {
    const lines = ['const memoized = true']
    const a = highlightRun(lines, 'typescript')
    const b = highlightRun([...lines], 'typescript')
    expect(a).toBe(b)
  })
})

// final review, finding 5: the splitter's token alphabet is hljs core's own output.
// Anything else — a tag hljs never emits today, or would start emitting tomorrow —
// is *skipped* by `exec`, which silently eats the `<` and the characters after it.
// The line-count guard can't see that: the output has the right number of lines and
// the wrong text on them. Totality is checked directly instead.
describe('splitHighlightedHtml', () => {
  it('splits hljs output into one balanced fragment per source line', () => {
    const out = splitHighlightedHtml('<span class="hljs-comment">/* a\n b */</span>;')
    expect(out).toEqual([
      '<span class="hljs-comment">/* a</span>',
      '<span class="hljs-comment"> b */</span>;'
    ])
  })

  it('consumes plain escaped text whole', () => {
    expect(splitHighlightedHtml('a &lt;b&gt; c')).toEqual(['a &lt;b&gt; c'])
  })

  it('refuses html it cannot account for rather than swallowing characters', () => {
    // `<b>` matches no alternative, so the regex skips past `<` and reads `b>bold`
    // as text — garbage, not misalignment
    expect(splitHighlightedHtml('<b>bold</b>')).toBeNull()
    expect(splitHighlightedHtml('<span class="hljs-x">ok</span><br/>')).toBeNull()
  })
})
