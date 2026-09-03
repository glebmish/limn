import { useEffect, useRef } from 'react'
import type { FileDiff } from '../../shared/types'
import type { Stack } from '../../shared/diffStack'
import { useStore } from '../store'
import { effectiveStack, nextPull, pop, pull, sheetsFor } from './stack'

export interface StackKey {
  key: string
  code?: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  /** the event target is a text field — the key belongs to it */
  inField?: boolean
}

/** What a keypress does to the current file's stack, or null when it is not ours:
 *  `[` pulls the next sheet, `]` puts one back; ⇧ spreads the result. Accepts the
 *  shifted glyphs too (`{` / `}` on a US layout) and the physical bracket keys, and
 *  stays out of the way of text fields and of ⌘/⌃/⌥ chords. */
export function stackKeyAction(
  e: StackKey, curFile: string | null, files: FileDiff[], s: { diffStack: Stack; fileStack: Record<string, Stack> }
): { path: string; next: Stack; spread: boolean } | null {
  const pulls = e.key === '[' || e.key === '{' || e.code === 'BracketLeft'
  const pops = e.key === ']' || e.key === '}' || e.code === 'BracketRight'
  if (!pulls && !pops) return null
  if (e.metaKey || e.ctrlKey || e.altKey || e.inField) return null
  if (!curFile) return null
  const f = files.find((x) => x.path === curFile)
  if (!f) return null
  const cur = effectiveStack(s.fileStack[curFile] ?? s.diffStack, f)
  if (pulls) {
    const sheet = nextPull(cur, sheetsFor(f))
    if (!sheet) return null
    return { path: curFile, next: pull(cur, sheet), spread: Boolean(e.shiftKey) }
  }
  if (cur.out.length === 0) return null
  return { path: curFile, next: pop(cur), spread: Boolean(e.shiftKey) }
}

/** `[` / `]` on the file nearest the top of the viewport (design board 13). */
export function useStackKeys(curFile: string | null, files: FileDiff[]): void {
  const filesRef = useRef(files)
  filesRef.current = files
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      const inField = Boolean(t && t.closest('textarea,input,select,[contenteditable="true"]'))
      const s = useStore.getState()
      const act = stackKeyAction({ key: e.key, code: e.code, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, inField }, curFile, filesRef.current, s)
      if (!act) return
      e.preventDefault()
      s.setFileStack(act.path, act.next)
      if (act.spread) useStore.getState().spreadStack(act.path)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [curFile])
}
