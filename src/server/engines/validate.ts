import type { DiffSkeleton, ReviewAnnotations, Section } from '../../shared/types.js'
import { hasCycle } from '../../shared/graph.js'

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
export function mergeAnnotations(skeleton: DiffSkeleton, parsed: ReviewAnnotations, untracked: ReadonlySet<string> = new Set(), artifactPaths: ReadonlySet<string> = new Set()): MergeResult {
  const warnings: string[] = []
  const known = new Set([...skeleton.files.map((f) => f.path), ...untracked])
  const assigned = new Set<string>()

  // A section id is a primary key downstream: the persisted `reviewed_sections` row,
  // the React list key, the scroll ref and every planMap jump target. The schema only
  // asks the agent for a "short stable id", so uniqueness is minted here — the scoped
  // path already does the same for new sections (splice.ts step 4). First occurrence
  // keeps the id it was cited by; a later collision is re-minted `id-2`, `id-3`, …
  const takenIds = new Set<string>()
  const freeId = (base: string): string => {
    if (!takenIds.has(base)) return base
    let n = 2
    while (takenIds.has(`${base}-${n}`)) n++
    return `${base}-${n}`
  }

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
    const id = freeId(s.id.trim() || 'section')
    if (id !== s.id) {
      warnings.push(`section "${s.name}" cannot keep id "${s.id}" (empty or already used) — re-minted as "${id}"`)
    }
    takenIds.add(id)
    sections.push({ ...s, id, files })
  }

  // Block-anchor integrity gate: a narration (or diagram-node) anchor pointing at
  // a file the diff never touched is dropped — text/node stays, only the anchor
  // is stripped, so a hallucinated file reference degrades gracefully instead of
  // producing a chip that resolves nowhere. Keyed on the SAME `known` set the
  // section-file check uses (skeleton.files ∪ untracked) so the anchor gate is
  // exactly as permissive as section assignment: an agent-sectioned untracked
  // file is legitimate diff content and its anchor is kept. Deliberately NOT
  // restricted to the section's own `files` either — a block anchoring a file
  // owned by a different section is a legitimate cross-reference (focus pathway).
  const isUnknownAnchorFile = (anchor: { kind: string; file?: string }): anchor is { kind: 'diff' | 'file'; file: string } =>
    (anchor.kind === 'diff' || anchor.kind === 'file') && anchor.file !== undefined && !known.has(anchor.file)
  for (const s of sections) {
    s.narration = s.narration.map((b) => {
      if (!b.anchor || !isUnknownAnchorFile(b.anchor)) return b
      warnings.push(`narration anchor on unknown file ${b.anchor.file} — de-anchored`)
      const { anchor: _drop, ...rest } = b
      return rest
    })
    if (s.diagram) {
      const nodeIds = new Set(s.diagram.nodes.map((n) => n.id))
      const edges = s.diagram.edges.filter((e) => {
        if (nodeIds.has(e.from) && nodeIds.has(e.to)) return true
        warnings.push(`section "${s.name}" diagram edge references unknown node (${e.from} → ${e.to}) — dropped`)
        return false
      })
      if (hasCycle(nodeIds, edges)) {
        warnings.push(`section "${s.name}" diagram has a cycle — kept, renderer falls back to a list`)
      }
      s.diagram = {
        ...s.diagram,
        edges,
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
    // 'other-changes' is the conventional sweep id, but a prior iteration's sweep
    // section (or an agent section) may already hold it — take the next free id
    // rather than renaming a section whose id comments and jumps already reference.
    sections.push({
      id: freeId('other-changes'),
      name: 'Other changes',
      narration: [{ text: 'Remaining changes in this branch the agent did not group into a section.' }],
      files: strays
    })
  }

  // valid sectionId references only
  const ids = new Set(sections.map((s) => s.id))
  // Acceptance-criterion `source` integrity: a citation is only trustworthy if it
  // points at either a file the diff actually touched OR a detected artifact
  // (spec/plan) — anything else is a hallucinated path, so the source is dropped
  // (the acceptance entry itself is kept; only the grounding link is stripped).
  const knownSource = new Set([...known, ...artifactPaths])
  const planMap = parsed.planMap
    ? {
        ...parsed.planMap,
        acceptance: parsed.planMap.acceptance.map((a) => {
          if (!a.source || knownSource.has(a.source.path)) return a
          warnings.push(`acceptance criterion "${a.text}" cites unknown source ${a.source.path} — source dropped`)
          const { source: _drop, ...rest } = a
          return rest
        }),
        steps: parsed.planMap.steps.map((st) => (ids.has(st.sectionId) ? st : { ...st, sectionId: '' })),
        deviations: parsed.planMap.deviations.filter((d) => ids.has(d.sectionId) || d.sectionId === '')
      }
    : undefined

  return { annotations: { ...parsed, sections, planMap }, warnings }
}

