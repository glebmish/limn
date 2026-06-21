import { describe, it, expect } from 'vitest'
import { buildChatPrompt } from '../src/main/engines/prompts'

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
})
