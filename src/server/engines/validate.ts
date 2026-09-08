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

  const surviving: { section: Section; files: string[] }[] = []
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
    surviving.push({ section: s, files })
  }

  // A section id is a key downstream: the section-anchored comment, the React list
  // key, the scroll ref and every planMap jump target. The schema only
  // asks the agent for a "short stable id", so uniqueness is minted here — the scoped
  // path already does the same for new sections (splice.ts step 4). Every id a
  // surviving section actually cites is RESERVED before any minting, so an empty or
  // duplicate id early in the list can never take an id a later section legitimately
  // owns — that would be exactly the id churn this hygiene exists to prevent.
  const reserved = new Set(surviving.map((x) => x.section.id.trim()).filter(Boolean))
  const used = new Set<string>()
  const freeId = (base: string): string => {
    const isFree = (id: string): boolean => !used.has(id) && !reserved.has(id)
    if (isFree(base)) return base
    let n = 2
    while (!isFree(`${base}-${n}`)) n++
    return `${base}-${n}`
  }

  const sections: Section[] = []
  for (const { section: s, files } of surviving) {
    // a padded id is trimmed silently; only a missing or already-taken one is warned.
    const cited = s.id.trim()
    const id = cited && !used.has(cited) ? cited : freeId(cited || 'section')
    if (!cited) warnings.push(`section "${s.name}" has no id — minted "${id}"`)
    else if (id !== cited) warnings.push(`duplicate section id "${cited}" — re-minted as "${id}"`)
    used.add(id)
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
        // like a step (line above): the dangling LINK is dropped, never the agent's
        // prose. Dropping the entry would also shift every later deviation's index,
        // the key its comment anchors use ({ kind: 'deviation', index }).
        deviations: parsed.planMap.deviations.map((d) => {
          if (d.sectionId === '' || ids.has(d.sectionId)) return d
          warnings.push(`plan deviation "${d.text}" cites unknown section ${d.sectionId} — section link dropped`)
          return { ...d, sectionId: '' }
        })
      }
    : undefined

  return { annotations: { ...parsed, sections, planMap }, warnings }
}

