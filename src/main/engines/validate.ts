import type { DiffSkeleton, ReviewAnnotations, Section } from '../../shared/types.js'

export interface MergeResult {
  annotations: ReviewAnnotations
  warnings: string[]
}

/** Validate engine annotations against the skeleton: every referenced file must exist;
 *  every skeleton file ends up in exactly one section ("Other changes" catches strays). */
export function mergeAnnotations(skeleton: DiffSkeleton, parsed: ReviewAnnotations): MergeResult {
  const warnings: string[] = []
  const known = new Set(skeleton.files.map((f) => f.path))
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

  const strays = skeleton.files.map((f) => f.path).filter((p) => !assigned.has(p))
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
