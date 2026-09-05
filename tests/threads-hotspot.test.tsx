import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Comment } from '../src/shared/types'
import { InlineThread } from '../src/renderer/components/Threads'

function hotspotComment(over: Partial<Comment> = {}): Comment {
  return {
    id: 'hs-1',
    anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '', lineContent: '' },
    author: 'agent',
    text: 'This branch is unreachable if input is empty.',
    severity: 'risk',
    status: 'resolved',
    replies: [],
    createdAt: 'now',
    iteration: 1,
    ...over
  }
}

const html = (c: Comment): string => renderToStaticMarkup(<InlineThread c={c} locLabel="src/a.ts:2" />)

describe('InlineThread — hotspot severity badge (A4)', () => {
  it('renders the severity badge for a risk hotspot', () => {
    const out = html(hotspotComment())
    expect(out).toContain('sev-badge')
    expect(out).toContain('sev-risk')
    expect(out).toContain('risk')
  })

  it('renders the severity badge for a note hotspot', () => {
    const out = html(hotspotComment({ severity: 'note' }))
    expect(out).toContain('sev-note')
    expect(out).toContain('note')
  })

  it('renders no badge when severity is absent', () => {
    const out = html(hotspotComment({ severity: undefined }))
    expect(out).not.toContain('sev-badge')
  })
})

describe('InlineThread — resolved comments keep a re-queue control (spec Decision 19)', () => {
  it('shows Re-queue for a resolved agent (hotspot) comment', () => {
    const out = html(hotspotComment())
    expect(out).toContain('requeue')
    expect(out).toContain('Re-queue')
  })

  it('shows Re-queue for a resolved reviewer-authored comment too', () => {
    const out = html(hotspotComment({
      author: 'user',
      severity: undefined,
      resolution: { verdict: 'addressed', note: 'Fixed in a follow-up commit.' }
    }))
    expect(out).toContain('requeue')
    expect(out).toContain('Re-queue')
  })

  it('does not show Re-queue for a queued comment', () => {
    const out = html(hotspotComment({ author: 'user', severity: undefined, status: 'queued' }))
    expect(out).not.toContain('Re-queue')
  })
})

describe('InlineThread — resolution note renders as a reply (B4 channel dedup)', () => {
  it('renders the resolution note as a reply-styled thread entry, not just verdict metadata', () => {
    const out = html(hotspotComment({
      author: 'user',
      severity: undefined,
      resolution: { verdict: 'addressed', note: 'Fixed the null check in a follow-up commit.' }
    }))
    // the note text appears in the thread body (previously only sat in a title attr)
    expect(out).toContain('Fixed the null check in a follow-up commit.')
    // it is wrapped in the same reply-entry class the human/agent reply thread uses
    const replyIdx = out.indexOf('dreply')
    expect(replyIdx).toBeGreaterThan(-1)
    const afterReply = out.slice(replyIdx)
    expect(afterReply).toContain('Fixed the null check in a follow-up commit.')
  })
})

// A thread can be continued (GitHub-style): a resolved comment — the reviewer's or an
// agent hotspot — offers Reply beside Re-queue. Re-queue resends the original text;
// Reply adds a turn and re-queues the whole thread.
describe('InlineThread — resolved threads can be continued', () => {
  it('shows Reply for a resolved reviewer comment', () => {
    const out = html(hotspotComment({ author: 'user', severity: undefined, resolution: { verdict: 'addressed', note: 'Done.' } }))
    expect(out).toContain('>Reply<')
    expect(out).toContain('Re-queue')
  })

  it('shows Reply for a resolved agent hotspot', () => {
    expect(html(hotspotComment())).toContain('>Reply<')
  })

  it('does not show Reply for a queued comment (Edit is the control there)', () => {
    const out = html(hotspotComment({ author: 'user', severity: undefined, status: 'queued' }))
    expect(out).not.toContain('>Reply<')
    expect(out).toContain('Edit')
  })

  it('renders a folded earlier resolution with its verdict, in thread order before the reply', () => {
    const out = html(hotspotComment({
      author: 'user', severity: undefined, status: 'queued', resolution: undefined,
      replies: [
        { author: 'agent', text: 'Replaced the prefix with a union.', at: 't1', verdict: 'addressed' },
        { author: 'user', text: 'not quite', at: 't2' }
      ]
    }))
    expect(out.indexOf('✓ addressed')).toBeGreaterThan(-1)
    expect(out.indexOf('Replaced the prefix with a union.')).toBeLessThan(out.indexOf('not quite'))
    expect(out).toContain('>replied<')
  })

  it('renders the live resolution after the replies — it is the latest turn', () => {
    const out = html(hotspotComment({
      author: 'user', severity: undefined,
      replies: [{ author: 'user', text: 'first follow-up', at: 't1' }],
      resolution: { verdict: 'reworked', note: 'Reworked the summary.' }
    }))
    // lastIndexOf: the header's verdict chip carries the note in a title attr, before the body
    expect(out.indexOf('first follow-up')).toBeLessThan(out.lastIndexOf('Reworked the summary.'))
  })
})

// The status chips follow the LATEST turn. A reply lands at the bottom of the thread;
// a "queued for agent" chip up in the card header said nothing about whether that
// reply had gone anywhere.
describe('InlineThread — status chips sit on the latest turn', () => {
  const replied = (over: Partial<Comment> = {}): Comment => hotspotComment({
    author: 'user', severity: undefined, resolution: undefined, status: 'queued', text: 'using text and prefix for logic smells',
    replies: [
      { author: 'agent', text: 'Replaced the prefix with a union.', at: 't1', verdict: 'addressed' },
      { author: 'user', text: 'not quite', at: 't2' }
    ],
    ...over
  })

  // (a turn's chips sit in its header row, which precedes its text — so "on the last
  // reply" means after every earlier turn's text and absent from the card header)
  it('a queued reply carries "queued for agent" + Send now on the reply, not the card header', () => {
    const out = html(replied())
    const prior = out.indexOf('Replaced the prefix with a union.')
    expect(out.indexOf('queued for agent')).toBeGreaterThan(prior)
    expect(out.indexOf('Send now')).toBeGreaterThan(prior)
    expect(out.slice(0, out.indexOf('using text and prefix'))).not.toContain('queued for agent')
  })

  it('a sent reply shows "with agent…" on the reply', () => {
    const out = html(replied({ status: 'sent' }))
    expect(out.indexOf('with agent…')).toBeGreaterThan(out.indexOf('Replaced the prefix with a union.'))
  })

  it('a reviewer reply on an agent hotspot gets the queued chip too (the turn is the reviewer\'s)', () => {
    const out = html(hotspotComment({ status: 'queued', replies: [{ author: 'user', text: 'agree, fix it', at: 't1' }] }))
    expect(out.indexOf('queued for agent')).toBeGreaterThan(out.indexOf('This branch is unreachable'))
  })

  it('the verdict chip sits on the resolution entry when there is one', () => {
    const out = html(hotspotComment({ author: 'user', severity: undefined, resolution: { verdict: 'addressed', note: 'Done.' } }))
    const entry = out.indexOf('>resolution<')
    expect(entry).toBeGreaterThan(-1)
    expect(out.indexOf('✓ addressed')).toBeGreaterThan(entry)
  })

  it('a thread with no replies keeps its chips in the card header (unchanged)', () => {
    const out = html(hotspotComment({ author: 'user', severity: undefined, status: 'queued', resolution: undefined }))
    expect(out.indexOf('queued for agent')).toBeLessThan(out.indexOf('This branch is unreachable'))
  })
})
