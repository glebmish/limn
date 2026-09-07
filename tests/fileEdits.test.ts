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

  // A latin-1/cp1252 file (a fixture, a vendored file, a smart quote saved in the
  // wrong encoding) decodes to U+FFFD and would be written back as EF BF BD —
  // corrupting bytes no edit ever touched. A NUL byte, by contrast, IS valid UTF-8
  // and round-trips, so the `\0` check has to stay for files like img.bin.
  it('refuses a text file whose bytes are not valid UTF-8', () => {
    const fx = makeFixtureRepo()
    fs.writeFileSync(path.join(fx.dir, 'latin1.ts'), Buffer.from('// caf\xe9\nline2\n', 'latin1'))
    expect(readWorkingFile(fx.dir, 'latin1.ts')).toMatchObject({ ok: false, reason: 'binary' })
    fs.writeFileSync(path.join(fx.dir, 'nul.txt'), Buffer.from('a\0b\n', 'utf8'))
    expect(readWorkingFile(fx.dir, 'nul.txt')).toMatchObject({ ok: false, reason: 'binary' })
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
    if (!result.ok && result.reason === 'conflict') expect(result.current[1]).toBe('  return 2')
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

  // ── #8: a region whose *line count* shrank — joined rows, and the zero-line
  // case where the anchored lines leave the file entirely.
  it('shrinks a 3-line region to 2 and rides the tail up', async () => {
    const fx = makeFixtureRepo()
    const before = lines(fx.dir, 'src/a.ts')
    const result = await applyEditToFile(fx.dir, 'src/a.ts', {
      start: 1, end: 3, snapshot: before.slice(0, 3), newLines: [before[0], `${before[1]}${before[2]}`]
    })
    expect(result.ok).toBe(true)
    const after = lines(fx.dir, 'src/a.ts')
    expect(after.slice(0, 2)).toEqual([before[0], `${before[1]}${before[2]}`])
    expect(after.slice(2)).toEqual(before.slice(3))
    expect(after.length).toBe(before.length - 1)
  })

  it('an empty newLines deletes the anchored line outright', async () => {
    const fx = makeFixtureRepo()
    const before = lines(fx.dir, 'src/a.ts')
    const result = await applyEditToFile(fx.dir, 'src/a.ts', {
      start: 2, end: 2, snapshot: ['  return 2'], newLines: []
    })
    expect(result.ok).toBe(true)
    const after = lines(fx.dir, 'src/a.ts')
    expect(after).not.toContain('  return 2')
    expect(after).toEqual([before[0], ...before.slice(2)])
    expect(fs.readFileSync(path.join(fx.dir, 'src/a.ts'), 'utf8').endsWith('\n')).toBe(true)
  })

  it('an empty newLines deletes a whole multi-line span', async () => {
    const fx = makeFixtureRepo()
    const before = lines(fx.dir, 'src/a.ts')
    const result = await applyEditToFile(fx.dir, 'src/a.ts', {
      start: 1, end: 3, snapshot: before.slice(0, 3), newLines: []
    })
    expect(result.ok).toBe(true)
    expect(lines(fx.dir, 'src/a.ts')).toEqual(before.slice(3))
  })

  it('deleting the only line of a file leaves it empty, not blank', async () => {
    const fx = makeFixtureRepo()
    const p = path.join(fx.dir, 'solo.txt')
    fs.writeFileSync(p, 'the only line\n')
    const result = await applyEditToFile(fx.dir, 'solo.txt', {
      start: 1, end: 1, snapshot: ['the only line'], newLines: []
    })
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(p, 'utf8')).toBe('')
    // and it round-trips: an empty file reads back as zero lines
    expect(readWorkingFile(fx.dir, 'solo.txt')).toMatchObject({ ok: true, lines: [] })
  })

  it('deleting the last line of a no-trailing-newline file keeps it that way', async () => {
    const fx = makeFixtureRepo()
    const p = path.join(fx.dir, 'noeol2.txt')
    fs.writeFileSync(p, 'keep\ndrop')
    const result = await applyEditToFile(fx.dir, 'noeol2.txt', {
      start: 2, end: 2, snapshot: ['drop'], newLines: []
    })
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(p, 'utf8')).toBe('keep')
  })

  it('a deleting edit still CAS-refuses on a stale snapshot', async () => {
    const fx = makeFixtureRepo()
    const before = fs.readFileSync(path.join(fx.dir, 'src/a.ts'), 'utf8')
    const result = await applyEditToFile(fx.dir, 'src/a.ts', {
      start: 2, end: 2, snapshot: ['  return 999'], newLines: []
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

  it('leaves a non-UTF-8 file byte-identical instead of rewriting it as U+FFFD', async () => {
    const fx = makeFixtureRepo()
    const p = path.join(fx.dir, 'latin1.ts')
    const bytes = Buffer.from('// caf\xe9\nline2\n', 'latin1') // the invalid byte is on line 1
    fs.writeFileSync(p, bytes)
    const result = await applyEditToFile(fx.dir, 'latin1.ts', {
      start: 2, end: 2, snapshot: ['line2'], newLines: ['line2 edited'] // …the edit is on line 2
    })
    expect(result.ok).toBe(false)
    expect(fs.readFileSync(p)).toEqual(bytes)
  })

  // A file that leaves the editable set between the frame opening and the save (a
  // generation writing to it is exactly this feature's concurrency) is not a
  // conflict: there is no fresh content to hand back, so the reason travels instead.
  it('reports a file that outgrew the edit cap as too-large, not a conflict', async () => {
    const fx = makeFixtureRepo()
    fs.writeFileSync(path.join(fx.dir, 'big.txt'), `${'x'.repeat(2 * 1024 * 1024)}\n`)
    const result = await applyEditToFile(fx.dir, 'big.txt', {
      start: 1, end: 1, snapshot: ['x'], newLines: ['y']
    })
    expect(result).toEqual({ ok: false, reason: 'too-large' })
  })

  it('reports a file that stopped being UTF-8 text as binary, not a conflict', async () => {
    const fx = makeFixtureRepo()
    fs.writeFileSync(path.join(fx.dir, 'now-binary.txt'), Buffer.from([0x61, 0x0a, 0xff, 0x0a]))
    const result = await applyEditToFile(fx.dir, 'now-binary.txt', {
      start: 1, end: 1, snapshot: ['a'], newLines: ['b']
    })
    expect(result).toEqual({ ok: false, reason: 'binary' })
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
