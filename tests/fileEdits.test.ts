import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { makeFixtureRepo } from './helpers/fixtureRepo'
import { applyEditToFile, readWorkingFile, withWriteQueue } from '../src/server/fileEdits'
import { execGit } from '../src/server/exec'

function lines(dir: string, rel: string): string[] {
  return fs.readFileSync(path.join(dir, rel), 'utf8').split('\n')
}

describe('readWorkingFile', () => {
  it('reads text files with line split + trailing-newline flag', () => {
    const fx = makeFixtureRepo()
    const a = readWorkingFile(fx.dir, 'src/a.ts')
    expect(a).toMatchObject({ ok: true, trailingNewline: true })
    if (a.ok) expect(a.lines[0]).toBe('export function a() {')
    const noeol = readWorkingFile(fx.dir, 'noeol.txt')
    expect(noeol).toMatchObject({ ok: true, trailingNewline: false })
    if (noeol.ok) expect(noeol.lines).toEqual(['still no newline at end'])
  })

  it('refuses binary, missing, and escaping paths', () => {
    const fx = makeFixtureRepo()
    expect(readWorkingFile(fx.dir, 'img.bin')).toMatchObject({ ok: false, reason: 'binary' })
    expect(readWorkingFile(fx.dir, 'nope.txt')).toMatchObject({ ok: false, reason: 'missing' })
    expect(() => readWorkingFile(fx.dir, '../outside.txt')).toThrow(/escapes/)
    expect(() => readWorkingFile(fx.dir, '/etc/passwd')).toThrow(/absolute/)
  })
})

describe('applyEditToFile', () => {
  it('replaces the anchored lines and reports the new blob hash', async () => {
    const fx = makeFixtureRepo()
    const result = await applyEditToFile(fx.dir, 'src/a.ts', {
      start: 2, end: 2, snapshot: ['  return 2'], newLines: ['  return 3']
    })
    expect(result.ok).toBe(true)
    expect(lines(fx.dir, 'src/a.ts')[1]).toBe('  return 3')
    // trailing newline preserved
    expect(fs.readFileSync(path.join(fx.dir, 'src/a.ts'), 'utf8').endsWith('\n')).toBe(true)
    if (result.ok) {
      const gitHash = (await execGit(fx.dir, ['hash-object', '--', 'src/a.ts'])).trim()
      expect(result.fileHash).toBe(gitHash)
    }
  })

  it('refuses when the anchored lines changed (conflict carries current content)', async () => {
    const fx = makeFixtureRepo()
    const before = fs.readFileSync(path.join(fx.dir, 'src/a.ts'), 'utf8')
    const result = await applyEditToFile(fx.dir, 'src/a.ts', {
      start: 2, end: 2, snapshot: ['  return 999 // stale render'], newLines: ['x']
    })
    expect(result).toMatchObject({ ok: false, reason: 'conflict' })
    if (!result.ok) expect(result.current[1]).toBe('  return 2')
    expect(fs.readFileSync(path.join(fx.dir, 'src/a.ts'), 'utf8')).toBe(before) // untouched
  })

  it('is anchored — writes elsewhere in the file never block', async () => {
    const fx = makeFixtureRepo()
    // disk drifted at line 5 (someone appended), but we edit line 2
    fs.appendFileSync(path.join(fx.dir, 'src/a.ts'), 'export const LATE = 99\n')
    const result = await applyEditToFile(fx.dir, 'src/a.ts', {
      start: 2, end: 2, snapshot: ['  return 2'], newLines: ['  return 3']
    })
    expect(result.ok).toBe(true)
    const l = lines(fx.dir, 'src/a.ts')
    expect(l[1]).toBe('  return 3')
    expect(l).toContain('export const LATE = 99')
  })

  it('inserts before `start` when end = start-1 with an empty snapshot', async () => {
    const fx = makeFixtureRepo()
    const result = await applyEditToFile(fx.dir, 'src/a.ts', {
      start: 3, end: 2, snapshot: [], newLines: ['  // inserted']
    })
    expect(result.ok).toBe(true)
    expect(lines(fx.dir, 'src/a.ts')[2]).toBe('  // inserted')
  })

  // ── #10: a region whose *line count* grew. The CAS anchors on the snapshot's
  // span; newLines may be longer, and everything after the span shifts down.
  it('splits one anchored line into two and shifts the rest down', async () => {
    const fx = makeFixtureRepo()
    const before = lines(fx.dir, 'src/a.ts')
    const result = await applyEditToFile(fx.dir, 'src/a.ts', {
      start: 2, end: 2, snapshot: ['  return 2'], newLines: ['  const n = 2', '  return n']
    })
    expect(result.ok).toBe(true)
    const after = lines(fx.dir, 'src/a.ts')
    expect(after.slice(0, 3)).toEqual(['export function a() {', '  const n = 2', '  return n'])
    // the tail rode down by exactly one line, unchanged
    expect(after.slice(3)).toEqual(before.slice(2))
    expect(after.length).toBe(before.length + 1)
  })

  it('grows a one-line region by several lines', async () => {
    const fx = makeFixtureRepo()
    const before = lines(fx.dir, 'src/a.ts')
    const result = await applyEditToFile(fx.dir, 'src/a.ts', {
      start: 2, end: 2, snapshot: ['  return 2'], newLines: ['  // a', '  // b', '  return 2']
    })
    expect(result.ok).toBe(true)
    const after = lines(fx.dir, 'src/a.ts')
    expect(after.slice(1, 4)).toEqual(['  // a', '  // b', '  return 2'])
    expect(after.length).toBe(before.length + 2)
  })

  it('a growing edit still CAS-refuses on a stale snapshot', async () => {
    const fx = makeFixtureRepo()
    const before = fs.readFileSync(path.join(fx.dir, 'src/a.ts'), 'utf8')
    const result = await applyEditToFile(fx.dir, 'src/a.ts', {
      start: 2, end: 2, snapshot: ['  return 999'], newLines: ['  const n = 2', '  return n']
    })
    expect(result).toMatchObject({ ok: false, reason: 'conflict' })
    expect(fs.readFileSync(path.join(fx.dir, 'src/a.ts'), 'utf8')).toBe(before)
  })

  it('preserves a missing trailing newline', async () => {
    const fx = makeFixtureRepo()
    const result = await applyEditToFile(fx.dir, 'noeol.txt', {
      start: 1, end: 1, snapshot: ['still no newline at end'], newLines: ['edited, still no newline']
    })
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(path.join(fx.dir, 'noeol.txt'), 'utf8')).toBe('edited, still no newline')
  })

  it('preserves the file mode', async () => {
    const fx = makeFixtureRepo()
    const p = path.join(fx.dir, 'src/a.ts')
    fs.chmodSync(p, 0o755)
    const result = await applyEditToFile(fx.dir, 'src/a.ts', {
      start: 2, end: 2, snapshot: ['  return 2'], newLines: ['  return 3']
    })
    expect(result.ok).toBe(true)
    expect(fs.statSync(p).mode & 0o111).not.toBe(0)
  })

  it('a missing file is a conflict with empty current', async () => {
    const fx = makeFixtureRepo()
    const result = await applyEditToFile(fx.dir, 'gone.txt', {
      start: 1, end: 1, snapshot: ['x'], newLines: ['y']
    })
    expect(result).toMatchObject({ ok: false, reason: 'conflict', current: [] })
  })
})

describe('withWriteQueue', () => {
  it('serializes writes to the same workdir in call order', async () => {
    const order: number[] = []
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const first = withWriteQueue('/tmp/wq-test', async () => { await held; order.push(1) })
    const second = withWriteQueue('/tmp/wq-test', async () => { order.push(2) })
    release()
    await Promise.all([first, second])
    expect(order).toEqual([1, 2])
  })

  it('keeps the chain alive after a rejection', async () => {
    await expect(withWriteQueue('/tmp/wq-test2', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(withWriteQueue('/tmp/wq-test2', async () => 'ok')).resolves.toBe('ok')
  })
})
