import type { ViewRow } from './rows'

// `.gfile-diff` is `content-visibility:auto`: an off-screen body is never laid out,
// so until the viewport first reaches it the browser reserves whatever
// `contain-intrinsic-height` says. A flat constant there made a 300-line file claim
// the same box as a 5-line one — the page more than doubled in height while it was
// being scrolled, and the scrollbar thumb jumped each time a body laid out. The rows
// are already known before layout, so reserve what they will actually take. `auto`
// still replaces the estimate with the measured height once a body has rendered.

/** one diff row: 12px mono × line-height 1.65 (`.gfile-diff`, review.css) */
export const LINE_ROW_PX = 19.8
/** one fold row (`.expander-row`), stepped controls included */
export const FOLD_ROW_PX = 25
/** a typical inline thread card — they vary (≈155–305px measured), this is the middle */
export const THREAD_PX = 190

/** The height a file's diff body will take once laid out, from the rows it renders
 *  and the number of inline threads between them. An estimate: rows never wrap
 *  (`white-space:pre`), so only the threads are approximate. */
export function estimateDiffHeight(view: ViewRow[], threads: number): number {
  let px = 0
  for (const r of view) px += r.type === 'gap' ? FOLD_ROW_PX : LINE_ROW_PX
  return Math.max(Math.round(LINE_ROW_PX), Math.round(px) + threads * THREAD_PX)
}
