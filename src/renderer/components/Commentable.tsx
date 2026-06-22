import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SelectionScope } from '../../shared/types'
import { I } from '../kit'
import { useStore } from '../store'
import { addComment } from '../lib/comments'
import { captureSelection, sameScope, type CapturedSelection } from '../lib/selection'
import { Composer, InlineThread } from './Threads'

const snip = (s: string, n = 48): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/** Wraps a prose region so any text selection inside it can be commented on: a
 *  floating "Comment" pill appears over the selection and opens the composer. It
 *  does NOT render existing threads — use <SelectionThreads> for that, so a scope
 *  spread across several regions (e.g. a section's desc + narration) shows its
 *  threads in one place. */
export function Commentable({ scope, className, children }: {
  scope: SelectionScope
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<CapturedSelection | null>(null)
  const [composing, setComposing] = useState<{ quote: string; prefix: string; suffix: string } | null>(null)

  useEffect(() => {
    const onDocDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPill(null)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [])

  return (
    <div ref={ref} className={'limn-commentable' + (className ? ` ${className}` : '')} onMouseUp={() => ref.current && setPill(captureSelection(ref.current))}>
      {children}
      {pill && (
        <button
          className="sel-cmt-pill"
          style={{ left: pill.x, top: pill.y }}
          onMouseDown={(e) => e.preventDefault()}  // don't collapse the selection
          onClick={() => {
            setComposing({ quote: pill.quote, prefix: pill.prefix, suffix: pill.suffix })
            setPill(null)
            window.getSelection()?.removeAllRanges()
          }}
        >
          <I.bubble style={{ width: 11, height: 11 }} />Comment
        </button>
      )}
      {composing && (
        <div className="sel-threads">
          <Composer
            placeholder={`Comment on “${snip(composing.quote)}” — the agent gets it with your next batch…`}
            onCancel={() => setComposing(null)}
            onSubmit={(text) => {
              void addComment({ kind: 'selection', scope, quote: composing.quote, prefix: composing.prefix, suffix: composing.suffix }, text)
              setComposing(null)
            }}
          />
        </div>
      )}
    </div>
  )
}

/** Renders the existing text-selection comment threads for a scope (each labelled
 *  with its quoted snippet). Place once per scope, near its region(s). */
export function SelectionThreads({ scope }: { scope: SelectionScope }) {
  const comments = useStore((s) => s.loaded?.state.comments ?? [])
  const mine = comments.filter((c) => c.anchor.kind === 'selection' && sameScope(c.anchor.scope, scope))
  if (mine.length === 0) return null
  return (
    <div className="sel-threads">
      {mine.map((c) => (
        <InlineThread key={c.id} c={c} locLabel={c.anchor.kind === 'selection' ? `on “${snip(c.anchor.quote)}”` : 'on selection'} />
      ))}
    </div>
  )
}
