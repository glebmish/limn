import { describe, it, expect } from 'vitest'
import { buildChatPrompt, buildReviewPrompt } from '../src/main/engines/prompts'
import type { ReviewRequest } from '../src/main/engines/types'

const baseReq: ReviewRequest = {
  repo: '/tmp/repo', branch: 'feat/x', base: 'main', artifacts: [],
  diff: { base: 'main', branch: 'feat/x', mergeBase: 'a'.repeat(40), headSha: 'b'.repeat(40), files: [] }
}

describe('buildReviewPrompt steer', () => {
  it('embeds the reviewer steer when provided', () => {
    const p = buildReviewPrompt({ ...baseReq, steer: 'focus on error handling' })
    expect(p).toContain('STEER FROM THE REVIEWER')
    expect(p).toContain('focus on error handling')
  })
  it('omits the steer block when no steer is given', () => {
    expect(buildReviewPrompt(baseReq)).not.toContain('STEER FROM THE REVIEWER')
  })
})

describe('buildReviewPrompt update (drift "Update review")', () => {
  it('folds the prior review in when prior is provided', () => {
    const p = buildReviewPrompt({
      ...baseReq,
      prior: { title: 'Billing overhaul', summary: 'Adds subscriptions.', sections: ['Migrations', 'Lifecycle'], sinceSha: 'c'.repeat(40) }
    })
    expect(p).toContain('UPDATING AN EXISTING REVIEW')
    expect(p).toContain('Billing overhaul')
    expect(p).toContain('- Migrations')
    expect(p).toContain('ccccccc') // sinceSha short
  })
  it('omits the update block on a from-scratch pass', () => {
    expect(buildReviewPrompt(baseReq)).not.toContain('UPDATING AN EXISTING REVIEW')
  })
})

// describeAnchor is module-private; exercise it through buildChatPrompt, which
// embeds "the user is asking about <describeAnchor(anchor)>".
describe('describeAnchor (via buildChatPrompt)', () => {
  it('labels a plain section anchor without a part', () => {
    const p = buildChatPrompt('hi', { kind: 'section', sectionId: 's1' })
    expect(p).toContain('asking about review section "s1".')
    expect(p).not.toContain('(diagram)')
    expect(p).not.toContain('(narration)')
  })

  it('labels a section diagram comment', () => {
    const p = buildChatPrompt('hi', { kind: 'section', sectionId: 's1', part: 'diagram' })
    expect(p).toContain('review section "s1" (diagram)')
  })

  it('labels a section narration comment', () => {
    const p = buildChatPrompt('hi', { kind: 'section', sectionId: 's1', part: 'narration' })
    expect(p).toContain('review section "s1" (narration)')
  })

  it('still labels summary, file, and plan-step anchors', () => {
    expect(buildChatPrompt('x', { kind: 'summary' })).toContain('the overall review summary')
    expect(buildChatPrompt('x', { kind: 'file', file: 'src/a.ts' })).toContain('file src/a.ts')
    expect(buildChatPrompt('x', { kind: 'plan-step', stepN: 3 })).toContain('plan step 3')
  })

  it('labels the title, acceptance, and deviation anchors', () => {
    expect(buildChatPrompt('x', { kind: 'title' })).toContain('the review title')
    expect(buildChatPrompt('x', { kind: 'acceptance', index: 1 })).toContain('acceptance criterion 2')
    expect(buildChatPrompt('x', { kind: 'deviation', index: 0 })).toContain('plan deviation 1')
  })

  it('labels a text-selection anchor with its quote and region', () => {
    expect(buildChatPrompt('x', { kind: 'selection', scope: { region: 'summary' }, quote: 'token bucket', prefix: '', suffix: '' }))
      .toContain('selected text “token bucket” in the overall review summary')
    expect(buildChatPrompt('x', { kind: 'selection', scope: { region: 'section', sectionId: 's1' }, quote: 'guard', prefix: '', suffix: '' }))
      .toContain('selected text “guard” in review section "s1"')
    expect(buildChatPrompt('x', { kind: 'selection', scope: { region: 'artifact', path: 'docs/p.md' }, quote: 'cap', prefix: '', suffix: '' }))
      .toContain('selected text “cap” in docs/p.md')
    expect(buildChatPrompt('x', { kind: 'selection', scope: { region: 'file-note', file: 'src/a.ts' }, quote: 'limiter', prefix: '', suffix: '' }))
      .toContain('selected text “limiter” in the note for src/a.ts')
  })
})
