import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

describe('bin/limn.js', () => {
  // A clone that was never built (or a broken install) has bin/ but no dist/.
  it('prints a build hint instead of a stack trace when dist/ is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-bin-'))
    try {
      fs.mkdirSync(path.join(dir, 'bin'))
      const bin = path.join(dir, 'bin', 'limn.js')
      fs.copyFileSync(path.resolve('bin/limn.js'), bin)
      const r = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/dist\/ is missing/)
      expect(r.stderr).toMatch(/npm run build|reinstall/)
      expect(r.stderr).not.toMatch(/node:internal/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
