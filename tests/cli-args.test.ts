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
  it('rejects stray positionals after a service subcommand instead of ignoring them', () => {
    expect(() => parseArgs(['service', 'status', 'extra'], cwd)).toThrow(/unexpected argument "extra"/)
    expect(() => parseArgs(['service', 'serve', '--port', '7000', 'x'], cwd)).toThrow(/unexpected argument "x"/)
    expect(() => parseArgs(['service', 'logs', '-f', 'limn.log'], cwd)).toThrow(/unexpected argument "limn.log"/)
  })
  it('rejects an empty `=value` on a value-taking flag', () => {
    expect(() => parseArgs(['open', '--base='], cwd)).toThrow(/--base needs a value/)
    expect(() => parseArgs(['--branch=', '--hub'], cwd)).toThrow(/--branch needs a value/)
    expect(() => parseArgs(['service', 'serve', '--port='], cwd)).toThrow(/--port needs a value/)
  })
  it('config subcommands', () => {
    expect(parseArgs(['config'], cwd)).toEqual({ kind: 'config-list' })
    expect(parseArgs(['config', 'get', 'model'], cwd)).toEqual({ kind: 'config-get', key: 'model' })
    expect(parseArgs(['config', 'set', 'effort', 'high'], cwd)).toEqual({ kind: 'config-set', key: 'effort', value: 'high' })
    expect(parseArgs(['config', '--help'], cwd)).toEqual({ kind: 'help', topic: 'config' })
  })
  it('rejects bad config subcommands', () => {
    expect(() => parseArgs(['config', 'get', 'colour'], cwd)).toThrow(/unknown config key "colour" \(agent, model, effort\)/)
    expect(() => parseArgs(['config', 'set', 'model'], cwd)).toThrow(/config set needs a key and a value/)
    expect(() => parseArgs(['config', 'frob'], cwd)).toThrow(CliUsageError)
  })
  it('HELP mentions `limn config`', async () => {
    const { HELP } = await import('../src/cli/main')
    expect(HELP).toMatch(/limn config/)
  })
})
