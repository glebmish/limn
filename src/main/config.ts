import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { EngineId } from '../shared/types.js'

interface AppConfig {
  recents: string[]
  lastEngine?: EngineId
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

export function loadConfig(): AppConfig {
  try {
    return { recents: [], ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }
  } catch {
    return { recents: [] }
  }
}

export function saveConfig(cfg: AppConfig): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2))
}

export function addRecent(repo: string): void {
  const cfg = loadConfig()
  cfg.recents = [repo, ...cfg.recents.filter((r) => r !== repo)].slice(0, 8)
  saveConfig(cfg)
}
