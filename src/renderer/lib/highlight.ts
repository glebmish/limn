import hljs from 'highlight.js/lib/core'
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import java from 'highlight.js/lib/languages/java'
import ruby from 'highlight.js/lib/languages/ruby'
import yaml from 'highlight.js/lib/languages/yaml'
import bash from 'highlight.js/lib/languages/bash'
import sql from 'highlight.js/lib/languages/sql'
import kotlin from 'highlight.js/lib/languages/kotlin'
import swift from 'highlight.js/lib/languages/swift'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'

hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('java', java)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('kotlin', kotlin)
hljs.registerLanguage('swift', swift)
hljs.registerLanguage('c', c)
hljs.registerLanguage('cpp', cpp)

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown', markdown: 'markdown',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  rb: 'ruby',
  yml: 'yaml', yaml: 'yaml',
  sh: 'bash', zsh: 'bash', bash: 'bash',
  sql: 'sql',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp', m: 'cpp', mm: 'cpp'
}

export function langForPath(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return EXT_LANG[ext] ?? null
}

const cache = new Map<string, string>()
const CACHE_MAX = 20000

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Tabs → spaces, so a rendered line's *display* columns match the ch-offset word
 *  marks (and the caret-from-point column mapping) laid over it. Every diff row
 *  renders through this. */
export function disp(text: string): string {
  return text.replace(/\t/g, '  ')
}

/** Whole fenced code block → safe highlighted HTML. `lang` is the fence info
 *  string (e.g. "ts", "bash", "typescript"); resolves hljs aliases and our
 *  extension map, falls back to auto-detect, then to escaped text. */
export function highlightBlock(code: string, lang: string | null): string {
  const resolved = lang ? (hljs.getLanguage(lang) ? lang : EXT_LANG[lang.toLowerCase()] ?? null) : null
  try {
    if (resolved) return hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value
    return hljs.highlightAuto(code).value
  } catch {
    return escapeHtml(code)
  }
}

/** Per-line syntax highlight → safe HTML (hljs escapes content). Tokenizes `text`
 *  in isolation, with no memory of any other line — correct for a self-contained
 *  line, wrong for one half of a construct that spans lines (a block comment, a
 *  multi-line template literal: #7). `highlightRun` below is the cross-line-aware
 *  version; this stays as `CodeLine`'s fallback for a row with no precomputed
 *  run-level HTML. */
export function highlightLine(text: string, lang: string | null): string {
  if (!lang || !text.trim()) return escapeHtml(text)
  const key = `${lang}\0${text}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let html: string
  try {
    html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
  } catch {
    html = escapeHtml(text)
  }
  if (cache.size > CACHE_MAX) cache.clear()
  cache.set(key, html)
  return html
}

const runCache = new Map<string, string[]>()
const RUN_CACHE_MAX = 4000

/** Splits one hljs `.value` HTML string back into one fragment per source line,
 *  closing every open `<span>` at each line break and reopening the same stack (same
 *  classes, same nesting order) at the start of the next line — so a `<span
 *  class="hljs-comment">` (or any nested mode, e.g. a `hljs-subst` inside a
 *  `hljs-string`) that covers several lines still yields independently balanced HTML
 *  per line, each carrying the class that was open at that point in the source.
 *
 *  Assumes hljs core's own output alphabet — `<span class="...">…</span>` around
 *  already-escaped text, and nothing else — which is all `hljs.highlight(...).value`
 *  ever emits. Splitting on raw `\n` is safe because hljs never introduces a literal
 *  newline of its own; every `\n` in the output came from the source text (HTML
 *  entities never contain one). */
function splitHighlightedHtml(html: string): string[] {
  const tokenRe = /<span class="([^"]*)">|<\/span>|[^<]+/g
  const stack: string[] = []
  const lines: string[] = []
  let cur = ''
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(html)) !== null) {
    const tok = m[0]
    if (tok === '</span>') {
      stack.pop()
      cur += tok
    } else if (tok.charCodeAt(0) === 60 /* '<' — an opening span */) {
      stack.push(m[1] ?? '')
      cur += tok
    } else {
      const parts = tok.split('\n')
      parts.forEach((part, i) => {
        cur += part
        if (i === parts.length - 1) return
        for (let k = stack.length - 1; k >= 0; k--) cur += '</span>'
        lines.push(cur)
        cur = stack.map((cls) => `<span class="${cls}">`).join('')
      })
    }
  }
  lines.push(cur)
  return lines
}

/** Cross-line-aware syntax highlight for one contiguous run of source lines (#7):
 *  `lines` is joined and tokenized as a single block, so a block comment or template
 *  literal spanning several of them keeps its styling on every line it covers —
 *  `highlightLine`'s defect, by construction, since it tokenizes one isolated line at
 *  a time with no memory of the last. The joined HTML is then split back to one
 *  string per input line (`splitHighlightedHtml`).
 *
 *  Scoped to exactly the lines given — a whole file/side, or (the pragmatic
 *  fallback used here) one diff run's own visible lines.
 *
 *  Memoized by `(lang, joined text)`: the common case across renders is the exact
 *  same run being asked for again (nothing changed since the last render), which is
 *  a cache hit — so the tokenizer runs once per distinct run's content, not once per
 *  line per render. Content-addressed rather than keyed by file path/version: it
 *  needs no separate invalidation signal, and a revealed run (which has no natural
 *  "version" of its own) memoizes the same way a hunk's run does. */
export function highlightRun(lines: string[], lang: string | null): string[] {
  if (lines.length === 0) return []
  if (!lang) return lines.map(escapeHtml)
  const key = `${lang}\0${lines.join('\n')}`
  const hit = runCache.get(key)
  if (hit) return hit
  let result: string[]
  try {
    const html = hljs.highlight(lines.join('\n'), { language: lang, ignoreIllegals: true }).value
    result = splitHighlightedHtml(html)
    // defensive: a mismatch here would misalign every row after it against the
    // wrong highlighted line — never render that, fall back instead
    if (result.length !== lines.length) result = lines.map(escapeHtml)
  } catch {
    result = lines.map(escapeHtml)
  }
  if (runCache.size > RUN_CACHE_MAX) runCache.clear()
  runCache.set(key, result)
  return result
}
