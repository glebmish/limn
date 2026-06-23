import { describe, it, expect } from 'vitest'
import { parseSchemaVersion } from '../src/main/db/db'

describe('parseSchemaVersion', () => {
  it('parses a normal numeric version', () => {
    expect(parseSchemaVersion('3')).toBe(3)
  })

  it('treats a missing row as version 0', () => {
    expect(parseSchemaVersion(undefined)).toBe(0)
  })

  it('treats a non-numeric (corrupt) value as version 0 rather than NaN', () => {
    // A corrupt schema_version must not become NaN: `m.version <= NaN` is always
    // false, which silently re-runs every migration on an otherwise healthy db.
    expect(parseSchemaVersion('corrupt')).toBe(0)
    expect(parseSchemaVersion('')).toBe(0)
  })
})
