import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readCliState, writeCliState } from '../src/cli/state'

describe('cli state file', () => {
  it('round-trips through the given file, creating its directory, and tolerates a missing or corrupt one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-state-'))
    try {
      const file = path.join(dir, 'nested', 'cli.json')
      expect(readCliState(file)).toEqual({})
      writeCliState({ servicePromptDeclined: true }, file)
      expect(readCliState(file)).toEqual({ servicePromptDeclined: true })
      expect(fs.readFileSync(file, 'utf8').endsWith('\n')).toBe(true)
      fs.writeFileSync(file, '{not json')
      expect(readCliState(file)).toEqual({})
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
