import { z } from 'zod'
import type { AgentQuestion, FocusTarget, ReviewAnnotations, Section } from '../../shared/types.js'

// Wire schemas: schema-in-prompt output validated client-side by zod (no native
// output-schema channel post-ACP). Keep shapes prompt-friendly: flat objects over
// unions, arrays over records, no z.tuple. `.optional()` for omittable fields so a
// sparse output is the cheap path and omission never burns the single repair turn.

const wireAnchor = z.object({
  file: z.string(),
  side: z.enum(['new', 'old']).optional(),   // absent = 'new'
  line: z.number().optional(),               // absent = whole file
  endLine: z.number().optional()             // absent = single line
})
const wireBlock = z.object({
  text: z.string(),
  anchor: wireAnchor.optional()              // absent = framing/cross-cutting block
})
const wireDiagram = z.object({
  why: z.string(),
  caption: z.string(),
  nodes: z.array(z.object({
    id: z.string(),
    label: z.string(),
    kind: z.enum(['plain', 'hi', 'new']),
    sub: z.string().optional(),
    anchor: wireAnchor.optional()
  })),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() }))
})
const wireSection = z.object({
  id: z.string(),
  name: z.string(),
  files: z.array(z.string()),
  narration: z.array(wireBlock),
  diagram: wireDiagram.optional(),
  contrast: z.object({ was: z.string(), now: z.string() }).optional(),
  verify: z.string().optional(),
  afterSectionId: z.string().optional()      // scoped-patch placement only; ignored on full gen
})

const wirePlanMap = z.object({
  acceptance: z.array(z.object({
    text: z.string(),
    met: z.union([z.boolean(), z.literal('partial')]),
    source: z.object({ path: z.string(), line: z.number().optional() }).optional()
  })),
  steps: z.array(z.object({
    n: z.number(), text: z.string(), sectionId: z.string(),
    status: z.enum(['done', 'changed', 'missing'])
  })),
  deviations: z.array(z.object({ text: z.string(), sectionId: z.string() }))
})

const wireQuestion = z.object({
  id: z.string(),
  text: z.string(),
  context: z.string().nullable(),
  options: z.array(z.string())
})

export const reviewWireSchema = z.object({
  title: z.string(),
  summary: z.string(),
  sections: z.array(wireSection),
  planMap: wirePlanMap.nullable(),
  questions: z.array(wireQuestion),
  artifactPaths: z.array(z.string()).nullable(),
  hotspots: z.array(z.object({ anchor: wireAnchor, text: z.string(), severity: z.enum(['risk', 'note']) }))
})

// Scoped-update patch: what the engine returns for a diff-scoped iteration.
// `null` scalars mean "keep prior"; the id arrays are the anti-hallucination
// handshake the splice validates. wireSection/wireQuestion are reused verbatim
// so a revised/new section is byte-identical in shape to a fresh generation.
export const scopedReviewWireSchema = z.object({
  title: z.string().nullable(),
  summary: z.string().nullable(),
  revisedSections: z.array(wireSection),
  deletedSectionIds: z.array(z.string()),
  keptSectionIds: z.array(z.string()),
  newQuestions: z.array(wireQuestion),
  resolvedQuestionIds: z.array(z.string()),
  planMap: wirePlanMap.nullable()
})

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>
  delete js.$schema
  return js
}

// JSON Schema for the SDKs' structured-output options
export const reviewJsonSchema = toJsonSchema(reviewWireSchema)
export const scopedReviewJsonSchema = toJsonSchema(scopedReviewWireSchema)

// Parsed scoped patch; splice consumes this against the prior annotations.
export type ScopedReviewPatch = z.infer<typeof scopedReviewWireSchema>
// Wire-shape section/question, reused by the splice to convert revised/new bodies.
export type WireSection = z.infer<typeof wireSection>
export type WireQuestion = z.infer<typeof wireQuestion>
export type WireAnchor = z.infer<typeof wireAnchor>

export function parseScopedOutput(raw: unknown): ScopedReviewPatch {
  return scopedReviewWireSchema.parse(raw)
}

/** Flat wire anchor → FocusTarget. no line ⇒ whole-file; line ⇒ diff range.
 *  Degenerate combos degrade: endLine<line drops endLine; side/endLine without line ignored. */
export function normalizeWireAnchor(a: WireAnchor): FocusTarget {
  if (a.line === undefined) return { kind: 'file', file: a.file }
  const endLine = a.endLine !== undefined && a.endLine >= a.line ? a.endLine : undefined
  return { kind: 'diff', file: a.file, side: a.side ?? 'new', line: a.line, ...(endLine ? { endLine } : {}), hunkRange: '', lineContent: '' }
}

/** Map a wire section to the domain Section. `afterSectionId` (scoped-patch
 *  placement) lives on `WireSection` only — splice.ts looks it up from the raw
 *  patch by id; it is not threaded onto the domain type. */
export function sectionFromWire(s: WireSection): Section {
  return {
    id: s.id,
    name: s.name,
    files: s.files,
    narration: s.narration.map((b) => ({ text: b.text, ...(b.anchor ? { anchor: normalizeWireAnchor(b.anchor) } : {}) })),
    ...(s.diagram ? { diagram: {
      why: s.diagram.why, caption: s.diagram.caption,
      nodes: s.diagram.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.kind, ...(n.sub ? { sub: n.sub } : {}), ...(n.anchor ? { anchor: normalizeWireAnchor(n.anchor) } : {}) })),
      edges: s.diagram.edges
    } } : {}),
    ...(s.contrast ? { contrast: s.contrast } : {}),
    ...(s.verify ? { verify: s.verify } : {})
  }
}

/** Map a wire question to the domain AgentQuestion (trim/dedup/cap the options). */
export function questionFromWire(q: WireQuestion): AgentQuestion {
  const options = [...new Set(q.options.map((o) => o.trim()).filter(Boolean))].slice(0, 4)
  return {
    id: q.id,
    text: q.text,
    context: q.context ?? undefined,
    ...(options.length ? { options } : {})
  }
}

export function parseReviewOutput(raw: unknown): ReviewAnnotations {
  const wire = reviewWireSchema.parse(raw)
  return {
    title: wire.title,
    summary: wire.summary,
    sections: wire.sections.map(sectionFromWire),
    planMap: wire.planMap ?? undefined,
    questions: wire.questions.map(questionFromWire),
    artifactPaths: wire.artifactPaths ?? undefined
  }
}
