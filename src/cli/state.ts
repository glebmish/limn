import fs from 'node:fs'
import path from 'node:path'
import { cliStatePath } from '../server/paths.js'

export interface CliState { servicePromptDeclined?: boolean }

export function readCliState(): CliState {
  try { return JSON.parse(fs.readFileSync(cliStatePath(), 'utf8')) as CliState } catch { return {} }
}

export function writeCliState(patch: Partial<CliState>): void {
  const file = cliStatePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...readCliState(), ...patch }, null, 2) + '\n')
}
