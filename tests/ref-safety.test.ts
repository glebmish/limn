import { describe, it, expect, beforeAll } from 'vitest'
import { assertSafeRef, resolveRefInput } from '../src/main/git'
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixtureRepo'

describe('assertSafeRef', () => {
  it('accepts ordinary refs', () => {
    expect(() => assertSafeRef('main')).not.toThrow()
    expect(() => assertSafeRef('HEAD~3')).not.toThrow()
    expect(() => assertSafeRef('feature/x')).not.toThrow()
    expect(() => assertSafeRef('a1b2c3d')).not.toThrow()
  })

  it('rejects a ref that would be parsed as a git option', () => {
    // A leading dash turns a positional ref operand into a git flag
    // (e.g. --upload-pack=…, --output=…) — argument injection.
    expect(() => assertSafeRef('-x')).toThrow()
    expect(() => assertSafeRef('--upload-pack=evil')).toThrow()
    expect(() => assertSafeRef('--output=/tmp/pwn')).toThrow()
  })
})

describe('resolveRefInput rejects option-like refs before touching git', () => {
  let fx: FixtureRepo
  beforeAll(() => { fx = makeFixtureRepo() })

  it('throws on a leading-dash input', async () => {
    await expect(resolveRefInput(fx.dir, '--upload-pack=evil')).rejects.toThrow()
  })

  it('still resolves a real branch', async () => {
    const r = await resolveRefInput(fx.dir, 'feature')
    expect(r.kind).toBe('branch')
    expect(r.symbol).toBe('feature')
  })
})
