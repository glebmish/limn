import type { ReactNode } from 'react'
import hljs from 'highlight.js'

/** Inline spans: `code` and **bold**. */
function inline(text: string, key: string): ReactNode {
  const parts: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('`')) parts.push(<code key={`${key}-${i}`} className="md-code">{t.slice(1, -1)}</code>)
    else parts.push(<strong key={`${key}-${i}`}>{t.slice(2, -2)}</strong>)
    last = m.index + t.length
    i++
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/** Minimal block renderer — headings, fenced code (hljs), blockquotes, bullet
 *  lists, and paragraphs. Enough to make agent answers read well in the panel. */
export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let b = 0
  const isPlain = (l: string): boolean =>
    l.trim() !== '' && !l.startsWith('```') && !l.startsWith('>') &&
    !/^\s*[-*]\s+/.test(l) && !/^#{1,3}\s+/.test(l)

  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^```(\w*)/)
    if (fence) {
      const lang = fence[1]
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) { body.push(lines[i]); i++ }
      i++ // skip closing fence
      const code = body.join('\n')
      let html = code
      try {
        html = lang && hljs.getLanguage(lang)
          ? hljs.highlight(code, { language: lang }).value
          : hljs.highlightAuto(code).value
      } catch { /* fall back to raw text */ }
      blocks.push(<pre key={b++} className="md-pre"><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>)
      continue
    }
    if (line.startsWith('>')) {
      const body: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) { body.push(lines[i].replace(/^>\s?/, '')); i++ }
      blocks.push(<blockquote key={b++} className="md-quote">{inline(body.join(' '), `q${b}`)}</blockquote>)
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++ }
      blocks.push(<ul key={b++} className="md-ul">{items.map((it, k) => <li key={k}>{inline(it, `li${b}-${k}`)}</li>)}</ul>)
      continue
    }
    const h = line.match(/^(#{1,3})\s+(.*)/)
    if (h) {
      blocks.push(<div key={b++} className={`md-h md-h${h[1].length}`}>{inline(h[2], `h${b}`)}</div>)
      i++
      continue
    }
    if (line.trim() === '') { i++; continue }
    const para: string[] = []
    while (i < lines.length && isPlain(lines[i])) { para.push(lines[i]); i++ }
    blocks.push(<p key={b++} className="md-p">{inline(para.join(' '), `p${b}`)}</p>)
  }
  return <div className="md">{blocks}</div>
}
