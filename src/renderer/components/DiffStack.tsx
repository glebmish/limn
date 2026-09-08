import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FileDiff } from '../../shared/types'
import type { Sheet, Stack } from '../../shared/diffStack'
import {
  close, columnsFor, describeStack, layoutFor, nextPull, pickerOptions, pop, pull, replace, setAgainst, sheetCaption, sheetsFor, sinceLabel
} from '../lib/stack'
import { useDismiss } from '../lib/useDismiss'
import { MarkersKey } from './MarkersKey'
import type { SinceBasis } from '../../shared/sinceBasis'

/** The stack strip and the caption row around a file body (design board 13, W1):
 *  a thin tab down the diff's left edge pulls the next sheet, a − above it puts the
 *  last one back, a ✓ beside it spreads this file's stack to every file and a ↺
 *  under the ✓ puts this file back on the review's default (both shown only while
 *  the file differs from the rest), and the captions ARE the controls —
 *  each checkpoint name a picker, an × on hover. Unified keeps one caption,
 *  `<against> · current`, so the baseline is always visible and changeable.
 *
 *  Everything here is a pure function of the file's effective stack; the strip owns
 *  only which picker is open and the peel animation flag. */
export function DiffStack({ f, stack, differs, defaultStack, fileCount, shas, since, onChange, onSpread, children }: {
  f: FileDiff
  /** the file's effective stack */
  stack: Stack
  /** this file's stack differs from the review's default — the ✓ shows */
  differs: boolean
  defaultStack: Stack
  /** how many files the ✓ would spread to */
  fileCount: number
  /** the commit each checkpoint resolves to, for the caption's hover */
  shas: Partial<Record<Sheet, string | undefined>>
  /** what the drift rail is measured from, for the key; null when the review has none */
  since: SinceBasis | null
  /** the file's stack changed; `spread` when ⇧ was held */
  onChange: (next: Stack, spread: boolean) => void
  onSpread: () => void
  children: ReactNode
}) {
  const avail = sheetsFor(f)
  const layout = layoutFor(stack)
  const cols = columnsFor(stack)
  const next = nextPull(stack, avail)
  const out = stack.out.length
  const last = out ? stack.out[out - 1] : null
  const [peel, setPeel] = useState(false)
  const [openFor, setOpenFor] = useState<Sheet | null>(null)
  const dcolsRef = useRef<HTMLDivElement>(null)
  useDismiss(openFor != null, () => setOpenFor(null), dcolsRef)
  // four or more columns: the body scrolls sideways on its own (so the caption row can
  // stay sticky), and the captions follow its scroll offset
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const body = bodyRef.current, caps = dcolsRef.current
    if (!body || !caps) return
    const sync = (): void => { caps.style.transform = body.scrollLeft ? `translateX(${-body.scrollLeft}px)` : '' }
    sync()
    body.addEventListener('scroll', sync, { passive: true })
    return () => body.removeEventListener('scroll', sync)
  })
  const change = (nextStack: Stack, spread = false): void => {
    setOpenFor(null)
    setPeel(true)
    onChange(nextStack, spread)
  }

  const picker = (sheet: Sheet, unified: boolean): ReactNode => {
    const opts = pickerOptions(stack, avail, sheet)
    const sha = sheet === 'base' ? undefined : shas[sheet]
    const isOpen = openFor === sheet
    return (
      <span className={'fb-dd' + (isOpen ? ' open' : '')}>
        <button
          type="button"
          className="cp"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-label={unified ? `Diff baseline for ${f.path}` : `Sheet for this column of ${f.path}`}
          title={sha ? `${sinceLabel(sheet)} · ${sha.slice(0, 7)}` : sinceLabel(sheet)}
          onClick={(e) => { e.stopPropagation(); setOpenFor(isOpen ? null : sheet) }}
        >
          <span className="cl">{sheetCaption(sheet, { unified })}</span>
          <svg className="cpv" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4l2.5 2.5L7.5 4" /></svg>
        </button>
        {/* mounted only while open (the house pattern — AgentPicker, ChatDropdown,
            RefPicker…): a menu kept in the DOM behind `opacity:0` stays in the tab
            order and the a11y tree, so a keyboard reader would walk through one
            invisible option per sheet, per caption, per file — and activating one
            silently re-bases the diff. The entry fade is a mount animation now. */}
        {isOpen && (
          <span className="fb-menu" role="listbox">
            {opts.map((o) => (
              <button
                type="button"
                key={o.sheet}
                role="option"
                aria-selected={o.sheet === sheet}
                className={'fh-dd-item' + (o.sheet === sheet ? ' sel' : '')}
                disabled={o.disabled}
                title={o.disabled ? 'already out as its own sheet' : undefined}
                onClick={(e) => {
                  e.stopPropagation()
                  if (o.sheet === sheet) { setOpenFor(null); return }
                  change(unified ? setAgainst(stack, o.sheet) : replace(stack, sheet, o.sheet))
                }}
              >
                <span className="fh-dd-check">✓</span>{sinceLabel(o.sheet)}
              </button>
            ))}
          </span>
        )}
      </span>
    )
  }
  const closeButton = (sheet: Sheet): ReactNode => (
    <button
      type="button"
      className="cx"
      title="Close this sheet"
      aria-label={`Close the ${sheetCaption(sheet)} sheet`}
      onClick={(e) => { e.stopPropagation(); change(close(stack, sheet)) }}
    >×</button>
  )
  const caption = (sheet: Sheet): ReactNode => {
    // base is fixed first from two sheets on — a plain label, no picker, no ×
    if (sheet === 'base' && out > 1) return <span key={sheet} className="stk-col"><span className="cl">{sheetCaption('base')}</span></span>
    return <span key={sheet} className="stk-col">{picker(sheet, false)}{closeButton(sheet)}</span>
  }

  const cls = ['stk', `lay-${layout === 'unified' ? 'uni' : layout}`, out ? 'has-pop' : '', differs ? 'has-ok' : '', peel ? 'peel' : '']
    .filter(Boolean).join(' ')
  const nCols = layout === 'unified' ? 1 : cols.length + 1
  // the key describes THIS file: its own uncommitted lines, its own sheets. Memoized
  // on the file: it is a scan of every line of the diff, and a clean file scans in
  // full — no business re-running because the strip opened a picker.
  const dirty = useMemo(
    () => f.hunks.some((h) => h.lines.some((l) => l.origin === 'staged' || l.origin === 'unstaged')), [f])
  const spreadTitle = `Use for all ${fileCount} files — every other file shows ${describeStack(defaultStack)}`
  const resetTitle = `Back to the review's default — ${describeStack(defaultStack)}`
  return (
    <div className={cls} data-cols={nCols} onAnimationEnd={() => setPeel(false)}>
      {/* the strip: − (level with the captions), the tab, ✓ — each sticks to the
          viewport while the file is on screen, so a long file never hides them */}
      <div className="stk-strip">
      {out > 0 && last && (
        <button
          type="button"
          className="stk-pop"
          title={`Put ${sheetCaption(last)} back`}
          aria-label={`Put the ${sheetCaption(last)} sheet back`}
          onClick={(e) => { e.stopPropagation(); change(pop(stack), e.shiftKey) }}
        >−</button>
      )}
      {differs && (
        <button
          type="button"
          className="stk-ok live"
          title={spreadTitle}
          aria-label={`Use this file's sheets for all ${fileCount} files`}
          onClick={(e) => { e.stopPropagation(); onSpread() }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.5l2.5 2.5L9.5 3.5" /></svg>
        </button>
      )}
      {differs && (
        <button
          type="button"
          className="stk-reset live"
          title={resetTitle}
          aria-label="Put this file back on the review's default sheets"
          onClick={(e) => { e.stopPropagation(); change(defaultStack) }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.6 5.2A3.6 3.6 0 1 1 3.3 8.4" /><path d="M2.2 2.4v3h3" /></svg>
        </button>
      )}
      {/* always rendered so the strip keeps its colour; with every sheet out only
          the icon leaves */}
      <button
        type="button"
        className="stk-tab"
        disabled={!next}
        title={next ? `Sheets · ${out} of ${avail.length} out · click to pull the next` : `Sheets · every one of ${avail.length} out`}
        aria-label={next ? `Pull the next sheet — ${out} of ${avail.length} out` : 'Every sheet is out'}
        onClick={next ? (e) => { e.stopPropagation(); change(pull(stack, next), e.shiftKey) } : undefined}
      >
        {next && <svg viewBox="0 0 14 12" aria-hidden="true"><rect x="1" y="1" width="12" height="10" rx="1.5" /><path d="M6 1v10" /><path d="M3.5 4.6v2.8M2.1 6h2.8" /></svg>}
      </button>
      </div>
      <div className="stk-in">
        <div className="stk-caps"><div className="dcols" ref={dcolsRef} style={{ '--cols': `repeat(${nCols}, minmax(0, 1fr))`, '--n': nCols } as React.CSSProperties}>
          {layout === 'unified'
            ? <span className="stk-col now">{picker(stack.against, true)}<span className="sep">·</span><span className="cl">{sheetCaption('current')}</span></span>
            : <>{cols.map(caption)}<span className="stk-col now"><span className="cl">{sheetCaption('current')}</span></span></>}
          <MarkersKey dirty={dirty} since={since} betweenSheets={out >= 2} />
        </div></div>
        <div className="stk-body" ref={bodyRef}>{children}</div>
      </div>
    </div>
  )
}
