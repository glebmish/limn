import { describe, it, expect } from 'vitest'
import { parseCliArgs } from '../src/main/cli'

describe('parseCliArgs', () => {
  it('returns null without --cli', () => {
    expect(parseCliArgs(['node', 'app'])).toBeNull()
    expect(parseCliArgs(['node', 'app', '--dir', '/x'])).toBeNull()
  })

  it('parses --dir, --base, --compare after --cli', () => {
    const a = parseCliArgs(['node', 'app', '--cli', '--dir', '/repo', '--base', 'main', '--compare', 'feature'])
    expect(a).toEqual({ dir: '/repo', base: 'main', compare: 'feature' })
  })

  it('defaults dir to cwd when --dir is absent', () => {
    const a = parseCliArgs(['node', 'app', '--cli', '--compare', 'feature'])
    expect(a).toEqual({ dir: process.cwd(), compare: 'feature' })
  })

  it('base/compare are optional', () => {
    expect(parseCliArgs(['node', 'app', '--cli', '--dir', '/repo'])).toEqual({ dir: '/repo' })
  })

  it('ignores unknown flags and tolerates flag order', () => {
    const a = parseCliArgs(['/Applications/limn.app/Contents/MacOS/limn',
      '--cli', '--compare', 'feature', '--dir', '/repo', '--unknown', 'x'])
    expect(a).toEqual({ dir: '/repo', compare: 'feature' })
  })

  it('does not consume a following flag as the value (forwarded argv is reordered)', () => {
    // Chromium canonicalizes a forwarded second-instance argv: bare positionals
    // (the repo path) move to the end, so the token after --dir is an unrelated
    // switch. We must not treat that switch as the directory.
    const a = parseCliArgs(['app', '--cli', '--dir', '--allow-file-access-from-files', '/real/repo'])
    expect(a?.dir).toBe(process.cwd())   // falls back to cwd, never the switch
    expect(a?.dir).not.toBe('--allow-file-access-from-files')
  })

  it('accepts attached --name=value forms (survive argv canonicalization)', () => {
    const a = parseCliArgs(['app', '--cli', '--dir=/repo', '--base=main', '--compare=feature'])
    expect(a).toEqual({ dir: '/repo', base: 'main', compare: 'feature' })
  })

  it('treats --branch as the preferred alias for the compare side', () => {
    expect(parseCliArgs(['app', '--cli', '--dir=/repo', '--branch', 'feature']))
      .toEqual({ dir: '/repo', compare: 'feature' })
    expect(parseCliArgs(['app', '--cli', '--dir=/repo', '--branch=feature']))
      .toEqual({ dir: '/repo', compare: 'feature' })
  })

  it('parses the boolean --hub flag', () => {
    expect(parseCliArgs(['app', '--cli', '--dir=/repo', '--hub']))
      .toEqual({ dir: '/repo', hub: true })
  })

  it('parses the boolean --new flag (force a fresh review)', () => {
    expect(parseCliArgs(['app', '--cli', '--dir=/repo', '--branch=feature', '--new']))
      .toEqual({ dir: '/repo', compare: 'feature', fresh: true })
  })

  it('omits hub/fresh when their flags are absent (not false)', () => {
    const a = parseCliArgs(['app', '--cli', '--dir=/repo'])
    expect(a).toEqual({ dir: '/repo' })
    expect('hub' in a!).toBe(false)
    expect('fresh' in a!).toBe(false)
  })
})
