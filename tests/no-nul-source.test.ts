import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectSourceFiles(full, out)
    else if (/\.(?:mts|ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('source files', () => {
  it('do not contain NUL bytes', () => {
    const roots = ['src', 'tests'].map((p) => path.join(process.cwd(), p)).filter((p) => fs.existsSync(p))
    const offenders = roots
      .flatMap((root) => collectSourceFiles(root))
      .filter((file) => fs.readFileSync(file).includes(0))
      .map((file) => path.relative(process.cwd(), file))

    expect(offenders).toEqual([])
  })
})
