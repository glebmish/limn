import { z } from 'zod'
import type { AgentQuestion, DiagramNode, ReviewAnnotations, Section } from '../../shared/types.js'

// Wire schemas: what the engines are asked to return. Constraints from the two
// structured-output validators:
//  - Claude CLI silently drops schemas containing prefixItems → no z.tuple;
//    diagram nodes travel as objects and are mapped to DiagramNode tuples after parsing.
//  - OpenAI strict mode requires every property in `required`, forbids records →
//    optionals are modeled as nullable, plainNotes travels as an array of {file, note}.

const wireDiagramNode = z.object({
  label: z.string(),
  kind: z.enum(['', 'hi', 'new']),
  sub: z.string()
})

const wireSection = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string(),
  what: z.string(),
  files: z.array(z.string()),
  order: z.number(),
  diagram: z.array(wireDiagramNode).nullable(),
  insight: z.object({ caption: z.string() }).nullable(),
  plainNotes: z.array(z.object({ file: z.string(), note: z.string() })).nullable()
})

const wirePlanMap = z.object({
  acceptance: z.array(z.object({ text: z.string(), met: z.union([z.boolean(), z.literal('partial')]) })),
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
  artifactPaths: z.array(z.string()).nullable()
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

export function parseScopedOutput(raw: unknown): ScopedReviewPatch {
  return scopedReviewWireSchema.parse(raw)
}

/** Map a wire section (nullable objects/arrays) to the domain Section (tuples/records). */
export function sectionFromWire(s: WireSection): Section {
  return {
    id: s.id,
    name: s.name,
    desc: s.desc,
    what: s.what,
    files: s.files,
    order: s.order,
    diagram: s.diagram?.map((n) => [n.label, n.kind, n.sub] as DiagramNode) ?? undefined,
    insight: s.insight ?? undefined,
    plainNotes: s.plainNotes ? Object.fromEntries(s.plainNotes.map((p) => [p.file, p.note])) : undefined
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
