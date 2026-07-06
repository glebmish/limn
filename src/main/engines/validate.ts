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

  // Block-anchor integrity gate: a narration (or diagram-node) anchor pointing at
  // a file the diff never touched is dropped — text/node stays, only the anchor
  // is stripped, so a hallucinated file reference degrades gracefully instead of
  // producing a chip that resolves nowhere. Deliberately NOT restricted to the
  // section's own `files` — a block anchoring a file owned by a different
  // section is a legitimate cross-reference (the focus pathway allows it).
  const trackedFiles = new Set(skeleton.files.map((f) => f.path))
  const isUnknownAnchorFile = (anchor: { kind: string; file?: string }): anchor is { kind: 'diff' | 'file'; file: string } =>
    (anchor.kind === 'diff' || anchor.kind === 'file') && anchor.file !== undefined && !trackedFiles.has(anchor.file)
  for (const s of sections) {
    s.narration = s.narration.map((b) => {
      if (!b.anchor || !isUnknownAnchorFile(b.anchor)) return b
      warnings.push(`narration anchor on unknown file ${b.anchor.file} — de-anchored`)
      const { anchor: _drop, ...rest } = b
      return rest
    })
    if (s.diagram) {
      s.diagram = {
        ...s.diagram,
        nodes: s.diagram.nodes.map((n) => {
          if (!n.anchor || !isUnknownAnchorFile(n.anchor)) return n
          warnings.push(`diagram node anchor on unknown file ${n.anchor.file} — de-anchored`)
          const { anchor: _drop, ...rest } = n
          return rest
        })
      }
    }
  }

  // only tracked (committed/staged) strays land in "Other changes"; an unsectioned
  // untracked file is intentionally left orphan so the renderer auto-excludes it.
  const strays = skeleton.files.map((f) => f.path).filter((p) => !assigned.has(p) && !untracked.has(p))
  if (strays.length > 0) {
    sections.push({
      id: 'other-changes',
      name: 'Other changes',
      narration: [{ text: 'Remaining changes in this branch the agent did not group into a section.' }],
      files: strays
    })
  }

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
