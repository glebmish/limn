import fs from 'node:fs'
import path from 'node:path'
import { cliStatePath } from '../server/paths.js'

export interface CliState { servicePromptDeclined?: boolean }

export function readCliState(file = cliStatePath()): CliState {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as CliState } catch { return {} }
}

export function writeCliState(patch: Partial<CliState>, file = cliStatePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ...readCliState(file), ...patch }, null, 2) + '\n')
}
