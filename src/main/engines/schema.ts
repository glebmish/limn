import { z } from 'zod'
import type { FixResult, ReviewAnnotations } from '../../shared/types.js'

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
  flags: z.array(z.object({
    file: z.string(),
    hunkRange: z.string().nullable(),
    risk: z.boolean(),
    label: z.string(),
    text: z.string()
  })),
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

export const reviewWireSchema = z.object({
  title: z.string(),
  summary: z.string(),
  sections: z.array(wireSection),
  planMap: wirePlanMap.nullable(),
  questions: z.array(z.object({ id: z.string(), text: z.string(), context: z.string().nullable() })),
  artifactPaths: z.array(z.string()).nullable()
})

export const fixWireSchema = z.object({
  summary: z.string(),
  resolutions: z.array(z.object({
    commentId: z.string(),
    verdict: z.enum(['addressed', 'reworked', 'skipped']),
    note: z.string()
  }))
})

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>
  delete js.$schema
  return js
}

// JSON Schemas for the SDKs' structured-output options
export const reviewJsonSchema = toJsonSchema(reviewWireSchema)
export const fixJsonSchema = toJsonSchema(fixWireSchema)

export function parseReviewOutput(raw: unknown): ReviewAnnotations {
  const wire = reviewWireSchema.parse(raw)
  return {
    title: wire.title,
    summary: wire.summary,
    sections: wire.sections.map((s) => ({
      id: s.id,
      name: s.name,
      desc: s.desc,
      what: s.what,
      files: s.files,
      order: s.order,
      diagram: s.diagram?.map((n) => [n.label, n.kind, n.sub] as [string, '' | 'hi' | 'new', string]) ?? undefined,
      insight: s.insight ?? undefined,
      flags: s.flags.map((f) => ({ ...f, hunkRange: f.hunkRange ?? undefined })),
      plainNotes: s.plainNotes ? Object.fromEntries(s.plainNotes.map((p) => [p.file, p.note])) : undefined
    })),
    planMap: wire.planMap ?? undefined,
    questions: wire.questions.map((q) => ({ ...q, context: q.context ?? undefined })),
    artifactPaths: wire.artifactPaths ?? undefined
  }
}

export function parseFixOutput(raw: unknown): FixResult {
  return fixWireSchema.parse(raw)
}
