import type { DiffSkeleton, ReviewAnnotations, Section } from '../../shared/types.js'

export interface MergeResult {
  annotations: ReviewAnnotations
  warnings: string[]
}

/** Validate engine annotations against the changed files: every referenced file must
 *  exist; every *committed/staged* (tracked) file ends up in exactly one section
 *  ("Other changes" catches strays). Untracked files (`untracked`) are optional
 *  candidates — the agent may section the relevant ones, but unsectioned untracked
 *  files are NOT swept into "Other changes"; they stay orphan and are auto-excluded
 *  from the review by the renderer. */
export function mergeAnnotations(skeleton: DiffSkeleton, parsed: ReviewAnnotations, untracked: ReadonlySet<string> = new Set()): MergeResult {
  const warnings: string[] = []
  const known = new Set([...skeleton.files.map((f) => f.path), ...untracked])
  const assigned = new Set<string>()

  const sections: Section[] = []
  for (const s of parsed.sections) {
    const files = s.files.filter((f) => {
      if (!known.has(f)) {
        warnings.push(`section "${s.name}" references unknown file ${f} — dropped`)
        return false
      }
      if (assigned.has(f)) {
        warnings.push(`file ${f} assigned to multiple sections — kept first`)
        return false
      }
      assigned.add(f)
      return true
    })
    if (files.length === 0) {
      warnings.push(`section "${s.name}" has no valid files — dropped`)
      continue
    }
    sections.push({ ...s, files })
  }

  // only tracked (committed/staged) strays land in "Other changes"; an unsectioned
  // untracked file is intentionally left orphan so the renderer auto-excludes it.
  const strays = skeleton.files.map((f) => f.path).filter((p) => !assigned.has(p) && !untracked.has(p))
  if (strays.length > 0) {
    sections.push({
      id: 'other-changes',
      name: 'Other changes',
      desc: 'Files the agent did not group into a section.',
      what: 'Remaining changes in this branch.',
      files: strays,
      order: sections.length + 1
    })
  }

  sections.sort((a, b) => a.order - b.order)
  // valid sectionId references only
  const ids = new Set(sections.map((s) => s.id))
  const planMap = parsed.planMap
    ? {
        ...parsed.planMap,
        steps: parsed.planMap.steps.map((st) => (ids.has(st.sectionId) ? st : { ...st, sectionId: '' })),
        deviations: parsed.planMap.deviations.filter((d) => ids.has(d.sectionId) || d.sectionId === '')
      }
    : undefined

  return { annotations: { ...parsed, sections, planMap }, warnings }
}
