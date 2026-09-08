import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { LoadedReview } from '../../shared/ipc'
import type { FileDiff, Section } from '../../shared/types'
import { fileViewed, useStore } from '../store'
import { cancelFocusJump, pinnedTop } from './focusScroll'
import { focusAnchor } from './focus'
import { dev } from '../dev'

/** All review scroll behavior in one hook: the scroll/head/section refs, the
 *  header-height CSS-var effect, the scroll-sync effect that tracks the current
 *  section + file, the section/file jump helpers (retry-loop + `behavior:'instant'`
 *  preserved verbatim), and the doc scroll-memory (goToDoc/closeDocBack/toggleDoc)
 *  with the `peek` sidebar-dropdown state it drives. Returns the refs + navigation
 *  functions for the orchestrator to wire into the DOM and hand to the sidebar. */
/** px below the pinned header where the scroll-spy draws its fold line */
const FOLD_GAP = 40

export function useReviewScroll({
  loaded,
  docPath,
  sections,
  filesFor,
  openDoc,
  closeDoc
}: {
  loaded: LoadedReview | null
  docPath: string | null
  sections: Section[]
  filesFor: (s: Section) => FileDiff[]
  openDoc: (path: string) => void
  closeDoc: () => void
}): {
  scrollRef: RefObject<HTMLDivElement | null>
  headRef: RefObject<HTMLDivElement | null>
  secRefs: RefObject<Record<string, HTMLDivElement | null>>
  peek: string | null
  setPeek: (v: string | null) => void
  jumpTo: (id: string) => void
  jumpToFile: (path: string) => void
  goToDoc: (path: string) => void
  closeDocBack: () => void
  toggleDoc: (path: string) => void
} {
  const scrollRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const secRefs = useRef<Record<string, HTMLDivElement | null>>({})
  // scroll memory: the review position to return to when a doc closes, plus each
  // doc's own scroll position (per file — a different doc opens from its own top)
  const reviewScrollRef = useRef(0)
  const docScrollRef = useRef<Record<string, number>>({})
  const [peek, setPeek] = useState<string | null>(dev.openPeek ?? null)

  // publish the pinned header's live height as a CSS var on the scroll container so
  // the (also-sticky) file headers stick *below* it instead of behind it. Measured,
  // not hard-coded, because the header height shifts with density and title wrapping.
  useEffect(() => {
    const head = headRef.current, box = scrollRef.current
    if (!head || !box) return
    const apply = (): void => box.style.setProperty('--limn-head-h', `${head.offsetHeight}px`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(head)
    return () => ro.disconnect()
  }, [loaded, docPath])

  // scroll-sync: keep the sidebar's current section AND current file in step with
  // the scroll position, so the tree always shows where you are in the diff.
  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const onScroll = (): void => {
      // the doc view shares this scroll container; scrolling a spec/plan must
      // not re-track the (unmounted) changes sections in the sidebar
      if (useStore.getState().docPath) return
      // the fold line: just under the pinned page header (measured — it wraps with
      // the title), so the file whose header sits right below it is the current one
      const baseTop = box.getBoundingClientRect().top + pinnedTop(box) + FOLD_GAP
      const va = useStore.getState().viewedAt
      const vaHead = useStore.getState().loaded?.skeleton.headSha
      const sectionDone = (s: Section): boolean => {
        const fs = filesFor(s)
        return fs.length > 0 && fs.every((f) => fileViewed(f, va, vaHead))
      }
      let active: string | undefined
      if (sections.length > 0) {
        const firstOpen = sections.find((s) => !sectionDone(s))
        active = firstOpen ? firstOpen.id : sections[0]?.id
        for (const s of sections) {
          if (sectionDone(s)) continue
          const el = secRefs.current[s.id]
          if (el && el.getBoundingClientRect().top <= baseTop) active = s.id
        }
        if (active) useStore.getState().setCur(active)
      }
      // current file: within the active section, the last file header at or above
      // the fold line; if none is above it yet (we're still in the section's
      // narration/diagram band), the section's FIRST file. Tying this to the active
      // section is what stops a section jump from leaving the *previous* section's
      // last file highlighted, and keeps the highlight in step while scrolling.
      const activeSecEl = active ? secRefs.current[active] : null
      const secTop = activeSecEl ? activeSecEl.getBoundingClientRect().top : -Infinity
      let activeFile: string | null = null
      let firstInSec: string | null = null
      for (const el of box.querySelectorAll<HTMLElement>('[data-limn-file]')) {
        const top = el.getBoundingClientRect().top
        if (top < secTop - 1) continue // file belongs to an earlier section
        const path = el.dataset.limnFile ?? null
        if (firstInSec === null) firstInSec = path
        if (top <= baseTop) activeFile = path
        else break
      }
      // fall back to the section's first file only once its header has reached the
      // fold (so reading the top summary doesn't pre-light section 1's first file)
      useStore.getState().setCurFile(activeFile ?? (secTop <= baseTop ? firstInSec : null))
    }
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => box.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections])

  // Every sidebar navigation is a focus jump with the flash turned off. One pipeline
  // for every way of getting somewhere (sidebar, chat chips, agent walkthrough
  // stops, diagram nodes): it clears the pinned page header, measures the file
  // block rather than its sticky header (a stuck header reports its stuck rect),
  // force-shows a viewed/collapsed file or a reviewed section so the target has a
  // box at all, re-measures while `content-visibility` bodies lay out under it, and
  // cancels the jump in flight first (#19). The one-shot scrolls this replaced got
  // every one of those wrong in some case — the visible one being a click on a
  // viewed file landing behind the header, with the NEXT section's title at the top.
  const leaveDoc = (): void => {
    if (docPath && scrollRef.current) docScrollRef.current[docPath] = scrollRef.current.scrollTop
  }
  const jumpTo = (id: string): void => {
    leaveDoc()
    focusAnchor({ kind: 'section', sectionId: id }, { quiet: true })
  }

  // jump straight to a file's diff (not just its section) — focusAnchor resolves
  // and force-opens the file's owning section itself, so there is nothing left for
  // a caller to pass in.
  const jumpToFile = (path: string): void => {
    leaveDoc()
    focusAnchor({ kind: 'file', file: path }, { quiet: true })
  }

  // restore a saved scroll position after the doc/review view swaps in (its content
  // lays out over a few frames, so re-apply across them). Direct scrollTop assignment
  // is instant regardless of .gmain's scroll-behavior:smooth.
  const restoreScroll = (target: number): void => {
    cancelFocusJump() // a jump still settling would drag the view back to its goal
    let tries = 0
    const apply = (): void => {
      if (scrollRef.current) scrollRef.current.scrollTop = target
      if (tries++ < 10) requestAnimationFrame(apply)
    }
    requestAnimationFrame(apply)
  }

  // open a doc (and its sidebar dropdown), remembering where we left the prior view
  const goToDoc = (path: string): void => {
    const box = scrollRef.current
    if (box) {
      if (docPath) docScrollRef.current[docPath] = box.scrollTop
      else reviewScrollRef.current = box.scrollTop
    }
    setPeek(path)
    openDoc(path)
    restoreScroll(docScrollRef.current[path] ?? 0)
  }

  // close the open doc and land back at the same spot in the review
  const closeDocBack = (): void => {
    if (docPath && scrollRef.current) docScrollRef.current[docPath] = scrollRef.current.scrollTop
    setPeek(null)
    closeDoc()
    restoreScroll(reviewScrollRef.current)
  }

  // clicking the spec/plan name: open it (+ dropdown), or — a second click on the
  // one already open — close it and return to the review
  const toggleDoc = (path: string): void => {
    if (docPath === path) closeDocBack()
    else goToDoc(path)
  }

  return { scrollRef, headRef, secRefs, peek, setPeek, jumpTo, jumpToFile, goToDoc, closeDocBack, toggleDoc }
}
