import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseArgs, CliUsageError } from '../src/cli/args'

const cwd = '/work/repo'

describe('parseArgs', () => {
  it('bare invocation is `open` on cwd', () => {
    expect(parseArgs([], cwd)).toEqual({ kind: 'open', dir: cwd, hub: false, fresh: false, noService: false })
  })
  it('open takes a positional dir (absolute or relative to cwd) and ref flags', () => {
    expect(parseArgs(['open', '/x', '--base', 'main', '--branch', 'feat'], cwd)).toMatchObject({ kind: 'open', dir: '/x', base: 'main', compare: 'feat' })
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-cli-args-'))
    fs.mkdirSync(path.join(tmpCwd, 'sub', 'dir'), { recursive: true })
    expect(parseArgs(['sub/dir'], tmpCwd)).toMatchObject({ kind: 'open', dir: path.join(tmpCwd, 'sub', 'dir') })
    expect(parseArgs(['--base=main', '--branch=feat', '--new', '--hub', '--no-service'], cwd))
      .toMatchObject({ kind: 'open', dir: cwd, base: 'main', compare: 'feat', fresh: true, hub: true, noService: true })
  })
  it('service subcommands', () => {
    expect(parseArgs(['service', 'serve'], cwd)).toEqual({ kind: 'serve', port80: false })
    expect(parseArgs(['service', 'serve', '--port', '7000', '--port-80'], cwd)).toEqual({ kind: 'serve', port: 7000, port80: true })
    expect(parseArgs(['service', 'install', '--port-80'], cwd)).toEqual({ kind: 'service-install', port80: true })
    expect(parseArgs(['service', 'uninstall'], cwd)).toEqual({ kind: 'service-uninstall' })
    expect(parseArgs(['service', 'status'], cwd)).toEqual({ kind: 'service-status' })
    expect(parseArgs(['service', 'logs', '-f'], cwd)).toEqual({ kind: 'service-logs', follow: true })
  })
  it('version and help', () => {
    expect(parseArgs(['--version'], cwd)).toEqual({ kind: 'version' })
    expect(parseArgs(['-v'], cwd)).toEqual({ kind: 'version' })
    expect(parseArgs(['--help'], cwd)).toEqual({ kind: 'help' })
    expect(parseArgs(['service'], cwd)).toEqual({ kind: 'help', topic: 'service' })
    expect(parseArgs(['service', '--help'], cwd)).toEqual({ kind: 'help', topic: 'service' })
  })
  it('rejects unknown commands, flags, and bad ports', () => {
    const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-cli-args-'))
    expect(() => parseArgs(['frobnicate'], emptyCwd)).toThrow(CliUsageError)
    expect(() => parseArgs(['open', '--bogus'], cwd)).toThrow(/unknown flag --bogus/)
    expect(() => parseArgs(['service', 'serve', '--port', 'x'], cwd)).toThrow(/--port/)
    expect(() => parseArgs(['service', 'dance'], cwd)).toThrow(/unknown service command/)
  })
  it('suggests `service <word>` for a bare service-command word that is not a directory', () => {
    expect(() => parseArgs(['serve'], cwd)).toThrow(/unknown command "serve" — did you mean "limn service serve"\?/)
  })
  it('boolean flags reject a bogus `=value` suffix', () => {
    expect(() => parseArgs(['service', 'install', '--port-80=1'], cwd)).toThrow(/takes no value/)
    expect(() => parseArgs(['service', 'logs', '--follow=true'], cwd)).toThrow(/takes no value/)
    expect(() => parseArgs(['open', '--hub=1'], cwd)).toThrow(/takes no value/)
    // value-taking flags still accept `=value`
    expect(parseArgs(['service', 'serve', '--port=7000'], cwd)).toEqual({ kind: 'serve', port: 7000, port80: false })
  })
})
