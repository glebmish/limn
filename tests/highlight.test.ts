import { describe, expect, it } from 'vitest'
import { highlightRun } from '../src/renderer/lib/highlight'

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
