import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Finding 120 (2026-09-07 audit): scripts/pack-local.sh used to `npm pack` whatever
// was on disk in dist/ with no existence or freshness check, so a forgotten `npm run
// build` silently shipped a stale (or missing) dogfood tarball. These tests run the
// real script, offline, in a throwaway root: a stub `npm` on PATH means no network
// call ever happens, and the log it writes proves whether the script got that far.

const SCRIPT = path.join(__dirname, '..', 'scripts', 'pack-local.sh')

/** A throwaway "repo root" holding just what pack-local.sh looks at: its own copy of
 *  the script, and (per test) a package.json plus dist/ and src/ trees. */
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-pack-local-'))
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  const script = path.join(root, 'scripts', 'pack-local.sh')
  fs.copyFileSync(SCRIPT, script)
  fs.chmodSync(script, 0o755)
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"pack-local-fixture"}\n')
  return root
}

/** A `npm` stub on its own PATH entry that never touches the network — it just
 *  appends the invocation to a log file and exits 0, so a passing run can be told
 *  apart from a refusal without either ever shelling out for real. */
function stubNpm(root: string): { bin: string; log: string } {
  const bin = path.join(root, 'stub-bin')
  const log = path.join(root, 'npm.log')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env bash\necho "npm $*" >> "${log}"\nexit 0\n`)
  fs.chmodSync(path.join(bin, 'npm'), 0o755)
  return { bin, log }
}

function run(root: string, binDir: string): { status: number; stderr: string } {
  try {
    execFileSync(path.join(root, 'scripts', 'pack-local.sh'), [], {
      cwd: root,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: 'utf8'
    })
    return { status: 0, stderr: '' }
  } catch (err) {
    const e = err as { status: number; stderr: string }
    return { status: e.status, stderr: e.stderr }
  }
}

describe('scripts/pack-local.sh: refuses a missing or stale dist/ (finding 120)', () => {
  it('refuses when dist/ is missing entirely, without ever invoking npm', () => {
    const root = makeRoot()
    const { bin, log } = stubNpm(root)

    const res = run(root, bin)

    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('dist/ is missing')
    expect(fs.existsSync(log)).toBe(false)
  })

  it('refuses when dist/ exists but predates the newest src/ file', () => {
    const root = makeRoot()
    fs.mkdirSync(path.join(root, 'dist', 'renderer'), { recursive: true })
    fs.mkdirSync(path.join(root, 'dist', 'server'), { recursive: true })
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    const older = new Date(Date.now() - 60_000)
    const newer = new Date()
    fs.utimesSync(path.join(root, 'dist'), older, older)
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
    fs.utimesSync(path.join(root, 'src', 'a.ts'), newer, newer)
    const { bin, log } = stubNpm(root)

    const res = run(root, bin)

    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('dist/ is older than src/')
    expect(fs.existsSync(log)).toBe(false)
  })

  it('packs when dist/ is present and newer than every src/ file', () => {
    const root = makeRoot()
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
    fs.mkdirSync(path.join(root, 'dist', 'renderer'), { recursive: true })
    fs.mkdirSync(path.join(root, 'dist', 'server'), { recursive: true })
    const older = new Date(Date.now() - 60_000)
    const newer = new Date()
    fs.utimesSync(path.join(root, 'src', 'a.ts'), older, older)
    fs.utimesSync(path.join(root, 'dist'), newer, newer)
    const { bin, log } = stubNpm(root)

    const res = run(root, bin)

    expect(res.status).toBe(0)
    const calls = fs.readFileSync(log, 'utf8')
    expect(calls).toContain('npm ci --omit=optional')
    expect(calls).toContain('npm pack')
  })
})
