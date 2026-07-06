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
      if (diagramHasCycle(nodeIds, edges)) {
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

  // A4: `parsed.hotspots` is GENERATION-TRANSIENT (consumed once at the ipc
  // post-merge seam via `mintHotspotComments`) — explicitly dropped here rather
  // than spread through, so it can never leak into the persisted annotations.
  const { hotspots: _hotspots, ...parsedRest } = parsed
  return { annotations: { ...parsedRest, sections, planMap }, warnings }
}

/** Cheap DFS cycle check over a diagram's (already node-id-valid) edges. Cycles
 *  are not dropped — only warned about — since the renderer's `layoutDiagram`
 *  already falls back to a flat node/edge list rather than crashing. */
function diagramHasCycle(nodeIds: ReadonlySet<string>, edges: { from: string; to: string }[]): boolean {
  const out = new Map<string, string[]>()
  for (const id of nodeIds) out.set(id, [])
  for (const e of edges) out.get(e.from)?.push(e.to)
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>([...nodeIds].map((id) => [id, WHITE]))
  const visit = (id: string): boolean => {
    color.set(id, GRAY)
    for (const next of out.get(id) ?? []) {
      const c = color.get(next)
      if (c === GRAY) return true
      if (c === WHITE && visit(next)) return true
    }
    color.set(id, BLACK)
    return false
  }
  for (const id of nodeIds) if (color.get(id) === WHITE && visit(id)) return true
  return false
}
