import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface FixtureRepo {
  dir: string
  shas: { base: string; firstFeature: string; head: string }
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fix@test',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fix@test'
    }
  }).trim()
}

function write(dir: string, rel: string, content: string): void {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

/** Builds a throwaway repo:
 *  main: src/a.ts, src/old.ts, src/moveme.ts, docs/spec.md, img.bin, noeol.txt
 *  feature: edits a.ts, adds src/b.ts, deletes old.ts, renames moveme.ts,
 *           changes img.bin, edits noeol.txt, then 2 more commits (for since-SHA tests).
 */
export function makeFixtureRepo(): FixtureRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-fix-'))
  git(dir, 'init', '-b', 'main')
  // Pin a repo-local identity so commits made by the app's own git calls (which
  // don't carry our GIT_AUTHOR_* env) succeed on machines with no global git
  // identity — e.g. CI runners, where git otherwise fails with "empty ident".
  git(dir, 'config', 'user.name', 'Fixture')
  git(dir, 'config', 'user.email', 'fix@test')

  write(dir, 'src/a.ts', ['export function a() {', '  return 1', '}', 'export const K = 10', ''].join('\n'))
  write(dir, 'src/old.ts', 'export const gone = true\n')
  write(dir, 'src/moveme.ts', ['export const stay1 = 1', 'export const stay2 = 2', 'export const stay3 = 3', ''].join('\n'))
  write(dir, 'docs/spec.md', '# Rate limiting spec\n\nGoal: protect the API on branch feature.\n\n- criterion one\n- criterion two\n')
  fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
  fs.writeFileSync(path.join(dir, 'noeol.txt'), 'no newline at end')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  const base = git(dir, 'rev-parse', 'HEAD')

  git(dir, 'checkout', '-q', '-b', 'feature')
  write(dir, 'src/a.ts', ['export function a() {', '  return 2', '}', 'export const K = 10', 'export const J = 20', ''].join('\n'))
  write(dir, 'src/b.ts', ['export function b() {', '  return 42', '}', ''].join('\n'))
  fs.rmSync(path.join(dir, 'src/old.ts'))
  git(dir, 'mv', 'src/moveme.ts', 'src/moved.ts')
  fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.from([9, 9, 9, 0, 255]))
  fs.writeFileSync(path.join(dir, 'noeol.txt'), 'still no newline at end')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'feature work')
  const firstFeature = git(dir, 'rev-parse', 'HEAD')

  write(dir, 'src/b.ts', ['export function b() {', '  return 43', '}', ''].join('\n'))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'tweak b')

  write(dir, 'src/c.ts', 'export const c = 3\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'add c')
  const head = git(dir, 'rev-parse', 'HEAD')

  return { dir, shas: { base, firstFeature, head } }
}

export { git as fixtureGit, write as fixtureWrite }
