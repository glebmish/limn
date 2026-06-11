import { z } from 'zod'

export const sectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string(),
  what: z.string(),
  files: z.array(z.string()),
  order: z.number(),
  diagram: z.array(z.tuple([z.string(), z.enum(['', 'hi', 'new']), z.string()])).optional(),
  insight: z.object({ caption: z.string() }).optional(),
  flags: z.array(z.object({
    file: z.string(),
    hunkRange: z.string().optional(),
    risk: z.boolean(),
    label: z.string(),
    text: z.string()
  })).default([]),
  plainNotes: z.record(z.string(), z.string()).optional()
})

export const planMapSchema = z.object({
  acceptance: z.array(z.object({ text: z.string(), met: z.union([z.boolean(), z.literal('partial')]) })),
  steps: z.array(z.object({
    n: z.number(), text: z.string(), sectionId: z.string(),
    status: z.enum(['done', 'changed', 'missing'])
  })),
  deviations: z.array(z.object({ text: z.string(), sectionId: z.string() }))
})

export const reviewAnnotationsSchema = z.object({
  title: z.string(),
  summary: z.string(),
  sections: z.array(sectionSchema),
  planMap: planMapSchema.optional(),
  questions: z.array(z.object({ id: z.string(), text: z.string(), context: z.string().optional() })).default([]),
  artifactPaths: z.array(z.string()).optional()
})

export const fixResultSchema = z.object({
  summary: z.string(),
  resolutions: z.array(z.object({
    commentId: z.string(),
    verdict: z.enum(['addressed', 'reworked', 'skipped']),
    note: z.string()
  }))
})

// JSON Schemas for the SDKs' structured-output options
export const reviewJsonSchema = z.toJSONSchema(reviewAnnotationsSchema)
export const fixJsonSchema = z.toJSONSchema(fixResultSchema)
