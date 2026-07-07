import type { DiffSkeleton, PlanMap, ReviewAnnotations, Section } from '../../shared/types.js'
import { type ScopedReviewPatch, questionFromWire, sectionFromWire } from './schema.js'
import { mergeAnnotations } from './validate.js'

/** Reserved section id minted by mergeAnnotations for unsectioned tracked files. */
const OTHER_CHANGES_ID = 'other-changes'

/** Thrown when a scoped patch cannot be safely spliced onto the prior annotations.
 *  The caller maps this to the full-update fallback (ladder step 3). */
export class SpliceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpliceError'
  }
}

export interface SpliceResult {
  annotations: ReviewAnnotations
  warnings: string[]
  /** revised∩prior count — sections whose body the engine rewrote. */
  revisedCount: number
  /** kept survivors — untouched prior sections that made it into the output. */
  keptCount: number
}

/**
 * Splice a diff-scoped patch onto the prior annotations, producing a complete,
 * validated ReviewAnnotations — or throw SpliceError (→ full-update fallback).
 * Pure; no I/O. See spec Design §5.
 *
 * @param sinceAddedPaths paths of files added by the drift since the last iteration.
 *   Used only for the step-9 quality signal: if one of these lands in 'other-changes'
 *   after merge (the engine ignored a genuinely new file) we WARN, never fall back.
 */
export function spliceScopedUpdate(
  prior: ReviewAnnotations,
  patch: ScopedReviewPatch,
  currentSkeleton: DiffSkeleton,
  untrackedPaths: ReadonlySet<string>,
  sinceAddedPaths: ReadonlySet<string> = new Set()
): SpliceResult {
  const priorIds = new Set(prior.sections.map((s) => s.id))

  // ── Step 1: handshake — exact set equality of the prior id partition ─────────
  const revisedIds = patch.revisedSections.map((s) => s.id)
  if (new Set(revisedIds).size !== revisedIds.length) {
    throw new SpliceError('duplicate id within revisedSections')
  }
  const kept = patch.keptSectionIds
  const deleted = patch.deletedSectionIds
  if (new Set(kept).size !== kept.length) throw new SpliceError('duplicate id within keptSectionIds')
  if (new Set(deleted).size !== deleted.length) throw new SpliceError('duplicate id within deletedSectionIds')
  for (const id of kept) if (!priorIds.has(id)) throw new SpliceError(`kept id "${id}" is not a prior section`)
  for (const id of deleted) if (!priorIds.has(id)) throw new SpliceError(`deleted id "${id}" is not a prior section`)

  const keptSet = new Set(kept)
  const deletedSet = new Set(deleted)
  const revisedExisting = new Set(revisedIds.filter((id) => priorIds.has(id)))
  for (const id of priorIds) {
    const n = (keptSet.has(id) ? 1 : 0) + (deletedSet.has(id) ? 1 : 0) + (revisedExisting.has(id) ? 1 : 0)
    if (n !== 1) throw new SpliceError(`prior section "${id}" accounted for ${n} times (must be exactly once)`)
  }

  // ── Step 2: garbage guard (Q4) ──────────────────────────────────────────────
  const priorCount = prior.sections.length
  if (priorCount > 0) {
    if (deletedSet.size > 0.5 * priorCount) throw new SpliceError('scoped patch deletes more than half of prior sections')
    if (revisedExisting.size === priorCount) throw new SpliceError('scoped patch revises every prior section')
  }

  // ── Steps 3 + 5: assemble prior order (minus deleted, revised substituted),
  //    stripping claimed files from kept sections (file move) ───────────────────
  const revisedConverted = patch.revisedSections.map(sectionFromWire)
  const revisedById = new Map(revisedConverted.filter((s) => priorIds.has(s.id)).map((s) => [s.id, s] as const))
  const newSections = revisedConverted.filter((s) => !priorIds.has(s.id))
  // afterSectionId lives on WireSection, not the domain Section sectionFromWire
  // returns — capture it per new section (by object identity) BEFORE the id
  // re-mint below can rewrite `ns.id` out from under a by-id lookup.
  const afterSectionIdByNew = new Map<Section, string | undefined>(
    newSections.map((s) => [s, patch.revisedSections.find((w) => w.id === s.id)?.afterSectionId] as const)
  )

  const claimed = new Set<string>()
  for (const s of revisedConverted) for (const f of s.files) claimed.add(f)

  const inOrder: Section[] = []
  let revisedCount = 0
  let keptCount = 0
  for (const p of prior.sections) {
    if (deletedSet.has(p.id)) continue
    const rev = revisedById.get(p.id)
    if (rev) {
      // keep the prior slot's position so a revised section stays in place
      inOrder.push({ ...rev })
      revisedCount++
      continue
    }
    // kept: a file that a revised/new section claims has moved away
    const files = p.files.filter((f) => !claimed.has(f))
    if (files.length === 0) continue // emptied kept section dropped (mirrors mergeAnnotations)
    inOrder.push({ ...p, files })
    keptCount++
  }

  // ── Step 4: re-mint colliding new-section ids + rewrite planMap references ───
  const takenIds = new Set<string>([...inOrder.map((s) => s.id), OTHER_CHANGES_ID])
  const idRemap = new Map<string, string>()
  for (const ns of newSections) {
    let id = ns.id
    if (takenIds.has(id)) {
      let n = 2
      while (takenIds.has(`${ns.id}-${n}`)) n++
      id = `${ns.id}-${n}`
      idRemap.set(ns.id, id)
      ns.id = id
    }
    takenIds.add(id)
  }

  // place new sections after their afterSectionId anchor (unknown/absent ⇒ append).
  // Placement must not depend on declaration order: an anchor may name another NEW
  // section declared later (defer it to a later pass), and siblings sharing one
  // anchor chain after each other so they keep declaration order. Anchors are
  // resolved through idRemap so a re-minted target is still found. Anything still
  // unplaced when a pass makes no progress (unknown or cyclic anchors) is appended.
  const sections: Section[] = [...inOrder]
  const chainTail = new Map<string, string>() // anchor id → id of last sibling placed there
  let pending = [...newSections]
  for (;;) {
    const deferred: Section[] = []
    for (const ns of pending) {
      const raw = afterSectionIdByNew.get(ns)
      const afterId = raw === undefined ? undefined : idRemap.get(raw) ?? raw
      const insertAfter = afterId === undefined ? undefined : chainTail.get(afterId) ?? afterId
      const idx = insertAfter === undefined ? -1 : sections.findIndex((s) => s.id === insertAfter)
      if (idx >= 0) {
        sections.splice(idx + 1, 0, ns)
        chainTail.set(afterId!, ns.id)
      } else if (afterId !== undefined && pending.some((p) => p !== ns && p.id === afterId)) {
        deferred.push(ns) // anchor is a new section not placed yet — retry next pass
      } else {
        sections.push(ns) // absent/unknown afterSectionId → append
      }
    }
    if (deferred.length === 0 || deferred.length === pending.length) {
      sections.push(...deferred) // cyclic anchors — append in declaration order
      break
    }
    pending = deferred
  }

  // ── Step 6: questions — add/resolve only (Q8) ───────────────────────────────
  const resolved = new Set(patch.resolvedQuestionIds)
  const questions = prior.questions.filter((q) => !resolved.has(q.id))
  const questionIds = new Set(questions.map((q) => q.id))
  for (const wq of patch.newQuestions) {
    if (questionIds.has(wq.id)) continue // dedup against survivors + earlier new ids
    questions.push(questionFromWire(wq))
    questionIds.add(wq.id)
  }

  // ── Step 7: scalars (null = keep prior); rewrite re-minted ids in the planMap ─
  let planMap: PlanMap | undefined = patch.planMap ?? prior.planMap ?? undefined
  if (patch.planMap && idRemap.size > 0) {
    planMap = {
      ...patch.planMap,
      steps: patch.planMap.steps.map((st) => ({ ...st, sectionId: idRemap.get(st.sectionId) ?? st.sectionId })),
      deviations: patch.planMap.deviations.map((d) => ({ ...d, sectionId: idRemap.get(d.sectionId) ?? d.sectionId }))
    }
  }

  const spliced: ReviewAnnotations = {
    title: patch.title ?? prior.title,
    summary: patch.summary ?? prior.summary,
    sections,
    planMap,
    questions,
    artifactPaths: prior.artifactPaths,
    generatedBy: prior.generatedBy
  }

  // ── Step 8: validate exactly like today via the existing mergeAnnotations ────
  // Scoped patches rarely touch planMap acceptance sources; `prior.artifactPaths`
  // (the agent-declared list carried over unchanged at Step 7 above) is threaded
  // through as the best available artifact set rather than an empty one.
  const { annotations, warnings } = mergeAnnotations(currentSkeleton, spliced, untrackedPaths, new Set(prior.artifactPaths ?? []))

  // ── Step 9: post-merge quality signal (Q5 — WARN, do NOT fall back) ──────────
  const other = annotations.sections.find((s) => s.id === OTHER_CHANGES_ID)
  if (other) {
    for (const f of other.files) {
      if (sinceAddedPaths.has(f)) {
        warnings.push(`new file ${f} was not assigned to a section — swept to Other changes`)
      }
    }
  }

  return { annotations, warnings, revisedCount, keptCount }
}
