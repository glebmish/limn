/** The diff's compare/layout state, one value: which sheets are out beside `current`
 *  (design board 13 — "a diff's columns are a stack of sheets"), and what Unified is
 *  measured against while none is out. Shared because the server stores the review's
 *  default in `sessions.diff_stack`.
 *
 *  - 0 sheets out → Unified, the slice since `against` (`base` = the full diff)
 *  - 1 sheet out → Split, that sheet beside current
 *  - 2+ sheets out → Multi, base · checkpoints · current — base is always among them
 *
 *  `out` is in PULL order (what − puts back next); the columns display in
 *  SHEET_ORDER. */
export type Sheet = 'base' | 'review' | 'approved' | 'viewed'
export const SHEET_ORDER: Sheet[] = ['base', 'review', 'approved', 'viewed']
export const CHECKPOINTS: Sheet[] = ['review', 'approved', 'viewed']

export interface Stack {
  /** sheets out, in pull order */
  out: Sheet[]
  /** what Unified is measured against — meaningful only while `out` is empty */
  against: Sheet
}

export const UNIFIED: Stack = { out: [], against: 'base' }

export function isSheet(x: unknown): x is Sheet {
  return typeof x === 'string' && (SHEET_ORDER as string[]).includes(x)
}

/** Dedupe `out`, keep the base invariant (two or more sheets out ⇒ base is one of
 *  them — otherwise only the first survives), and fall back to `base` for a missing
 *  or unknown `against`. */
export function normalizeStack(s: { out?: unknown; against?: unknown }): Stack {
  const raw = Array.isArray(s.out) ? s.out.filter(isSheet) : []
  let out = raw.filter((x, i) => raw.indexOf(x) === i)
  if (out.length >= 2 && !out.includes('base')) out = [out[0]]
  return { out, against: isSheet(s.against) ? s.against : 'base' }
}

/** A stored stack back into a value — garbage of any shape reads as UNIFIED. */
export function parseStack(json: string | null | undefined): Stack {
  if (!json) return UNIFIED
  try {
    const v: unknown = JSON.parse(json)
    if (!v || typeof v !== 'object') return UNIFIED
    return normalizeStack(v as { out?: unknown; against?: unknown })
  } catch {
    return UNIFIED
  }
}
